import { LoginLockout, type LoginReservation, WorkGate } from "./auth.ts";
import { rateLimited } from "./routes/errors.ts";

const TOO_MANY_FAILURES = "Too many failed password checks";
const TOO_MANY_RUNNING = "Too many password checks in progress";

/**
 * Every account password check, and every new password hashed: one
 * per-email failure window and one hashing gate, so no route resets another
 * route's count and none hashes past the shared bound.
 */
export class PasswordChecks {
  constructor(
    private readonly lockout = new LoginLockout(),
    private readonly work = new WorkGate(),
  ) {}

  /** Runs `run` in a hashing slot, refused at once when the queue is full. */
  async hashing<T>(run: () => Promise<T>): Promise<T> {
    // Shed before any lookup or hash: the per-email lockout alone does not
    // bound work when every attempt names a new address.
    const slot = this.work.tryAcquire();
    if (!slot) throw rateLimited(1000, TOO_MANY_RUNNING);
    const release = await slot;
    try {
      return await run();
    } finally {
      release();
    }
  }

  /**
   * A guess at `email`'s password. It is counted as a failure before `run`
   * looks at the password, in the same synchronous step as the lockout
   * check, so a burst of concurrent guesses cannot all see the window open
   * while their hashes run. A throw from `run` is an outage, not a guess,
   * and gives the attempt back; otherwise the attempt stays counted until
   * `succeeded`. The reservation is returned for a later outage to give back.
   */
  async guess<T>(
    email: string,
    run: () => Promise<T>,
  ): Promise<{ value: T; reservation: LoginReservation }> {
    const lockedFor = this.lockout.retryAfterMs(email);
    if (lockedFor > 0) throw rateLimited(lockedFor, TOO_MANY_FAILURES);
    return this.hashing(async () => {
      const reservation = this.lockout.reserve(email);
      if (reservation.retryAfterMs > 0) {
        throw rateLimited(reservation.retryAfterMs, TOO_MANY_FAILURES);
      }
      try {
        return { value: await run(), reservation };
      } catch (error) {
        reservation.release();
        throw error;
      }
    });
  }

  /** The right password got in: the failures before it no longer count. */
  succeeded(email: string): void {
    this.lockout.clear(email);
  }
}
