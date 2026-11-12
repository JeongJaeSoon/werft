import { bash, scripted } from "../../e2e/client.ts";
import {
  type Capability,
  type EngineFixture,
  type ModelCall,
  PUSH_TOOL,
} from "../engine.ts";

const MESSAGES_URL = "E2E_MESSAGES_URL";

/** claude_agent_sdk against the compose fake Messages API. */
export function claudeEngine(env = process.env): EngineFixture {
  const messagesUrl = env[MESSAGES_URL];
  if (!messagesUrl) throw new Error(`${MESSAGES_URL} is unset`);
  return {
    runtimeKind: "claude_agent_sdk",
    connectionId: "fake-messages",
    cardModel: "claude-sonnet-5",
    repositoryId: "sample-app",
    // The Claude engine enforces its budget inside the SDK, and the fake
    // Messages API reports no scripted usage.
    capabilities: new Set<Capability>(),
    // A write through `tee` asks; a read-only command and a redirect into the
    // workspace do not.
    approvalCommand: "echo conformance | tee approved.txt",
    prompt: (script) =>
      scripted(
        script.id,
        [
          ...script.commands.map(bash),
          ...(script.pushTool ? [{ tool: PUSH_TOOL, input: {} }] : []),
        ],
        script.final,
        script.finalDelayMs,
      ),
    // The SDK defers MCP tools behind its tool search once there are many:
    // the model then sees the push tool when a search result references it.
    async pushToolShown(id) {
      return (await this.modelCalls(id)).some(
        (call) =>
          call.tools.includes(PUSH_TOOL) ||
          (call.found ?? []).includes(PUSH_TOOL),
      );
    },
    async modelCalls(id) {
      const response = await fetch(
        `${messagesUrl}/requests?spec=${encodeURIComponent(id)}`,
      );
      return (await response.json()) as ModelCall[];
    },
  };
}
