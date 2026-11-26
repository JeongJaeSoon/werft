import { expect, test } from "bun:test";
import { Api, bash, e2eStack, poll, scripted } from "./client.ts";
import { docker } from "./docker.ts";

/**
 * The database is down for fifteen seconds under a running turn, on the
 * stack tests/e2e/run.sh started: shorter than a worker's lease, so the
 * worker still owns its session when the database is back. While it is down
 * nobody can say whether the worker's egress token still stands. That is
 * not a refusal: the proxy holds the engine's next model call and asks
 * again, the worker keeps the transcript batch it could not mirror and sends
 * it again, and the turn completes with its context intact.
 *
 * Stopping postgres is test scaffolding, the one step here that is not
 * public HTTP: it stands in for a restart or a failover. So is reading the
 * attempt's last heartbeat, which only times the stop. A worker gives its
 * lease up 20 s after the last heartbeat that landed and heartbeats are 2 s
 * apart, so the stop comes late in that interval, the worst case: with 5 s
 * beats an outage of 15 s that began there outlasted the lease and lost the
 * turn (`worker_ownership_lost`).
 */
const api = new Api(await e2eStack());
const TIMEOUT = 600_000;
const OUTAGE_MS = 15_000;
/** How old the last heartbeat is when the stop comes: late in a 2 s interval. */
const LATE_BEAT_S = { from: 1.5, to: 2.5 };
/** See workspace-loss.e2e.ts: spec ids are read back from the fake by id. */
const RUN = crypto.randomUUID().slice(0, 8);

const project = process.env.E2E_COMPOSE_PROJECT;
if (!project) {
  throw new Error(
    "E2E_COMPOSE_PROJECT is unset: run tests/e2e/run.sh, or source its vars.sh (E2E_UP_ONLY=1)",
  );
}

async function must(...args: string[]): Promise<string> {
  const done = await docker(...args);
  if (done.status !== 0) {
    throw new Error(`docker ${args.join(" ")}: ${done.stderr}`);
  }
  return done.stdout;
}

/** This stack's postgres container, and no other stack's. */
async function postgres(): Promise<string> {
  const ids = (
    await must(
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      "label=com.docker.compose.service=postgres",
    )
  )
    .split("\n")
    .filter((id) => id !== "");
  if (ids.length !== 1) {
    throw new Error(`${project} has ${ids.length} postgres containers`);
  }
  return ids[0] as string;
}

/** Seconds since the session's running attempt last had a heartbeat taken. */
async function heartbeatAge(
  container: string,
  sessionId: string,
): Promise<number> {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) {
    throw new Error(`not a session id: ${sessionId}`);
  }
  const age = await must(
    "exec",
    container,
    "psql",
    "-U",
    "postgres",
    "-d",
    "sessions",
    "-Atc",
    `select extract(epoch from clock_timestamp() - last_heartbeat_at) from attempts where session_id = '${sessionId}' and state = 'running'`,
  );
  return Number(age.trim() || "NaN");
}

/** The API answers 503, or nothing, until it has its database back. */
function apiBack(sessionId: string): Promise<true> {
  return poll("the API to answer again", 120_000, async () => {
    const answer = await api
      .request("GET", `/v1/sessions/${sessionId}`)
      .catch(() => null);
    return answer?.status === 200 ? true : null;
  });
}

/**
 * One session through the outage. Whatever became of the turn, the session
 * takes its next message and is left active; true when the turn itself came
 * through, with every model call made once and its context kept.
 */
async function throughOutage(attempt: number): Promise<boolean> {
  const spec = (name: string) => `dbo-${name}-${RUN}-${attempt}`;
  const created = await api.createSession(scripted(spec("first"), [], "ready"));
  expect(created.status).toBe(201);
  const sessionId = created.body.session_id;
  expect((await api.settleAllowing(sessionId, "1")).status).toBe("completed");
  await api.sessionUntil(
    sessionId,
    "checkpoints turn 1",
    (s) => s.durability.last_checkpointed_turn_id === "1",
  );

  // Ten model calls three seconds apart: the outage begins and ends under
  // the turn, with calls and transcript batches due all through it.
  const steps = Array.from({ length: 9 }, (_, step) => ({
    ...bash(`echo step-${step}`),
    delayMs: 3_000,
  }));
  const long = await api.send(
    sessionId,
    scripted(spec("long"), steps, "all steps done", 3_000),
  );
  await api.modelCallSeen(spec("long"), 2);

  const container = await postgres();
  await poll(
    "a heartbeat late in its interval",
    30_000,
    async () => {
      const age = await heartbeatAge(container, sessionId);
      return age >= LATE_BEAT_S.from && age < LATE_BEAT_S.to ? true : null;
    },
    100,
  );
  await must("stop", "-t", "10", container);
  try {
    await Bun.sleep(OUTAGE_MS);
  } finally {
    await must("start", container);
  }

  await apiBack(sessionId);
  const turn = await api.settledTurn(sessionId, long.turn_id);
  const calls = await api.modelCalls(spec("long"));
  const completed = turn.status === "completed";
  if (completed) {
    // A held call is the same call, not a new one.
    expect(calls.map((call) => call.step)).toEqual(
      Array.from({ length: steps.length + 1 }, (_, step) => step),
    );
  } else {
    expect(turn).toMatchObject({
      status: "failed",
      terminal_reason: "worker_ownership_lost",
    });
  }

  // Before this held, the next message was 409 CHECKPOINT_UNAVAILABLE and
  // the session went to recovery_required over a CONTEXT_GAP.
  const next = await api.send(
    sessionId,
    scripted(spec("next"), [], "after the outage"),
  );
  expect((await api.settleAllowing(sessionId, next.turn_id)).status).toBe(
    "completed",
  );
  const session = await api.sessionUntil(
    sessionId,
    `checkpoints turn ${next.turn_id}`,
    (s) => s.durability.last_checkpointed_turn_id === next.turn_id,
  );
  expect(session).toMatchObject({ admission_state: "active", attention: null });
  if (completed) {
    const [first] = await api.modelCalls(spec("next"));
    expect(first?.history).toContain(spec("long"));
  }
  console.log(
    `db outage ${sessionId} (attempt ${attempt}): turn ${long.turn_id} ${turn.status}, ${calls.length} model calls, next turn completed`,
  );

  // Frees the slot: the suites after this one need theirs.
  const close = await api.control(sessionId, "close", {
    expected_revision: session.revision,
    reason: "e2e: db outage done",
  });
  expect(close.status).toBe(202);
  return completed;
}

test(
  "a turn running through fifteen seconds without the database, stopped late in a heartbeat interval, completes with its context, and the session takes its next message",
  async () => {
    expect(await throughOutage(1)).toBe(true);
  },
  TIMEOUT,
);
