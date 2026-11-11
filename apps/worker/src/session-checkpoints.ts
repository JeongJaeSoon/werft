import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type BootstrapClaimResponse,
  type CheckpointRef,
  MAX_RESTORE_ALTERNATES,
  type RestorePlanWire,
  type WorkerScope,
} from "@werft-ai/contracts";
import {
  type CheckpointCodec,
  type CheckpointManifest,
  type CheckpointObjectStore,
  type CheckpointOutput,
  type CheckpointPreparation,
  type CheckpointTranscripts,
  DEFAULT_MAX_MANIFEST_BYTES,
  DEFAULT_MAX_MANIFEST_OBJECTS,
  type ImmutableObjectSource,
  isOwnershipLost,
  MAX_WORKSPACE_BUNDLE_CHAIN,
  ObjectIntegrityError,
  type ObjectRef,
  type ReadyCheckpoint,
  type RejectedCheckpoint,
  type RuntimeFingerprint,
  type RuntimeModule,
  restoreCwdRefusal,
  runtimeFor,
  type StoredOutput,
  storedOutputs,
  TRANSCRIPT_LIMITS,
  TRANSCRIPT_MIRROR_DIRECTORY,
  type TranscriptLimits,
  type TranscriptRevision,
  type TranscriptSizeProblem,
  type TranscriptStore,
  TranscriptTooLargeError,
  transcriptBytes,
  transcriptParts,
  transcriptSizeProblem,
  transcriptWarnBytes,
  type WorkerGatewayClient,
  WorkerGatewayRequestError,
  type WorkspaceArtifact,
  workingTreeSnapshotMismatch,
  workspacePathsProblem,
  writeWorkspaceFile,
} from "@werft-ai/runtime-core";
import {
  claimExpectations,
  repairAttribution,
  workspaceMismatches,
} from "./attribution-repair.ts";
import type {
  CheckpointCaptureContext,
  RuntimeResumePlan,
  WorkerCheckpointPort,
} from "./checkpoint.ts";
import {
  CheckpointBundleRefused,
  clearWorkspace,
  restoreCheckpointTree,
  stageCheckpointBundle,
  stagedInstructions,
} from "./checkpoint-restore.ts";
import type { WorkerLogger } from "./console-logger.ts";
import { messageOf as describe } from "./message-of.ts";
import { isObjectStoreOutage } from "./object-store.ts";
import {
  committedInstructionsOf,
  storableRepositoryUrl,
  workerScratch,
} from "./workspace.ts";
import {
  type BundleBase,
  captureWorkspace,
  DEFAULT_WORKSPACE_CAPTURE_LIMITS,
  type InstructionsPin,
  type WorkspaceCaptureLimits,
  type WorkspaceCaptureResult,
} from "./workspace-capture.ts";
import {
  indexOutputs,
  OUTPUT_DIRECTORY,
  type OutputIndex,
  type OutputLimits,
} from "./workspace-outputs.ts";

const UPLOAD_CONCURRENCY = 8;
/** Objects a restore downloads at once, each streamed and verified to disk. */
const DOWNLOAD_CONCURRENCY = 8;
/**
 * An object-store operation needed at startup is redone after 1s, doubling to
 * 30s, until the startup budget (`WORKER_STARTUP_TIMEOUT_SEC`) stops it.
 */
const STORE_RETRY_FIRST_MS = 1_000;
const STORE_RETRY_MAX_MS = 30_000;
const UNSETTLED =
  "a transcript batch failed to mirror and has not been written since";

export type SessionCheckpointsOptions = {
  gateway: Pick<WorkerGatewayClient, "requestCheckpoint" | "restorePlan"> &
    Partial<Pick<WorkerGatewayClient, "protectedCommits">>;
  /**
   * The attribution repair tool and the HOME it reads the claim's files
   * under; absent outside the image, where no repair runs.
   */
  repairTool?: string;
  home?: string;
  logger: WorkerLogger;
  /** Scoped to the session: every key it takes starts with `objectPrefix`. */
  objects: CheckpointObjectStore;
  /** `sessions/<id>/`, as the launcher configured the store. */
  objectPrefix: string;
  /** What this worker runs, recomputed from the claim. */
  fingerprint: (claim: BootstrapClaimResponse) => RuntimeFingerprint;
  /**
   * What a session made before the platform stopped giving engines its
   * paragraph stamped its checkpoints with. Those checkpoints stay
   * restorable; the ones this run takes carry `fingerprint`.
   */
  legacyFingerprint?: (claim: BootstrapClaimResponse) => RuntimeFingerprint;
  /**
   * What an image of each earlier digest scheme this one resumes stamped its
   * checkpoints with, for one config. Those checkpoints stay restorable; the
   * ones this run takes carry `fingerprint`.
   */
  earlierSchemeFingerprints?: (
    claim: BootstrapClaimResponse,
  ) => RuntimeFingerprint[];
  /** The provisioned root the engine runs in, and the manifest's `cwd`. */
  workspaceRoot: string;
  /**
   * The engine's `CLAUDE_CONFIG_DIR`. Its transcripts are moved onto the
   * workspace volume and a restore writes the resumed one there; absent, the
   * engine keeps them where it would and a resume hands it the transcript
   * through the store.
   */
  claudeConfigDir?: string;
  /** The engine whose checkpoints these are: its manifest codec and transcript store. */
  runtime: Pick<RuntimeModule, "checkpointCodec" | "openTranscriptStore">;
  /** The engine's instruction files, in order of preference, a restore reads at the pinned commit. */
  instructionFiles: readonly string[];
  /**
   * The commit the workspace preparer read the instruction file from, for a
   * session with nothing to restore; a restore takes the checkpoint's instead.
   */
  instructionsCommit?: () => string | null;
  /** Swapped in by tests that need a workspace refused or captured slowly. */
  captureWorkspace?: (input: {
    root: string;
    bundlePath: string;
    signal: AbortSignal;
    limits?: WorkspaceCaptureLimits;
    instructions?: InstructionsPin;
    base?: BundleBase;
    markNewFiles?: boolean;
    keepBranches?: boolean;
  }) => Promise<WorkspaceCaptureResult>;
  limits?: WorkspaceCaptureLimits;
  /** `DEFAULT_OUTPUT_LIMITS` unless a test sets smaller ones. */
  outputLimits?: OutputLimits;
  /** `TRANSCRIPT_LIMITS` unless a test sets smaller ones. */
  transcriptLimits?: TranscriptLimits;
  now?: () => Date;
  /** Waits out a restore's backoff; resolves early once `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type Bound = {
  claim: BootstrapClaimResponse;
  /** Carried into every bundle this run captures (`CHECKPOINT_INSTRUCTIONS_REF`). */
  instructions: InstructionsPin | undefined;
  runtime: RuntimeFingerprint;
  store: TranscriptStore;
  /** The checkpoint restored from, or the last one this run saw committed. */
  committed?: PublishedCheckpoint;
  /** The last one this run published, until the next shows it committed. */
  published?: PublishedCheckpoint | undefined;
  judgedTip?: string | undefined;
};

/** A checkpoint's workspace bundles as its manifest names them. */
type BundleChain = {
  revision: number;
  /** Oldest first; the last is the manifest's `bundle`. */
  links: readonly ObjectRef[];
  tips: readonly string[];
};

type PublishedCheckpoint = BundleChain & {
  untracked: readonly WorkspaceArtifact[];
  outputs: readonly StoredOutput[];
};

/**
 * A checkpoint this worker will not resume from. The claim fails on it, as on
 * any restore that cannot finish: starting a fresh engine session on top of a
 * session that has a checkpoint is what the pointer exists to stop. `code` is
 * the restore plan's, when the gateway gave one.
 */
export class RestoreRefused extends Error {
  constructor(
    readonly code: "CHECKPOINT_UNAVAILABLE" | "INCOMPATIBLE_CHECKPOINT",
    reason: string,
  ) {
    super(`Checkpoint restore refused (${code}): ${reason}`);
    this.name = "RestoreRefused";
  }
}

/**
 * A publish that stopped short. Never thrown past the port: it is logged and
 * reported as the advisory `publish_failed`, so the session shows that its
 * last turn went without a checkpoint.
 */
class PublishFailure extends Error {
  constructor(
    readonly stage: string,
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * The transcript is missing entries nobody can name. Unlike the other
 * failures this outlives the publish and is blocking: the session must not
 * report a turn complete without a checkpoint, so the gateway is told before
 * the port answers.
 */
class MirrorLost extends PublishFailure {
  constructor(reason: string) {
    super("transcript", reason);
  }
}

/**
 * The transcript is past `TRANSCRIPT_LIMITS`. It only grows, so this too
 * outlives the publish: it is reported under its own reason, which keeps the
 * session from taking new turns, rather than as `publish_failed`.
 */
class TranscriptLimitReached extends PublishFailure {
  readonly reason: TranscriptSizeProblem["reason"];
  constructor(problem: TranscriptSizeProblem) {
    super("transcript", problem.detail);
    this.reason = problem.reason;
  }
}

function isTranscriptLimit(reason: RejectedCheckpoint["reason"]): boolean {
  return (
    reason === "transcript_too_large" || reason === "transcript_part_too_large"
  );
}

/**
 * Checkpoints one claimed session: the transcript mirror the engine writes
 * to, and the publisher that turns a quiescent turn boundary into a manifest
 * finalize can commit.
 *
 * A publish follows the server's answer, never this worker's memory: the
 * revision and the manifest key are what `requestCheckpoint` answered, the
 * workspace is committed and bundled, the untracked files and the pinned
 * transcripts go up beside it, and only then the manifest, create-only,
 * under the key it was handed. Every object is written into that publish's
 * own directory, so nothing another publish or attempt wrote is ever
 * overwritten, and a publish that stops half way leaves orphans rather than
 * a manifest that names something missing.
 *
 * The caller holds the run's checkpoint lease for the whole of it, so no
 * tool the engine runs writes between the verdict and the commit. What the
 * engine does not run — a process a command detached from it — is not held
 * back.
 *
 * A claim that names a checkpoint is restored from it before the engine
 * starts; see `restorePlan`.
 */
export class SessionCheckpoints implements WorkerCheckpointPort {
  readonly #options: SessionCheckpointsOptions;
  readonly #codec: CheckpointCodec;
  #bound: Bound | undefined;

  constructor(options: SessionCheckpointsOptions) {
    if (!options.objectPrefix.endsWith("/")) {
      throw new Error(
        `Object prefix ${options.objectPrefix} must end in "/"; it is a key prefix`,
      );
    }
    this.#options = options;
    this.#codec = options.runtime.checkpointCodec;
  }

  async restorePlan(
    claim: BootstrapClaimResponse,
    signal: AbortSignal,
  ): Promise<RuntimeResumePlan> {
    const runtime = this.#options.fingerprint(claim);
    // Configs the session ran before its model moved; the
    // checkpoints this run takes carry `runtime`.
    const configs = [
      claim.runtime_config,
      ...(claim.restore_runtime_configs ?? []),
    ];
    const legacy = this.#options.legacyFingerprint;
    const earlier = this.#options.earlierSchemeFingerprints;
    const alternates = [
      ...new Set(
        configs.flatMap((config, index) => {
          const next = { ...claim, runtime_config: config };
          return [
            ...(legacy === undefined ? [] : [legacy(next).profileSha256]),
            ...(earlier === undefined
              ? []
              : earlier(next).map((found) => found.profileSha256)),
            ...(index === 0
              ? []
              : [this.#options.fingerprint(next).profileSha256]),
          ];
        }),
      ),
    ]
      .filter((digest) => digest !== runtime.profileSha256)
      .slice(0, MAX_RESTORE_ALTERNATES);
    const pointer = claim.restore;
    if (pointer !== null) {
      // The store not answering is no fault of the checkpoint: the restore
      // is redone whole inside this attempt rather than failing a claim the
      // session counts towards RESTORE_FAILED. What the store did
      // answer is held to the manifest as ever.
      for (let retries = 0; ; retries += 1) {
        try {
          return await this.#restore(
            claim,
            pointer,
            { runtime, alternates },
            signal,
          );
        } catch (caught) {
          if (!signal.aborted && isRestoreOutage(caught)) {
            const retryInMs = Math.min(
              STORE_RETRY_FIRST_MS * 2 ** retries,
              STORE_RETRY_MAX_MS,
            );
            this.#options.logger.warn("worker.checkpoint.restore_unavailable", {
              reason: describe(caught),
              retries,
              retry_in_ms: retryInMs,
              revision: pointer.revision,
              manifest_ref: pointer.manifest_ref,
            });
            await (this.#options.sleep ?? sleepUnlessAborted)(
              retryInMs,
              signal,
            );
            signal.throwIfAborted();
            continue;
          }
          // Bytes that fail the store's checksum are as damaged as bytes that
          // fail the manifest's digest; only the layer that caught them
          // differs. So is a bundle that holds its digest but not its shape.
          const error =
            caught instanceof ObjectIntegrityError ||
            caught instanceof CheckpointBundleRefused
              ? new RestoreRefused("CHECKPOINT_UNAVAILABLE", caught.message)
              : caught;
          if (error instanceof RestoreRefused) {
            this.#options.logger.error("worker.checkpoint.restore_refused", {
              code: error.code,
              reason: error.message,
              revision: pointer.revision,
              manifest_ref: pointer.manifest_ref,
            });
          }
          throw error;
        }
      }
    }
    const engineDirectory = await this.#transcriptsDirectory();
    const store = await this.#openFreshStore(claim, signal, engineDirectory);
    signal.throwIfAborted();
    const commit = this.#options.instructionsCommit?.() ?? null;
    this.#bound = {
      claim,
      instructions: commit === null ? undefined : { commit },
      runtime,
      store,
    };
    return {
      mode: "new",
      ...(store.mirror === undefined ? {} : { sessionStore: store.mirror }),
    };
  }

  /** Opens a fresh transcript generation once the object store answers. */
  async #openFreshStore(
    claim: BootstrapClaimResponse,
    signal: AbortSignal,
    engineDirectory: string | undefined,
  ): Promise<TranscriptStore> {
    for (let retries = 0; ; retries += 1) {
      const store = this.#options.runtime.openTranscriptStore({
        generation: claim.execution_generation,
        ...(engineDirectory === undefined ? {} : { engineDirectory }),
        objects: this.#options.objects,
        prefix: this.#transcriptPrefix(),
        ...this.#storeLimits(),
      });
      try {
        // Before the engine starts: a generation another launch already wrote
        // to would otherwise surface as the first append failing mid-turn.
        await store.ready();
        return store;
      } catch (caught) {
        if (signal.aborted || !isObjectStoreOutage(caught)) throw caught;
        const retryInMs = Math.min(
          STORE_RETRY_FIRST_MS * 2 ** retries,
          STORE_RETRY_MAX_MS,
        );
        this.#options.logger.warn("worker.checkpoint.store_unavailable", {
          reason: describe(caught),
          retries,
          retry_in_ms: retryInMs,
          execution_generation: claim.execution_generation,
        });
        await (this.#options.sleep ?? sleepUnlessAborted)(retryInMs, signal);
        signal.throwIfAborted();
      }
    }
  }

  /**
   * Restores the checkpoint the claim names, in three steps.
   *
   * What needs no disk runs first, while the workspace is untouched: the
   * gateway's plan (whose fingerprint verdict is made against this worker's
   * recomputed one, ), the manifest the claim pinned by digest — the
   * authority for everything else — checked against the claim, this runtime
   * and this workspace root, and the inherited transcript parts read and
   * parsed.
   *
   * Then the old tree is cleared, to make room on the one disk the worker
   * has, and every object the manifest names is downloaded there and held to
   * its digest: the bundle fetched and its refs checked in a repository of
   * the worker's own, the untracked files spooled.
   *
   * Only then is the checkout written, and the untracked files written
   * back without following a link the checkout brought. The signal is
   * checked between every step, and nothing that finishes late starts
   * touching files once it has fired; a restore stopped half way leaves a
   * workspace the next attempt restores again from the start.
   */
  async #restore(
    claim: BootstrapClaimResponse,
    pointer: CheckpointRef,
    {
      runtime,
      alternates,
    }: { runtime: RuntimeFingerprint; alternates: readonly string[] },
    signal: AbortSignal,
  ): Promise<RuntimeResumePlan> {
    const { objects, workspaceRoot } = this.#options;
    const answer = await this.#options.gateway.restorePlan({
      ...claimScope(claim),
      runtime: {
        cli_version: runtime.cliVersion,
        engine: runtime.engine,
        profile_sha256: runtime.profileSha256,
        sdk_version: runtime.sdkVersion,
      },
      ...(alternates.length === 0
        ? {}
        : { alternate_profile_sha256s: [...alternates] }),
    });
    signal.throwIfAborted();
    const { plan, restoring } = planFor(answer, pointer);
    // Which write of each object to read is the gateway's call: it knows
    // whether this deployment pins versions. What the bytes must be is the
    // manifest's, so a wrong answer here can only fail the restore.
    const versions = versionsOf(plan);
    const manifestBytes = await objects.get(
      restoring.manifest_ref,
      plan.manifest_version,
    );
    signal.throwIfAborted();
    if (
      manifestBytes === undefined ||
      sha256(manifestBytes) !== restoring.manifest_sha256
    ) {
      throw new RestoreRefused(
        "CHECKPOINT_UNAVAILABLE",
        `manifest ${restoring.manifest_ref} is not the one ${restoring === pointer ? "the claim" : "the fallback plan"} pinned`,
      );
    }
    const manifest = this.#codec.decode(manifestBytes);
    this.#checkManifest(
      claim,
      restoring,
      runtimeFor(manifest, runtime, alternates),
      manifest,
    );
    const pinned = <T extends ObjectRef>(ref: T): T => {
      const { version: _stale, ...rest } = ref;
      const version = versions.get(ref.key);
      return (version === undefined ? rest : { ...rest, version }) as T;
    };

    const { claudeConfigDir } = this.#options;
    const store = this.#options.runtime.openTranscriptStore({
      generation: claim.execution_generation,
      // The path only: the restore makes the directory itself, last.
      ...(claudeConfigDir === undefined
        ? {}
        : { engineDirectory: join(claudeConfigDir, "projects") }),
      inherit: {
        sessionId: manifest.resume,
        transcripts: transcriptsWith(manifest.transcripts, pinned),
      },
      objects,
      prefix: this.#transcriptPrefix(),
      ...this.#storeLimits(),
    });
    await store.ready();
    await store.verifyInherited(signal);

    // On the workspace volume, the only disk a worker has, and so only once
    // the tree it replaces is gone: the volume's quota must not have to hold
    // both. Nothing reads that tree after a restore has a plan — this one
    // replaces it, and so does any restore after one that fails from here.
    // The restore moves the spool into the new `.git`, where its staged
    // repository outlives it: later captures take the instructions commit's
    // objects from it.
    signal.throwIfAborted();
    await clearWorkspace(workspaceRoot, signal);
    signal.throwIfAborted();
    let spool = await mkdtemp(join(workspaceRoot, ".werft-restore-"));
    const spooled = new Map<string, string>();
    const bases = manifest.workspace.baseBundles ?? [];
    const artifacts = [
      { name: "workspace.bundle", ref: pinned(manifest.workspace.bundle) },
      ...bases.map((ref, index) => ({
        name: `workspace-base-${index}.bundle`,
        ref: pinned(ref),
      })),
      ...distinctRefs(manifest.workspace.untracked).map((ref, index) => {
        const name = `untracked-${index}`;
        spooled.set(ref.key, name);
        return { name, ref: pinned(ref) };
      }),
    ];
    let restored = false;
    try {
      await downloadAll(objects, artifacts, spool, signal);
      signal.throwIfAborted();
      const staged = await stageCheckpointBundle({
        bases: bases.map((_, index) =>
          join(spool, `workspace-base-${index}.bundle`),
        ),
        bundle: join(spool, "workspace.bundle"),
        gitCommit: manifest.workspace.gitCommit,
        repository: join(spool, "checkpoint.git"),
        signal,
      });
      const instructions = await stagedInstructions(
        staged,
        this.#options.instructionFiles,
        signal,
      );
      // Staged, so their disk is free before the workspace fetches a copy.
      await Promise.all(
        artifacts
          .filter(({ name }) => name.endsWith(".bundle"))
          .map(({ name }) => rm(join(spool, name), { force: true })),
      );

      signal.throwIfAborted();
      const { repository } = claim.workspace;
      const tree = await restoreCheckpointTree({
        keep: spool,
        origin:
          repository === null ? null : storableRepositoryUrl(repository.url),
        root: workspaceRoot,
        signal,
        staged,
      });
      spool = tree.kept ?? spool;
      for (const file of manifest.workspace.untracked) {
        const bytes = await readFile(
          join(spool, spooled.get(file.key) as string),
        );
        signal.throwIfAborted();
        const refusal = await writeWorkspaceFile({
          bytes,
          executable: file.executable === true,
          path: file.path,
          workspaceRoot,
        });
        if (refusal !== undefined) {
          throw new RestoreRefused("CHECKPOINT_UNAVAILABLE", refusal.reason);
        }
      }
      signal.throwIfAborted();
      // Last, on the volume the new tree is already on: the transcript was
      // verified before the old tree went, and is fetched again here part by
      // part rather than held from then.
      const projects = await this.#transcriptsDirectory();
      if (projects !== undefined) await store.materialize(projects, signal);
      signal.throwIfAborted();
      this.#bound = {
        claim,
        instructions:
          staged.instructions === null
            ? undefined
            : {
                commit: staged.instructions,
                objects: join(tree.staged.repository, "objects"),
              },
        runtime,
        store,
        committed: {
          revision: restoring.revision,
          links: [...bases, manifest.workspace.bundle],
          tips: staged.tips,
          untracked: manifest.workspace.untracked.map(pinned),
          // As the manifest names them: finalize lets the next one inherit
          // exactly that ref, and the restore plan does not carry them.
          outputs: storedOutputs(manifest.outputs),
        },
      };
      restored = true;
      this.#options.logger.info("worker.checkpoint.restored", {
        revision: restoring.revision,
        manifest_ref: restoring.manifest_ref,
        ...(plan.fallback === undefined
          ? {}
          : { fallback_from: plan.fallback.pointer_revision }),
        git_commit: manifest.workspace.gitCommit,
        untracked: manifest.workspace.untracked.length,
      });
      return {
        mode: "resume",
        resume: manifest.resume,
        ...(store.mirror === undefined ? {} : { sessionStore: store.mirror }),
        committedInstructions: () => committedInstructionsOf(instructions),
        restoredRevision: restoring.revision,
      };
    } finally {
      if (restored) {
        await Promise.all(
          artifacts.map(({ name }) => rm(join(spool, name), { force: true })),
        );
      } else {
        await rm(spool, { force: true, recursive: true });
      }
    }
  }

  /**
   * Where the engine keeps its transcripts, `<config dir>/projects`, moved
   * onto the workspace volume: HOME is a tmpfs paid for out of the worker's
   * memory, and a transcript is bounded by `MAX_TRANSCRIPT_BYTES`, not by
   * that. A link into a `workerScratch` directory, made again on every call,
   * since a restore that started over cleared the directory it pointed at.
   * Left alone when it is a directory of its own, and when the workspace has
   * no `.git` to hold one. The engine runs as this worker's user and can move
   * the link or what it points at; that only misplaces its own transcript,
   * whose copy of record is the mirror.
   */
  async #transcriptsDirectory(): Promise<string | undefined> {
    const { claudeConfigDir, workspaceRoot } = this.#options;
    if (claudeConfigDir === undefined) return undefined;
    const projects = join(claudeConfigDir, "projects");
    const found = await lstat(projects).catch(() => null);
    if (found !== null && !found.isSymbolicLink()) return projects;
    const scratch = await workerScratch(workspaceRoot, "transcripts");
    if (scratch === undefined) return found === null ? projects : undefined;
    if (found !== null) await unlink(projects);
    await mkdir(claudeConfigDir, { recursive: true, mode: 0o700 });
    await symlink(scratch, projects);
    return projects;
  }

  /**
   * The manifest the claim pinned, against everything this worker knows
   * independently of it: the claim, the runtime it would resume on, and the
   * workspace root the backend provisioned.
   */
  #checkManifest(
    claim: BootstrapClaimResponse,
    pointer: CheckpointRef,
    runtime: RuntimeFingerprint,
    manifest: CheckpointManifest,
  ): void {
    const refuse = (reason: string) =>
      new RestoreRefused("CHECKPOINT_UNAVAILABLE", reason);
    if (manifest.sessionId !== claim.session_id) {
      throw refuse(`manifest belongs to session ${manifest.sessionId}`);
    }
    if (manifest.revision !== pointer.revision) {
      throw refuse(
        `manifest is revision ${manifest.revision}, not the planned ${pointer.revision}`,
      );
    }
    const verdict = this.#codec.validateCompatibility(manifest, runtime);
    if (verdict.status === "incompatible") {
      throw new RestoreRefused(
        "INCOMPATIBLE_CHECKPOINT",
        verdict.mismatches
          .map(
            ({ expected, field, found }) =>
              `${field} ${found} where this worker runs ${expected}`,
          )
          .join("; "),
      );
    }
    const cwd = restoreCwdRefusal(manifest.cwd, this.#options.workspaceRoot);
    if (cwd !== undefined) throw refuse(cwd.reason);
    const paths = workspacePathsProblem(
      manifest.workspace.untracked.map(({ path }) => path),
    );
    if (paths !== undefined) throw refuse(`untracked files: ${paths}`);
    // Before a single part is fetched: an engine resuming a transcript this
    // size is what would take the worker down.
    const oversized = transcriptSizeProblem(
      transcriptParts(manifest.transcripts),
      this.#limits(),
    );
    if (oversized !== undefined) throw refuse(oversized.detail);
    for (const ref of [
      ...(manifest.workspace.baseBundles ?? []),
      manifest.workspace.bundle,
      ...manifest.workspace.untracked,
    ]) {
      if (!ref.key.startsWith(this.#options.objectPrefix)) {
        throw refuse(`${ref.key} is outside this session's objects`);
      }
    }
  }

  #limits(): TranscriptLimits {
    return this.#options.transcriptLimits ?? TRANSCRIPT_LIMITS;
  }

  #storeLimits(): { transcriptLimits?: TranscriptLimits } {
    const limits = this.#options.transcriptLimits;
    return limits === undefined ? {} : { transcriptLimits: limits };
  }

  #transcriptPrefix(): string {
    return `${this.#options.objectPrefix}${TRANSCRIPT_MIRROR_DIRECTORY}`;
  }

  mirror(): { persistedAt: Date | null } | undefined {
    const store = this.#bound?.store;
    return store === undefined ? undefined : { persistedAt: store.persistedAt };
  }

  async capture(
    preparation: CheckpointPreparation,
    context: CheckpointCaptureContext,
  ): Promise<CheckpointRef | null> {
    const bound = this.#bound;
    if (bound === undefined) return null;
    let stage = "request";
    let revision: number | null = null;
    let manifestRef: string | null = null;
    let lost: string | undefined;
    let limit: TranscriptLimitReached | undefined;
    let failed: string | undefined;
    const timer = new StageTimer();
    let outcome = "failed";
    let reasonCode = "internal_error";
    try {
      if (preparation.status === "rejected") {
        outcome = "refused";
        reasonCode = preparation.reason;
        await this.#report(preparation, context.scope);
        if (preparation.reason !== "mirror_error") {
          await this.#reportLostMirror(bound, context, undefined);
        }
        return null;
      }
      const limited = await this.#limitReached(
        bound,
        preparation,
        context,
      ).catch((error: unknown) => {
        if (isOwnershipLost(error)) reasonCode = "ownership_lost";
        throw error;
      });
      if (limited !== undefined) {
        outcome = "refused";
        reasonCode = limited;
        return null;
      }
      try {
        const answer = await timer.time("request", () =>
          this.#options.gateway.requestCheckpoint({
            ...context.scope,
            preparation: { status: "ready" },
          }),
        );
        if (answer.status === "blocked") {
          outcome = "blocked";
          reasonCode = answer.reason;
          this.#options.logger.warn("worker.checkpoint.blocked", {
            reason: answer.reason,
            detail: answer.detail,
          });
        } else {
          revision = answer.revision;
          manifestRef = answer.manifest_ref;
          stage = "publish";
          const published = await this.#publish(
            bound,
            preparation,
            context,
            { manifestRef: answer.manifest_ref, revision: answer.revision },
            timer,
          );
          outcome = "succeeded";
          reasonCode = "none";
          return published;
        }
      } catch (error) {
        if (isOwnershipLost(error)) {
          reasonCode = "ownership_lost";
          throw error;
        }
        const failedAt = error instanceof PublishFailure ? error.stage : stage;
        outcome = error instanceof PublishFailure ? "refused" : "failed";
        reasonCode = failedAt;
        this.#options.logger.warn("worker.checkpoint.failed", {
          stage: failedAt,
          category: error instanceof PublishFailure ? "refused" : "error",
          reason: describe(error),
          revision,
          manifest_ref: manifestRef,
          ...timer.fields(),
        });
        if (error instanceof MirrorLost) lost = error.message;
        else if (error instanceof TranscriptLimitReached) limit = error;
        else failed = `${failedAt}: ${describe(error)}`;
      }
      if (limit !== undefined) {
        await this.#report(
          { status: "rejected", reason: limit.reason, detail: limit.message },
          context.scope,
        );
      }
      const mirrorLost = await this.#reportLostMirror(bound, context, lost);
      // A ready run whose checkpoint went unwritten looks, from the session,
      // exactly like one that wrote it until something needs it. A lost mirror
      // already says more, and outranks it.
      if (failed !== undefined && !mirrorLost && limit === undefined) {
        await this.#report(
          { status: "rejected", reason: "publish_failed", detail: failed },
          context.scope,
        );
      }
      return null;
    } finally {
      this.#options.logger.info("worker.checkpoint.result", {
        message: "Checkpoint capture finished",
        operation: "checkpoint_capture",
        outcome,
        reason_code: reasonCode,
        revision,
        ...timer.resultFields(),
      });
    }
  }

  /**
   * Sizes the transcript before anything is requested or uploaded: one past
   * the limits is reported under its reason and the publish never starts,
   * so a session past them does not pay for a workspace bundle every turn.
   * One past the warning threshold is only logged; finalize warns the
   * session once it commits. Answers the reason when it stopped the publish.
   */
  async #limitReached(
    bound: Bound,
    preparation: ReadyCheckpoint,
    context: CheckpointCaptureContext,
  ): Promise<TranscriptSizeProblem["reason"] | undefined> {
    let sizes: Array<{ bytes: number; key: string }> | null;
    try {
      sizes = await bound.store.transcriptSizes(preparation.checkpoint.resume);
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      // The capture reads the same parts and reports what fails there.
      return undefined;
    }
    if (sizes === null) return undefined;
    const limits = this.#limits();
    const problem = transcriptSizeProblem(sizes, limits);
    if (problem === undefined) {
      const bytes = transcriptBytes(sizes);
      if (bytes >= transcriptWarnBytes(limits)) {
        this.#options.logger.warn("worker.checkpoint.transcript_near_limit", {
          transcript_bytes: bytes,
          limit_bytes: limits.totalBytes,
        });
      }
      return undefined;
    }
    this.#options.logger.warn("worker.checkpoint.transcript_limit", {
      reason: problem.reason,
      detail: problem.detail,
    });
    await this.#report(
      { status: "rejected", reason: problem.reason, detail: problem.detail },
      context.scope,
    );
    await this.#reportLostMirror(bound, context, undefined);
    return problem.reason;
  }

  async parkBlocked(resume: string): Promise<string | undefined> {
    const bound = this.#bound;
    if (bound === undefined) return "No transcript mirror is bound";
    let sizes: Array<{ bytes: number; key: string }> | null;
    try {
      sizes = await bound.store.transcriptSizes(resume);
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      return `The transcript could not be measured: ${describe(error)}`;
    }
    if (sizes === null) return undefined;
    return transcriptSizeProblem(sizes, this.#limits())?.detail;
  }

  async finalizeRefused(detail: string, scope: WorkerScope): Promise<void> {
    if (this.#bound !== undefined) this.#bound.published = undefined;
    await this.#report(
      {
        status: "rejected",
        reason: "publish_failed",
        detail: `finalize: ${detail}`,
      },
      scope,
    );
  }

  /**
   * Whatever left the turn without a checkpoint — a refusal, a blocked
   * request, a failed publish — a mirror that lost a batch is recorded
   * before the turn can be finalized without one. Answers whether it was.
   */
  async #reportLostMirror(
    bound: Bound,
    context: CheckpointCaptureContext,
    known: string | undefined,
  ): Promise<boolean> {
    let lost = known ?? (bound.store.unsettled ? UNSETTLED : undefined);
    if (lost === undefined) {
      // The run's verdict as of now: a batch the SDK gave up on after the
      // one this capture started from, which a later append may have left
      // the store settled on.
      const now = await context.recheck();
      if (now.status === "rejected" && now.reason === "mirror_error") {
        lost = now.detail;
      }
    }
    if (lost === undefined) return false;
    await this.#report(
      { status: "rejected", reason: "mirror_error", detail: lost },
      context.scope,
    );
    return true;
  }

  /**
   * Sends a refusal to the gateway, which records the ones that outlive the
   * turn as the session's pending reason. An advisory one that does not land
   * is only logged. A mirror error that does not land throws, and so does a
   * transcript limit, which would otherwise let new turns in: finalize
   * without a checkpoint is accepted only while no blocking reason is
   * recorded, so the turn must stay open rather than be reported complete
   * ahead of the heartbeat that would have recorded it.
   */
  async #report(
    preparation: RejectedCheckpoint,
    scope: WorkerScope,
  ): Promise<void> {
    try {
      await this.#options.gateway.requestCheckpoint({
        ...scope,
        preparation: {
          status: "rejected",
          reason: preparation.reason,
          detail: preparation.detail,
        },
      });
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      if (preparation.reason === "mirror_error") {
        throw new Error(
          `The transcript mirror failed and the gateway did not record it: ${describe(error)}`,
        );
      }
      // It holds new turns back too, so it has to land as well.
      if (isTranscriptLimit(preparation.reason)) {
        throw new Error(
          `The transcript is past its limits and the gateway did not record it: ${describe(error)}`,
        );
      }
      this.#options.logger.warn("worker.checkpoint.report_failed", {
        reason: describe(error),
      });
    }
  }

  /**
   * The previous checkpoint a capture for `revision` may build on, which
   * finalize holds the new one to, and only while every bundle of it is still
   * in the store. The server hands out the revision after the pointer, so one
   * that follows what this run published last shows that one committed; one
   * that does not, that it was not.
   */
  async #checkpointBefore(
    bound: Bound,
    revision: number,
  ): Promise<PublishedCheckpoint | undefined> {
    if (bound.published?.revision === revision - 1) {
      bound.committed = bound.published;
    }
    bound.published = undefined;
    const chain = bound.committed;
    if (
      chain === undefined ||
      chain.revision !== revision - 1 ||
      // A bundle builds on at most one fewer; at the limit it stands alone.
      chain.links.length >= MAX_WORKSPACE_BUNDLE_CHAIN
    ) {
      return undefined;
    }
    const present = await Promise.all(
      chain.links.map(async (link) => {
        try {
          const head = await this.#options.objects.head(link.key, link.version);
          return head?.bytes === link.bytes;
        } catch {
          return false;
        }
      }),
    );
    return present.every(Boolean) ? chain : undefined;
  }

  async #publish(
    bound: Bound,
    preparation: ReadyCheckpoint,
    context: CheckpointCaptureContext,
    request: { manifestRef: string; revision: number },
    timer: StageTimer,
  ): Promise<CheckpointRef> {
    const { objects } = this.#options;
    const { manifestRef } = request;
    if (
      !manifestRef.startsWith(this.#options.objectPrefix) ||
      !manifestRef.endsWith("/manifest.json")
    ) {
      throw new PublishFailure(
        "request",
        `the gateway handed a manifest key outside this session: ${manifestRef}`,
      );
    }
    const directory = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
    // The version each upload answered, which the manifest names.
    const versions = new Map<string, string>();
    const upload = async (
      key: string,
      body: Uint8Array | ImmutableObjectSource,
    ) => {
      timer.startedPut();
      const result = await objects.putImmutable(key, body, {
        contentAddressed: true,
      });
      timer.finishedPut(body, result.outcome);
      // Content-addressed keys under this publish's own directory: another
      // body there is corruption, not a race anyone could have won.
      if (result.outcome === "conflict") {
        throw new PublishFailure("upload", `${key} already holds other bytes`);
      }
      if (result.version !== undefined) versions.set(key, result.version);
    };
    const versioned = <T extends ObjectRef>(ref: T): T => {
      const version = versions.get(ref.key);
      return version === undefined ? ref : { ...ref, version };
    };

    const spool = await workerScratch(this.#options.workspaceRoot, "publish");
    if (spool === undefined) {
      throw new PublishFailure(
        "workspace",
        "the workspace .git is not a directory",
      );
    }
    // The lease is held and the engine stopped: the one moment the session's
    // own commits may be remade before this capture pins the tip.
    const repaired = await repairAttribution({
      root: this.#options.workspaceRoot,
      home: this.#options.home ?? "",
      tool: this.#options.repairTool,
      gateway: this.#options.gateway,
      scope: context.scope,
      spool,
      ...(bound.judgedTip === undefined ? {} : { judged: [bound.judgedTip] }),
      logger: this.#options.logger,
    });
    if ("head" in repaired && repaired.head !== undefined) {
      bound.judgedTip = repaired.head;
    }
    if (repaired.status !== "clean") {
      this.#options.logger.info("worker.attribution_repair", {
        status: repaired.status,
        ...("reason" in repaired ? { reason: repaired.reason } : {}),
      });
    }
    const previous = await timer.time("chain", () =>
      this.#checkpointBefore(bound, request.revision),
    );
    const maxBundleBytes = (
      this.#options.limits ?? DEFAULT_WORKSPACE_CAPTURE_LIMITS
    ).maxBundleBytes;
    let captured: WorkspaceCaptureResult;
    let bundle: ObjectRef;
    try {
      const workspaceCapture =
        this.#options.captureWorkspace ?? captureWorkspace;
      captured = await timer.time("git", () =>
        workspaceCapture({
          root: this.#options.workspaceRoot,
          bundlePath: join(spool, "workspace.bundle"),
          signal: new AbortController().signal,
          ...(this.#options.limits === undefined
            ? {}
            : { limits: this.#options.limits }),
          ...(bound.instructions === undefined
            ? {}
            : { instructions: bound.instructions }),
          ...(bound.claim.workspace.repository === null
            ? { markNewFiles: true }
            : {}),
          keepBranches: true,
          ...(previous === undefined
            ? {}
            : {
                base: {
                  maxBytes:
                    maxBundleBytes -
                    previous.links.reduce(
                      (total, link) => total + link.bytes,
                      0,
                    ),
                  tips: previous.tips,
                },
              }),
        }),
      );
      if (captured.status === "refused") {
        throw new PublishFailure("workspace", captured.reason);
      }
      const { bytes, path, sha256: digest } = captured.capture.bundle;
      bundle = {
        bytes,
        key: `${directory}workspace-${digest}.bundle`,
        sha256: digest,
      };
      await timer.time("bundle_upload", () =>
        upload(bundle.key, {
          bytes,
          sha256: digest,
          open: () => createReadStream(path),
        }),
      );
    } finally {
      await rm(spool, { force: true, recursive: true });
    }
    const { capture } = captured;
    // A snapshot of uncommitted tracked files is the platform's own commit:
    // it is not judged, it is named so request_push can say what to do. The
    // commits under it are judged once the agent commits and the turn's
    // repair has run.
    const mismatches =
      capture.gitCommit === capture.headCommit
        ? await workspaceMismatches({
            root: this.#options.workspaceRoot,
            tip: capture.gitCommit,
            expectations: claimExpectations(bound.claim),
            stripEmails: bound.claim.git_strip ?? [],
            protectedCommits:
              repaired.status === "skipped" ? null : repaired.protectedCommits,
          })
        : [workingTreeSnapshotMismatch(capture.gitCommit)];
    const bases = capture.bundle.incremental ? (previous?.links ?? []) : [];
    timer.reused(bases.length);

    const previousUntracked = new Map(
      previous?.untracked.map((file) => [file.path, file]),
    );
    const distinct = new Map<string, Uint8Array>();
    let unchanged = 0;
    const untracked: WorkspaceArtifact[] = capture.untracked.map((file) => {
      const digest = sha256(file.bytes);
      const earlier = previousUntracked.get(file.path);
      const same =
        earlier !== undefined &&
        earlier.bytes === file.bytes.byteLength &&
        earlier.sha256 === digest &&
        earlier.executable === (file.executable ? true : undefined);
      if (same) unchanged += 1;
      if (same && earlier.version !== undefined) {
        timer.reused(1);
        return earlier;
      }
      const ref: WorkspaceArtifact = {
        ...refOf(`${directory}untracked/${digest}`, file.bytes),
        ...(file.executable ? { executable: true } : {}),
        path: file.path,
      };
      distinct.set(ref.key, file.bytes);
      return ref;
    });
    await timer.time("untracked_upload", () =>
      inBatches([...distinct], UPLOAD_CONCURRENCY, ([key, bytes]) =>
        upload(key, bytes),
      ),
    );

    // Inherited by digest from the checkpoint this one builds on, whatever
    // its bundle chain did, since finalize vouches for that pointer's refs.
    const parent =
      bound.committed?.revision === request.revision - 1
        ? bound.committed
        : undefined;
    const earlierOutputs = new Map(
      parent?.outputs
        .filter((ref) => ref.version !== undefined)
        .map((ref) => [ref.sha256, ref]),
    );
    const uploadedOutputs = new Map<string, ObjectRef>();
    let outputsInherited = 0;
    // A workspace without out/ publishes and logs exactly what it did before.
    const hasOutputs = await lstat(
      join(this.#options.workspaceRoot, OUTPUT_DIRECTORY),
    ).then(
      () => true,
      () => false,
    );
    const indexed: OutputIndex = !hasOutputs
      ? { dropped: 0, outputs: [] }
      : await timer.time("outputs", () =>
          indexOutputs({
            workspaceRoot: this.#options.workspaceRoot,
            ...(this.#options.outputLimits === undefined
              ? {}
              : { limits: this.#options.outputLimits }),
            store: async ({ bytes, path }) => {
              const digest = sha256(bytes);
              const earlier = earlierOutputs.get(digest);
              if (earlier !== undefined && earlier.bytes === bytes.byteLength) {
                outputsInherited += 1;
                timer.reused(1);
                const { path: _path, ...ref } = earlier;
                return { ...ref, path };
              }
              let ref = uploadedOutputs.get(digest);
              if (ref === undefined) {
                ref = refOf(`${directory}outputs/${digest}`, bytes);
                await upload(ref.key, bytes);
                ref = versioned(ref);
                uploadedOutputs.set(digest, ref);
              }
              return { ...ref, path };
            },
          }),
        );

    const transcripts = await timer.time("transcript", () =>
      bound.store
        .captureTranscripts(preparation.checkpoint.resume)
        .catch((error: unknown) => {
          throw error instanceof TranscriptTooLargeError
            ? new TranscriptLimitReached({
                reason: error.reason,
                detail: error.message,
              })
            : error;
        }),
    );
    if (transcripts === null) {
      throw new PublishFailure(
        "transcript",
        `engine session ${preparation.checkpoint.resume} has no mirrored root transcript`,
      );
    }
    // Pinned, but only worth committing if nothing was lost on the way: a
    // batch whose append failed is one the SDK may still retry or give up
    // on, and a mirror error the engine raised since the verdict means the
    // pinned parts are missing entries nobody can name.
    if (bound.store.unsettled) {
      throw new MirrorLost(UNSETTLED);
    }
    const now = await timer.time("recheck", () => context.recheck());
    if (now.status === "rejected" && now.reason === "mirror_error") {
      throw new MirrorLost(now.detail);
    }

    const oversized = transcriptSizeProblem(
      transcriptParts(transcripts),
      this.#limits(),
    );
    if (oversized !== undefined) throw new TranscriptLimitReached(oversized);
    // Finalize refuses a manifest over either limit only after everything it
    // names was uploaded, so it is refused here first.
    const restoring =
      1 +
      bases.length +
      untracked.length +
      transcripts.root.parts.length +
      Object.values(transcripts.subagents).reduce(
        (total, revision) => total + revision.parts.length,
        0,
      );
    // Outputs get only the objects restoring leaves; the ones past that were
    // uploaded but are dropped, not the checkpoint. Indexing after the
    // transcripts would put the uploads between their capture and the
    // checks above.
    let room = DEFAULT_MAX_MANIFEST_OBJECTS - restoring;
    let outputsDropped = indexed.dropped;
    const listed = indexed.outputs.filter((output) => {
      if ("omitted" in output) return true;
      if (room > 0) {
        room -= 1;
        return true;
      }
      outputsDropped += 1;
      return false;
    });
    const referenced = restoring + storedOutputs(listed).length;
    if (referenced > DEFAULT_MAX_MANIFEST_OBJECTS) {
      throw new PublishFailure(
        "manifest",
        `the manifest would name ${referenced} objects, over the ${DEFAULT_MAX_MANIFEST_OBJECTS} the control plane reads`,
      );
    }
    const createdAt = (this.#options.now?.() ?? new Date()).toISOString();
    const manifestOf = (
      outputs: readonly CheckpointOutput[],
    ): CheckpointManifest => ({
      ...(mismatches.length === 0 ? {} : { attribution: { mismatches } }),
      createdAt,
      cwd: this.#options.workspaceRoot,
      engine: preparation.checkpoint.engine,
      ...(outputs.length === 0 ? {} : { outputs }),
      resume: preparation.checkpoint.resume,
      revision: request.revision,
      runtime: bound.runtime,
      sessionId: bound.claim.session_id,
      transcripts,
      version: 2,
      ...(context.workerState === undefined
        ? {}
        : { workerState: context.workerState }),
      workspace: {
        ...(bases.length === 0 ? {} : { baseBundles: bases }),
        bundle: versioned(bundle),
        gitCommit: capture.gitCommit,
        ...(capture.sources.length === 0
          ? {}
          : { sources: capture.sources.map((s) => ({ ...s })) }),
        untracked: untracked.map(versioned),
      },
    });
    let manifest = manifestOf(listed);
    let encoded = this.#codec.encode(manifest);
    let outputsRefused = indexed.refused;
    // The index does not restore anything, so an index too long to read
    // leaves the checkpoint without it rather than fail it.
    if (
      encoded.bytes.byteLength > DEFAULT_MAX_MANIFEST_BYTES &&
      manifest.outputs !== undefined
    ) {
      outputsRefused = `listing ${manifest.outputs.length} outputs takes the manifest to ${encoded.bytes.byteLength} bytes, over the ${DEFAULT_MAX_MANIFEST_BYTES} the control plane reads`;
      manifest = manifestOf([]);
      encoded = this.#codec.encode(manifest);
    }
    const outputs = manifest.outputs ?? [];
    timer.manifest(encoded.bytes.byteLength);
    if (encoded.bytes.byteLength > DEFAULT_MAX_MANIFEST_BYTES) {
      throw new PublishFailure(
        "manifest",
        `the manifest is ${encoded.bytes.byteLength} bytes, over the ${DEFAULT_MAX_MANIFEST_BYTES} the control plane reads`,
      );
    }
    const stored = await timer.time("manifest", async () => {
      timer.startedPut();
      const result = await objects.putImmutable(manifestRef, encoded.bytes);
      timer.finishedPut(encoded.bytes, result.outcome);
      return result;
    });
    if (stored.outcome === "conflict") {
      throw new PublishFailure(
        "manifest",
        `${manifestRef} already holds another manifest`,
      );
    }
    bound.published = {
      revision: request.revision,
      links: [...bases, manifest.workspace.bundle],
      tips: [
        ...(bases.length === 0 ? [] : (previous?.tips ?? [])),
        ...capture.bundle.tips,
      ],
      untracked: manifest.workspace.untracked,
      outputs: storedOutputs(outputs),
    };
    this.#options.logger.info("worker.checkpoint.published", {
      revision: request.revision,
      manifest_ref: manifestRef,
      git_commit: capture.gitCommit,
      untracked: untracked.length,
      untracked_bytes: capture.untracked.reduce(
        (total, file) => total + file.bytes.byteLength,
        0,
      ),
      untracked_changed: untracked.length - unchanged,
      untracked_unchanged: unchanged,
      untracked_uploads: distinct.size,
      ...(hasOutputs
        ? {
            outputs: outputs.length,
            outputs_too_large: outputs.length - storedOutputs(outputs).length,
            outputs_dropped: outputsDropped,
            outputs_inherited: outputsInherited,
            outputs_uploads: uploadedOutputs.size,
            ...(outputsRefused === undefined
              ? {}
              : { outputs_refused: outputsRefused }),
          }
        : {}),
      manifest_bytes: encoded.bytes.byteLength,
      bundle_bytes: bundle.bytes,
      base_bundles: bases.length,
      ...timer.fields(),
    });
    return {
      revision: request.revision,
      manifest_ref: manifestRef,
      manifest_sha256: encoded.sha256,
      ...(stored.version === undefined
        ? {}
        : { manifest_version: stored.version }),
    };
  }
}

/**
 * How long each stage of one capture took, for its log line: a
 * capture that runs long says which stage it spent the time in. A stage
 * that failed is timed up to its failure; one never reached is absent.
 */
class StageTimer {
  readonly #started = performance.now();
  readonly #stages: Record<string, number> = {};
  #conflictCount = 0;
  #manifestBytes = 0;
  #putCount = 0;
  #reusedCount = 0;
  #uploadedBytes = 0;

  async time<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.#stages[stage] = Math.round(performance.now() - started);
    }
  }

  fields(): { durations_ms: Record<string, number>; total_ms: number } {
    return {
      durations_ms: { ...this.#stages },
      total_ms: Math.round(performance.now() - this.#started),
    };
  }

  startedPut(): void {
    this.#putCount += 1;
  }

  finishedPut(
    body: Uint8Array | ImmutableObjectSource,
    outcome: "created" | "duplicate" | "conflict",
  ): void {
    if (outcome === "created") {
      this.#uploadedBytes +=
        body instanceof Uint8Array ? body.byteLength : body.bytes;
    } else if (outcome === "duplicate") {
      this.#reusedCount += 1;
    } else {
      this.#conflictCount += 1;
    }
  }

  reused(count: number): void {
    this.#reusedCount += count;
  }

  manifest(bytes: number): void {
    this.#manifestBytes = bytes;
  }

  resultFields(): {
    conflict_count: number;
    duration_ms: number;
    durations_ms: Record<string, number>;
    manifest_bytes: number;
    put_count: number;
    reused_count: number;
    uploaded_bytes: number;
  } {
    const { durations_ms, total_ms } = this.fields();
    return {
      conflict_count: this.#conflictCount,
      duration_ms: total_ms,
      durations_ms,
      manifest_bytes: this.#manifestBytes,
      put_count: this.#putCount,
      reused_count: this.#reusedCount,
      uploaded_bytes: this.#uploadedBytes,
    };
  }
}

/** The fenced identity a claim runs under, before any turn. */
function claimScope(claim: BootstrapClaimResponse): WorkerScope {
  return {
    session_id: claim.session_id,
    turn_id: null,
    attempt_id: claim.attempt_id,
    lease_epoch: claim.lease_epoch,
    execution_generation: claim.execution_generation,
    auth_revision: claim.auth_revision,
  };
}

/**
 * The gateway's plan for the claim's checkpoint, or a refusal, with the
 * checkpoint it restores. A plan for another revision or manifest means the
 * pointer moved after the claim, and the claim is what this worker restores
 * — unless the plan says it falls back from the claim's own pointer, which
 * was damaged, to an earlier revision. That one is pinned by the
 * digest the plan carries, since the claim only knows the pointer's.
 */
function planFor(
  answer: Awaited<ReturnType<WorkerGatewayClient["restorePlan"]>>,
  pointer: CheckpointRef,
): { plan: RestorePlanWire; restoring: CheckpointRef } {
  switch (answer.status) {
    case "none":
      throw new RestoreRefused(
        "CHECKPOINT_UNAVAILABLE",
        `the claim names revision ${pointer.revision} and the gateway has no checkpoint`,
      );
    case "unavailable":
      throw new RestoreRefused(answer.code, answer.reason);
    case "incompatible":
      throw new RestoreRefused(
        answer.code,
        answer.mismatches
          .map(
            ({ expected, field, found }) =>
              `${field} ${found} where this worker runs ${expected}`,
          )
          .join("; "),
      );
    case "ready":
      break;
  }
  const { plan } = answer;
  if (plan.fallback !== undefined) {
    if (
      plan.fallback.pointer_revision !== pointer.revision ||
      plan.revision >= pointer.revision
    ) {
      throw new RestoreRefused(
        "CHECKPOINT_UNAVAILABLE",
        `the gateway falls back from revision ${plan.fallback.pointer_revision} to ${plan.revision}, not from the claim's ${pointer.revision} to an earlier one`,
      );
    }
    return {
      plan,
      restoring: {
        revision: plan.revision,
        manifest_ref: plan.manifest_ref,
        manifest_sha256: plan.manifest_sha256,
        ...(plan.manifest_version === undefined
          ? {}
          : { manifest_version: plan.manifest_version }),
      },
    };
  }
  if (
    plan.revision !== pointer.revision ||
    plan.manifest_ref !== pointer.manifest_ref
  ) {
    throw new RestoreRefused(
      "CHECKPOINT_UNAVAILABLE",
      `the gateway planned revision ${plan.revision} (${plan.manifest_ref}), not the claim's ${pointer.revision} (${pointer.manifest_ref})`,
    );
  }
  return { plan, restoring: pointer };
}

function versionsOf(plan: RestorePlanWire): Map<string, string> {
  const versions = new Map<string, string>();
  for (const artifact of plan.artifacts) {
    for (const object of artifact.objects) {
      if (object.version !== undefined)
        versions.set(object.key, object.version);
    }
  }
  return versions;
}

function transcriptsWith(
  transcripts: CheckpointTranscripts,
  pinned: (ref: ObjectRef) => ObjectRef,
): CheckpointTranscripts {
  const revision = (value: TranscriptRevision): TranscriptRevision => ({
    ...value,
    parts: value.parts.map(pinned),
  });
  return {
    root: revision(transcripts.root),
    subagents: Object.fromEntries(
      Object.entries(transcripts.subagents).map(([subpath, value]) => [
        subpath,
        revision(value),
      ]),
    ),
  };
}

/**
 * Streams `ref` into a new file at `path`, held to the manifest's size and
 * digest as it arrives: a body longer than pinned stops at the first byte
 * past it.
 */
async function download(
  objects: CheckpointObjectStore,
  ref: ObjectRef,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const damaged = () =>
    new RestoreRefused(
      "CHECKPOINT_UNAVAILABLE",
      `${ref.key} is missing or not the bytes the manifest pinned`,
    );
  const body = await objects.stream(ref.key, ref.version);
  if (body === undefined) throw damaged();
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    Readable.from(
      (async function* () {
        for await (const chunk of body) {
          bytes += chunk.byteLength;
          if (bytes > ref.bytes) throw damaged();
          hash.update(chunk);
          // Copied: the store may refill the chunk before the file takes it.
          yield Buffer.from(chunk);
        }
      })(),
    ),
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  if (bytes !== ref.bytes || hash.digest("hex") !== ref.sha256) {
    throw damaged();
  }
}

/**
 * The object store failing to answer, or the gateway failing to plan for the
 * same reason (it reads the checkpoint's objects too, and answers a
 * retryable error then). Everything else fails the claim as before.
 */
function isRestoreOutage(error: unknown): boolean {
  return (
    (error instanceof WorkerGatewayRequestError && error.retryable) ||
    isObjectStoreOutage(error)
  );
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Every artifact into `spool`, `DOWNLOAD_CONCURRENCY` at a time. The first
 * failure stops the rest and they are waited out before it is thrown, so a
 * restore redone after it never shares the volume with this one's streams.
 */
async function downloadAll(
  objects: CheckpointObjectStore,
  artifacts: readonly { name: string; ref: ObjectRef }[],
  spool: string,
  signal: AbortSignal,
): Promise<void> {
  const round = new AbortController();
  const stop = () => round.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  let failure: { error: unknown } | undefined;
  try {
    for (
      let start = 0;
      start < artifacts.length;
      start += DOWNLOAD_CONCURRENCY
    ) {
      await Promise.allSettled(
        artifacts
          .slice(start, start + DOWNLOAD_CONCURRENCY)
          .map(({ name, ref }) =>
            download(objects, ref, join(spool, name), round.signal).catch(
              (error: unknown) => {
                failure ??= { error };
                round.abort(error);
              },
            ),
          ),
      );
      if (failure !== undefined) throw failure.error;
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** One download per stored object, however many paths share its bytes. */
function distinctRefs(untracked: readonly WorkspaceArtifact[]): ObjectRef[] {
  const byKey = new Map<string, ObjectRef>();
  for (const file of untracked) byKey.set(file.key, file);
  return [...byKey.values()];
}

function refOf(key: string, bytes: Uint8Array): ObjectRef {
  return { bytes: bytes.byteLength, key, sha256: sha256(bytes) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inBatches<T>(
  items: readonly T[],
  size: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(task));
  }
}
