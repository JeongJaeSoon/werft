import { createHash, createHmac } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { SignatureV4 } from "@smithy/signature-v4";
import type {
  AwsCredentialIdentity,
  AwsCredentialIdentityProvider,
  Checksum,
  SourceData,
} from "@smithy/types";
import {
  BoundedNodeHttpHandler,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_BOUNDS,
  type S3RequestBounds,
} from "./s3.ts";
import { listPrefixWithin, objectKeyWithin } from "./scoped-objects.ts";

/**
 * The control plane's half of the object store route. A worker
 * holds no object store credential: its S3 requests go to the egress proxy,
 * which asks the API whether the attempt behind the token still owns its
 * session, and then whether this one request is one the session may make.
 * This module answers the second question and, when the answer is yes,
 * signs exactly that request with the API's own key. The key never leaves
 * the API; what leaves is a signature for one method, one key and one set of
 * headers, valid for the few minutes SigV4 allows.
 *
 * What a worker may do is what `createCheckpointObjectStore` does through a
 * store confined to the session prefix: get and head an object, create one
 * that does not exist yet (`putImmutable`; never an overwrite), and list
 * under the prefix. Nothing else is signed — no delete, no copy (its
 * source is a header), no legal hold or retention (the control plane owns
 * those), no multipart, no ACL.
 */

/** The worker's request as the proxy saw it, below the route's prefix. */
export type ObjectRouteRequest = {
  method: string;
  /** Path and query exactly as sent: `/<bucket>/<key>?<query>`. */
  target: string;
  /** Lowercased names; only those the proxy passes on (see the proxy). */
  headers: ReadonlyArray<readonly [string, string]>;
};

/** Where the proxy sends it and what it adds: nothing else of the worker's. */
export type ObjectRouteGrant = {
  kind: "signed";
  /** Origin only; `target` carries the whole path. */
  url: string;
  target: string;
  /** Signed, `content-length` included for a PUT; the host comes from `url`. */
  headers: Array<[string, string]>;
};

export type ObjectRouteRefusal = { kind: "refused"; reason: string };

export type ObjectRouteSigner = {
  sign(
    request: ObjectRouteRequest,
    scope: string,
  ): Promise<ObjectRouteGrant | ObjectRouteRefusal>;
};

export type ObjectRouteSignerConfig = {
  bucket: string;
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** Absent means AWS itself, over https. */
  endpoint?: string;
  region: string;
  /** Tests pin the signing clock. */
  now?: () => Date;
};

/**
 * The payload is not hashed: a checkpoint bundle is hundreds of MiB, the
 * proxy streams it, and the bytes are the worker's own to choose anyway —
 * what the signature must pin is where they go. S3 accepts this for header
 * signatures; the SDK's own checksum header, signed below, still lets S3
 * check the body.
 */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const CHECKSUM_ALGORITHMS = new Set([
  "CRC32",
  "CRC32C",
  "CRC64NVME",
  "SHA1",
  "SHA256",
]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DIGITS = /^(0|[1-9][0-9]{0,15})$/;
const PRINTABLE = /^[\x20-\x7e]+$/;

type Operation = "get" | "head" | "put" | "list";

/**
 * Header rules per operation: a value check for each header the operation
 * may carry. A header the worker sent that is not here refuses the request
 * rather than being dropped, so nothing that changes what S3 does with it —
 * `content-encoding: aws-chunked`, `x-amz-copy-source`, an Object Lock
 * header — is ever quietly lost or quietly signed.
 */
const HEADER_RULES: Record<
  Operation,
  Record<string, (value: string) => boolean>
> = {
  get: { "x-amz-checksum-mode": (value) => value === "ENABLED" },
  head: { "x-amz-checksum-mode": (value) => value === "ENABLED" },
  list: {},
  put: {
    "content-length": (value) => DIGITS.test(value),
    "content-md5": (value) => BASE64.test(value),
    "content-type": (value) => PRINTABLE.test(value),
    "if-none-match": (value) => value === "*",
    "x-amz-sdk-checksum-algorithm": (value) => CHECKSUM_ALGORITHMS.has(value),
    "x-amz-checksum-crc32": (value) => BASE64.test(value),
    "x-amz-checksum-crc32c": (value) => BASE64.test(value),
    "x-amz-checksum-crc64nvme": (value) => BASE64.test(value),
    "x-amz-checksum-sha1": (value) => BASE64.test(value),
    "x-amz-checksum-sha256": (value) => BASE64.test(value),
  },
};

/** Query parameters per operation; `x-id` is the SDK's label, never sent. */
const QUERY_RULES: Record<
  Operation,
  Record<string, (value: string) => boolean>
> = {
  get: { versionId: (value) => PRINTABLE.test(value) },
  head: { versionId: (value) => PRINTABLE.test(value) },
  list: {
    "continuation-token": (value) => PRINTABLE.test(value),
    "list-type": (value) => value === "2",
    prefix: () => true,
  },
  put: {},
};

const OPERATION_IDS: Record<Operation, string> = {
  get: "GetObject",
  head: "HeadObject",
  list: "ListObjectsV2",
  put: "PutObject",
};

/**
 * SigV4's URI encoding: RFC 3986 unreserved characters stay, everything
 * else is percent-encoded — `encodeURIComponent` less the five it spares.
 */
function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Strict: a malformed escape is a refusal, not a best guess. */
function decode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

type Parsed = {
  operation: Operation;
  key: string | null;
  query: Map<string, string>;
  headers: Map<string, string>;
};

function parse(
  request: ObjectRouteRequest,
  bucket: string,
  scope: string,
): Parsed | string {
  const { method, target } = request;
  if (!target.startsWith("/") || target.includes("#")) {
    return "the target is not a path";
  }
  const mark = target.indexOf("?");
  const rawPath = mark < 0 ? target : target.slice(0, mark);
  const rawQuery = mark < 0 ? "" : target.slice(mark + 1);
  const [first, ...rest] = rawPath.slice(1).split("/");
  if (first !== bucket) return "the bucket is not this installation's";

  let operation: Operation;
  let key: string | null = null;
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "")) {
    if (method !== "GET") return `${method} on the bucket is not routed`;
    operation = "list";
  } else {
    const segments: string[] = [];
    for (const raw of rest) {
      const segment = decode(raw);
      // An encoded slash would make one segment two once S3 decodes it.
      if (segment === null || segment.includes("/")) {
        return "the key is not plainly encoded";
      }
      segments.push(segment);
    }
    key = segments.join("/");
    if (!objectKeyWithin(scope, key)) {
      return "the key is outside the session's prefix";
    }
    if (method === "GET") operation = "get";
    else if (method === "HEAD") operation = "head";
    else if (method === "PUT") operation = "put";
    else return `${method} on an object is not routed`;
  }

  const query = new Map<string, string>();
  if (rawQuery !== "") {
    for (const piece of rawQuery.split("&")) {
      // A literal `+` reads as a space to some servers and a plus to others.
      if (piece === "" || piece.includes("+")) {
        return "the query is not plainly encoded";
      }
      const equals = piece.indexOf("=");
      const name = decode(equals < 0 ? piece : piece.slice(0, equals));
      const value = decode(equals < 0 ? "" : piece.slice(equals + 1));
      if (name === null || value === null) {
        return "the query is not plainly encoded";
      }
      if (query.has(name)) return `the query names ${name} twice`;
      query.set(name, value);
    }
  }
  const label = query.get("x-id");
  if (label !== undefined && label !== OPERATION_IDS[operation]) {
    return `the query labels the request ${label}`;
  }
  query.delete("x-id");
  const queryRules = QUERY_RULES[operation];
  for (const [name, value] of query) {
    const rule = queryRules[name];
    if (rule === undefined) return `the query parameter ${name} is not routed`;
    if (!rule(value)) return `the query parameter ${name} is malformed`;
  }
  if (operation === "list") {
    const prefix = query.get("prefix");
    if (query.get("list-type") !== "2" || prefix === undefined) {
      return "a list must be ListObjectsV2 with a prefix";
    }
    if (!listPrefixWithin(scope, prefix)) {
      return "the list prefix is outside the session's prefix";
    }
  }

  const headers = new Map<string, string>();
  const headerRules = HEADER_RULES[operation];
  for (const [name, value] of request.headers) {
    const rule = headerRules[name];
    if (rule === undefined) return `the header ${name} is not routed`;
    if (headers.has(name)) return `the header ${name} is repeated`;
    if (!rule(value)) return `the header ${name} is malformed`;
    headers.set(name, value);
  }
  if (operation === "put" && !headers.has("content-length")) {
    return "a PUT must say its length";
  }
  // Create-only, always: every worker write is `putImmutable`, and a PUT
  // signed before a takeover can still finish after it (the proxy regrants
  // every 30s). Unable to replace, such a late write adds at most an object
  // no committed checkpoint names.
  if (operation === "put" && headers.get("if-none-match") !== "*") {
    return "a PUT must be create-only (If-None-Match: *)";
  }
  return { operation, key, query, headers };
}

/** `Checksum` over node:crypto, the one SigV4 needs. */
class Sha256 implements Checksum {
  readonly #secret;
  #hash;
  constructor(secret?: SourceData) {
    this.#secret = secret === undefined ? undefined : toBytes(secret);
    this.#hash = this.#fresh();
  }
  #fresh() {
    return this.#secret === undefined
      ? createHash("sha256")
      : createHmac("sha256", this.#secret);
  }
  update(data: Uint8Array): void {
    this.#hash.update(data);
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.#hash.digest());
  }
  reset(): void {
    this.#hash = this.#fresh();
  }
}

function toBytes(data: SourceData): Uint8Array {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

/**
 * Where a key lives: path-style under a configured endpoint (LocalStack,
 * MinIO), virtual-hosted on AWS — unless the bucket has a dot, which the
 * wildcard certificate cannot cover.
 */
function addressOf(
  config: Pick<ObjectRouteSignerConfig, "bucket" | "endpoint" | "region">,
): { origin: URL; base: string } {
  if (config.endpoint !== undefined) {
    const endpoint = new URL(config.endpoint);
    return {
      origin: new URL(endpoint.origin),
      base: `${endpoint.pathname.replace(/\/$/, "")}/${config.bucket}`,
    };
  }
  if (config.bucket.includes(".")) {
    return {
      origin: new URL(`https://s3.${config.region}.amazonaws.com`),
      base: `/${config.bucket}`,
    };
  }
  return {
    origin: new URL(
      `https://${config.bucket}.s3.${config.region}.amazonaws.com`,
    ),
    base: "",
  };
}

export function createObjectRouteSigner(
  config: ObjectRouteSignerConfig,
): ObjectRouteSigner {
  const { origin, base } = addressOf(config);
  const signer = new SignatureV4({
    credentials: config.credentials,
    region: config.region,
    service: "s3",
    sha256: Sha256,
    // S3 wants each segment encoded once, as the target below already is.
    uriEscapePath: false,
    applyChecksum: false,
  });
  const now = config.now ?? (() => new Date());

  return {
    async sign(request, scope) {
      const parsed = parse(request, config.bucket, scope);
      if (typeof parsed === "string")
        return { kind: "refused", reason: parsed };
      const path =
        parsed.key === null
          ? `${base}/`
          : `${base}/${parsed.key.split("/").map(awsUriEncode).join("/")}`;
      // Sorted and encoded the way SigV4 canonicalizes it, so what is sent
      // is byte for byte what was signed.
      const query = [...parsed.query.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const search = query
        .map(([name, value]) => `${awsUriEncode(name)}=${awsUriEncode(value)}`)
        .join("&");
      const signed = await signer.sign(
        {
          method: request.method,
          protocol: origin.protocol,
          hostname: origin.hostname,
          ...(origin.port === "" ? {} : { port: Number(origin.port) }),
          path,
          query: Object.fromEntries(query),
          headers: {
            host: origin.host,
            "x-amz-content-sha256": UNSIGNED_PAYLOAD,
            ...Object.fromEntries(parsed.headers),
          },
        },
        { signingDate: now() },
      );
      const headers: Array<[string, string]> = [];
      for (const [name, value] of Object.entries(signed.headers)) {
        // The proxy names the host itself, from `url`.
        if (name.toLowerCase() === "host") continue;
        headers.push([name.toLowerCase(), value]);
      }
      return {
        kind: "signed",
        url: origin.origin,
        target: search === "" ? path : `${path}?${search}`,
        headers,
      };
    },
  };
}

/**
 * Stands in for a secret the worker does not have. The SDK signs with it and
 * the route ignores that signature: the token in the credential scope is
 * what it checks, and the API signs the request anew.
 */
const ROUTE_SIGNING_KEY = "object-store-route";

/**
 * The worker's side of the route: an ordinary S3 client whose endpoint is
 * the route and whose access key id is the claim's egress token, so the SDK
 * builds every request exactly as it would for S3. Plain http on the
 * worker's own network, reached directly (the proxy's name is in NO_PROXY).
 *
 * The token is read per request: it exists only once the claim is in, and
 * a store used before that fails rather than sending anything.
 */
export function createObjectRouteClient(
  route: { endpoint: string; region: string; token: () => string },
  bounds: S3RequestBounds = S3_REQUEST_BOUNDS,
): S3Client {
  return new S3Client({
    credentials: async () => ({
      accessKeyId: route.token(),
      secretAccessKey: ROUTE_SIGNING_KEY,
      // Near enough that the SDK asks again every time.
      expiration: new Date(Date.now() + 1_000),
    }),
    endpoint: route.endpoint,
    forcePathStyle: true,
    maxAttempts: S3_MAX_ATTEMPTS,
    region: route.region,
    requestHandler: new BoundedNodeHttpHandler(bounds),
  });
}
