import { existsSync } from "node:fs";
import type {
  BootstrapClaimResponse,
  RuntimeConfig,
  SessionRuntime,
} from "@werft-ai/contracts";
import {
  type CheckpointObjectStore,
  RuntimeRegistry as InstalledRuntimes,
  type InstructionPart,
  type PlatformMcpServer,
  parseImageRuntime,
  type RuntimeBindings,
  type RuntimeFingerprint,
  type RuntimeModule,
  type RuntimeProfileInput,
  type RuntimeStart,
} from "@werft-ai/runtime-core";
import { installedRuntimes } from "@werft-ai/runtime-registry";

import { REPAIR_TOOL_PATH } from "./attribution-repair.ts";
import type { WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerConfig, WorkerTimeouts } from "./config.ts";
import { consoleLogger } from "./console-logger.ts";
import { EngineProcesses } from "./engine-processes.ts";
import {
  publishExtensionBundles,
  publishedBundlePath,
} from "./extension-bundles.ts";
import { HttpWorkerGatewayClient } from "./gateway-client.ts";
import {
  gitEnvironmentFor,
  IMAGE_GIT_HOOKS,
  writeGitTrailers,
} from "./git-trailers.ts";
import { placeInstructionFiles } from "./instruction-files.ts";
import {
  LEGACY_OUT_DIRECTORY_PROMPT,
  LEGACY_OUT_DIRECTORY_PROMPT_STARTS_WITHOUT_REPOSITORY,
  legacyPlatformPromptText,
  startsWithoutRepository,
} from "./legacy-platform-prompt.ts";
import { createWorkerObjectStore, ObjectStoreToken } from "./object-store.ts";
import { writePackageManagerConfig } from "./package-managers.ts";
import { writeRepositoryRoutes } from "./repository-routes.ts";
import { scrubbingLogger } from "./secret-scrubber.ts";
import { SessionCheckpoints } from "./session-checkpoints.ts";
import {
  type RuntimeLaunch,
  type RuntimeLauncher,
  type RuntimeRegistry,
  type WorkerGatewaySession,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";
import { GitWorkspace, type WorkspacePreparer } from "./workspace.ts";
import type { WorkspaceObserver } from "./workspace-observer.ts";
import type { WorkspaceQuotaLimits } from "./workspace-quota.ts";

export type WorkerComposition = {
  checkpoints?: WorkerCheckpointPort;
  engines?: EngineProcesses;
  gateway?: WorkerGatewaySession;
  logger?: WorkerLogger;
  objectStore?: CheckpointObjectStore;
  runtimes?: RuntimeRegistry;
  workspace?: WorkspacePreparer;
  workspaceQuota?: {
    observer: WorkspaceObserver;
    limits: WorkspaceQuotaLimits;
  };
};

/**
 * The worker's composition root. It builds the gateway transport, the
 * session-scoped object store and the one runtime this image ships; it never
 * opens a database pool or talks to an execution backend, which is what
 * `tests/architecture` holds it to.
 */
export function createWorkerHost(
  config: WorkerConfig,
  overrides: WorkerComposition = {},
): WorkerHost {
  const engines =
    overrides.engines ?? new EngineProcesses("/proc", config.runtime.cwd);
  const logger = overrides.logger ?? consoleLogger;
  const imageHooks = existsSync(IMAGE_GIT_HOOKS) ? IMAGE_GIT_HOOKS : undefined;
  const gateway =
    overrides.gateway ??
    new HttpWorkerGatewayClient({
      baseUrl: config.gatewayUrl,
      credential: config.bootstrapNonce,
      requestTimeoutMs: config.timeouts.requestTimeoutMs,
    });
  const runtime = imageRuntime();
  const instructionFiles = runtime.descriptor.instructionFiles;
  const workspace =
    overrides.workspace ??
    new GitWorkspace(
      config.runtime.cwd,
      instructionFiles,
      config.egressCredentialUrl,
      config.attachLimits,
    );
  const objectToken = new ObjectStoreToken();
  // Built before the host that learns the claim's secrets, so it asks the
  // host for them at each line.
  let host: WorkerHost | undefined;
  const checkpointLogger = scrubbingLogger(logger, () => host?.secrets);
  host = new WorkerHost({
    checkpoints:
      overrides.checkpoints ??
      new SessionCheckpoints({
        fingerprint: claimFingerprint(config),
        legacyFingerprint: claimFingerprint(config, true),
        gateway,
        instructionsCommit: () => workspace.instructionsCommit(),
        logger: checkpointLogger,
        objectPrefix: config.objectStore.scope,
        objects:
          overrides.objectStore ??
          createWorkerObjectStore(config.objectStore, () =>
            objectToken.current(),
          ),
        workspaceRoot: config.runtime.cwd,
        home: config.runtime.home,
        // Only the worker image installs the tool.
        ...(existsSync(REPAIR_TOOL_PATH)
          ? { repairTool: REPAIR_TOOL_PATH }
          : {}),
        claudeConfigDir: config.runtime.claudeConfigDir,
        instructionFiles,
        runtime,
      }),
    engines,
    execution: {
      bootstrapNonce: config.bootstrapNonce,
      generation: config.executionGeneration,
      id: config.executionId,
    },
    gateway,
    gitTrailers: (claim) => writeGitTrailers(config.runtime.home, claim),
    gitEnvironment: (claim) => gitEnvironmentFor(claim, imageHooks),
    extensionBundles: (claim, signal) =>
      publishExtensionBundles({
        home: config.runtime.home,
        attemptId: claim.attempt_id,
        bundles: claim.runtime_config.extensions ?? [],
        gateway,
        signal,
      }),
    placeInstructions: (claim, signal) =>
      placeInstructionFiles({
        root: config.runtime.cwd,
        text: instructionParts(claim.runtime_config, claim.workspace)
          .map((part) => part.text)
          .join("\n\n"),
        signal,
      }),
    packageManagers: (token, github, privateModules) =>
      writePackageManagerConfig(
        config.runtime.home,
        config.egressCredentialUrl,
        token,
        github,
        privateModules,
      ),
    repositoryRoutes: (workspace) =>
      writeRepositoryRoutes(
        config.runtime.home,
        config.egressCredentialUrl,
        workspace,
      ),
    imageRuntime: parseImageRuntime(runtime.imageFingerprint()),
    logger,
    objectStoreAccess: objectToken,
    runtimes: overrides.runtimes ?? workerRuntimeRegistry(config, engines),
    timeouts: config.timeouts,
    workspace,
    ...(overrides.workspaceQuota === undefined
      ? {}
      : { workspaceQuota: overrides.workspaceQuota }),
  });
  return host;
}

/**
 * The one runtime this image installs. Checkpoints, the workspace's
 * instruction file and the image fingerprint all speak for a single engine,
 * so an image built with none or several is refused at start.
 */
export function imageRuntime(): RuntimeModule {
  const [runtime, ...others] = installedRuntimes;
  if (runtime === undefined || others.length > 0) {
    throw new Error(
      `This image must install exactly one runtime, not ${installedRuntimes.length}`,
    );
  }
  return runtime;
}

/**
 * This image runs exactly one engine. A session created for another engine —
 * or for another build of this one — is refused rather than run on whatever
 * happens to be installed, because the transcript a checkpoint resumes is only
 * replayable on the build that wrote it.
 */
export function workerRuntimeRegistry(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime"> & {
    timeouts?: Pick<WorkerTimeouts, "toolUseFrameWaitMs">;
  },
  engines: EngineProcesses,
): RuntimeRegistry {
  const installed = new InstalledRuntimes([imageRuntime()]);
  return {
    launcherFor(session: SessionRuntime): RuntimeLauncher {
      const module = installed.require(session.kind);
      module.assertCompatible(session);
      const runtime = module.createRuntime({
        processObserver: engines,
        stateDir: config.runtime.claudeConfigDir,
        providerMaxRetries: config.runtime.providerMaxRetries,
        ...(config.timeouts?.toolUseFrameWaitMs === undefined
          ? {}
          : { toolCallWaitMs: config.timeouts.toolUseFrameWaitMs }),
      });
      return {
        start: (launch) => runtime.start(runtimeStart(config, module, launch)),
      };
    },
  };
}

export function runtimeStart(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime">,
  module: Pick<RuntimeModule, "descriptor">,
  launch: RuntimeLaunch,
): RuntimeStart {
  const profile = runtimeProfile(
    config,
    module,
    launch,
    launch.committedInstructions,
  );
  const { correlationId, maxBudgetUsd } = launch;
  const mode =
    launch.mode === "new"
      ? { mode: "new" as const }
      : {
          mode: "resume" as const,
          resume: launch.resume,
          ...(launch.localTranscriptResume === true
            ? { localTranscriptResume: true as const }
            : {}),
        };
  return {
    config: {
      ...profile.config,
      ...mode,
      correlationId,
      ...(launch.runtimeConfig.disallowed_tools === undefined
        ? {}
        : { disallowedTools: launch.runtimeConfig.disallowed_tools }),
      ...(launch.runtimeConfig.engine_settings === undefined
        ? {}
        : { engineSettings: launch.runtimeConfig.engine_settings }),
      ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
      ...(launch.gitEnvironment === undefined
        ? {}
        : { gitEnvironment: launch.gitEnvironment }),
      // Not in runtimeProfile: the fingerprint must not move with a
      // variable's value, and a resumed run reads them from its claim again.
      ...(launch.runtimeConfig.env === undefined
        ? {}
        : { userEnvironment: launch.runtimeConfig.env }),
    },
    bindings: {
      ...profile.bindings,
      ...(launch.sessionStore === undefined
        ? {}
        : { transcript: launch.sessionStore }),
    },
    bundle: profile.bundle,
  };
}

/**
 * What the engine of a session without a repository is told: the one fact it
 * cannot see, which directory the platform collects outputs from. It is part
 * of the fingerprint of the checkpoints made after it, so rewording it stops
 * those sessions' checkpoints from resuming unless the old wording stays in
 * the legacy fingerprint.
 */
export const OUT_DIRECTORY_PROMPT =
  "`out/` at the workspace root is the directory whose files a checkpoint collects as outputs.";

/**
 * What a claim runs, short of how it resumes: shared by the launcher and by
 * the fingerprint a checkpoint is stamped with, so the two cannot describe
 * different runs.
 */
export function runtimeProfile(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime">,
  module: Pick<RuntimeModule, "descriptor">,
  launch: Pick<RuntimeLaunch, "principal" | "runtimeConfig" | "workspace">,
  committedInstructions: () => string | null,
  legacyPrompt = false,
): RuntimeProfileInput {
  const { principal, runtimeConfig } = launch;
  const { principal: owner, ...provider } = engineProfile(
    runtimeConfig.provider,
    principal.owner_scope,
    config.egressCredentialUrl,
  );
  const instructionFiles = module.descriptor.instructionFiles;
  return {
    config: {
      cwd: config.runtime.cwd,
      home: config.runtime.home,
      model: runtimeConfig.model,
      permissionMode: runtimeConfig.permission_mode,
      tools: runtimeConfig.tools,
    },
    bindings: { principal: owner, provider },
    bundle: {
      instructions: instructionParts(
        runtimeConfig,
        launch.workspace,
        legacyPrompt,
      ),
      repoInstructions:
        runtimeConfig.project_settings?.claude_md === true &&
        instructionFiles.length > 0
          ? { files: instructionFiles, text: committedInstructions() }
          : null,
      mcpServers: mcpServersOf(runtimeConfig, config.egressCredentialUrl),
      ...((runtimeConfig.extensions ?? []).length === 0
        ? {}
        : {
            extensions: (runtimeConfig.extensions ?? []).map((bundle) => ({
              name: bundle.name,
              digest: bundle.digest,
              path: publishedBundlePath(config.runtime.home, bundle.digest),
            })),
          }),
    },
  };
}

/**
 * What the platform tells the engine, in order. The engine gets it as its prompt and the workspace as AGENTS.md
 * (`placeInstructionFiles`), so the two cannot differ.
 */
export function instructionParts(
  runtimeConfig: RuntimeConfig,
  workspace:
    | Pick<BootstrapClaimResponse["workspace"], "repository">
    | undefined,
  /** Only the checkpoint fingerprint of an older session asks for this. */
  legacy = false,
): InstructionPart[] {
  if (legacy) {
    return [
      ...(runtimeConfig.platform_prompt === undefined
        ? []
        : [{ text: legacyPlatformPromptText(runtimeConfig.platform_prompt) }]),
      ...(workspace?.repository === null
        ? [
            {
              text:
                runtimeConfig.platform_prompt !== undefined &&
                startsWithoutRepository(runtimeConfig.platform_prompt)
                  ? LEGACY_OUT_DIRECTORY_PROMPT_STARTS_WITHOUT_REPOSITORY
                  : LEGACY_OUT_DIRECTORY_PROMPT,
            },
          ]
        : []),
    ];
  }
  return [
    ...(workspace?.repository === null ? [{ text: OUT_DIRECTORY_PROMPT }] : []),
  ];
}

function mcpServersOf(
  runtimeConfig: RuntimeConfig,
  egressCredentialUrl: string,
): PlatformMcpServer[] {
  return (runtimeConfig.mcp_servers ?? []).map((s) => ({
    name: s.name,
    binding: s.binding,
    url: `${egressCredentialUrl}/mcp/${s.name}`,
    token: s.access.token,
    tools: runtimeConfig.tools,
    ...(s.platform === true ? { platform: true } : {}),
    ...(s.trusted === undefined ? {} : { trusted: s.trusted }),
  }));
}

/**
 * The fingerprint a checkpoint of this claim's run is stamped with, and the
 * one a restore plan is asked for. The committed instruction file is not
 * read: the digest records only that the profile lets it in. A claim given
 * without its workspace is taken for a session with a repository, which is
 * all `image-runtime.ts` is fed.
 *
 * With `legacyPrompt`, the fingerprint the checkpoints of a session made
 * before the platform stopped giving engines its paragraph were stamped with.
 */
export function claimFingerprint(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime">,
  legacyPrompt = false,
): (
  claim: Pick<BootstrapClaimResponse, "principal" | "runtime_config"> & {
    workspace?: BootstrapClaimResponse["workspace"] | undefined;
  },
) => RuntimeFingerprint {
  const runtime = imageRuntime();
  return (claim) =>
    runtime.fingerprint(
      runtimeProfile(
        config,
        runtime,
        {
          principal: claim.principal,
          runtimeConfig: claim.runtime_config,
          ...(claim.workspace === undefined
            ? {}
            : { workspace: claim.workspace }),
        },
        () => null,
        legacyPrompt,
      ),
    );
}

/**
 * The claim's provider as the engine sees it: the upstream endpoint stays
 * (policy approves it and the checkpoint fingerprint names it), but the
 * calls go to the egress proxy's provider route with the attempt's token,
 * and the proxy adds the credential.
 */
export function engineProfile(
  provider: RuntimeConfig["provider"],
  ownerScope: string,
  egressCredentialUrl: string,
): RuntimeBindings["provider"] & Pick<RuntimeBindings, "principal"> {
  const auth = {
    kind: "egress_token" as const,
    token: provider.auth.token,
    transport: `${egressCredentialUrl}/provider`,
  };
  // The catalog provider is shared across partitions; the claim's
  // principal is what makes this session's checkpoints its own.
  const principal = { ownerScope };
  return { kind: provider.kind, endpoint: provider.endpoint, auth, principal };
}
