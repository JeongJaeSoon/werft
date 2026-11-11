import {
  type EventStream,
  isApiError,
  type SessionEvent,
  type SessionId,
  type StreamOptions,
  Werft,
  waitForReceipt,
  waitForTurn,
} from "@werft-ai/sdk";

const client = new Werft();
const signal = AbortSignal.timeout(5 * 60_000);
const agent_release_id = process.env.WERFT_AGENT_RELEASE_ID ?? "";
if (!agent_release_id) {
  throw new Error("set WERFT_AGENT_RELEASE_ID to the agent release to run");
}
const target = { agent_release_id };

const script = (id: string, final: string) =>
  `GATE-SPEC ${JSON.stringify({ id, steps: [], final })}`;

function log(stream: string, event: SessionEvent): void {
  const text =
    event.kind === "assistant"
      ? (event.payload as { text?: unknown }).text
      : undefined;
  console.log(
    `  ${stream} ${event.kind}${event.turn_id ? ` (turn ${event.turn_id})` : ""}${typeof text === "string" ? `: ${text}` : ""}`,
  );
}

/**
 * Reads until the `result` event of `turnId`. A result event is not the
 * durable end of a turn, so the caller checks the turn afterwards.
 */
async function readUntilResult(
  name: string,
  stream: EventStream,
  turnId: string,
  seen: Set<string>,
): Promise<number> {
  let count = 0;
  for await (const event of stream) {
    if (seen.has(event.id)) throw new Error(`${name} repeated ${event.id}`);
    seen.add(event.id);
    count++;
    log(name, event);
    // close() ends the loop at its next step, as `break` would.
    if (event.kind === "result" && event.turn_id === turnId) stream.close();
  }
  return count;
}

async function run(): Promise<void> {
  const created = await client.sessions.create(
    { ...target, message: script("ev1", "first turn") },
    { signal },
  );
  const sessionId: SessionId = created.session_id;
  console.log(`session ${sessionId}: created, turn ${created.turn_id}`);
  const seen = new Set<string>();

  // Without lastEventId the stream replays the session from its start.
  const first = client.sessions.events.stream(sessionId, { signal });
  const firstCount = await readUntilResult(
    "stream 1",
    first,
    created.turn_id,
    seen,
  );
  const atResult = await client.sessions.turns.get(sessionId, created.turn_id, {
    signal,
  });
  const turn1 = await waitForTurn(client, sessionId, created.turn_id, {
    signal,
  });
  console.log(
    `stream 1: ${firstCount} events; turn 1 was ${atResult.status} at its result event, then ${turn1.status}`,
  );
  const cursor = first.lastEventId;
  if (!cursor) throw new Error("stream 1 delivered no event");
  // A process would store the cursor here and resume from it later.

  const sent = await client.sessions.messages.send(
    sessionId,
    { message: script("ev2", "second turn") },
    { signal },
  );
  const resume: StreamOptions = { lastEventId: cursor, signal };
  const second = client.sessions.events.stream(sessionId, resume);
  const secondCount = await readUntilResult(
    "stream 2",
    second,
    sent.turn_id,
    seen,
  );
  console.log(
    `stream 2: ${secondCount} events after the saved cursor, none repeated`,
  );
  const turn2 = await waitForTurn(client, sessionId, sent.turn_id, { signal });
  console.log(`turn ${turn2.turn_id}: ${turn2.status}`);
  if (turn1.status !== "completed" || turn2.status !== "completed")
    throw new Error("a turn did not complete");

  // A stream never ends by itself; its signal ends it without an error.
  const quiet = client.sessions.events.stream(sessionId, {
    lastEventId: second.lastEventId ?? cursor,
    signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
  });
  let late = 0;
  for await (const event of quiet) {
    if (seen.has(event.id)) throw new Error(`stream 3 repeated ${event.id}`);
    late++;
  }
  console.log(`stream 3: ended by its signal after ${late} new events`);

  const page = await client.sessions.turns.list(
    sessionId,
    { limit: 1 },
    { signal },
  );
  const next = await page.nextPage();
  if (!next || (await next.nextPage()))
    throw new Error("expected exactly two pages of one turn");
  console.log(
    `turns page 1: turn ${page.items[0]?.turn_id}, page 2: turn ${next.items[0]?.turn_id}, then null`,
  );
  const statuses: string[] = [];
  for await (const turn of client.sessions.turns.list(sessionId, undefined, {
    signal,
  }))
    statuses.push(`${turn.turn_id}:${turn.status}`);
  console.log(`all turns: ${statuses.join(", ")}`);

  // A stream the server refuses throws instead of retrying.
  const unknown = client.sessions.events.stream(crypto.randomUUID(), {
    signal,
  });
  try {
    for await (const _ of unknown) break;
    throw new Error("an unknown session streamed");
  } catch (error) {
    if (!isApiError(error)) throw error;
    console.log(`stream of an unknown session: ${error.status} ${error.code}`);
  }

  const { revision } = await client.sessions.get(sessionId, { signal });
  const accepted = await client.sessions.close(
    sessionId,
    { expected_revision: revision, reason: "events sample finished" },
    { signal },
  );
  const receipt = await waitForReceipt(client, accepted.receipt_id, { signal });
  console.log(`close: receipt ${receipt.status}`);
  if (receipt.status !== "succeeded") throw new Error("close did not succeed");
}

try {
  await run();
} catch (error) {
  if (isApiError(error))
    console.error(error.code, error.message, "request_id:", error.requestId);
  else console.error(error instanceof Error ? error.message : "Sample failed");
  process.exitCode = 1;
}
