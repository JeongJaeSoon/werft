// Starts one conversation turn on the conversation runtime and prints how it
// ended. Run inside the API's container, whose operator socket it reaches:
//
//   bun run apps/control-host/src/api/conversation-turn.ts \
//     --workspace <id> --agent <id> --conversation <id> --topic <id> \
//     --text <text>
//
// The conversation is one of the agent's and the topic one of its topics.
// The turn's one provider call is charged to the agent's team as an
// operator's call, and the API's log names the user and host that ran this.
// Until people's messages dispatch turns, this is the only way one starts.
import { hostname, userInfo } from "node:os";
import { parseArgs } from "node:util";
import {
  conversationRuntimeConfigFromEnv,
  DEFAULT_CONVERSATION_TURN_SOCKET,
  type OperatorTurnResult,
  operatorTurnRequestSchema,
} from "./conversation-runtime.ts";

/** Part of the CLI contract: the verify skill branches on these. */
export const CONVERSATION_TURN_EXIT = {
  completed: 0,
  unexpected: 1,
  usage: 2,
  /** The turn was not started, or ended without an answer. */
  failed: 3,
  /** The conversation runtime is off for this API, or the API is not running here. */
  off: 4,
} as const;

const USAGE =
  "usage: conversation-turn.ts --workspace <id> --agent <id> --conversation <id> --topic <id> --text <text>";

export async function main(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  out: { log(line: string): void; error(line: string): void } = console,
): Promise<number> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        workspace: { type: "string" },
        agent: { type: "string" },
        conversation: { type: "string" },
        topic: { type: "string" },
        text: { type: "string" },
      },
      strict: true,
    }));
  } catch {
    out.error(USAGE);
    return CONVERSATION_TURN_EXIT.usage;
  }
  const request = operatorTurnRequestSchema.safeParse({
    workspace_id: values.workspace,
    agent_id: values.agent,
    conversation_id: values.conversation,
    topic_id: values.topic,
    text: values.text,
    operator: { user: operatorUser(), host: hostname() },
  });
  if (!request.success) {
    out.error(USAGE);
    return CONVERSATION_TURN_EXIT.usage;
  }
  // Said here rather than as a socket error: the API opens the socket only
  // when the runtime's bearer is set.
  if (conversationRuntimeConfigFromEnv(env) === null) {
    out.error(
      "The conversation runtime is off for this API: CONVERSATION_RUNTIME_TOKEN is not set",
    );
    return CONVERSATION_TURN_EXIT.off;
  }
  let response: Response;
  try {
    response = await fetch("http://conversation-turns/", {
      unix: env.CONVERSATION_TURN_SOCKET || DEFAULT_CONVERSATION_TURN_SOCKET,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.data),
    } as RequestInit);
  } catch {
    out.error(
      "The API's operator socket does not answer: run this inside the running API's container",
    );
    return CONVERSATION_TURN_EXIT.off;
  }
  const result = (await response.json().catch(() => null)) as
    | OperatorTurnResult
    | { outcome: "error" }
    | null;
  if (result === null || result.outcome === "error") {
    out.error("The API could not run the turn; its log has the reason");
    return CONVERSATION_TURN_EXIT.unexpected;
  }
  out.log(JSON.stringify(result));
  return result.outcome === "ended" && result.turn.outcome === "completed"
    ? CONVERSATION_TURN_EXIT.completed
    : CONVERSATION_TURN_EXIT.failed;
}

/** The OS user running the command; a uid with no account is named by number. */
function operatorUser(): string {
  try {
    return userInfo().username;
  } catch {
    return `uid:${process.getuid?.() ?? "unknown"}`;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
