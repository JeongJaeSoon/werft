import { poll } from "../e2e/client.ts";

/**
 * What a scenario needs from an engine, owned by the suite: the scenarios
 * depend on this interface and never name an engine. Each engine implements
 * it in engines/, and engines.ts, the one place that names them, picks the
 * implementation for the stack under test.
 */

export type RuntimeKind = "claude_agent_sdk" | "codex_app_server";

/**
 * What the model does in one turn, engine-neutral: runs each command in
 * order, then says `final`.
 */
export type Script = {
  commands: readonly string[];
  final: string;
  finalDelayMs?: number;
  id: string;
};

/** One call the fake provider answered for a script. */
export type ModelCall = {
  /** Ids of the scripts the call's history replays, oldest first. */
  history: string[];
  /** The command step the call reached; `commands.length` is the final text. */
  step: number | null;
};

export interface EngineFixture {
  /** A command the engine asks permission for before it runs. */
  readonly approvalCommand: string;
  /** The connection the suite's agent is released on. */
  readonly connectionId: string;
  readonly repositoryId: string;
  readonly runtimeKind: RuntimeKind;
  /** Calls the engine's fake provider recorded for the script `id`. */
  modelCalls(id: string): Promise<ModelCall[]>;
  /** The prompt that makes the engine's fake provider play `script`. */
  prompt(script: Script): string;
}

/** Waits until the provider has received the call for `step` of script `id`. */
export async function modelCallSeen(
  engine: EngineFixture,
  id: string,
  step: number,
): Promise<void> {
  await poll(`model call ${id}#${step}`, 180_000, async () =>
    (await engine.modelCalls(id)).some((call) => call.step === step)
      ? true
      : null,
  );
}

/** A script id no other test of the run reuses, so provider logs never mix. */
export function scriptId(name: string): string {
  return `${name}-${crypto.randomUUID().slice(0, 8)}`;
}
