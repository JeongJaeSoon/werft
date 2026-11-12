import { AsyncResource } from "node:async_hooks";
import { Socket } from "node:net";
import type { StructuredLogger } from "@werft-ai/observability";
import { lookupEveryTime } from "@werft-ai/system";
import { Client, Pool, type PoolClient, type PoolConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import {
  currentDeadline,
  type RequestDeadline,
  RequestDeadlineExceededError,
} from "./request-deadline.ts";

export {
  currentDeadline,
  RequestDeadline,
  RequestDeadlineExceededError,
  runWithDeadline,
} from "./request-deadline.ts";

export interface PoolTimeouts {
  // Waiting for a connection or a free pooled client.
  readonly connectMs: number;
  // Server-side statement_timeout: Postgres cancels the statement itself.
  readonly statementMs: number;
  // Client-side fallback for a socket the server can no longer answer on;
  // later than statementMs so the server cancel is the one that normally
  // fires and the statement does not keep running behind a dead request.
  readonly queryMs: number;
}

// For the one-shot jobs (scheduler, reconciler): the API's numbers. Against
// a frozen database a scheduler pass then waits connectMs + queryMs on the
// statement that fails and queryMs on the pass-lock unlock, about 45s, which
// the compose loop's SCHEDULER_PASS_TIMEOUT_SEC must stay above.
export const JOB_POOL_TIMEOUTS: PoolTimeouts = {
  connectMs: 5_000,
  statementMs: 10_000,
  queryMs: 20_000,
};

// pg's query_timeout only rejects the caller's promise: the client stays
// busy on a socket the server never answered, so drizzle's ROLLBACK after a
// failed transaction waits another full query_timeout and the client then goes
// back to the pool still poisoned. Dropping the socket the moment the read
// timeout fires fails every queued statement immediately and marks the client
// not queryable, which makes pg-pool discard it on release.
const QUERY_READ_TIMEOUT = "Query read timeout";

interface Checkout {
  readonly release: (error?: Error) => void;
  done: boolean;
  unhold?: () => void;
}

export class EvictOnReadTimeoutClient extends Client {
  private checkout: Checkout | undefined;
  private evicted = false;

  constructor(...args: ConstructorParameters<typeof Client>) {
    super(...args);
    // pg-pool takes its idle listener off at checkout, so a backend that dies
    // while a caller holds the client between statements — a DB restart, an
    // admin kill — would be an uncaught "error" that takes the process down.
    // Nothing is lost by swallowing it: pg marks the client not queryable, the
    // holder's next statement fails with a connection error (503 in the API),
    // and pg-pool discards the client on release. Not logged here: the
    // holder sees the failure, and a pass lock watches for it on its own.
    this.on("error", () => {});
  }

  // pg-pool assigns release() on every checkout and throws if it is called
  // twice. Eviction hands the client back itself (drizzle runs BEGIN before
  // the try/finally that releases, so a timed-out BEGIN would otherwise leak
  // the slot for good), and the caller's own release() must then be a no-op.
  // Each checkout gets its own handle: one captured during an earlier
  // checkout must not release the client from under its next holder.
  set release(fn: ((error?: Error) => void) | undefined) {
    if (!fn) {
      this.checkout = undefined;
      return;
    }
    const checkout: Checkout = {
      release: (error?: Error) => {
        if (checkout.done) {
          return;
        }
        checkout.done = true;
        checkout.unhold?.();
        fn(error);
      },
      done: false,
    };
    this.checkout = checkout;
  }

  get release(): (error?: Error) => void {
    return this.checkout?.release ?? (() => {});
  }

  // Checked out under a request deadline: evicted if the deadline expires
  // while this checkout is still open.
  holdFor(deadline: RequestDeadline): void {
    const checkout = this.checkout;
    if (checkout && !checkout.done) {
      checkout.unhold = deadline.hold(() =>
        this.evict(new RequestDeadlineExceededError()),
      );
    }
  }

  private evictOnReadTimeout(error: unknown): void {
    if (error instanceof Error && error.message === QUERY_READ_TIMEOUT) {
      this.evict(error);
    }
  }

  private evict(error: Error): void {
    if (this.evicted) {
      return;
    }
    this.evicted = true;
    // Flag the client unusable now so pg-pool removes it rather than parking
    // it idle, and so end() takes its destroy-the-socket path instead of
    // asking a server that no longer answers to say goodbye.
    (this as unknown as { _queryable: boolean })._queryable = false;
    // end(), not a bare socket destroy: an ending client fails the queued
    // statements with "Connection terminated" and emits no "error". pg-pool's
    // idle listener stamps any error it sees with `err.client` — password
    // included — and that same object is what the queued callers get, which a
    // job that crashes on it then prints.
    void this.end();
    this.release(error);
  }

  // pg's overloads (callback or promise, text or config) all funnel through
  // here; only the failure path is wrapped, so the return shape is unchanged.
  override query(...args: unknown[]): never {
    const deadline = currentDeadline();
    if (deadline) {
      const remaining = deadline.remainingMs();
      if (remaining <= 0) {
        // The client may be mid-transaction for a request that has already
        // answered; it must not go back to the pool, nor run anything more.
        const error = new RequestDeadlineExceededError();
        this.evict(error);
        const last = args[args.length - 1];
        if (typeof last === "function") {
          process.nextTick(() => last(error));
          return undefined as never;
        }
        return Promise.reject(error) as never;
      }
      // pg reads query_timeout per statement, so the read timeout that
      // already evicts a stuck client now also fires at the deadline.
      args[0] = withReadTimeout(
        args[0],
        Math.min(Math.ceil(remaining), this.configuredReadTimeoutMs()),
      );
    }
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = (error: unknown, result: unknown) => {
        this.evictOnReadTimeout(error);
        last(error, result);
      };
      return (super.query as (...a: unknown[]) => never)(...args);
    }
    const pending = (super.query as (...a: unknown[]) => unknown)(...args);
    if (pending instanceof Promise) {
      return pending.catch((error: unknown) => {
        this.evictOnReadTimeout(error);
        throw error;
      }) as never;
    }
    return pending as never;
  }

  private configuredReadTimeoutMs(): number {
    const configured = (
      this as unknown as { connectionParameters: { query_timeout?: number } }
    ).connectionParameters.query_timeout;
    return configured && configured > 0 ? configured : Number.POSITIVE_INFINITY;
  }
}

function withReadTimeout(config: unknown, ms: number): unknown {
  if (typeof config === "string") {
    return { text: config, query_timeout: ms };
  }
  if (config === null || typeof config !== "object") {
    // pg throws its own TypeError for these.
    return config;
  }
  if (typeof (config as { submit?: unknown }).submit === "function") {
    // A Submittable (cursor, stream) is the object pg drives; it cannot be
    // copied.
    (config as { query_timeout?: number }).query_timeout = ms;
    return config;
  }
  return { ...config, query_timeout: ms };
}

type ConnectCallback = (
  error: Error | undefined,
  client?: PoolClient,
  release?: (error?: Error) => void,
) => void;

class DeadlinePool extends Pool {
  override connect(...args: unknown[]): never {
    const callback =
      typeof args[0] === "function" ? (args[0] as ConnectCallback) : undefined;
    const deadline = currentDeadline();
    if (!deadline) {
      // pg-pool hands a queued callback its client from inside whichever
      // caller released one; bound, it keeps running in its own caller's
      // context (pool.query issues its statement from this callback) rather
      // than under the releaser's deadline.
      return (super.connect as (...a: unknown[]) => never)(
        ...(callback ? [AsyncResource.bind(callback)] : args),
      );
    }
    const checkout = this.connectWithin(deadline);
    if (!callback) {
      return checkout as never;
    }
    // A continuation runs in the caller's context, so no binding is needed.
    checkout.then(
      (client) => callback(undefined, client, client.release),
      (error: Error) => callback(error),
    );
    return undefined as never;
  }

  // The wait for a client ends at the deadline too. A client that turns up
  // afterwards goes straight back, untouched: evicting it on the late
  // request's first statement instead would, under saturation, let every
  // expired waiter destroy a healthy connection.
  private connectWithin(deadline: RequestDeadline): Promise<PoolClient> {
    const remaining = deadline.remainingMs();
    if (remaining <= 0) {
      return Promise.reject(new RequestDeadlineExceededError());
    }
    return new Promise((resolve, reject) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        reject(new RequestDeadlineExceededError());
      }, remaining);
      (super.connect as (callback: ConnectCallback) => void)(
        (error, client, release) => {
          clearTimeout(timer);
          if (late) {
            release?.();
            return;
          }
          if (error || !client) {
            reject(error ?? new Error("pg-pool returned no client"));
            return;
          }
          if (client instanceof EvictOnReadTimeoutClient) {
            client.holdFor(deadline);
          }
          resolve(client);
        },
      );
    });
  }
}

// What pg dials through (the `stream` option): a plain socket whose hostname
// connect resolves with lookupEveryTime, so a restarted postgres is found at
// its new address. pg calls connect(port, host), or
// connect(path) for a Unix socket, which needs no lookup.
export class LookupEveryTimeSocket extends Socket {
  override connect(...args: unknown[]): this {
    const [port, host] = args;
    if (args.length === 2 && typeof host === "string") {
      return super.connect({
        port: Number(port),
        host,
        lookup: lookupEveryTime,
      });
    }
    return (super.connect as (...a: unknown[]) => this)(...args);
  }
}

export function lookupEveryTimeStream(): LookupEveryTimeSocket {
  return new LookupEveryTimeSocket();
}

// pg's own default. The connection budget across roles is in
// apps/docs/content/docs/run-server/self-hosting/operate/database.mdx; a role that never runs statements side by side
// takes less.
export const DEFAULT_POOL_MAX = 10;

// The scheduler, reconciler and slack roles run their passes one statement
// at a time; the scheduler holds one more client for its pass lock. The rest
// is headroom, not concurrency they use.
export const SEQUENTIAL_ROLE_POOL_MAX = 4;

export function createEnforcedPool(
  connectionString: string,
  logger: StructuredLogger,
  name: string,
  timeouts: PoolTimeouts,
  {
    // Every transaction starts read only, so the database refuses a write a
    // reader should never make.
    readOnly = false,
    max = DEFAULT_POOL_MAX,
  }: { readOnly?: boolean; max?: number } = {},
): Pool {
  const config = enforcedConfig(connectionString, timeouts, name);
  return watchIdleErrors(
    new DeadlinePool({
      ...config,
      max,
      ...(readOnly
        ? {
            options: [config.options, "-c default_transaction_read_only=on"]
              .filter(Boolean)
              .join(" "),
          }
        : {}),
    }),
    logger,
    name,
  );
}

// No transaction waits on anything but its own statements (as audited), so
// one left idle this long belongs to a holder that has stopped:
// the server ends that session and its row locks go with it.
export const IDLE_IN_TRANSACTION_MS = 30_000;

// pg parses connectionString last, so `?statement_timeout=0&query_timeout=0`
// in DATABASE_URL would silently switch the limits off. Parse the URL here
// and lay the limits over it instead.
export function enforcedConfig(
  connectionString: string,
  timeouts: PoolTimeouts,
  // pg_stat_activity and the server log tell the roles apart by it.
  name: string,
): PoolConfig {
  const parsed = parseIntoClientConfig(connectionString);
  return {
    ...parsed,
    Client: EvictOnReadTimeoutClient,
    stream: lookupEveryTimeStream,
    connectionTimeoutMillis: timeouts.connectMs,
    statement_timeout: timeouts.statementMs,
    query_timeout: timeouts.queryMs,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_MS,
    application_name: parsed.application_name ?? `werft:${name}`,
  };
}

// pg-pool emits "error" for a pooled client whose socket failed: an idle
// backend that went away, or a client we evicted above whose socket error
// lands after release. With no listener that is an uncaught exception and the
// process dies on a database restart instead of failing the one request or pass.
export function watchIdleErrors(
  pool: Pool,
  logger: StructuredLogger,
  name: string,
): Pool {
  pool.on("error", (error) => {
    logger.warn("Pooled database connection dropped", {
      pool: name,
      error_name: error.name,
      // Not `error_message`: the logger drops any *message* key as a body.
      error: error.message,
      code: (error as { code?: string }).code ?? null,
    });
  });
  return pool;
}

// Node socket errors that mean the database is out of reach, and the name
// resolution failures Bun reports for its host (lookupEveryTime strips the
// DNS_ prefix).
const SOCKET_ERROR_CODES = new Set([
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEOUT",
  "ESERVFAIL",
]);

// What pg raises without a code when the socket drops, a timeout fires, or a
// saturated pool cannot hand out a client (pg/lib/client.js, pg-pool/index.js).
const PG_CONNECTION_MESSAGES =
  /^(Connection terminated|timeout expired|Query read timeout|timeout exceeded when trying to connect|Client has encountered a connection error|Client was closed and is not queryable)/;

/**
 * One link of a cause chain says the connection is gone: a 08xxx connection
 * exception, a node socket error, or one of pg's code-less connection
 * failures. Callers walk the chain themselves (Drizzle and pg-pool both wrap
 * the driver's error) and add the SQLSTATEs their own policy counts.
 */
export function isConnectionFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === "string" &&
    (code.startsWith("08") ||
      code.startsWith("ECONN") ||
      SOCKET_ERROR_CODES.has(code))
  ) {
    return true;
  }
  return error instanceof Error && PG_CONNECTION_MESSAGES.test(error.message);
}
