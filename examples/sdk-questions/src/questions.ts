import {
  type AnswerOutcome,
  answerPending,
  isApiError,
  type PendingRequest,
  type PendingRequestHandlers,
  type SessionId,
  type WaitForTurnOptions,
  Werft,
  waitForReceipt,
  waitForTurn,
} from "@werft-ai/sdk";

const client = new Werft();
const signal = AbortSignal.timeout(5 * 60_000);
// `general` runs without a repository: the session starts in an empty directory.
const agent_release_id = process.env.WERFT_AGENT_RELEASE_ID;
if (!agent_release_id) {
  throw new Error("set WERFT_AGENT_RELEASE_ID to the agent release to run");
}

const QUESTION = "Which environment should the report cover?";
const CHOICE = "staging";
const FILE = "notes.txt";
// The worker resolves the path in its workspace before asking.
const ALLOWED_PATH = `/workspace/${FILE}`;

const script = (id: string, steps: unknown[], final: string) =>
  `GATE-SPEC ${JSON.stringify({ id, steps, final })}`;
const ask = {
  tool: "AskUserQuestion",
  input: {
    questions: [
      {
        question: QUESTION,
        header: "Environment",
        multiSelect: false,
        options: [
          { label: "staging", description: "safe to read" },
          { label: "production", description: "live data" },
        ],
      },
    ],
  },
};
const write = {
  tool: "Write",
  input: { file_path: FILE, content: "draft report\n" },
};

const filePath = (request: { input: unknown }) =>
  (request.input as { file_path?: unknown } | null)?.file_path;

// Handlers are a security boundary: answer only what this script expects.
const answerQuestion: NonNullable<PendingRequestHandlers["question"]> = (
  request,
) => {
  const [question] = request.questions;
  const option = question?.options.find((o) => o.label === CHOICE);
  if (
    request.questions.length !== 1 ||
    question?.prompt !== QUESTION ||
    !option
  )
    return undefined; // left open for a person in the console or Slack
  console.log(
    `question ${request.request_id}: "${question.prompt}" -> ${CHOICE}`,
  );
  return {
    answers: [
      {
        question_id: question.question_id,
        selected_option_ids: [option.option_id],
      },
    ],
  };
};

const logOutcome = (outcome: AnswerOutcome) =>
  console.log(`answer ${outcome.request_id}: ${outcome.outcome}`);

async function openRequests(sessionId: SessionId): Promise<PendingRequest[]> {
  for (;;) {
    const requests = await client.sessions.requests.list(sessionId, { signal });
    if (requests.length > 0) return requests;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    signal.throwIfAborted();
  }
}

async function run(): Promise<void> {
  // 1. A question, answered by its handler while waitForTurn polls.
  const created = await client.sessions.create(
    { agent_release_id, message: script("qa1", [ask], "staging it is") },
    { signal },
  );
  const sessionId = created.session_id;
  console.log(`session ${sessionId}: created on ${agent_release_id}`);
  const waitOptions: WaitForTurnOptions = {
    signal,
    onRequest: { question: answerQuestion },
    onAnswer: logOutcome,
  };
  const first = await waitForTurn(
    client,
    sessionId,
    created.turn_id,
    waitOptions,
  );
  console.log(`turn ${first.turn_id}: ${first.status}`);

  // 2. A permission the handler denies; the reason goes back to the model.
  const denied = await client.sessions.messages.send(
    sessionId,
    { message: script("qa2", [write], "left the file alone") },
    { signal },
  );
  const second = await waitForTurn(client, sessionId, denied.turn_id, {
    signal,
    onRequest: {
      permission(request) {
        console.log(
          `permission ${request.request_id}: deny ${request.tool} ${filePath(request)}`,
        );
        return {
          action: "deny",
          reason: "This run only reads; do not write files",
        };
      },
    },
    onAnswer: logOutcome,
  });
  console.log(`turn ${second.turn_id}: ${second.status}`);

  // 3. No handler: the request stays open until someone answers it. Here the
  // script lists it, then answers once with answerPending.
  const pending = await client.sessions.messages.send(
    sessionId,
    { message: script("qa3", [write], "wrote the notes") },
    { signal },
  );
  const [open] = await openRequests(sessionId);
  if (!open) throw new Error("no open request");
  console.log(
    `open request ${open.request_id}: ${open.kind}${open.kind === "permission" ? ` ${open.tool} ${filePath(open)}` : ""}, expires ${open.expires_at}`,
  );
  const outcomes = await answerPending(
    client,
    sessionId,
    {
      permission(request) {
        const allow =
          request.tool === "Write" && filePath(request) === ALLOWED_PATH;
        console.log(
          `permission ${request.request_id}: ${allow ? "allow" : "deny"} ${request.tool} ${filePath(request)}`,
        );
        return allow
          ? { action: "allow" }
          : {
              action: "deny",
              reason: `This script only allows writing ${ALLOWED_PATH}`,
            };
      },
    },
    { signal },
  );
  outcomes.forEach(logOutcome);
  const accepted = outcomes.find((o) => o.outcome === "accepted");
  if (!accepted || accepted.outcome !== "accepted")
    throw new Error("the open request was not answered");
  const receipt = await waitForReceipt(client, accepted.receipt.receipt_id, {
    signal,
  });
  console.log(`answer receipt: ${receipt.operation} ${receipt.status}`);

  // One request has one answer: the default key is answer:<request_id>, so a
  // different answer for the same request is refused.
  const changed = await client.sessions.requests
    .answer(
      sessionId,
      {
        request_id: open.request_id,
        kind: "permission",
        action: "deny",
        reason: "changed my mind",
      },
      { signal },
    )
    .catch((error: unknown) => error);
  if (!isApiError(changed, "IDEMPOTENCY_CONFLICT"))
    throw new Error("a second, different answer was not refused as a conflict");
  console.log(`second answer: ${changed.status} ${changed.code}`);

  const third = await waitForTurn(client, sessionId, pending.turn_id, {
    signal,
  });
  console.log(`turn ${third.turn_id}: ${third.status}`);
  const left = await answerPending(client, sessionId, {}, { signal });
  console.log(`still open: ${left.length}`);
  if ([first, second, third].some((turn) => turn.status !== "completed"))
    throw new Error("a turn did not complete");

  const { revision } = await client.sessions.get(sessionId, { signal });
  const close = await client.sessions.close(
    sessionId,
    { expected_revision: revision, reason: "questions sample finished" },
    { signal },
  );
  const closed = await waitForReceipt(client, close.receipt_id, { signal });
  console.log(`close: receipt ${closed.status}`);
  if (closed.status !== "succeeded") throw new Error("close did not succeed");
}

try {
  await run();
} catch (error) {
  if (isApiError(error))
    console.error(error.code, error.message, "request_id:", error.requestId);
  else console.error(error instanceof Error ? error.message : "Sample failed");
  process.exitCode = 1;
}
