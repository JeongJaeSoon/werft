import type {
  AttemptState,
  HeartbeatResponse,
  TranscriptReport,
  WorkerScope,
} from "@werft-ai/contracts";
import {
  isOwnershipLost,
  isRetryable,
  type WorkerGatewayClient,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";

/**
 * A lease as the gateway granted it: what was left of it on the database
 * clock, and the monotonic instant the request that won it was sent. The
 * gateway measured the remainder after that request arrived, so counting it
 * from the send can only end the lease early, never late — and no wall
 * clock, the worker's or the database's, enters the sum.
 */
export type LeaseGrant = { remainingMs: number; sentAt: number };

export function leaseTimeLeft(
  deadline: number,
  marginMs: number,
  now: number,
): number {
  return Math.max(0, deadline - marginMs - now);
}

export function renewedLeaseDeadline(
  deadline: number,
  grant: LeaseGrant,
): number {
  return Math.max(deadline, grant.sentAt + grant.remainingMs);
}

export function nextHeartbeatDelay(
  intervalMs: number,
  leaseLeftMs: number,
): number {
  return Math.min(intervalMs, Math.floor(leaseLeftMs / 2));
}

/** Schedules a callback and returns its cancellation function. */
export type HeartbeatTimer = (callback: () => void, ms: number) => () => void;

const scheduleTimer: HeartbeatTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/**
 * The least time between beats sent over one still unanswered, so that a
 * gateway which swallows requests is not sent a burst of them as the lease
 * runs down.
 */
const MIN_BEAT_SPACING_MS = 250;

export type HeartbeatOptions = {
  gateway: Pick<WorkerGatewayClient, "heartbeat">;
  scope: () => WorkerScope;
  attemptState: () => AttemptState;
  intervalMs: number;
  /** The lease the claim came back with; each beat pushes it out. */
  lease: LeaseGrant;
  /**
   * How long before the lease runs out an unrenewed one counts as lost: the
   * engine is killed then, so that it is gone by the time another attempt
   * may be handed the session.
   */
  safetyMarginMs: number;
  /**
   * Called once, with why this attempt stopped owning the session and the
   * gateway's refusal when one said so.
   */
  onLost: (reason: string, error?: unknown) => void;
  /** An answer or control intent is waiting to be fetched. */
  onControlPending?: () => void;
  /**
   * The transcript mirror as of this beat; undefined while the run has none.
   * A `mirror_error` here is what records the session's blocking pending
   * reason even when no checkpoint is asked for afterwards.
   */
  transcript?: () => TranscriptReport | undefined;
  /** Milliseconds on a clock that never jumps; `performance.now` by default. */
  monotonicNow?: () => number;
  scheduleTimer?: HeartbeatTimer;
};

/**
 * The lease clock, deliberately on its own timer rather than inside the turn
 * loop: a turn that blocks for an hour on a model call must still be reporting
 * that it is alive, and a lease that lapses must be noticed even when no
 * gateway call is otherwise due.
 */
export class Heartbeat {
  private readonly options: HeartbeatOptions;
  private readonly clock: () => number;
  private readonly schedule: HeartbeatTimer;
  /** When the lease runs out, on `clock`. */
  private deadline: number;
  private readonly marginMs: number;
  private lost = false;
  private running: Promise<void> | undefined;
  private stopped = false;
  private wake: (() => void) | undefined;
  /** A beat asked for and not yet sent; the loop, or `stop`, owes it. */
  private owed = false;
  /** Whether a beat the gateway answered carried a `mirror_error`. */
  private mirrorErrorAnswered = false;
  /** The last retryable refusal, for the reason a lease is given up with. */
  private lastRefusal: string | undefined;

  constructor(options: HeartbeatOptions) {
    this.options = options;
    this.clock = options.monotonicNow ?? (() => performance.now());
    this.schedule = options.scheduleTimer ?? scheduleTimer;
    this.deadline = options.lease.sentAt + options.lease.remainingMs;
    // Not clamped to the grant: a margin the lease cannot cover loses the
    // attempt at its first beat and says so, rather than quietly running
    // with less safety than was configured.
    this.marginMs = options.safetyMarginMs;
    if (!(this.marginMs >= 0) || !Number.isFinite(this.deadline)) {
      throw new Error(
        `Heartbeat needs a finite lease and a non-negative margin, got ${options.lease.remainingMs}ms and ${options.safetyMarginMs}ms`,
      );
    }
  }

  /**
   * What is left before the lease is given up, as of now. Once it reaches
   * zero it is given up for good: a renewal that lands later does not bring
   * back an ownership this attempt already stopped acting on.
   */
  get leaseLeftMs(): number {
    return leaseTimeLeft(this.deadline, this.marginMs, this.clock());
  }

  /**
   * True once the gateway answered a beat that reported the transcript
   * mirror's error, which is when it holds the session's pending reason.
   */
  get mirrorErrorRecorded(): boolean {
    return this.mirrorErrorAnswered;
  }

  start(): void {
    this.running ??= this.loop();
  }

  /**
   * Beats at once instead of waiting out the interval. Asked mid-beat, the
   * next beat follows that one directly: the beat already on the wire may
   * carry the state from before the change this call is announcing.
   */
  beatNow(): void {
    this.owed = true;
    this.wake?.();
  }

  /**
   * Ends the loop, then sends a beat that was asked for and never sent: a
   * stop that lands between `beatNow` and the beat must not drop what that
   * beat was announcing.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
    if (this.owed && !this.lost) await this.beatOnce();
  }

  /** One beat now, outside the loop; for a caller that must see it land. */
  async beatOnce(): Promise<void> {
    this.owed = false;
    await this.beat();
  }

  private async loop(): Promise<void> {
    let overdue = false;
    while (!this.stopped && !this.lost) {
      // Wakes by halfway to the point the lease is given up at: one granted
      // with less left than the interval (a slow answer, a long interval)
      // must still be beaten while a renewal can land, and one that runs
      // out between beats noticed when it does. A beat still unanswered
      // when the next one is due has already used that wait.
      if (!this.owed && !overdue) await this.pause(this.nextBeatInMs());
      if (this.stopped || this.lost) return;
      this.owed = false;
      overdue = !(await this.beat(
        Math.max(this.nextBeatInMs(), MIN_BEAT_SPACING_MS),
      ));
    }
  }

  private nextBeatInMs(): number {
    return nextHeartbeatDelay(this.options.intervalMs, this.leaseLeftMs);
  }

  /**
   * Sends one beat and waits for its answer at most `patienceMs`, and never
   * past the point the lease is given up at. False when it stopped waiting
   * with lease still left: the beat stays in flight and its answer still
   * counts when it lands, but the loop sends the next one meanwhile. A beat
   * sent while the gateway was down can sit in the network — a connect
   * retrying against an address with nobody behind it — well after the
   * gateway is back, and must not take the lease down with it.
   */
  private async beat(patienceMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    const scope = this.options.scope();
    const transcript = this.options.transcript?.();
    if (this.leaseLeftMs <= 0) {
      this.giveUp("no beat renewed it in time");
      return true;
    }
    const sentAt = this.clock();
    let waiting = true;
    const answered = this.options.gateway
      .heartbeat({
        ...scope,
        attempt_state: this.options.attemptState(),
        ...(transcript === undefined ? {} : { transcript }),
      })
      .then(
        (response) => {
          if (waiting || !this.stopped) {
            this.renew(response, sentAt, transcript);
          }
        },
        (error: unknown) => {
          if (waiting || !this.stopped) this.refused(error);
        },
      );
    let cancel: (() => void) | undefined;
    const expired = new Promise<false>((resolve) => {
      cancel = this.schedule(
        () => resolve(false),
        Math.min(patienceMs, this.leaseLeftMs),
      );
    });
    let settled: boolean;
    try {
      settled = await Promise.race([answered.then(() => true), expired]);
    } finally {
      cancel?.();
    }
    waiting = false;
    if (settled || this.lost) return true;
    // The request timeout can be longer than what is left of the lease, and
    // a stalled event loop can fire the timer late: the lease is judged as
    // it stands now — an overlapping beat may have renewed it meanwhile.
    if (this.leaseLeftMs <= 0) {
      this.giveUp("the gateway had not answered the beat renewing it");
      return true;
    }
    return false;
  }

  private renew(
    response: HeartbeatResponse,
    sentAt: number,
    transcript: TranscriptReport | undefined,
  ): void {
    if (this.lost) return;
    // An answer is taken only if it came back before the lease was given up.
    if (this.leaseLeftMs <= 0) {
      this.giveUp("the gateway had not answered the beat renewing it");
      return;
    }
    // Overlapping beats can answer out of order; neither shortens the
    // lease the other already granted, as on the database side.
    this.deadline = renewedLeaseDeadline(this.deadline, {
      sentAt,
      remainingMs: response.lease_remaining_ms,
    });
    this.lastRefusal = undefined;
    if (transcript?.mirror_error != null) this.mirrorErrorAnswered = true;
    if (response.control_pending) this.options.onControlPending?.();
  }

  private refused(error: unknown): void {
    if (isOwnershipLost(error) || !isRetryable(error)) {
      this.declareLost(message(error), error);
      return;
    }
    // A gateway that is merely unreachable is survivable right up to the
    // point where the lease it granted is given up.
    this.lastRefusal = message(error);
    if (this.leaseLeftMs <= 0) this.giveUp("the gateway is unreachable");
  }

  /**
   * Gives the lease up a margin before the database would end it, so the
   * engine is gone by the time another attempt may be handed the session.
   * It goes the way of any loss — no release, no further writes — even
   * though a release might still land: recovery then waits out the margin.
   */
  private giveUp(why: string): void {
    this.declareLost(
      `lease given up ${this.marginMs}ms before it runs out: ${why}` +
        (this.lastRefusal === undefined
          ? ""
          : ` (last refusal: ${this.lastRefusal})`),
    );
  }

  private declareLost(reason: string, error?: unknown): void {
    if (this.lost) return;
    this.lost = true;
    this.options.onLost(reason, error);
  }

  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancel = this.schedule(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        cancel();
        this.wake = undefined;
        resolve();
      };
    });
  }
}

function message(error: unknown): string {
  if (error instanceof WorkerGatewayRequestError && error.code !== null) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
