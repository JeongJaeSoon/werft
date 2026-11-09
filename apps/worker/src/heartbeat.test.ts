import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  type HeartbeatRequest,
  type HeartbeatResponse,
  type TranscriptReport,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_LEASE_SAFETY_MARGIN_MS,
  type WorkerScope,
} from "@werft-ai/contracts";
import { WorkerGatewayRequestError } from "@werft-ai/runtime-core";

import {
  Heartbeat,
  type HeartbeatOptions,
  type HeartbeatTimer,
  leaseTimeLeft,
  nextHeartbeatDelay,
  renewedLeaseDeadline,
} from "./heartbeat.ts";

class FakeClock {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  now = () => this.time;
  schedule: HeartbeatTimer = (run, ms) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(1, ms), run });
    return () => {
      this.timers.delete(id);
    };
  };

  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      // Drain promise continuations before looking for the next timer.
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].run();
    }
    this.time = end;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(resolve, ms);
    });
  }
}

let timer: FakeClock;
beforeEach(() => {
  timer = new FakeClock();
});

const scope: WorkerScope = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 3,
  execution_generation: 1,
  auth_revision: 7,
};

function heartbeat(
  beat: (request: HeartbeatRequest) => Promise<HeartbeatResponse>,
  options: {
    remainingMs?: number;
    safetyMarginMs?: number;
    monotonicNow?: () => number;
    transcript?: () => TranscriptReport | undefined;
  } = {},
) {
  const lost: string[] = [];
  const beats: HeartbeatRequest[] = [];
  const monotonicNow = options.monotonicNow ?? timer.now;
  const instance = new Heartbeat({
    gateway: {
      heartbeat: (request) => {
        beats.push(request);
        return beat(request);
      },
    },
    scope: () => scope,
    attemptState: () => "running",
    intervalMs: 1,
    lease: {
      remainingMs: options.remainingMs ?? 30_000,
      sentAt: monotonicNow(),
    },
    safetyMarginMs: options.safetyMarginMs ?? 1_000,
    onLost: (reason) => lost.push(reason),
    monotonicNow,
    scheduleTimer: timer.schedule,
    ...(options.transcript === undefined
      ? {}
      : { transcript: options.transcript }),
  });
  return { beats, heartbeat: instance, lost };
}

function answer(remainingMs: number) {
  return {
    lease_expires_at: new Date(Date.now() + remainingMs).toISOString(),
    lease_remaining_ms: remainingMs,
    auth_revision: scope.auth_revision,
    control_pending: false,
  };
}

async function settle(): Promise<void> {
  await timer.advance(30);
}

async function stop(beat: Heartbeat): Promise<void> {
  const stopped = beat.stop();
  await timer.advance(60_000);
  await stopped;
}

async function until(done: () => boolean, withinMs = 2_000): Promise<void> {
  const started = timer.now();
  while (!done()) {
    if (timer.now() - started > withinMs) throw new Error("timed out");
    await timer.advance(5);
  }
}

describe("Heartbeat", () => {
  test.each([
    [6_999, 1],
    [7_000, 0],
    [10_000, 0],
    [11_000, 0],
  ])("lease budget at %ims is %ims before the safety margin", (now, left) => {
    expect(leaseTimeLeft(10_000, 3_000, now)).toBe(left);
  });

  test.each([
    [30_000, 1_000, 5_000, 30_000],
    [10_000, 4_000, 30_000, 34_000],
    [30_000, 0, 30_000, 30_000],
  ])(
    "renewal keeps deadline %i with send %i and remainder %i at %i",
    (deadline, sentAt, remainingMs, expected) => {
      expect(renewedLeaseDeadline(deadline, { sentAt, remainingMs })).toBe(
        expected,
      );
    },
  );

  test.each([
    [10_000, 50, 25],
    [300, 10_000, 300],
    [300, 1, 0],
    [300, 0, 0],
  ])(
    "next beat with interval %i and budget %i is due in %i",
    (interval, left, delay) => {
      expect(nextHeartbeatDelay(interval, left)).toBe(delay);
    },
  );

  test("injected clock renews across wall jumps beyond the original TTL, then loses exactly at the safety margin", async () => {
    let unreachable = false;
    let refused = 0;
    let lastGrantSentAt = 0;
    const losses: { at: number; reason: string }[] = [];
    const beat = new Heartbeat({
      gateway: {
        heartbeat: async () => {
          if (unreachable) {
            refused += 1;
            throw new WorkerGatewayRequestError(0, null, "socket closed", true);
          }
          lastGrantSentAt = timer.now();
          return answer(10_000);
        },
      },
      scope: () => scope,
      attemptState: () => "running",
      intervalMs: 300,
      lease: { remainingMs: 10_000, sentAt: timer.now() },
      safetyMarginMs: 3_000,
      monotonicNow: timer.now,
      scheduleTimer: timer.schedule,
      onLost: (reason) => losses.push({ at: timer.now(), reason }),
    });
    beat.start();
    try {
      setSystemTime(new Date(Date.now() + 3_600_000));
      await timer.advance(5_000);
      setSystemTime(new Date(Date.now() - 7_200_000));
      await timer.advance(10_000);
      expect(lastGrantSentAt + 10_000).toBeGreaterThan(15_000);
      expect(losses).toEqual([]);

      const deadline = lastGrantSentAt + 10_000;
      const cutoff = deadline - 3_000;
      unreachable = true;
      await timer.advance(cutoff - timer.now() - 1);
      expect(losses).toEqual([]);
      await timer.advance(1);
      expect(losses).toHaveLength(1);
      expect(losses[0]?.reason).toContain(
        "lease given up 3000ms before it runs out",
      );
      expect(losses[0]?.at).toBe(cutoff);
      expect(losses[0]?.at).toBeLessThan(deadline);
      expect(refused).toBeGreaterThan(1);
      expect(deadline - (losses[0]?.at ?? 0)).toBe(3_000);
    } finally {
      setSystemTime();
      await beat.stop();
    }
  });

  test("default clock and timer renew across forward and backward wall clock jumps", async () => {
    const recorded = Promise.withResolvers<void>();
    const lost: string[] = [];
    const beat = new Heartbeat({
      gateway: {
        heartbeat: async () => ({ ...answer(60_000), control_pending: true }),
      },
      scope: () => scope,
      attemptState: () => "running",
      intervalMs: 10_000,
      lease: { remainingMs: 30_000, sentAt: performance.now() },
      safetyMarginMs: 1_000,
      onLost: (reason) => lost.push(reason),
      onControlPending: recorded.resolve,
    });
    beat.start();
    try {
      beat.beatNow();
      await recorded.promise;
      for (const jump of [3_600_000, -7_200_000]) {
        setSystemTime(new Date(Date.now() + jump));
        expect(beat.leaseLeftMs).toBeGreaterThan(30_000);
        expect(beat.leaseLeftMs).toBeLessThanOrEqual(59_000);
        await beat.beatOnce();
        expect(beat.leaseLeftMs).toBeGreaterThan(30_000);
        expect(beat.leaseLeftMs).toBeLessThanOrEqual(59_000);
        expect(lost).toEqual([]);
      }
    } finally {
      setSystemTime();
      await beat.stop();
    }
  });

  test("reports the attempt alive and carries the lease forward", async () => {
    const { beats, heartbeat: beat } = heartbeat(async () => answer(60_000), {
      remainingMs: 5_000,
    });
    beat.start();
    await settle();
    await beat.stop();

    expect(beats.length).toBeGreaterThan(0);
    expect(beats[0]?.attempt_state).toBe("running");
    expect(beats[0]?.lease_epoch).toBe(3);
    expect(beat.leaseLeftMs).toBeGreaterThan(5_000);
    expect(beat.leaseLeftMs).toBeLessThanOrEqual(60_000 - 1_000);
  });

  test("counts the remainder from when the beat was sent, not from when its answer came", async () => {
    let clock = 0;
    const { heartbeat: beat } = heartbeat(
      async () => {
        // The answer takes 4s to come back: that is spent lease, not extra.
        clock += 4_000;
        return answer(30_000);
      },
      { remainingMs: 10_000, safetyMarginMs: 2_000, monotonicNow: () => clock },
    );
    await beat.beatOnce();

    expect(beat.leaseLeftMs).toBe(30_000 - 4_000 - 2_000);
  });

  test("an answer that grants less never shortens a lease already granted", async () => {
    let clock = 0;
    const grants = [30_000, 5_000];
    const { heartbeat: beat } = heartbeat(
      async () => answer(grants.shift() ?? 0),
      {
        remainingMs: 10_000,
        safetyMarginMs: 1_000,
        monotonicNow: () => clock,
      },
    );
    await beat.beatOnce();
    clock += 1_000;
    await beat.beatOnce();

    expect(beat.leaseLeftMs).toBe(30_000 - 1_000 - 1_000);
  });

  test("the lease is judged on the monotonic clock whatever the wall clock or the answer's deadline say", async () => {
    // A gateway whose clock is an hour behind the worker's: the deadline it
    // names is already past on this side, and only the remainder counts.
    const {
      beats,
      heartbeat: beat,
      lost,
    } = heartbeat(
      async () => ({
        ...answer(5_000),
        lease_expires_at: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      { remainingMs: 5_000, safetyMarginMs: 1_000 },
    );
    try {
      beat.start();
      await settle();
      // The wall clock jumps an hour ahead, then two hours back, mid-lease.
      setSystemTime(new Date(Date.now() + 3_600_000));
      await settle();
      expect(beat.leaseLeftMs).toBeGreaterThan(1_000);
      setSystemTime(new Date(Date.now() - 7_200_000));
      await settle();
      expect(beat.leaseLeftMs).toBeGreaterThan(1_000);
      const before = beats.length;
      await until(() => beats.length > before);
      expect(lost).toEqual([]);
    } finally {
      setSystemTime();
      await beat.stop();
    }
  });

  test("carries the transcript report as of each beat, and none while there is no mirror", async () => {
    const reports: Array<TranscriptReport | undefined> = [
      undefined,
      { persisted_at: "2026-09-23T00:00:00.000Z", mirror_error: null },
    ];
    let next = 0;
    const { beats, heartbeat: beat } = heartbeat(async () => answer(60_000), {
      transcript: () => reports[Math.min(next++, 1)],
    });
    beat.start();
    await until(() => beats.length > 1);
    await beat.stop();

    expect("transcript" in (beats[0] ?? {})).toBe(false);
    expect(beats[1]?.transcript).toEqual({
      persisted_at: "2026-09-23T00:00:00.000Z",
      mirror_error: null,
    });
  });

  test("declares ownership lost on a fenced-out answer", async () => {
    const { heartbeat: beat, lost } = heartbeat(async () => {
      throw new WorkerGatewayRequestError(
        409,
        "LEASE_EXPIRED",
        "Lease expired; the attempt must stop writing",
        false,
      );
    });
    beat.start();
    await settle();
    await beat.stop();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("LEASE_EXPIRED");
  });

  // an operator's execution revocation revokes the session token
  // so the next beat does not even authenticate. That is a stop, never a
  // gateway outage to ride out until the lease lapses.
  test("declares ownership lost when its token is revoked", async () => {
    const { heartbeat: beat, lost } = heartbeat(async () => {
      throw new WorkerGatewayRequestError(
        401,
        "UNAUTHORIZED",
        "Worker token is missing, expired or revoked",
        true,
      );
    });
    beat.start();
    await settle();
    await beat.stop();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("UNAUTHORIZED");
  });

  test("rides out an unreachable gateway until the safety margin before the lease's end", async () => {
    let clock = 0;
    const {
      beats,
      heartbeat: beat,
      lost,
    } = heartbeat(
      async () => {
        throw new WorkerGatewayRequestError(0, null, "socket closed", true);
      },
      { remainingMs: 1_000, safetyMarginMs: 300, monotonicNow: () => clock },
    );
    beat.start();
    await timer.advance(10);
    clock = 650;
    await timer.advance(10);
    expect(lost).toEqual([]);
    expect(beats.length).toBeGreaterThan(0);

    // Still 300ms of lease on the database's side: given up all the same.
    clock = 700;
    await settle();
    await beat.stop();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("lease given up 300ms before it runs out");
  });

  test("on the default lease clock, rides out a 12s session lock taken as a beat goes out: two 503s, then a renewal", async () => {
    const leaseMs = 30_000;
    const lockTimeoutMs = 2_000;
    const holdMs = 12_000;
    let holdEnd: number | undefined;
    const answers: string[] = [];
    const lost: string[] = [];
    const instance = new Heartbeat({
      gateway: {
        heartbeat: async () => {
          holdEnd ??= timer.now() + holdMs;
          await timer.sleep(
            Math.max(0, Math.min(lockTimeoutMs, holdEnd - timer.now())),
          );
          if (timer.now() < holdEnd) {
            answers.push("503");
            throw new WorkerGatewayRequestError(
              503,
              "BACKEND_UNAVAILABLE",
              "Storage is unavailable, retry later",
              true,
            );
          }
          answers.push("200");
          return answer(leaseMs);
        },
      },
      scope: () => scope,
      attemptState: () => "running",
      intervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
      lease: { remainingMs: leaseMs, sentAt: timer.now() },
      monotonicNow: timer.now,
      scheduleTimer: timer.schedule,
      safetyMarginMs: WORKER_LEASE_SAFETY_MARGIN_MS,
      onLost: (reason) => lost.push(reason),
    });
    instance.start();
    await timer.advance(30_000);
    await instance.stop();

    expect(lost).toEqual([]);
    expect(answers.at(-1)).toBe("200");
    expect(
      answers.filter((status) => status === "503").length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("a lease given up behind refused beats says what the gateway answered", async () => {
    let clock = 0;
    const { heartbeat: beat, lost } = heartbeat(
      async () => {
        throw new WorkerGatewayRequestError(
          503,
          "BACKEND_UNAVAILABLE",
          "Storage is unavailable, retry later",
          true,
        );
      },
      { remainingMs: 1_000, safetyMarginMs: 300, monotonicNow: () => clock },
    );
    beat.start();
    await timer.advance(10);
    clock = 700;
    await settle();
    await beat.stop();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toStartWith("lease given up 300ms before it runs out: ");
    expect(lost[0]).toEndWith(
      " (last refusal: BACKEND_UNAVAILABLE: Storage is unavailable, retry later)",
    );
  });

  test("gives the lease up a safety margin early with a beat still unanswered", async () => {
    const { heartbeat: beat, lost } = heartbeat(() => new Promise(() => {}), {
      remainingMs: 4_000,
      safetyMarginMs: 2_000,
    });
    const started = timer.now();
    beat.start();
    await timer.advance(100);
    expect(lost).toEqual([]);

    await until(() => lost.length > 0, 6_000);

    expect(lost).toHaveLength(1);
    // A timer can fire a hair before its instant, so the beat after the
    // hanging one may be the one to say so.
    expect(lost[0]).toContain("lease given up 2000ms before it runs out");
    // Given up at the margin (~2s), not at the lease's end (4s).
    expect(timer.now() - started).toBeLessThan(4_000);
    await beat.stop();
  });

  test("a margin the lease cannot cover loses the attempt at its first beat, and says why", async () => {
    const {
      beats,
      heartbeat: beat,
      lost,
    } = heartbeat(async () => answer(1_000), {
      remainingMs: 1_000,
      safetyMarginMs: 60_000,
    });
    beat.start();
    await settle();
    await beat.stop();

    expect(beats).toEqual([]);
    expect(lost).toEqual([
      "lease given up 60000ms before it runs out: no beat renewed it in time",
    ]);
  });

  test("a beat left unanswered does not give up a lease an overlapping beat renewed", async () => {
    let calls = 0;
    const { heartbeat: beat, lost } = heartbeat(
      () => {
        calls += 1;
        // The loop's beat hangs; the one asked for meanwhile answers.
        return calls === 1
          ? new Promise(() => {})
          : Promise.resolve(answer(30_000));
      },
      // Frozen: only the race's own timer can end the hanging beat.
      { remainingMs: 200, safetyMarginMs: 100, monotonicNow: () => 0 },
    );
    beat.start();
    await until(() => calls >= 1);
    await beat.beatOnce();
    // Past the hanging beat's 100ms race.
    await timer.advance(250);

    expect(lost).toEqual([]);
    expect(beat.leaseLeftMs).toBe(30_000 - 100);
    await beat.stop();
  });

  test("a beat stuck while the gateway restarts does not hold the lease: the next one renews it", async () => {
    // The first beat went out while the API was down and sits in the
    // network; the API is back for every beat after it.
    let calls = 0;
    const lost: string[] = [];
    const instance = new Heartbeat({
      gateway: {
        heartbeat: () => {
          calls += 1;
          return calls === 1
            ? new Promise(() => {})
            : Promise.resolve(answer(30_000));
        },
      },
      scope: () => scope,
      attemptState: () => "running",
      intervalMs: 400,
      lease: { remainingMs: 1_000, sentAt: timer.now() },
      monotonicNow: timer.now,
      scheduleTimer: timer.schedule,
      safetyMarginMs: 200,
      onLost: (reason) => lost.push(reason),
    });
    instance.start();
    await until(() => calls >= 2);
    await settle();
    await instance.stop();

    expect(lost).toEqual([]);
    expect(instance.leaseLeftMs).toBeGreaterThan(1_000);
  });

  test("a stuck beat's answer still counts when it lands after the next beat went out", async () => {
    let release: (response: HeartbeatResponse) => void = () => {};
    let calls = 0;
    const { heartbeat: beat, lost } = heartbeat(
      () => {
        calls += 1;
        return calls === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : new Promise(() => {});
      },
      { remainingMs: 2_000, safetyMarginMs: 500, monotonicNow: () => 0 },
    );
    beat.start();
    await until(() => calls >= 2);
    release(answer(30_000));
    await settle();
    await stop(beat);

    expect(lost).toEqual([]);
    expect(beat.leaseLeftMs).toBe(30_000 - 500);
  });

  test("a stuck beat that lands revoked loses the attempt; once stopped, nothing does", async () => {
    const revoked = new WorkerGatewayRequestError(
      401,
      "UNAUTHORIZED",
      "Worker token is missing, expired or revoked",
      false,
    );
    const rejects: ((error: Error) => void)[] = [];
    const run = () => {
      const made = heartbeat(
        () =>
          new Promise((_, reject) => {
            rejects.push(reject);
          }),
        { remainingMs: 2_000, safetyMarginMs: 500, monotonicNow: () => 0 },
      );
      made.heartbeat.start();
      return made;
    };

    const live = run();
    await until(() => rejects.length >= 2);
    rejects[0]?.(revoked);
    await settle();
    expect(live.lost).toEqual([
      "UNAUTHORIZED: Worker token is missing, expired or revoked",
    ]);
    await stop(live.heartbeat);

    rejects.length = 0;
    const stopped = run();
    await until(() => rejects.length >= 2);
    await stop(stopped.heartbeat);
    for (const reject of rejects) reject(revoked);
    await settle();
    expect(stopped.lost).toEqual([]);
  });

  test("an answer that comes back after the lease was given up does not revive it", async () => {
    let clock = 0;
    const { heartbeat: beat, lost } = heartbeat(
      async () => {
        // The event loop stalled past the cutoff; the race's timer never got
        // to fire, and the answer grants a whole new lease.
        clock = 950;
        return answer(30_000);
      },
      { remainingMs: 1_000, safetyMarginMs: 100, monotonicNow: () => clock },
    );
    await beat.beatOnce();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("had not answered");
    expect(beat.leaseLeftMs).toBe(0);
  });

  test("beats before a lease shorter than the interval runs out", async () => {
    const beats: HeartbeatRequest[] = [];
    const lost: string[] = [];
    const instance = new Heartbeat({
      gateway: {
        heartbeat: async (request) => {
          beats.push(request);
          return answer(60_000);
        },
      },
      scope: () => scope,
      attemptState: () => "running",
      intervalMs: 10_000,
      lease: { remainingMs: 100, sentAt: 0 },
      safetyMarginMs: 50,
      onLost: (reason) => lost.push(reason),
      // Frozen, so a loaded machine's late timers cannot run the lease out.
      monotonicNow: () => 0,
      scheduleTimer: timer.schedule,
    });
    instance.start();
    await timer.advance(150);
    await instance.stop();

    expect(beats.length).toBeGreaterThan(0);
    expect(lost).toEqual([]);
  });

  test("owes a beat asked for while one is in flight", async () => {
    let state: "running" | "draining" = "running";
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beats: HeartbeatRequest[] = [];
    const options: HeartbeatOptions = {
      gateway: {
        heartbeat: async (request) => {
          beats.push(request);
          if (beats.length === 1) await held;
          return answer(30_000);
        },
      },
      scope: () => scope,
      attemptState: () => state,
      intervalMs: 1,
      lease: { remainingMs: 30_000, sentAt: timer.now() },
      monotonicNow: timer.now,
      scheduleTimer: timer.schedule,
      safetyMarginMs: 1_000,
      onLost: () => {},
    };
    const beat = new Heartbeat(options);
    beat.start();
    for (let waited = 0; beats.length === 0 && waited < 1_000; waited += 1) {
      await timer.advance(1);
    }
    // Now slow the loop down: only an owed beat can arrive in time.
    options.intervalMs = 60_000;
    state = "draining";
    beat.beatNow();
    release();
    await settle();
    await beat.stop();

    expect(beats.map((request) => request.attempt_state)).toEqual([
      "running",
      "draining",
    ]);
  });

  test("a stop does not drop a beat owed for a mirror error, and says once one landed", async () => {
    let mirrorError: string | null = null;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beats: HeartbeatRequest[] = [];
    const beat = new Heartbeat({
      gateway: {
        heartbeat: async (request) => {
          beats.push(request);
          if (beats.length === 1) await held;
          return answer(30_000);
        },
      },
      scope: () => scope,
      attemptState: () => "running",
      intervalMs: 60_000,
      lease: { remainingMs: 30_000, sentAt: timer.now() },
      monotonicNow: timer.now,
      scheduleTimer: timer.schedule,
      safetyMarginMs: 1_000,
      onLost: () => {},
      transcript: () => ({ persisted_at: null, mirror_error: mirrorError }),
    });
    beat.beatNow();
    beat.start();
    for (let waited = 0; beats.length === 0 && waited < 1_000; waited += 1) {
      await timer.advance(1);
    }
    // The beat in flight carries no error; the drain starts before it lands.
    mirrorError = "Transcript mirror dropped a batch";
    beat.beatNow();
    const stopping = beat.stop();
    release();
    await stopping;

    expect(beats.map((request) => request.transcript?.mirror_error)).toEqual([
      null,
      "Transcript mirror dropped a batch",
    ]);
    expect(beat.mirrorErrorRecorded).toBe(true);
  });

  test("stops beating once it has lost ownership", async () => {
    const { beats, heartbeat: beat } = heartbeat(async () => {
      throw new WorkerGatewayRequestError(409, "STALE_EPOCH", "gone", false);
    });
    beat.start();
    await settle();
    const afterLoss = beats.length;
    await settle();
    await beat.stop();

    expect(beats).toHaveLength(afterLoss);
    expect(afterLoss).toBe(1);
  });
});
