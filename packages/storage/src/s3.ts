import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { HttpRequest } from "@smithy/core/protocols";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ObjectIntegrityError } from "@werft-ai/runtime-core";
import { resolveEveryTime } from "@werft-ai/system";

export interface S3ClientLike {
  send(
    command: unknown,
    options?: { readonly requestTimeout?: number },
  ): Promise<unknown>;
}

export type S3RequestBounds = {
  /**
   * How long any response body may deliver nothing before the handler
   * destroys it. This is the only bound that reaches the bodies the SDK reads
   * for itself — an error document, a ListObjectsV2 page — which it collects
   * inside `send()` before we ever see them.
   */
  readonly bodyIdleMs: number;
  readonly connectionTimeout: number;
  readonly requestTimeout: number;
  readonly throwOnRequestTimeout: boolean;
};

/**
 * Request-stage bounds for every S3 client this package builds. The SDK's node
 * handler ships with neither, so a peer that completes the handshake and then
 * never answers leaves `send()` pending forever.
 *
 * `requestTimeout` runs from `send()` until the response *headers* arrive, the
 * upload included, and it does not care whether bytes are moving. Five
 * minutes is the floor for every write; a streamed `putImmutable` stretches
 * it to its own size ({@link transferBudgetMs}), so a workspace bundle is
 * never held to a budget sized for a smaller one. A snappier value would
 * abort healthy checkpoint uploads on a slow link, three times over, and
 * still fail. Reads do not upload anything and so do not wait on that
 * budget: they pass {@link BodyReadBounds.requestTimeoutMs} per request
 * instead.
 *
 * `throwOnRequestTimeout` is not optional dressing: without it
 * @smithy/node-http-handler 4.12.1 logs a warning when `requestTimeout`
 * expires and keeps waiting.
 *
 * `socketTimeout` is deliberately absent. It would be the better bound — plain
 * inactivity — but it is installed through `ClientRequest.setTimeout`, which
 * bun's `node:http` does not honour. `requestTimeout` is the enforceable bound.
 */
export const S3_REQUEST_BOUNDS: S3RequestBounds = {
  bodyIdleMs: 10_000,
  connectionTimeout: 3_000,
  requestTimeout: 300_000,
  throwOnRequestTimeout: true,
};

/**
 * The slowest link a checkpoint transfer is allowed: 256 MiB in five
 * minutes, ~0.85 MiB/s, the rate the fixed 300 s budgets were sized against
 * at the reference bundle size. Scaling by it keeps every size on the same
 * terms.
 */
const MIN_TRANSFER_BYTES_PER_SECOND = (256 * 1024 * 1024) / 300;

/**
 * How long moving `bytes` may take: `floorMs`, or longer for a body that
 * would need more at {@link MIN_TRANSFER_BYTES_PER_SECOND}.
 */
export function transferBudgetMs(bytes: number, floorMs: number): number {
  return Math.max(
    floorMs,
    Math.ceil((bytes / MIN_TRANSFER_BYTES_PER_SECOND) * 1000),
  );
}

/**
 * The largest body a read budget is sized for: the most any checkpoint
 * writer stores in one object (the egress proxy's cap, twice the bundle
 * ceiling). The size a read is budgeted by is the store's own answer, so a
 * larger claim — a misreported length, a stranger at the key — earns no
 * more time than this.
 */
const MAX_BUDGETED_READ_BYTES = 512 * 1024 * 1024;

/** `transferBudgetMs` for a read of a body the store says is `bytes`. */
export function readBudgetMs(bytes: number, floorMs: number): number {
  return transferBudgetMs(Math.min(bytes, MAX_BUDGETED_READ_BYTES), floorMs);
}

/**
 * `NodeHttpHandler` with every response body on a leash.
 *
 * Both request timeouts are cleared the moment the response *headers* arrive,
 * and the SDK then reads some bodies itself — an error document on any status
 * >= 300, a ListObjectsV2 page — inside `send()`, before `bodyBytes()` could
 * ever bound them. An `abortSignal` passed to `send` does not reach that body;
 * destroying the stream does, and this is the last place that still holds it.
 *
 * The bound is idle time, not total: it is armed from the socket's own data
 * events, so a 128 MiB GetObject that keeps arriving keeps resetting it.
 */
export class BoundedNodeHttpHandler extends NodeHttpHandler {
  readonly #bodyIdleMs: number;

  constructor(bounds: S3RequestBounds) {
    super(bounds);
    this.#bodyIdleMs = bounds.bodyIdleMs;
  }

  override async handle(
    ...args: Parameters<NodeHttpHandler["handle"]>
  ): ReturnType<NodeHttpHandler["handle"]> {
    const result = await super.handle(...args);
    guardResponseBody(result.response.body, this.#bodyIdleMs);
    return result;
  }
}

/**
 * {@link BoundedNodeHttpHandler} that looks a plain-http endpoint's name up
 * again for every request, for the control plane's long-lived
 * processes.
 *
 * Under Bun, `node:http` hands a hostname to `fetch`, whose resolver keeps
 * each answer for 30s, and it ignores an agent's `lookup` — only a request's
 * own `lookup` reaches it, and this handler cannot pass one. So the name is
 * resolved here and the request dialed at the address, with the name kept
 * in the `host` header the SDK signed. A restarted LocalStack on a new
 * address is then followed from the next request on.
 *
 * https is left to Bun: dialing an address would lose the server name the
 * certificate is checked against, and no https endpoint here is a container
 * that restarts. So is any request while `http_proxy` (or `all_proxy`) is
 * set: Bun then sends
 * it to the proxy, which dials the name itself, and both the proxy's
 * allowlist and `NO_PROXY` judge it by name — the worker's case, which is
 * why its handlers stay {@link BoundedNodeHttpHandler}.
 */
export class FreshAddressHttpHandler extends BoundedNodeHttpHandler {
  readonly #lookupMs: number;

  constructor(bounds: S3RequestBounds) {
    super(bounds);
    this.#lookupMs = bounds.connectionTimeout;
  }

  override async handle(
    ...[request, options]: Parameters<NodeHttpHandler["handle"]>
  ): ReturnType<NodeHttpHandler["handle"]> {
    const signal = options?.abortSignal;
    // Aborted before or while the name is looked up: the request goes on
    // unchanged and the parent rejects it the way it rejects any aborted one.
    const dialed = signal?.aborted
      ? undefined
      : await withinLookupBounds(
          atFreshAddress(request),
          this.#lookupMs,
          signal,
        );
    return super.handle(dialed ?? request, options);
  }
}

// The parent's timers start once it has the request, so a stalled resolver
// must not hold the call here: the lookup counts against the connection
// bound, and an abort ends the wait.
async function withinLookupBounds(
  lookup: Promise<HttpRequest>,
  ms: number,
  signal: HandlerSignal | undefined,
): Promise<HttpRequest | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const bounds = new Promise<undefined>((resolve, reject) => {
    if (ms > 0) {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(
              new Error(`S3 endpoint name was not resolved within ${ms}ms`),
              { name: "TimeoutError" },
            ),
          ),
        ms,
      );
    }
    unsubscribe = onAbort(signal, () => resolve(undefined));
  });
  try {
    return await Promise.race([lookup, bounds]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

type HandlerSignal = NonNullable<
  NonNullable<Parameters<NodeHttpHandler["handle"]>[1]>["abortSignal"]
>;

// Smithy still accepts a signal with only `onabort`. This chains onto it for
// the lookup and puts the old handler back before the parent sets its own.
function onAbort(
  signal: HandlerSignal | undefined,
  listener: () => void,
): () => void {
  if (!signal) return () => {};
  if ("addEventListener" in signal) {
    signal.addEventListener("abort", listener, { once: true });
    return () => signal.removeEventListener("abort", listener);
  }
  const previous = signal.onabort;
  signal.onabort = function (this: unknown, ...args: unknown[]) {
    listener();
    return (previous as ((...a: unknown[]) => unknown) | null)?.apply(
      this,
      args,
    );
  } as typeof signal.onabort;
  return () => {
    signal.onabort = previous;
  };
}

async function atFreshAddress(request: HttpRequest): Promise<HttpRequest> {
  const { hostname, port, protocol } = request;
  if (protocol !== "http:" || isIP(hostname) !== 0) return request;
  const { env } = process;
  if (env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY) {
    return request;
  }
  const addresses = await resolveEveryTime(hostname);
  // One answer, as Docker gives for a container. A name with several (a
  // dual-stack `localhost`) stays with Bun, which tries each in turn.
  const [only] = addresses;
  if (addresses.length !== 1 || !only) return request;
  const dialed = HttpRequest.clone(request);
  dialed.hostname = only.address;
  const named = Object.keys(dialed.headers).some(
    (name) => name.toLowerCase() === "host",
  );
  if (!named) dialed.headers.host = port ? `${hostname}:${port}` : hostname;
  return dialed;
}

type GuardableBody = {
  destroy?: (error?: Error) => void;
  on?: (event: string, listener: () => void) => void;
  socket?: {
    on?: (event: string, listener: () => void) => void;
    off?: (event: string, listener: () => void) => void;
  };
};

function guardResponseBody(body: unknown, idleMs: number): void {
  const stream = body as GuardableBody | null;
  if (typeof stream?.destroy !== "function") return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onData = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onIdle, idleMs);
  };
  const onIdle = () => {
    // Listening on the socket rather than the body: a `data` listener on the
    // body would put it in flowing mode and eat the bytes its real consumer
    // is waiting for.
    stream.socket?.off?.("data", onData);
    stream.destroy?.(
      new BodyStallError(`S3 response body delivered nothing for ${idleMs}ms`),
    );
  };
  const settle = () => {
    if (timer) clearTimeout(timer);
    stream.socket?.off?.("data", onData);
  };

  stream.socket?.on?.("data", onData);
  stream.on?.("close", settle);
  stream.on?.("end", settle);
  timer = setTimeout(onIdle, idleMs);
}

/** Bounded retries on top of {@link S3_REQUEST_BOUNDS}. */
export const S3_MAX_ATTEMPTS = 3;

export type BodyReadBounds = {
  /** Attempts at one object's body before the read is given up on. */
  readonly attempts: number;
  /** Ceiling on what one body may accumulate in memory. */
  readonly maxBytes: number;
  /**
   * Budget for one whole body, however steadily it trickles. A streamed read
   * stretches it to the body's size (`transferBudgetMs`); this is the floor.
   */
  readonly maxReadMs: number;
  /**
   * Per-request bound for the GetObject itself, in place of the client's
   * upload-sized {@link S3_REQUEST_BOUNDS.requestTimeout}. A read sends almost
   * nothing, so waiting minutes for its response headers only holds the turn.
   */
  readonly requestTimeoutMs: number;
  /** How long a body may deliver nothing before the read is abandoned. */
  readonly stallMs: number;
};

/**
 * A GetObject settles when the response *headers* arrive; the body is a stream
 * consumed afterwards, and nothing in the AWS SDK bounds that read — neither
 * `requestTimeout` nor an `abortSignal` passed to `send` reaches a stream the
 * handler has already handed over. Destroying the stream is the only thing
 * that ends the wait, so the bound lives here rather than in the client.
 *
 * Three bounds, because one cannot do the job:
 *
 * - `stallMs` is the fast one and the reason this exists: no bytes, no wait.
 *   It is deliberately not a budget for the whole read, since a bundle of a
 *   few hundred MiB may legitimately take minutes on a healthy connection.
 * - `maxReadMs` is the backstop a per-chunk bound cannot be: a peer dripping
 *   one byte just inside `stallMs` stays technically alive forever.
 * - `maxBytes` caps what a body read whole (`get`) can make this process
 *   hold, which keeps a lying `Content-Length` from growing the heap without
 *   end. A streamed read (`streamObjectVersion`) holds nothing, so it leaves
 *   the limit to its consumer.
 */
export const DEFAULT_BODY_READ_BOUNDS: BodyReadBounds = {
  attempts: 3,
  maxBytes: 256 * 1024 * 1024,
  maxReadMs: 300_000,
  requestTimeoutMs: 30_000,
  stallMs: 10_000,
};

/**
 * A response body that stopped delivering bytes within its bound. Worth
 * another request: the stalled socket is gone, so the retry gets a fresh one.
 */
export class BodyStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyStallError";
  }
}

/**
 * A body that ended cleanly before the length its response declared: a
 * failed read, not damage, and worth another request.
 */
export class BodyTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyTruncatedError";
  }
}

/**
 * A body that kept delivering but ran past {@link BodyReadBounds.maxReadMs} or
 * {@link BodyReadBounds.maxBytes}. Not retried: a peer that behaves this way
 * on one connection will behave this way on the next, and retrying only
 * multiplies the time a worker turn spends held.
 */
export class BodyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyLimitError";
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

export async function bodyBytes(
  body: unknown,
  bounds: BodyReadBounds = DEFAULT_BODY_READ_BOUNDS,
): Promise<Uint8Array> {
  // See boundedChunks for why iterating wins over transformToByteArray().
  if (Symbol.asyncIterator in Object(body)) {
    return readIterable(body as AsyncIterable<Uint8Array | string>, bounds);
  }
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    // No progress to observe, so the stall bound covers the whole read.
    const collect = body.transformToByteArray() as Promise<Uint8Array>;
    return new Uint8Array(
      await withStallBound(collect, bounds.stallMs, (error) =>
        closeBody(body, error),
      ),
    );
  }
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  throw new Error("Unsupported S3 response body");
}

/**
 * GetObject with the body read bounded and, on a stall, retried.
 *
 * A stalled body is a property of the connection, not of the object: the bound
 * destroys the stream on its way out, so the retry's request opens a fresh
 * socket instead of queueing behind the dead one. Says which version
 * answered; a missing key or version is undefined — S3 answers both with 404 —
 * which is how callers tell "absent" from "failed".
 */
export async function getObjectVersion(
  client: S3ClientLike,
  bucket: string,
  key: string,
  options: { bounds?: BodyReadBounds; version?: string } = {},
): Promise<{ bytes: Uint8Array; version?: string } | undefined> {
  const bounds = options.bounds ?? DEFAULT_BODY_READ_BOUNDS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= bounds.attempts; attempt += 1) {
    try {
      const response = await getObject(
        client,
        { Bucket: bucket, Key: key, VersionId: options.version },
        bounds,
      );
      const bytes = await bodyBytes(response.Body, bounds);
      const version = storedVersion(response.VersionId);
      return version === undefined ? { bytes } : { bytes, version };
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      if (options.version !== undefined && isUnreadableVersion(error)) {
        return undefined;
      }
      if (isResponseChecksumMismatch(error)) {
        throw new ObjectIntegrityError(key, { cause: error });
      }
      if (!(error instanceof BodyStallError)) throw error;
      lastError = error;
    }
  }
  throw new Error(`S3 object body stalled ${bounds.attempts} times: ${key}`, {
    cause: lastError,
  });
}

/**
 * `getObjectVersion` for a body too large to hold: resolves once the response
 * headers say whether the object exists, and hands out the body chunk by
 * chunk under the same stall and whole-read bounds. `maxBytes` does not
 * apply — nothing accumulates here, so how much to read is the consumer's
 * call.
 *
 * A stall cannot be retried from the top once chunks have gone out, so it is
 * resumed instead: a ranged GetObject from the first byte not yet delivered,
 * pinned to the object that answered first — its version when the bucket
 * reports one, and its ETag through `If-Match` either way. Without the pin
 * a resume could splice the tail of whatever the key holds by then onto the
 * head of what it held before, and the consumer's digest would call that
 * damage rather than a flaky connection. An object that changed, vanished,
 * or answered without honouring the range fails the read instead.
 */
export async function streamObjectVersion(
  client: S3ClientLike,
  bucket: string,
  key: string,
  options: { bounds?: BodyReadBounds; version?: string } = {},
): Promise<
  { chunks: AsyncIterable<Uint8Array>; version?: string } | undefined
> {
  const bounds = options.bounds ?? DEFAULT_BODY_READ_BOUNDS;
  const startedAt = Date.now();
  let first: GetObjectResponse;
  try {
    first = await getObject(
      client,
      {
        Bucket: bucket,
        Key: key,
        VersionId: options.version,
      },
      bounds,
    );
  } catch (error) {
    if (isMissingObject(error)) return undefined;
    if (options.version !== undefined && isUnreadableVersion(error)) {
      return undefined;
    }
    throw error;
  }
  const version = storedVersion(first.VersionId);
  const etag = first.ETag;
  const size = first.ContentLength;
  // The whole-read budget grows with the body, so it bounds a drip without
  // failing a large object on a link that is merely slow.
  const bodyBounds = {
    ...bounds,
    maxReadMs: readBudgetMs(size ?? 0, bounds.maxReadMs),
  };

  async function* chunks(): AsyncGenerator<Uint8Array> {
    let body = first.Body;
    let offset = 0;
    for (let stalls = 0; ; ) {
      try {
        for await (const bytes of boundedChunks(body, bodyBounds, startedAt)) {
          offset += bytes.byteLength;
          yield bytes;
        }
        // A body that ends cleanly but short — a proxy's truncated range, a
        // dropped connection read as an end — would otherwise reach the
        // consumer's digest and be judged damage rather than a failed read.
        if (size !== undefined && offset !== size) {
          throw new BodyTruncatedError(
            `S3 object ${key} ended after ${offset} of its ${size} bytes`,
          );
        }
        return;
      } catch (error) {
        if (isResponseChecksumMismatch(error)) {
          throw new ObjectIntegrityError(key, { cause: error });
        }
        if (!(error instanceof BodyStallError)) throw error;
        stalls += 1;
        if (stalls >= bounds.attempts) {
          throw new Error(
            `S3 object body stalled ${bounds.attempts} times: ${key}`,
            { cause: error },
          );
        }
        // Everything arrived and only the end of the stream went missing.
        if (size !== undefined && offset === size) return;
        if (etag === undefined && version === undefined) {
          throw new Error(
            `S3 object body stalled and ${key} carries nothing to resume it against`,
            { cause: error },
          );
        }
        body = await resume(offset);
      }
    }
  }

  async function resume(offset: number): Promise<unknown> {
    let response: GetObjectResponse;
    try {
      response = await getObject(
        client,
        {
          Bucket: bucket,
          IfMatch: etag,
          Key: key,
          Range: `bytes=${offset}-`,
          VersionId: version ?? options.version,
        },
        bounds,
      );
    } catch (error) {
      if (isPreconditionFailed(error)) {
        throw new Error(`S3 object ${key} changed while it was being read`, {
          cause: error,
        });
      }
      if (isMissingObject(error)) {
        throw new Error(
          `S3 object ${key} disappeared while it was being read`,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
    const wanted =
      size === undefined
        ? `bytes ${offset}-`
        : `bytes ${offset}-${size - 1}/${size}`;
    const range = response.ContentRange;
    if (
      range === undefined ||
      (size === undefined ? !range.startsWith(wanted) : range !== wanted)
    ) {
      // No error: nobody is iterating this body to receive one.
      (response.Body as { destroy?: () => void }).destroy?.();
      throw new Error(
        `S3 answered a resume of ${key} from byte ${offset} with ${response.ContentRange ?? "the whole object"}`,
      );
    }
    return response.Body;
  }

  return version === undefined
    ? { chunks: chunks() }
    : { chunks: chunks(), version };
}

type GetObjectResponse = {
  Body?: unknown;
  ContentLength?: number;
  ContentRange?: string;
  ETag?: string;
  VersionId?: string;
};

async function getObject(
  client: S3ClientLike,
  input: ConstructorParameters<typeof GetObjectCommand>[0],
  bounds: BodyReadBounds,
): Promise<GetObjectResponse & { Body: unknown }> {
  const response = (await client.send(new GetObjectCommand(input), {
    requestTimeout: bounds.requestTimeoutMs,
  })) as GetObjectResponse;
  if (response.Body === undefined) {
    throw new Error(`S3 object has no body: ${input.Key}`);
  }
  return response as GetObjectResponse & { Body: unknown };
}

/**
 * A version id worth recording, or undefined. `"null"` is what S3 calls the
 * version of an object written while versioning was off or suspended, and it
 * is not a version in the sense that matters: the next unversioned write to
 * the key replaces it in place.
 */
export function storedVersion(value: string | undefined): string | undefined {
  return value === undefined || value === "" || value === "null"
    ? undefined
    : value;
}

/**
 * A version-specific read that names something other than an object version:
 * an id AWS cannot parse (400), or the id of a delete marker (405). The id
 * came from a manifest a worker wrote, so to the caller it is one more version
 * the store does not have — not an outage worth retrying.
 */
export function isUnreadableVersion(error: unknown): boolean {
  const value = awsError(error);
  return (
    value?.name === "InvalidArgument" ||
    value?.Code === "InvalidArgument" ||
    value?.name === "MethodNotAllowed" ||
    value?.Code === "MethodNotAllowed" ||
    value?.$metadata?.httpStatusCode === 400 ||
    value?.$metadata?.httpStatusCode === 405
  );
}

/**
 * The SDK's response checksum validation failing. It throws a plain Error
 * whose message is the only mark it carries, so this reads the message;
 * `checksum-mismatch.test.ts` drives the real client into it, and an SDK that
 * reports it differently fails there instead of passing damage off as an
 * ordinary read failure.
 */
function isResponseChecksumMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^Checksum mismatch: .* in response header "x-amz-checksum-/.test(
      error.message,
    )
  );
}

export function isMissingObject(error: unknown): boolean {
  const value = awsError(error);
  return (
    value?.name === "NoSuchKey" ||
    value?.name === "NoSuchVersion" ||
    value?.name === "NotFound" ||
    value?.$metadata?.httpStatusCode === 404
  );
}

/**
 * How S3 reports a failed `If-None-Match: *`. Implementations differ on where
 * they put the marker, so any of the three counts.
 */
export function isPreconditionFailed(error: unknown): boolean {
  const value = awsError(error);
  return (
    value?.name === "PreconditionFailed" ||
    value?.Code === "PreconditionFailed" ||
    value?.$metadata?.httpStatusCode === 412
  );
}

/**
 * The other answer a conditional write can get. S3 returns 409
 * `ConditionalRequestConflict` when two conditional writes to one key overlap,
 * and its contract says to retry — unlike 412, it is not a verdict about who
 * won. Treating it as fatal turns an ordinary race into a mirror failure.
 */
export function isConditionalConflict(error: unknown): boolean {
  const value = awsError(error);
  return (
    value?.name === "ConditionalRequestConflict" ||
    value?.Code === "ConditionalRequestConflict" ||
    value?.$metadata?.httpStatusCode === 409
  );
}

async function readIterable(
  body: AsyncIterable<Uint8Array | string>,
  bounds: BodyReadBounds,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const bytes of boundedChunks(body, bounds, Date.now())) {
    total += bytes.byteLength;
    if (total > bounds.maxBytes) {
      // Leaving the loop closes the body (boundedChunks' finally).
      throw new BodyLimitError(
        `S3 response body exceeded ${bounds.maxBytes} bytes`,
      );
    }
    parts.push(bytes);
  }
  return concatBytes(parts);
}

/**
 * A body's chunks with the stall and whole-read bounds applied, and nothing
 * accumulated. `startedAt` is when the read began, which for a resumed
 * stream is the first request, not this one. The body is closed whichever
 * way iteration ends before the peer finished it: a stall, the budget, or a
 * consumer that stopped asking.
 */
async function* boundedChunks(
  body: unknown,
  bounds: BodyReadBounds,
  startedAt: number,
): AsyncGenerator<Uint8Array> {
  // Iterating comes before `transformToByteArray()` even though SDK bodies
  // offer both: chunk arrival is the only progress signal there is, and
  // without it the bound would have to be a budget for the entire read, which
  // a large object would trip on a perfectly healthy connection.
  if (!(Symbol.asyncIterator in Object(body))) {
    yield await bodyBytes(body, bounds);
    return;
  }
  const iterator = (body as AsyncIterable<Uint8Array | string>)[
    Symbol.asyncIterator
  ]();
  let ended = false;
  try {
    for (;;) {
      const step = await withStallBound(
        iterator.next(),
        bounds.stallMs,
        (error) => closeBody(body, error, iterator),
      );
      if (step.done === true) {
        ended = true;
        return;
      }
      const part = step.value;
      const bytes =
        typeof part === "string"
          ? new TextEncoder().encode(part)
          : new Uint8Array(part);
      // Checked per chunk rather than on a timer: a body that keeps
      // delivering never lets the stall bound fire, so this is the only place
      // a drip is seen for what it is.
      if (Date.now() - startedAt > bounds.maxReadMs) {
        throw overLimit(
          body,
          iterator,
          `S3 response body took longer than ${bounds.maxReadMs}ms`,
        );
      }
      yield bytes;
    }
  } finally {
    if (!ended) release(body, iterator);
  }
}

/**
 * Lets go of a body nobody will finish reading, without an error: a stream
 * destroyed with one emits it, and here nobody is left listening.
 */
function release(
  body: unknown,
  iterator: AsyncIterator<Uint8Array | string>,
): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    (body as { destroy?: () => void }).destroy?.();
  } catch {
    // Best effort, as in closeBody.
  }
}

function overLimit(
  body: unknown,
  iterator: AsyncIterator<Uint8Array | string>,
  message: string,
): BodyLimitError {
  const error = new BodyLimitError(message);
  try {
    closeBody(body, error, iterator);
  } catch {
    // Best effort, as in withStallBound: the caller still gets the error.
  }
  return error;
}

async function withStallBound<T>(
  pending: Promise<T>,
  stallMs: number,
  close: (error: Error) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new BodyStallError(
            `S3 response body delivered nothing for ${stallMs}ms`,
          );
          try {
            close(error);
          } catch {
            // Letting go of the socket is best effort. A throw here must not
            // escape a timer callback and must not cost us the rejection —
            // that would leave the read pending, which is the hang this
            // whole bound exists to prevent.
          }
          reject(error);
        }, stallMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Lets go of a stalled body. `destroy()` is what releases the socket, which is
 * why a retry reaches a fresh connection rather than waiting behind the dead
 * one; an async iterable with no `destroy` is closed through `return()`.
 */
function closeBody(
  body: unknown,
  error: Error,
  iterator?: AsyncIterator<Uint8Array | string>,
): void {
  const destroy = (body as { destroy?: (cause?: Error) => void }).destroy;
  if (typeof destroy === "function") {
    destroy.call(body, error);
    return;
  }
  void Promise.resolve(iterator?.return?.()).catch(() => undefined);
}

function awsError(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  return error as {
    $metadata?: { httpStatusCode?: number };
    Code?: string;
    name?: string;
  };
}
