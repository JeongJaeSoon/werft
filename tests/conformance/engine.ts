import { test } from "bun:test";
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
  /**
   * Tokens each scripted reply reports. Only an engine whose fake provider
   * reports scripted usage (`provider_budget`) plays it.
   */
  usage?: { input_tokens: number; output_tokens: number };
};

/**
 * What an engine can be asked to do beyond the flow every engine shares. A
 * scenario that needs one runs through `scenario`, so an engine without it
 * is skipped by name, with the reason in the report, never passed empty.
 */
export type Capability = "provider_budget";

/** Why an engine without the capability is skipped; it goes into the report. */
const SKIP_REASON: Record<Capability, string> = {
  provider_budget:
    "the engine SDK enforces the budget itself, so this scenario is for engines only the egress proxy enforces",
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
  readonly capabilities: ReadonlySet<Capability>;
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

/**
 * A scenario that needs `capability`. Without it the test is registered as
 * skipped under a name that says so; tests/e2e/run.sh accepts only skips
 * named this way.
 */
export function scenario(
  engine: EngineFixture,
  capability: Capability,
  name: string,
  run: () => Promise<void>,
  timeoutMs: number,
): void {
  if (engine.capabilities.has(capability)) {
    test(name, run, timeoutMs);
  } else {
    test.skip(
      `${name} [declared skip: ${engine.runtimeKind} lacks ${capability}, ${SKIP_REASON[capability]}]`,
      run,
    );
  }
}

/** A script id no other test of the run reuses, so provider logs never mix. */
export function scriptId(name: string): string {
  return `${name}-${crypto.randomUUID().slice(0, 8)}`;
}
