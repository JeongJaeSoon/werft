import type { SessionRuntime } from "@werft-ai/contracts";

import type { AgentRuntime, RuntimeStart } from "./agent-runtime.ts";
import type {
  CheckpointCodec,
  RuntimeFingerprint,
} from "./checkpoint-manifest.ts";
import type { RuntimeDescriptor, RuntimeKind } from "./descriptor.ts";
import type { EventCodec } from "./event-codec.ts";
import type {
  TranscriptStore,
  TranscriptStoreOptions,
} from "./transcript-store.ts";

/** What fixes how a stored transcript replays: a start short of how it resumes. */
export type RuntimeProfileInput = {
  config: Omit<
    RuntimeStart["config"],
    | "correlationId"
    | "disallowedTools"
    | "engineSettings"
    | "gitEnvironment"
    | "localTranscriptResume"
    | "maxBudgetUsd"
    | "mode"
    | "resume"
  >;
  bindings: Omit<RuntimeStart["bindings"], "transcript">;
  bundle: RuntimeStart["bundle"];
};

export type RuntimeProcessObserver = {
  onExit?(
    pid: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void;
  onSpawn(pid: number): void;
};

/** What the host lends every runtime it creates. */
export type RuntimeHostDeps = {
  processObserver?: RuntimeProcessObserver;
  /** Where the engine keeps its own state on this container. */
  stateDir: string;
  /** How often a failed provider request is retried; unset leaves the engine's own policy. */
  providerMaxRetries?: number;
  /** How long an approval waits for its tool call to reach the event stream. */
  toolCallWaitMs?: number;
  /**
   * Judged before every tool call, in every permission mode: a string refuses
   * the call, and the model reads it as the reason. For advice the host can
   * give at once from where the engine runs; it is never a security gate.
   */
  precheckTool?: ToolPrecheck;
};

export type ToolPrecheck = (
  tool: string,
  input: Record<string, unknown>,
) => Promise<string | null>;

export interface RuntimeModule {
  readonly descriptor: RuntimeDescriptor;
  readonly checkpointCodec: CheckpointCodec;
  /**
   * Reads the events this adapter's mapper writes, for a reader inside the
   * worker that needs the engine-neutral fields before the control plane adds
   * them.
   */
  readonly eventCodec?: EventCodec;
  /** Throws `RuntimeMismatch` for a session made for another build. */
  assertCompatible(runtime: SessionRuntime): void;
  /**
   * The fingerprint a checkpoint of this profile is stamped with. With a
   * `scheme`, the digest an image of that earlier scheme stamped instead
   * (one of `imageFingerprint()`'s `restorableSchemes`), for the candidates
   * of a restore.
   */
  fingerprint(
    profile: RuntimeProfileInput,
    scheme?: number,
  ): RuntimeFingerprint;
  createRuntime(deps: RuntimeHostDeps): AgentRuntime;
  imageFingerprint(): string;
  /** Where this engine's transcripts are mirrored to and restored from. */
  openTranscriptStore(options: TranscriptStoreOptions): TranscriptStore;
}

export class UnsupportedRuntime extends Error {
  override readonly name = "UnsupportedRuntime";
}

export class RuntimeMismatch extends Error {
  override readonly name = "RuntimeMismatch";
}

export class RuntimeRegistry {
  private readonly modules = new Map<RuntimeKind, RuntimeModule>();

  constructor(modules: readonly RuntimeModule[]) {
    for (const module of modules) {
      const kind = module.descriptor.kind;
      if (this.modules.has(kind)) {
        throw new Error(`Runtime ${kind} is installed twice`);
      }
      this.modules.set(kind, module);
    }
  }

  require(kind: RuntimeKind): RuntimeModule {
    const module = this.modules.get(kind);
    if (module === undefined) {
      throw new UnsupportedRuntime(
        `This worker runs ${[...this.modules.keys()].join(", ")}, not ${kind}`,
      );
    }
    return module;
  }

  descriptors(): readonly RuntimeDescriptor[] {
    return [...this.modules.values()].map((module) => module.descriptor);
  }
}
