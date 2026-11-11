import type { Capability, EngineFixture, ModelCall } from "../engine.ts";

const RESPONSES_URL = "E2E_RESPONSES_URL";

/** codex_app_server against the compose fake Responses API. */
export function codexEngine(env = process.env): EngineFixture {
  const responsesUrl = env[RESPONSES_URL];
  if (!responsesUrl) throw new Error(`${RESPONSES_URL} is unset`);
  return {
    runtimeKind: "codex_app_server",
    connectionId: "fake-responses",
    repositoryId: "sample-app",
    // The gateway and egress proxy enforce the session's cost limit on the
    // provider calls the fake Responses API reports usage for.
    capabilities: new Set<Capability>(["provider_budget"]),
    approvalCommand: "echo conformance | tee approved.txt",
    prompt: (script) =>
      `GATE-SPEC ${JSON.stringify({
        id: script.id,
        steps: script.commands.map((cmd) => ({
          tool: "exec_command",
          input: { cmd },
        })),
        final: script.final,
        ...(script.usage === undefined ? {} : { usage: script.usage }),
        ...(script.finalDelayMs === undefined
          ? {}
          : { finalDelayMs: script.finalDelayMs }),
      })}`,
    async modelCalls(id) {
      const response = await fetch(
        `${responsesUrl}/calls?spec=${encodeURIComponent(id)}`,
      );
      return (await response.json()) as ModelCall[];
    },
  };
}
