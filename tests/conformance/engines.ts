import type { EngineFixture } from "./engine.ts";
import { claudeEngine } from "./engines/claude.ts";
import { codexEngine } from "./engines/codex.ts";

/**
 * The one place that names the engines: the implementation for the stack
 * tests/e2e/run.sh --conformance started, read from the variable it sets.
 */
export function engineFromEnv(env = process.env): EngineFixture {
  const kind = env.CONFORMANCE_RUNTIME_KIND;
  switch (kind) {
    case "claude_agent_sdk":
      return claudeEngine(env);
    case "codex_app_server":
      return codexEngine(env);
    default:
      throw new Error(
        `CONFORMANCE_RUNTIME_KIND is ${kind === undefined ? "unset" : `"${kind}"`}: run tests/e2e/run.sh --conformance <runtime_kind>`,
      );
  }
}
