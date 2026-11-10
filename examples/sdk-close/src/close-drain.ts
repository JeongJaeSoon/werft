import {
  answerPending,
  CLOSE_BLOCKED,
  type CloseBlockedAttention,
  type CloseParams,
  type CloseReceiptResult,
  closeBlocked,
  closeResult,
  isApiError,
  isClosing,
  SESSION_ADMISSION_CLOSING,
  SESSION_CLOSING,
  type Session,
  type SessionId,
  Werft,
  waitForReceipt,
} from "@werft-ai/sdk";

const client = new Werft();
const signal = AbortSignal.timeout(5 * 60_000);
const agent_release_id = process.env.WERFT_AGENT_RELEASE_ID;
if (!agent_release_id) {
  throw new Error("set WERFT_AGENT_RELEASE_ID to the agent release to run");
}
const QUESTION = "Ship the release notes now?";

const ask = {
  id: "close1",
  steps: [
    {
      tool: "AskUserQuestion",
      input: {
        questions: [
          {
            question: QUESTION,
            header: "Release",
            multiSelect: false,
            options: [
              { label: "yes", description: "publish" },
              { label: "no", description: "keep the draft" },
            ],
          },
        ],
      },
    },
  ],
  final: "answered",
};

let sessionId: SessionId | undefined;

async function until(
  id: SessionId,
  done: (session: Session) => boolean,
): Promise<Session> {
  for (;;) {
    const session = await client.sessions.get(id, { signal });
    if (done(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    signal.throwIfAborted();
  }
}

async function run(): Promise<void> {
  // Turn 1 asks a question and waits on it; turn 2 queues behind it.
  const created = await client.sessions.create(
    { agent_release_id, message: `GATE-SPEC ${JSON.stringify(ask)}` },
    { signal },
  );
  sessionId = created.session_id;
  console.log(`session ${sessionId}: created`);
  const queued = await client.sessions.messages.send(
    sessionId,
    { message: "a message the close will cancel" },
    { signal },
  );
  await until(sessionId, (s) => s.status === "needs_input");
  console.log(
    `turn ${created.turn_id}: waiting on a question, turn ${queued.turn_id} queued`,
  );

  // close drains: the turn that waits on the question has to end first.
  const params: CloseParams = {
    expected_revision: (await client.sessions.get(sessionId, { signal }))
      .revision,
    reason: "close sample",
  };
  const accepted = await client.sessions.close(sessionId, params, { signal });
  const closing = await client.sessions.get(sessionId, { signal });
  console.log(
    `close: receipt ${accepted.receipt_status}, admission ${closing.admission_state} (closing: ${isClosing(closing)})`,
  );
  if (closing.admission_state !== SESSION_ADMISSION_CLOSING)
    throw new Error("the session is not closing");

  const refused = await client.sessions.messages
    .send(sessionId, { message: "too late" }, { signal })
    .catch((error: unknown) => error);
  if (!isApiError(refused, SESSION_CLOSING)) throw refused;
  console.log(`message while closing: ${refused.status} ${refused.code}`);

  // After 60 seconds of drain the session says why it is still open.
  console.log("waiting for the drain to report itself blocked…");
  const stuck = await until(sessionId, (s) => closeBlocked(s) !== null);
  const attention = closeBlocked(stuck) as CloseBlockedAttention;
  console.log(
    `attention: ${attention.code === CLOSE_BLOCKED ? CLOSE_BLOCKED : attention.code}`,
    attention,
  );

  // Nothing is killed for it: answering the question lets the turn end.
  const outcomes = await answerPending(
    client,
    sessionId,
    {
      question(request) {
        const [question] = request.questions;
        const no = question?.options.find((o) => o.label === "no");
        if (question?.prompt !== QUESTION || !no) return undefined;
        console.log(
          `question ${request.request_id}: "${question.prompt}" -> no`,
        );
        return {
          answers: [
            {
              question_id: question.question_id,
              selected_option_ids: [no.option_id],
            },
          ],
        };
      },
    },
    { signal },
  );
  for (const outcome of outcomes)
    console.log(`answer ${outcome.request_id}: ${outcome.outcome}`);

  const receipt = await waitForReceipt(client, accepted.receipt_id, { signal });
  const result: CloseReceiptResult | null = closeResult(receipt);
  console.log(`close: receipt ${receipt.status}`, result);
  if (!result) throw new Error("close did not succeed");

  const closed = await client.sessions.get(sessionId, { signal });
  const cancelled = await client.sessions.turns.get(sessionId, queued.turn_id, {
    signal,
  });
  console.log(
    `session: admission ${closed.admission_state}, status ${closed.status}, attention ${closed.attention?.code ?? "none"}; turn ${queued.turn_id} ${cancelled.status}`,
  );
  if (closed.admission_state !== "closed")
    throw new Error("session is not closed");
}

try {
  await run();
} catch (error) {
  if (isApiError(error))
    console.error(error.code, error.message, "request_id:", error.requestId);
  else console.error(error instanceof Error ? error.message : "Sample failed");
  if (sessionId)
    console.error(
      `session ${sessionId} is left as it is; check it in the console`,
    );
  process.exitCode = 1;
}
