import { expect, test } from "bun:test";
import { Api, e2eStack, poll, type SseEvent, type Turn } from "./client.ts";

/**
 * The alpha path against the real Messages API, run by
 * `tests/e2e/run.sh --real-model`: two turns, a checkpoint, and a third turn
 * on a new worker restored from it. A real model's words vary, so nothing
 * here reads them. What is checked is what the tools returned (the
 * repository's state) and what the platform recorded (turns, attempts,
 * checkpoint, the engine session, usage).
 */
// The connection's agent and key, set by each run of the test below.
let api: Api;
// Set by run.sh from its flag; the same path runs once on each connection of
// the mode's settings, an agent released on each. Also the test's name and
// the run record's key.
const CONNECTIONS = {
  real: ["anthropic"],
  local: ["ollama", "litellm"],
} as const;
const MODE = process.env.E2E_MODEL_MODE || "real";
if (!Object.hasOwn(CONNECTIONS, MODE)) {
  throw new Error(`E2E_MODEL_MODE ${MODE} is neither real nor local`);
}
const CONNECTION_IDS = CONNECTIONS[MODE as keyof typeof CONNECTIONS];
const SESSION_COST_LIMIT_USD = process.env.SESSION_COST_LIMIT_USD;
if (!SESSION_COST_LIMIT_USD) {
  throw new Error("SESSION_COST_LIMIT_USD is unset; run tests/e2e/run.sh");
}
const TURN_TIMEOUT = 300_000;

const nonce = crypto.randomUUID().slice(0, 8);
const file = `real-model-${nonce}.txt`;
const subject = `e2e real model ${nonce}`;
// Neither in the file name nor in the subject, so only `cat` can print it.
const content = `content-${crypto.randomUUID().slice(0, 8)}`;
const write =
  `printf '%s\\n' ${content} > ${file} && git add ${file} && ` +
  `git commit -q -m '${subject}'`;
const inspect = `git log -1 --format='%H %s' -- ${file} && cat ${file}`;
const exactly = (command: string) =>
  `Run this exact shell command with the Bash tool, once, and nothing else:\n\n${command}\n\nThen reply with the single word: done`;

/** Settles a turn, allowing each permission request it makes on the way. */
async function completed(sessionId: string, turnId: string): Promise<Turn> {
  const turn = await poll(
    `turn ${turnId} of ${sessionId}`,
    TURN_TIMEOUT,
    async () => {
      const current = await api.turn(sessionId, turnId);
      if (!["queued", "running", "needs_input"].includes(current.status)) {
        return current;
      }
      for (const request of await api.pending(sessionId)) {
        if (request.turn_id !== turnId) continue;
        if (request.kind !== "permission") {
          throw new Error(`turn ${turnId} asked: ${JSON.stringify(request)}`);
        }
        await api.allow(sessionId, request.request_id);
      }
      return null;
    },
    1_000,
  );
  if (turn.status !== "completed") {
    throw new Error(`turn ${turnId} ended ${JSON.stringify(turn)}`);
  }
  return turn;
}

/** Every event of a settled turn, read from the start of the stream. */
async function eventsOf(sessionId: string, turnId: string) {
  const events = await api.events(
    sessionId,
    (event) => event.event === "result" && event.data.turn_id === turnId,
  );
  return events.filter((event) => event.data.turn_id === turnId);
}

function toolCommands(events: SseEvent[]): string[] {
  return events
    .filter((event) => event.event === "tool_use")
    .flatMap((event) => {
      const content = (event.data.data as { message?: { content?: unknown[] } })
        .message?.content;
      return (content ?? []).flatMap((block) => {
        const command = (block as { input?: { command?: unknown } }).input
          ?.command;
        return typeof command === "string" ? [command] : [];
      });
    });
}

const toolOutput = (events: SseEvent[]) =>
  events
    .filter((event) => event.event === "tool_result")
    .map((event) => JSON.stringify(event.data.data))
    .join("\n");

function engineSession(events: SseEvent[]): string {
  const result = events.find((event) => event.event === "result");
  const id = result?.data.data.session_id;
  if (typeof id !== "string") throw new Error("the turn has no result event");
  return id;
}

const attemptsOf = (turn: Turn) =>
  (turn.attempts as Array<{ attempt_id: string }>).map((a) => a.attempt_id);

/** The commit the turn's `inspect` printed: `<sha> <subject>`. */
function commitSeen(events: SseEvent[]): string {
  expect(toolCommands(events).some((c) => c.includes("git log"))).toBe(true);
  const output = toolOutput(events);
  const commit = new RegExp(`([0-9a-f]{40}) ${subject}`).exec(output)?.[1];
  if (commit === undefined) {
    throw new Error(`no commit "${subject}" in the tool output: ${output}`);
  }
  expect(output).toContain(content);
  return commit;
}

test.each(CONNECTION_IDS)(
  `two turns, a checkpoint and a resume on a new worker, against the ${MODE} model (%s)`,
  async (connectionId) => {
    api = new Api(await e2eStack({ needsMessages: false, connectionId }));
    // 1. The model writes and commits a file; workspace writes and local git are pre-approved.
    const created = await api.createSession(exactly(write));
    expect(created.status).toBe(201);
    const sessionId = created.body.session_id;
    const first = await completed(sessionId, "1");
    const firstEvents = await eventsOf(sessionId, "1");
    expect(toolCommands(firstEvents).some((c) => c.includes(file))).toBe(true);

    // 2. A second turn on the same worker reads the commit back.
    const second = await api.send(sessionId, exactly(inspect));
    const sameWorker = await completed(sessionId, second.turn_id);
    expect(attemptsOf(sameWorker)).toEqual(attemptsOf(first));
    const commit = commitSeen(await eventsOf(sessionId, second.turn_id));

    // 3. Pause: the worker checkpoints both turns and goes away.
    const pause = await api.control(sessionId, "pause", {
      expected_revision: (await api.session(sessionId)).revision,
      reason: "e2e real model",
    });
    expect(pause.status).toBe(202);
    const paused = await api.sessionUntil(
      sessionId,
      "is paused",
      (s) => s.admission_state === "paused",
      TURN_TIMEOUT,
    );
    expect(paused.checkpoint_revision).not.toBeNull();
    expect(paused.durability.last_checkpointed_turn_id).toBe(second.turn_id);

    // 4. Resume: a new worker restores the repository and the engine session.
    const resume = await api.control(sessionId, "resume", {
      expected_revision: paused.revision,
    });
    expect(resume.status).toBe(202);
    await api.sessionUntil(
      sessionId,
      "is active again",
      (s) => s.admission_state === "active",
      TURN_TIMEOUT,
    );
    const third = await api.send(sessionId, exactly(inspect));
    const restored = await completed(sessionId, third.turn_id);
    const thirdEvents = await eventsOf(sessionId, third.turn_id);
    expect(commitSeen(thirdEvents)).toBe(commit);
    for (const attempt of attemptsOf(restored)) {
      expect(attemptsOf(first)).not.toContain(attempt);
    }
    expect(engineSession(thirdEvents)).toBe(engineSession(firstEvents));

    // 5. Usage: every turn reported a cost, inside the run's limit.
    const usage = await api.expect<{
      budget_exceeded: boolean;
      cost: {
        amount_usd: string;
        complete: boolean;
        reported_turn_count: number;
      };
      cost_limit_usd: string;
    }>(200, "GET", `/v1/sessions/${sessionId}/usage`);
    expect(usage.cost.complete).toBe(true);
    expect(usage.cost.reported_turn_count).toBe(3);
    // Decimal strings (costUsdSchema), compared as numbers.
    const spent = Number(usage.cost.amount_usd);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(Number(usage.cost_limit_usd));
    expect(usage.budget_exceeded).toBe(false);
    // The session runs under the limit run.sh gave the stack. A key cannot
    // read it back from /v1/limits, the signed-in owner's alone.
    expect(Number(usage.cost_limit_usd)).toBe(Number(SESSION_COST_LIMIT_USD));
    await api.expect(403, "GET", "/v1/limits");

    // One line for the run record.
    console.log(
      JSON.stringify({
        [`${MODE}_model`]: {
          connection_id: connectionId,
          session_id: sessionId,
          commit,
          engine_session: engineSession(thirdEvents),
          attempts: {
            before: attemptsOf(first),
            after: attemptsOf(restored),
          },
          cost_usd: usage.cost.amount_usd,
          cost_limit_usd: usage.cost_limit_usd,
        },
      }),
    );
  },
  1_200_000,
);
