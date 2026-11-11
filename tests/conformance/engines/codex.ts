import {
  type Capability,
  type EngineFixture,
  type ModelCall,
  PUSH_TOOL,
} from "../engine.ts";

const RESPONSES_URL = "E2E_RESPONSES_URL";

/** codex_app_server against the compose fake Responses API. */
export function codexEngine(env = process.env): EngineFixture {
  const responsesUrl = env[RESPONSES_URL];
  if (!responsesUrl) throw new Error(`${RESPONSES_URL} is unset`);
  return {
    runtimeKind: "codex_app_server",
    cardModel: "gpt-5.5",
    profileId: "codex-coding-local",
    repositoryId: "sample-app",
    // The gateway and egress proxy enforce the session's cost limit on the
    // provider calls the fake Responses API reports usage for.
    capabilities: new Set<Capability>(["provider_budget"]),
    approvalCommand: "echo conformance | tee approved.txt",
    prompt: (script) =>
      `GATE-SPEC ${JSON.stringify({
        id: script.id,
        steps: [
          ...script.commands.map((cmd) => ({
            tool: "exec_command",
            input: { cmd },
          })),
          ...(script.pushTool
            ? [
                { tool: "tool_search", input: { query: "request_push" } },
                { tool: PUSH_TOOL, input: {} },
              ]
            : []),
        ],
        final: script.final,
        ...(script.usage === undefined ? {} : { usage: script.usage }),
        ...(script.finalDelayMs === undefined
          ? {}
          : { finalDelayMs: script.finalDelayMs }),
      })}`,
    // The engine defers MCP tools behind its `tool_search`: the model sees the
    // push tool when a search answer names it.
    async pushToolShown(id) {
      const shown = "mcp__github/request_push";
      return (await this.modelCalls(id)).some(
        (call) =>
          call.tools.includes(shown) ||
          (call.outputs ?? []).some((names) =>
            names.split(",").includes(shown),
          ),
      );
    },
    async modelCalls(id) {
      const response = await fetch(
        `${responsesUrl}/calls?spec=${encodeURIComponent(id)}`,
      );
      return (await response.json()) as ModelCall[];
    },
  };
}
