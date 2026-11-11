import { bash, scripted } from "../../e2e/client.ts";
import type { EngineFixture, ModelCall } from "../engine.ts";

const MESSAGES_URL = "E2E_MESSAGES_URL";

/** claude_agent_sdk against the compose fake Messages API. */
export function claudeEngine(env = process.env): EngineFixture {
  const messagesUrl = env[MESSAGES_URL];
  if (!messagesUrl) throw new Error(`${MESSAGES_URL} is unset`);
  return {
    runtimeKind: "claude_agent_sdk",
    connectionId: "fake-messages",
    repositoryId: "sample-app",
    // A write through `tee` asks; a read-only command and a redirect into the
    // workspace do not.
    approvalCommand: "echo conformance | tee approved.txt",
    prompt: (script) =>
      scripted(
        script.id,
        script.commands.map(bash),
        script.final,
        script.finalDelayMs,
      ),
    async modelCalls(id) {
      const response = await fetch(
        `${messagesUrl}/requests?spec=${encodeURIComponent(id)}`,
      );
      return (await response.json()) as ModelCall[];
    },
  };
}
