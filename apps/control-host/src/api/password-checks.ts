import type { StructuredLogger } from "@werft-ai/observability";
import type {
  AuthAttemptKey,
  AuthAttemptRule,
  AuthAttemptStore,
  AuthAttemptWindowRef,
} from "@werft-ai/platform";
import { WorkGate } from "./auth.ts";
import {
  AuthAttemptKeys,
  type AuthAttemptRules,
  DEFAULT_AUTH_ATTEMPT_RULES,
  MemoryAuthAttemptStore,
} from "./auth-attempts.ts";
import { type ClientNetwork, requestClientNetwork } from "./client-address.ts";
import { rateLimited } from "./routes/errors.ts";

const TOO_MANY_FAILURES = "Too many failed password checks";
const TOO_MANY_RUNNING = "Too many password checks in progress";
const TOO_MANY_REQUESTS = "Too many sign-in requests from this network";

/** A guess counted until it is known to be right or not a guess at all. */
export interface PasswordReservation {
  /** An outage, not a guess: uncount it. Never throws. */
  release(): void;
  /** The right password got in: the account's failures no longer count. Never throws. */
  succeeded(): Promise<void>;
}

type Taken = { key: AuthAttemptKey; window: AuthAttemptWindowRef };

/**
 * Every account password check, every new password hashed, and every
 * request to a token route: per-account and per-network failure windows and
 * a per-network request window in one shared store, and one hashing gate, so
 * no route resets another route's count and none hashes past the bound.
 */
export class PasswordChecks {
  private readonly store: AuthAttemptStore;
  private readonly keys: AuthAttemptKeys;
  private readonly rules: AuthAttemptRules;
  private readonly work: WorkGate;
  private readonly logger: StructuredLogger | undefined;
  private readonly clientIpHeader: string | undefined;
  private warnedPrivatePeer = false;

  constructor(
    options: {
      store?: AuthAttemptStore;
      keys?: AuthAttemptKeys;
      rules?: Partial<AuthAttemptRules>;
      work?: WorkGate;
      logger?: StructuredLogger;
      /** The one header naming the client, written by the proxy in front. */
      clientIpHeader?: string;
    } = {},
  ) {
    this.store = options.store ?? new MemoryAuthAttemptStore();
    this.keys = options.keys ?? new AuthAttemptKeys();
    this.rules = { ...DEFAULT_AUTH_ATTEMPT_RULES, ...options.rules };
    this.work = options.work ?? new WorkGate();
    this.logger = options.logger;
    this.clientIpHeader = options.clientIpHeader;
  }

  /** The network a request is counted under; null when it is not counted. */
  clientOf(context: {
    env?: { clientAddress?: string } | undefined;
    req: { raw: Request };
  }): ClientNetwork | null {
    const { client, skippedPrivate } = requestClientNetwork(
      { header: this.clientIpHeader, socket: context.env?.clientAddress },
      context.req.raw.headers,
    );
    if (skippedPrivate && !this.warnedPrivatePeer) {
      this.warnedPrivatePeer = true;
      this.logger?.warn(
        "Per-network sign-in limits skip a private peer: behind a proxy or tunnel set CLIENT_IP_HEADER",
      );
    }
    return client;
  }

  /** Runs `run` in a hashing slot, refused at once when the queue is full. */
  async hashing<T>(run: () => Promise<T>): Promise<T> {
    // Shed before any lookup or hash: the failure windows alone do not bound
    // work when every attempt names a new address from a new network.
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
   * One request to a route that takes a 256-bit token. The token itself is
   * not worth guessing, so nothing is kept per token; the window is there so
   * one network cannot hold the hashing gate.
   */
  async admitTokenRequest(client: ClientNetwork | null): Promise<void> {
    if (client === null) return;
    const rule = this.rules.networkRequests;
    const key = this.keys.network(client.network);
    const taken = await this.store.take("ip_request", key, rule);
    if (taken.admitted) return;
    if (taken.closedNow) {
      this.logger?.warn("Sign-in requests limited", {
        kind: "ip",
        key,
        window_started_at: taken.windowStartedAt.toISOString(),
        window_seconds: rule.windowMs / 1000,
        requests: rule.limit,
      });
    }
    throw rateLimited(taken.retryAfterMs, TOO_MANY_REQUESTS);
  }

  /**
   * A guess at `email`'s password from `client`. It is counted as a failure
   * against the network and the account before `run` looks at the password,
   * in the store's one statement per window, so a burst of concurrent guesses
   * on any replica cannot all see the windows open while their hashes run. A
   * throw from `run` is an outage, not a guess, and gives both back;
   * otherwise they stay counted until `succeeded`.
   */
  async guess<T>(
    email: string,
    client: ClientNetwork | null,
    run: () => Promise<T>,
  ): Promise<{ value: T; reservation: PasswordReservation }> {
    // Counted inside the hashing slot, as the check before it was: guesses
    // the gate sheds or an outage fails are never in a window at once in
    // numbers the gate does not admit.
    return this.hashing(async () => {
      const network =
        client === null
          ? null
          : await this.take(
              "ip_failure",
              this.keys.network(client.network),
              this.rules.networkFailures,
            );
      const account = await this.take(
        "account_failure",
        this.keys.account(email),
        this.rules.accountFailures,
        email,
      ).catch((error: unknown) => {
        this.giveBack("ip_failure", network);
        throw error;
      });
      const release = () => {
        this.giveBack("ip_failure", network);
        this.giveBack("account_failure", account);
      };
      try {
        return {
          value: await run(),
          reservation: {
            release,
            succeeded: async () => {
              // The sign-in already happened: a failure here must not undo
              // it, only leave the account's failures to run out.
              this.giveBack("ip_failure", network);
              await this.store
                .clear("account_failure", account.key)
                .catch((error: unknown) => {
                  this.logger?.warn(
                    "Sign-in failures not cleared",
                    errorFields(error),
                  );
                });
            },
          },
        };
      } catch (error) {
        release();
        throw error;
      }
    });
  }

  private async take(
    kind: "ip_failure" | "account_failure",
    key: AuthAttemptKey,
    rule: AuthAttemptRule,
    email?: string,
  ): Promise<Taken> {
    const taken = await this.store.take(kind, key, rule);
    if (taken.admitted) return { key, window: taken.window };
    if (taken.closedNow) await this.locked(kind, key, rule, taken, email);
    throw rateLimited(taken.retryAfterMs, TOO_MANY_FAILURES);
  }

  private async locked(
    kind: "ip_failure" | "account_failure",
    key: AuthAttemptKey,
    rule: AuthAttemptRule,
    taken: { windowStartedAt: Date },
    email: string | undefined,
  ): Promise<void> {
    const window = {
      window_started_at: taken.windowStartedAt.toISOString(),
      window_seconds: rule.windowMs / 1000,
      failures: rule.limit,
    };
    // An account with a live membership gets a receipt on each of its
    // workspaces. An unknown email or a network belongs to no workspace, so
    // it gets the log line alone (holds the same fields, never the address).
    const recorded =
      email === undefined
        ? null
        : await this.store
            .recordAccountLock({
              email,
              windowStartedAt: taken.windowStartedAt,
              windowMs: rule.windowMs,
              failures: rule.limit,
            })
            .catch((error: unknown) => {
              this.logger?.error(
                "Login lock receipt not written",
                errorFields(error),
              );
              return null;
            });
    this.logger?.warn("Login locked", {
      kind: kind === "ip_failure" ? "ip" : "account",
      ...(recorded
        ? { user_id: recorded.userId, workspace_ids: recorded.workspaceIds }
        : { key }),
      ...window,
    });
  }

  private giveBack(
    kind: "ip_failure" | "account_failure",
    taken: Taken | null,
  ): void {
    if (taken === null) return;
    void this.store
      .giveBack(kind, taken.key, taken.window)
      .catch((error: unknown) => {
        this.logger?.warn("Sign-in attempt not given back", {
          kind,
          ...errorFields(error),
        });
      });
  }
}

/**
 * What a store error may log: a query error's message carries its
 * parameters, and those include the email that was tried.
 */
function errorFields(error: unknown): Record<string, string> {
  const fields: Record<string, string> = {
    error_name: error instanceof Error ? error.name : typeof error,
  };
  const cause = error instanceof Error ? error.cause : undefined;
  for (const source of [error, cause]) {
    const code = (source as { code?: unknown } | undefined)?.code;
    if (typeof code === "string") {
      fields.error_code = code;
      break;
    }
  }
  return fields;
}
