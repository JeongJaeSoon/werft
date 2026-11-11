import {
  closeResult,
  isApiError,
  type PendingRequestHandlers,
  type SessionEvent,
  type SessionId,
  Werft,
  waitForReceipt,
  waitForTurn,
} from "@werft-ai/sdk";

const client = new Werft();
const approver = process.env.WERFT_APPROVER_API_KEY
  ? client.withOptions({ apiKey: process.env.WERFT_APPROVER_API_KEY })
  : client;
const signal = AbortSignal.timeout(5 * 60_000);
const agent_release_id = process.env.WERFT_AGENT_RELEASE_ID ?? "";
if (!agent_release_id) {
  throw new Error("set WERFT_AGENT_RELEASE_ID to the agent release to run");
}
const target = { agent_release_id };

// `tee` rather than a redirect: a write under the workspace by redirect is
// pre-approved by the platform and would never reach this handler.
const COMMAND = "echo alpha | tee hello.txt";
// A handler is a security boundary: allow the exact command, deny the rest.
const approvals: PendingRequestHandlers = {
  permission(request) {
    const command = (request.input as { command?: unknown } | null)?.command;
    if (request.tool === "Bash" && command === COMMAND) {
      console.log(
        `permission ${request.request_id}: allow ${request.tool} "${command}"`,
      );
      return { action: "allow" };
    }
    return { action: "deny", reason: `This script only allows: ${COMMAND}` };
  },
};

function logEvent(event: SessionEvent): void {
  console.log(
    `  event ${event.kind}${event.turn_id ? ` (turn ${event.turn_id})` : ""}`,
  );
  if (event.kind === "assistant") {
    const text = (event.payload as { text?: unknown }).text;
    if (typeof text === "string") console.log(text);
  }
}

async function run(): Promise<void> {
  const created = await client.sessions.create(
    {
      ...target,
      message:
        'GATE-SPEC {"id":"sdk1","steps":[],"final":"hello from the SDK"}',
    },
    { signal },
  );
  const sessionId: SessionId = created.session_id;
  console.log(
    `session ${sessionId}: created, turn ${created.turn_id} ${created.status}`,
  );

  let lastEventId: string | undefined;
  const first = await waitForTurn(client, sessionId, created.turn_id, {
    signal,
    events: {
      onEvent(event) {
        lastEventId = event.id;
        logEvent(event);
      },
    },
  });
  console.log(`turn ${first.turn_id}: ${first.status}`);
  if (first.status !== "completed")
    throw new Error(`turn ${first.turn_id} did not complete`);
  console.log("result:", first.result);

  const sent = await client.sessions.messages.send(
    sessionId,
    {
      message: `GATE-SPEC ${JSON.stringify({
        id: "sdk2",
        steps: [
          {
            tool: "Bash",
            input: { command: COMMAND, description: "write hello.txt" },
          },
        ],
        final: "wrote hello.txt",
      })}`,
    },
    { signal },
  );
  const second = await waitForTurn(approver, sessionId, sent.turn_id, {
    signal,
    onRequest: approvals,
    onAnswer: (outcome) =>
      console.log(`answer ${outcome.request_id}: ${outcome.outcome}`),
    events: {
      ...(lastEventId ? { lastEventId } : {}),
      onEvent: logEvent,
    },
  });
  console.log(`turn ${second.turn_id}: ${second.status}`);
  if (second.status !== "completed")
    throw new Error(`turn ${second.turn_id} did not complete`);
  console.log("result:", second.result);

  const { revision } = await client.sessions.get(sessionId, { signal });
  const accepted = await client.sessions.close(
    sessionId,
    { expected_revision: revision, reason: "script finished" },
    { signal },
  );
  console.log(`close: receipt ${accepted.receipt_status}`);
  const receipt = await waitForReceipt(client, accepted.receipt_id, { signal });
  console.log(`close: receipt ${receipt.status}`, closeResult(receipt));
  if (receipt.status !== "succeeded") throw new Error("close did not succeed");

  const closed = await client.sessions.get(sessionId, { signal });
  console.log(
    `session ${sessionId}: admission ${closed.admission_state}, status ${closed.status}`,
  );
  if (closed.admission_state !== "closed")
    throw new Error("session is not closed");

  const refused = await client.sessions.messages
    .send(sessionId, { message: "one more" }, { signal })
    .catch((error: unknown) => error);
  console.log(
    "message after close:",
    isApiError(refused) ? `${refused.status} ${refused.code}` : refused,
  );
  if (!isApiError(refused, "SESSION_CLOSED"))
    throw new Error("message after close was not refused");
}

try {
  await run();
} catch (error) {
  if (isApiError(error))
    console.error(error.code, error.message, "request_id:", error.requestId);
  else console.error(error instanceof Error ? error.message : "Sample failed");
  process.exitCode = 1;
}
