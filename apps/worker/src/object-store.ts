import type { CheckpointObjectStore } from "@werft-ai/runtime-core";
import {
  BodyStallError,
  BodyTruncatedError,
  createCheckpointObjectStore,
  createObjectRouteClient,
  S3_REQUEST_BOUNDS,
  scopedCheckpointObjectStore,
} from "@werft-ai/storage";

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
 * A store whose writes wait on the promise `unconfirmed` returns, and are
 * not made once it rejects: what the gateway client does for its calls (see
 * `Heartbeat.unconfirmed`). Reads go through.
 */
export function holdingObjectStore(
  store: CheckpointObjectStore,
  unconfirmed: () => Promise<void> | undefined,
): CheckpointObjectStore {
  return {
    get: (key, version) => store.get(key, version),
    head: (key, version) => store.head(key, version),
    stream: (key, version) => store.stream(key, version),
    list: (prefix) => store.list(prefix),
    async putImmutable(key, body, options) {
      await unconfirmed();
      return store.putImmutable(key, body, options);
    },
  };
}

export function createWorkerObjectStore(
  config: WorkerObjectStoreConfig,
  token: () => string,
): CheckpointObjectStore {
  const client = createObjectRouteClient(
    { endpoint: config.endpoint, region: config.region, token },
    S3_REQUEST_BOUNDS,
  );
  return scopedCheckpointObjectStore(
    createCheckpointObjectStore({ bucket: config.bucket, client }),
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
