import type { CheckpointObjectStore } from "@werft-ai/runtime-core";
import {
  BodyStallError,
  BodyTruncatedError,
  createCheckpointObjectStore,
  createObjectRouteClient,
  S3_REQUEST_BOUNDS,
  type S3ClientLike,
  type S3TimeoutWarn,
  scopedCheckpointObjectStore,
} from "@werft-ai/storage";
import { notFoundBackoff } from "./heartbeat.ts";

/**
 * The one file in the worker that knows objects live in S3. Everything else
 * — the turn loop, the Claude adapter's session store — takes the
 * `CheckpointObjectStore` port, and `tests/architecture` holds the package
 * to that: `@werft-ai/storage` may be imported from here and nowhere
 * else in `apps/worker`.
 */

/**
 * What the execution backend puts in the container (`backend.ts`
 * `workerEnvironmentFor`): the bucket and region, and the prefix this
 * worker's session owns. No credential: the worker reaches the object store
 * only through the egress proxy's object store route, with the token its
 * claim hands out.
 */
export type WorkerObjectStoreEnvironment = {
  AWS_REGION?: string | undefined;
  S3_BUCKET?: string | undefined;
  /** `sessions/<sessionId>/`; the worker never derives it from a session id. */
  WORKER_OBJECT_PREFIX?: string | undefined;
};

export type WorkerObjectStoreConfig = {
  bucket: string;
  /** The egress proxy's object store route. */
  endpoint: string;
  region: string;
  /** Every key this worker may read or write starts with this. */
  scope: string;
};

export function objectStoreConfigFromEnv(
  environment: WorkerObjectStoreEnvironment,
  egressCredentialUrl: string,
): WorkerObjectStoreConfig {
  const scope = required(
    environment.WORKER_OBJECT_PREFIX,
    "WORKER_OBJECT_PREFIX",
  );
  if (
    !scope.endsWith("/") ||
    !scope
      .slice(0, -1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  ) {
    throw new Error(
      `WORKER_OBJECT_PREFIX ${scope} must be a key prefix ending in "/"`,
    );
  }
  return {
    bucket: required(environment.S3_BUCKET, "S3_BUCKET"),
    endpoint: `${egressCredentialUrl}/object-store`,
    region: required(environment.AWS_REGION, "AWS_REGION"),
    scope,
  };
}

/**
 * The store the worker's checkpoint code gets: S3 through the route, under
 * the storage package's request bounds, confined to the session prefix.
 * The confinement is the fast failure; the route is the boundary, and it
 * refuses what the confinement would have (`object-route.ts`).
 * `token` is the claim's object store token, asked for on every request.
 */
/**
 * An S3 client each of whose requests waits on the promise `unconfirmed`
 * returns, and is not sent once it rejects: what the gateway client does for
 * its calls (see `WorkerHost.ownershipUnconfirmed`). Every request, reads
 * included: one write is several of them, and a read decides its next one.
 */
export function holdingS3Client(
  client: S3ClientLike,
  unconfirmed: () => Promise<void> | undefined,
): S3ClientLike {
  return {
    async send(command, options) {
      // Read again after each wait, and sent in the tick it reads open.
      for (let held = unconfirmed(); held; held = unconfirmed()) await held;
      return client.send(command, options);
    },
  };
}

export function createWorkerObjectStore(
  config: WorkerObjectStoreConfig,
  token: () => string,
  unconfirmed: () => Promise<void> | undefined = () => undefined,
  /** One line for each request that ran out its bound. */
  warn?: S3TimeoutWarn,
): CheckpointObjectStore {
  const client = createObjectRouteClient(
    { endpoint: config.endpoint, region: config.region, token },
    S3_REQUEST_BOUNDS,
    warn,
  );
  return scopedCheckpointObjectStore(
    createCheckpointObjectStore({
      bucket: config.bucket,
      client: holdingS3Client(client, unconfirmed),
    }),
    config.scope,
  );
}

/**
 * The claim's object store token, handed over once the claim is in. Asked
 * for earlier, it refuses: nothing reaches the route without one.
 */
export class ObjectStoreToken {
  #value: string | null = null;

  useToken(token: string): void {
    this.#value = token;
  }

  current(): string {
    if (this.#value === null) {
      throw new Error("The object store was used before the claim");
    }
    return this.#value;
  }
}

/**
 * No send of one transcript write starts later than this after its first,
 * however long the lease goes on being renewed: the engine's SDK waits 60 s
 * for an append and then gives the batch up itself. A send already under way
 * is not cut short by it; how long one may take is the store's own bound.
 */
export const TRANSCRIPT_RESEND_CEILING_MS = 50_000;

/**
 * Runs a transcript write and, while the store only failed to answer it
 * (`isObjectStoreOutage`), runs it again on the heartbeat's backoff until
 * this attempt gives its lease up: the batch is kept rather than dropped for
 * as long as the attempt still owns what it writes, up to the ceiling above,
 * and nothing is sent once it does not. An outage is never an answer: the
 * write is done only once the store took it, and at the lease's end it fails
 * with the outage it last met. Any other failure fails it at once.
 */
export async function resentUntilLeaseEnds(
  write: () => Promise<void>,
  leaseLeftMs: () => number,
  hooks: {
    /** The first outage of this write, before it is sent again. */
    onHeld?: (error: unknown) => void;
    /** The store took it after this many outages. */
    onResent?: (outages: number) => void;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
  } = {},
): Promise<void> {
  const now = hooks.now ?? (() => performance.now());
  const until = now() + TRANSCRIPT_RESEND_CEILING_MS;
  // The lease as it stands at each look: a beat that landed meanwhile
  // extends it.
  const left = () => Math.min(leaseLeftMs(), until - now());
  for (let outages = 0; ; ) {
    try {
      await write();
      if (outages > 0) hooks.onResent?.(outages);
      return;
    } catch (error) {
      if (!isObjectStoreOutage(error)) throw error;
      if (outages === 0) hooks.onHeld?.(error);
      outages += 1;
      const wait = Math.min(notFoundBackoff(outages), left());
      if (wait <= 0) throw error;
      await (hooks.sleep ?? Bun.sleep)(wait);
      // Looked at again after the wait: nothing is sent past the lease.
      if (left() <= 0) throw error;
    }
  }
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

/** Node's and bun's codes for a connection that failed or was cut. */
const TRANSPORT_FAILURES = new Set([
  "ConnectionClosed",
  "ConnectionRefused",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * The store failing to answer rather than answering no: a connection that
 * failed or was cut, a request or name lookup past its bound, a body that
 * kept stalling or ended short, or a 5xx, 408 or 429. Worth asking again later; a 401, 403
 * or other 4xx, an integrity failure, or a malformed answer is not.
 */
export function isObjectStoreOutage(error: unknown): boolean {
  for (let depth = 0, current = error; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const { $metadata, code, name } = current as {
      $metadata?: { httpStatusCode?: unknown };
      code?: unknown;
      name?: unknown;
    };
    const status = $metadata?.httpStatusCode;
    if (
      typeof status === "number" &&
      (status >= 500 || status === 408 || status === 429)
    ) {
      return true;
    }
    if (
      current instanceof BodyStallError ||
      current instanceof BodyTruncatedError ||
      name === "TimeoutError" ||
      (typeof code === "string" && TRANSPORT_FAILURES.has(code))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
