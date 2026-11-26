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
import { messageOf } from "./message-of.ts";

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

/**
 * How long to wait before asking again after the gateway answered a beat
 * 404: one second, doubling up to four, then every four until the lease is
 * given up. The heartbeat caps it at its beat interval, so an unconfirmed
 * lease is never asked about less often than a confirmed one.
 */
export const NOT_FOUND_BACKOFF_MS = { first: 1_000, cap: 4_000 } as const;

export function notFoundBackoff(
  refused: number,
  capMs: number = NOT_FOUND_BACKOFF_MS.cap,
): number {
  return Math.min(
    NOT_FOUND_BACKOFF_MS.first * 2 ** Math.max(0, refused - 1),
    capMs,
  );
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
   * gateway's refusal when one said so: the refusal that ended it, or the
   * last one before the lease was given up.
   */
  onLost: (reason: string, error?: unknown) => void;
  /** The gateway answered a beat 404; see `Heartbeat.unconfirmed`. */
  onUnconfirmed?: (reason: string) => void;
  /** A beat was accepted after this many in a row were answered 404. */
  onConfirmed?: (notFoundBeats: number) => void;
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
  /** The last refusal ridden out, for the reason a lease is given up with. */
  private lastRefusal: unknown;
  /** Beats in a row the gateway answered 404; zero once one is accepted. */
  private notFound = 0;
  /** When the latest beat the gateway accepted was sent, on `clock`. */
  private acceptedSentAt = Number.NEGATIVE_INFINITY;
  /** When the latest beat the gateway answered 404 was sent, on `clock`. */
  private notFoundSentAt = Number.NEGATIVE_INFINITY;
  /** Beats refused since ownership went unconfirmed: the backoff's step. */
  private retries = 0;
  /** When the next beat is due while ownership is unconfirmed, on `clock`. */
  private retryAt = 0;
  /** Sets the wait under way to what is due now. */
  private rearm: (() => void) | undefined;
  /** Open while ownership is unconfirmed; see `unconfirmed`. */
  private doubt:
    | {
        promise: Promise<void>;
        resolve: () => void;
        reject: (reason: unknown) => void;
      }
    | undefined;

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
   * Undefined while the gateway's last answer stands. A promise from the
   * first beat answered 404: the route can be missing for a moment while the
   * control plane is replaced, and the lease it granted still stands, so the
   * beat is asked again (`NOT_FOUND_BACKOFF_MS`) until the lease is given
   * up. Nothing new may be written outside meanwhile. It resolves when a beat
   * is accepted and rejects, for good, when the lease is lost.
   */
  get unconfirmed(): Promise<void> | undefined {
    return this.doubt?.promise;
  }

  /**
   * True once the gateway answered a beat that reported the transcript
   * mirror's error, which is when it holds the session's pending reason.
   */
  get mirrorErrorRecorded(): boolean {
    return this.mirrorErrorAnswered;
  }

  start(): void {
    if (this.running !== undefined) return;
    // A loop that threw stays as it ended, for `stop` to report.
    this.running = this.loop().then(() => {
      this.running = undefined;
      // A 404 that landed as the loop was ending found it still set.
      if (this.going) this.start();
    });
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
    await this.ended();
    if (this.owed && !this.lost) {
      await this.beatOnce();
      // Answered 404, that beat left the lease unconfirmed and the loop
      // running again: the stop waits for it as for any other.
      await this.ended();
    }
  }

  /** The loop over, and any that started in its place. */
  private async ended(): Promise<void> {
    while (this.running !== undefined) await this.running;
  }

  /** One beat now, outside the loop; for a caller that must see it land. */
  async beatOnce(): Promise<void> {
    this.owed = false;
    await this.beat();
  }

  /**
   * A stop does not end the loop while ownership is unconfirmed: what the
   * shutdown still owes the gateway waits on that answer.
   */
  private get going(): boolean {
    return !this.lost && (!this.stopped || this.doubt !== undefined);
  }

  private async loop(): Promise<void> {
    let overdue = false;
    while (this.going) {
      // Wakes by halfway to the point the lease is given up at: one granted
      // with less left than the interval (a slow answer, a long interval)
      // must still be beaten while a renewal can land, and one that runs
      // out between beats noticed when it does. A beat still unanswered
      // when the next one is due has already used that wait.
      // After a 404 the next beat waits for its backoff whatever else is
      // still unanswered.
      if (
        !this.owed &&
        (!overdue || (this.notFound > 0 && this.dueInMs() > 0))
      ) {
        await this.pause(() => this.dueInMs());
      }
      if (!this.going) return;
      this.owed = false;
      overdue = !(await this.beat(
        Math.max(this.nextBeatInMs(), MIN_BEAT_SPACING_MS),
      ));
    }
  }

  /** The 404 backoff's current step, never longer than the beat interval. */
  private backoff(): number {
    return notFoundBackoff(
      this.retries,
      Math.min(NOT_FOUND_BACKOFF_MS.cap, this.options.intervalMs),
    );
  }

  private nextBeatInMs(): number {
    if (this.notFound > 0) {
      return Math.min(this.backoff(), this.leaseLeftMs);
    }
    return nextHeartbeatDelay(this.options.intervalMs, this.leaseLeftMs);
  }

  /** How long the loop waits before the beat it sends of its own accord. */
  private dueInMs(): number {
    if (this.notFound === 0) return this.nextBeatInMs();
    return Math.min(Math.max(0, this.retryAt - this.clock()), this.leaseLeftMs);
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
        // An answer nobody waits for any more still counts until the loop
        // is over, which a stop puts off while ownership is unconfirmed.
        (response) => {
          if (waiting || this.going) {
            this.renew(response, sentAt, transcript);
          }
        },
        (error: unknown) => {
          if (waiting || this.going) this.refused(error, sentAt);
        },
      );
    // Only the loop's own beat: one sent for a caller is waited out.
    const fromLoop = Number.isFinite(patienceMs);
    // False once another beat's refusal cut this one's wait short.
    let outwaited = true;
    let cancel: (() => void) | undefined;
    const expired = new Promise<false>((resolve) => {
      const arm = (ms: number) => {
        cancel = this.schedule(() => resolve(false), ms);
      };
      arm(Math.min(patienceMs, this.leaseLeftMs));
      if (fromLoop) {
        // A refusal of another beat sets when the next one is due, which
        // can be before this one's patience runs out.
        this.rearm = () => {
          outwaited = false;
          cancel?.();
          arm(this.dueInMs());
        };
      }
    });
    let settled: boolean;
    try {
      settled = await Promise.race([answered.then(() => true), expired]);
    } finally {
      cancel?.();
      if (fromLoop) this.rearm = undefined;
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
    if (outwaited && this.notFound > 0) {
      // Unanswered for its whole patience, it used a step of the backoff as
      // a refused one does: the next is due that much after it went out.
      this.retries += 1;
      this.retryAt = sentAt + this.backoff();
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
    this.acceptedSentAt = Math.max(this.acceptedSentAt, sentAt);
    if (this.doubt === undefined) {
      this.lastRefusal = undefined;
    } else if (sentAt > this.notFoundSentAt) {
      // Only a beat sent after the last one answered 404 confirms it: an
      // answer to an older one renews the lease and says nothing newer.
      const beats = this.notFound;
      this.lastRefusal = undefined;
      this.notFound = 0;
      this.retries = 0;
      this.doubt.resolve();
      this.doubt = undefined;
      this.options.onConfirmed?.(beats);
    }
    if (transcript?.mirror_error != null) this.mirrorErrorAnswered = true;
    if (response.control_pending) this.options.onControlPending?.();
  }

  private refused(error: unknown, sentAt: number): void {
    if (this.lost) return;
    if (!isOwnershipLost(error) && isNotFound(error)) {
      // Overlapping beats answer out of order: a 404 to one sent before a
      // beat the gateway has since accepted is older news than that answer.
      if (sentAt < this.acceptedSentAt) return;
      this.lastRefusal = error;
      this.notFound += 1;
      this.notFoundSentAt = Math.max(this.notFoundSentAt, sentAt);
      this.retries += 1;
      this.retryAt = this.clock() + this.backoff();
      if (this.doubt === undefined) {
        this.doubt = Promise.withResolvers<void>();
        // Nothing may be waiting on it when the lease is lost.
        this.doubt.promise.catch(() => undefined);
        this.options.onUnconfirmed?.(message(error));
      }
      if (this.leaseLeftMs <= 0) {
        this.giveUp("the gateway kept answering 404");
        return;
      }
      // The answer may be to a beat the loop no longer waits on, or one
      // sent outside it: the wait under way was set for something else,
      // and a loop that has ended is asked again like any other.
      this.rearm?.();
      this.start();
      return;
    }
    if (isOwnershipLost(error) || !isRetryable(error)) {
      this.declareLost(message(error), error);
      return;
    }
    // A gateway that is merely unreachable is survivable right up to the
    // point where the lease it granted is given up.
    this.lastRefusal = error;
    if (this.leaseLeftMs <= 0) {
      this.giveUp("the gateway is unreachable");
      return;
    }
    if (this.notFound > 0) {
      // Still unconfirmed: the next beat keeps to the backoff, a step on.
      this.retries += 1;
      this.retryAt = this.clock() + this.backoff();
      this.rearm?.();
    }
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
        (this.notFound === 0
          ? ""
          : `; beats answered 404 in a row: ${this.notFound}`) +
        (this.lastRefusal === undefined
          ? ""
          : ` (last refusal: ${message(this.lastRefusal)})`),
      this.lastRefusal,
    );
  }

  private declareLost(reason: string, error?: unknown): void {
    if (this.lost) return;
    this.lost = true;
    // Whatever waited on the answer is refused here, unsent, the way the
    // gateway would refuse it: a lost lease writes nothing more.
    this.doubt?.reject(
      new WorkerGatewayRequestError(
        0,
        "LEASE_EXPIRED",
        `Not sent: ${reason}`,
        false,
      ),
    );
    this.options.onLost(reason, error);
  }

  private pause(ms: () => number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.wake = undefined;
        this.rearm = undefined;
        resolve();
      };
      const arm = () => {
        const cancel = this.schedule(done, ms());
        this.wake = () => {
          cancel();
          done();
        };
        this.rearm = () => {
          cancel();
          arm();
        };
      };
      arm();
    });
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof WorkerGatewayRequestError && error.status === 404;
}

function message(error: unknown): string {
  if (error instanceof WorkerGatewayRequestError && error.code !== null) {
    return `${error.code}: ${error.message}`;
  }
  return messageOf(error);
}
