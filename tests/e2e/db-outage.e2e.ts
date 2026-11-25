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
 * it again, and the session comes out taking its next message instead of
 * needing recovery. Stopping postgres is test scaffolding, the one step
 * here that is not public HTTP: it stands in for a restart or a failover.
 *
 * The turn itself may still fail. A worker gives its lease up 20 s after
 * the last heartbeat that landed and heartbeats are 5 s apart, so an outage
 * of 15 s that began late in that interval outlasts the lease
 * (`worker_ownership_lost`). That turn is lost; the session is not.
 */
const api = new Api(await e2eStack());
const TIMEOUT = 600_000;
const OUTAGE_MS = 15_000;
/** See workspace-loss.e2e.ts: spec ids are read back from the fake by id. */
const RUN = crypto.randomUUID().slice(0, 8);
const spec = (name: string) => `dbo-${name}-${RUN}`;

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

/** The API answers 503, or nothing, until it has its database back. */
function apiBack(sessionId: string): Promise<true> {
  return poll("the API to answer again", 120_000, async () => {
    const answer = await api
      .request("GET", `/v1/sessions/${sessionId}`)
      .catch(() => null);
    return answer?.status === 200 ? true : null;
  });
}

test(
  "fifteen seconds without the database under a running turn leaves the session taking its next message",
  async () => {
    const created = await api.createSession(
      scripted(spec("first"), [], "ready"),
    );
    expect(created.status).toBe(201);
    const sessionId = created.body.session_id;
    expect((await api.settleAllowing(sessionId, "1")).status).toBe("completed");
    await api.sessionUntil(
      sessionId,
      "checkpoints turn 1",
      (s) => s.durability.last_checkpointed_turn_id === "1",
    );

    // Ten model calls three seconds apart: the outage begins and ends
    // under the turn, with calls and transcript batches due all through it.
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
    await must("stop", "-t", "10", container);
    try {
      await Bun.sleep(OUTAGE_MS);
    } finally {
      await must("start", container);
    }

    await apiBack(sessionId);
    const turn = await api.settledTurn(sessionId, long.turn_id);
    const calls = await api.modelCalls(spec("long"));
    if (turn.status === "completed") {
      // Every call once, in order: a held call is the same call, not a new one.
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
    expect(session).toMatchObject({
      admission_state: "active",
      attention: null,
    });
    if (turn.status === "completed") {
      // The outage's turn is in the context the next one ran with.
      const [first] = await api.modelCalls(spec("next"));
      expect(first?.history).toContain(spec("long"));
    }
    console.log(
      `db outage ${sessionId}: turn ${long.turn_id} ${turn.status}, ${calls.length} model calls, next turn completed`,
    );

    // Frees the slot: the suites after this one need theirs.
    const close = await api.control(sessionId, "close", {
      expected_revision: session.revision,
      reason: "e2e: db outage done",
    });
    expect(close.status).toBe(202);
  },
  TIMEOUT,
);
