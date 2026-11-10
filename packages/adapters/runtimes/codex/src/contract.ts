import { mkdirSync } from "node:fs";
import {
  CODEX_CLI_VERSION,
  CODEX_DESCRIPTOR,
  CODEX_RUNTIME_FINGERPRINT,
  codexCheckpointCodec,
} from "@werft-ai/runtime-codex-codec";
import {
  type AgentRun,
  type AgentRuntime,
  type ImageRuntime,
  type RuntimeHostDeps,
  RuntimeMismatch,
  type RuntimeModule,
  type RuntimeStart,
} from "@werft-ai/runtime-core";

import { codexExecutable } from "./binary.ts";
import { codexLaunch, codexProfileDigest } from "./config.ts";
import { spawnAppServer } from "./process.ts";
import { CodexRolloutStore } from "./rollout-store.ts";
import { CodexRun, heldInputsFrom } from "./run.ts";

/** Bumped when what the digest covers changes; a checkpoint is stamped with it. */
export const CODEX_PROFILE_DIGEST_SCHEME = 1;

export class CodexAgentRuntime implements AgentRuntime {
  readonly descriptor = CODEX_DESCRIPTOR;

  constructor(private readonly deps: RuntimeHostDeps) {}

  start(start: RuntimeStart): AgentRun {
    const launch = codexLaunch(start, this.deps);
    mkdirSync(launch.home, { recursive: true, mode: 0o700 });
    const process = spawnAppServer({
      command: codexExecutable(),
      args: launch.args,
      cwd: start.config.cwd,
      env: launch.env,
      observer: this.deps.processObserver,
    });
    return new CodexRun({
      transport: process.transport,
      launch,
      cwd: start.config.cwd,
      model: start.config.model,
      ...(start.config.mode === "resume"
        ? { resume: start.config.resume }
        : {}),
      precheckTool: this.deps.precheckTool,
      heldInputs: heldInputsFrom(launch.home),
      descendants: process.descendants,
      kill: process.kill,
      startupProblem: process.startupProblem,
    });
  }
}

export const codexRuntimeModule: RuntimeModule = {
  descriptor: CODEX_DESCRIPTOR,
  checkpointCodec: codexCheckpointCodec,
  assertCompatible(runtime) {
    if (runtime.version !== CODEX_CLI_VERSION) {
      throw new RuntimeMismatch(
        `Session needs runtime version ${runtime.version}; this worker ships Codex ${CODEX_CLI_VERSION}`,
      );
    }
  },
  fingerprint: (profile, scheme) => {
    if (scheme !== undefined && scheme !== CODEX_PROFILE_DIGEST_SCHEME) {
      throw new Error(`Codex has no profile digest scheme ${scheme}`);
    }
    return {
      ...CODEX_RUNTIME_FINGERPRINT,
      profileSha256: codexProfileDigest(profile),
    };
  },
  createRuntime: (deps) => new CodexAgentRuntime(deps),
  imageFingerprint: () =>
    JSON.stringify({
      ...CODEX_RUNTIME_FINGERPRINT,
      profileDigestScheme: CODEX_PROFILE_DIGEST_SCHEME,
      restorableSchemes: [CODEX_PROFILE_DIGEST_SCHEME],
    } satisfies ImageRuntime),
  openTranscriptStore: (options) => new CodexRolloutStore(options),
};
