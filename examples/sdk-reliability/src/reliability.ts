import { createServer } from "node:net";
import {
  AbortedError,
  type ClientErrorCode,
  ConnectionError,
  isApiError,
  type MutationOptions,
  type RequestOptions,
  TimeoutError,
  Werft,
  WerftError,
  waitForReceipt,
  waitForTurn,
} from "@werft-ai/sdk";

const client = new Werft({
  defaultHeaders: { "x-werft-sample": "sdk-reliability" },
});
const signal = AbortSignal.timeout(5 * 60_000);
const agent_release_id = process.env.WERFT_AGENT_RELEASE_ID ?? "";
if (!agent_release_id) {
  throw new Error("set WERFT_AGENT_RELEASE_ID to the agent release to run");
}

const script = (id: string, final: string) =>
  `GATE-SPEC ${JSON.stringify({ id, steps: [], final })}`;

function expectError<T extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => T,
): T {
  if (error instanceof type) return error;
  throw error instanceof Error ? error : new Error(String(error));
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function run(): Promise<void> {
  // 1. One Idempotency-Key, one session: a repeat replays the first answer.
  const key = crypto.randomUUID();
  const keyed: MutationOptions = { idempotencyKey: key, signal };
  const body = { agent_release_id, message: script("rel1", "once") };
  const created = await client.sessions.create(body, keyed);
  const again = await client.sessions.create(body, keyed);
  console.log(
    `create twice with one key: ${created.session_id === again.session_id ? "same session" : "two sessions"} ${created.session_id}`,
  );
  if (created.session_id !== again.session_id)
    throw new Error("the repeat made a second session");
  const sessionId = created.session_id;

  const conflict = await client.sessions
    .create({ ...body, message: script("rel1b", "other") }, keyed)
    .catch((error: unknown) => error);
  if (!isApiError(conflict, "IDEMPOTENCY_CONFLICT")) throw conflict;
  console.log(
    `same key, other body: ${conflict.status} ${conflict.code}, retryable ${conflict.retryable}, request id ${conflict.requestId ? "present" : "missing"}, error key ${conflict.idempotencyKey === key ? "is ours" : "differs"}`,
  );

  const first = await waitForTurn(client, sessionId, created.turn_id, {
    signal,
  });
  console.log(`turn ${first.turn_id}: ${first.status}`);

  // 2. The server answers but the response is lost on the way back. The SDK
  // retries with the same key and the server replays: one turn, not two.
  const keys: (string | null)[] = [];
  const lossy = client.withOptions({
    fetch: async (request) => {
      const message =
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/messages");
      if (message) keys.push(request.headers.get("idempotency-key"));
      const response = await fetch(request);
      if (message && keys.length === 1) {
        await response.body?.cancel();
        throw new TypeError("connection reset after the server answered");
      }
      return response;
    },
  });
  const sent = await lossy.sessions.messages.send(
    sessionId,
    { message: script("rel2", "sent once") },
    { signal },
  );
  console.log(
    `lost response: ${keys.length} attempts, ${new Set(keys).size} key, turn ${sent.turn_id}`,
  );
  if (keys.length !== 2 || keys[0] !== keys[1])
    throw new Error("the retry did not reuse the key");
  const second = await waitForTurn(client, sessionId, sent.turn_id, { signal });
  console.log(`turn ${second.turn_id}: ${second.status}`);

  // 3. A timeout on a keyed command carries its key. Sending again with that
  // key is safe whether or not the first attempt reached the server.
  const slow = client.withOptions({
    timeoutMs: 200,
    maxRetries: 0,
    fetch: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return fetch(request);
    },
  });
  const message = { message: script("rel3", "after a timeout") };
  const timeout = expectError(
    await slow.sessions.messages
      .send(sessionId, message, { signal })
      .catch((error: unknown) => error),
    TimeoutError,
  );
  const code: ClientErrorCode = "TIMEOUT";
  console.log(
    `timeout: ${timeout.name} ${timeout.code === code ? code : timeout.code}, attempts ${timeout.attempts}, key ${timeout.idempotencyKey ? "kept" : "missing"}`,
  );
  const saved = timeout.idempotencyKey;
  if (!saved) throw new Error("a keyed command's error had no key");
  const resent = await client.sessions.messages.send(sessionId, message, {
    idempotencyKey: saved,
    signal,
  });
  const replayed = await client.sessions.messages.send(sessionId, message, {
    idempotencyKey: saved,
    signal,
  });
  console.log(
    `resent with the saved key: turn ${resent.turn_id}, again: turn ${replayed.turn_id}`,
  );
  if (resent.turn_id !== replayed.turn_id)
    throw new Error("the saved key made two turns");
  const third = await waitForTurn(client, sessionId, resent.turn_id, {
    signal,
  });
  console.log(`turn ${third.turn_id}: ${third.status}`);

  const turns: string[] = [];
  for await (const turn of client.sessions.turns.list(sessionId, undefined, {
    signal,
  }))
    turns.push(turn.turn_id);
  console.log(`turns: ${turns.join(", ")}`);
  if (turns.length !== 3) throw new Error(`expected 3 turns, got ${turns}`);

  // 4. Nothing listens: no response was read, so the command may or may not
  // have run. Reads and keyed commands are retried; maxRetries 1 = 2 tries.
  const nowhere = new Werft({
    baseUrl: `http://127.0.0.1:${await closedPort()}`,
    apiKey: "unused",
    maxRetries: 1,
  });
  const connection = expectError(
    await nowhere.root.get().catch((error: unknown) => error),
    ConnectionError,
  );
  console.log(
    `no listener: ${connection.name} ${connection.code}, attempts ${connection.attempts}`,
  );

  // 5. The caller's own signal.
  const controller = new AbortController();
  controller.abort(new Error("cancelled by the operator"));
  const options: RequestOptions = { signal: controller.signal };
  const aborted = expectError(
    await client.sessions.get(sessionId, options).catch((e: unknown) => e),
    AbortedError,
  );
  console.log(
    `aborted: ${aborted.name} ${aborted.code}, cause "${(aborted.cause as Error).message}"`,
  );

  // 6. Per-call headers can never set the key or Authorization.
  const reserved = await client.sessions
    .get(sessionId, { headers: { "Idempotency-Key": "mine" }, signal })
    .catch((error: unknown) => error);
  if (!(reserved instanceof TypeError)) throw reserved;
  console.log(`reserved header: ${reserved.message}`);

  for (const error of [conflict, timeout, connection, aborted])
    if (!(error instanceof WerftError)) throw new Error("not a WerftError");
  console.log("every SDK failure above is a WerftError");

  const { revision } = await client.sessions.get(sessionId, { signal });
  const accepted = await client.sessions.close(
    sessionId,
    { expected_revision: revision, reason: "reliability sample finished" },
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
