import { isIP } from "node:net";
import type { Server } from "bun";
import { createProxyLogger, type ProxyLogger } from "./logger.ts";
import {
  classifyAddress,
  decideEgress,
  type EgressDecision,
  type EgressPolicy,
  type EgressResolver,
  normalizeHost,
} from "./policy.ts";
import { systemResolver } from "./proxy.ts";
import { REDACTED, sanitizeText } from "./redaction.ts";
import {
  failedBeforeRequest,
  type UpstreamBody,
  upstreamExchange,
} from "./upstream-http.ts";
import { type MessagesUsage, type UsageMeter, usageMeter } from "./usage.ts";

/**
 * The proxy's credential routes: the one place a worker's request
 * picks up a provider key or a repository login, which the worker itself
 * never holds. The worker presents an attempt-scoped token; the gateway's
 * authorizer says what it stands for right now and hands back the upstream
 * and the credential; the request goes there with the credential injected
 * and the token stripped.
 *
 * A listener of its own rather than a mode of the forward proxy: this one
 * has to understand each HTTP exchange — one request, its framing, its
 * headers — where the forward proxy deliberately only pipes bytes, and a
 * second request pipelined behind an authorized one must never reach the
 * upstream on its coat-tails. Bun's HTTP server does the framing. Plaintext
 * on the worker's side is fine: only the worker and this proxy sit on a
 * worker's network.
 *
 * Only the operations a session needs are routed — the Messages API, and
 * the read half of git's smart HTTP and of Git LFS — so a leaked token buys at most that,
 * for as long as its attempt still owns its session.
 *
 * The object store route is the one way a worker reaches its
 * objects: the store itself is not on its allowlist. The worker's S3 client
 * sends ordinary S3 requests here with its token as the access key id; the
 * authorizer judges each one against the session's prefix and signs it with
 * the API's key, and only what it signed — its target, its headers — goes
 * upstream. Nothing of the worker's request travels but the body.
 */

export const DEFAULT_CREDENTIAL_PORT = 3129;
const DEFAULT_AUTHORIZE_TIMEOUT_MS = 10_000;
/**
 * Waits between tries of one usage report. The report carries the exchange's
 * id, so a try whose answer was lost and the one after it charge once; a
 * report still refused after the last try goes uncounted, and says so.
 */
const DEFAULT_USAGE_REPORT_BACKOFF_MS = [1_000, 5_000, 15_000];
/**
 * One exchange, start to last byte. A clone of a large repository is one
 * exchange (the pack streams back on the upload-pack POST), and the worker
 * gives a clone 30 minutes, so this sits just above it.
 */
const DEFAULT_EXCHANGE_TIMEOUT_MS = 35 * 60_000;
const DEFAULT_MAX_EXCHANGES = 256;
/**
 * How often an open exchange asks again whether its grant still stands. A
 * revoked token stops new exchanges at once; one already streaming learns
 * of it here, so an attempt that lost its lease keeps an upstream call at
 * most this long rather than to the exchange deadline.
 */
const DEFAULT_REGRANT_INTERVAL_MS = 30_000;
/**
 * How long an open exchange may go without a fresh grant while the
 * authorizer cannot be asked. A blip passes; an outage long enough to hide
 * the attempt's end does not.
 */
const DEFAULT_REGRANT_GRACE_MS = 90_000;
const DEFAULT_MAX_EXCHANGES_PER_CLIENT = 32;
/** An error body bigger than this is not relayed at all. */
/**
 * The built-in MCP server's restart window: connection-stage failures are
 * dialled again, each time from a fresh lookup, until this budget is spent.
 * A dial is cut at the budget's end, so the wait stays under three seconds
 * plus the lookups.
 */
const BUILTIN_RETRY_BUDGET_MS = 3_000;
const BUILTIN_RETRY_BACKOFF_MS = [200, 400, 800];
const BUILTIN_CONNECT_TIMEOUT_MS = 500;
const BUILTIN_RETRY_AFTER_SECONDS = 5;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** How much of a refusing provider's error body the warn log keeps. */
const REFUSAL_EXCERPT_CHARS = 512;
const BUDGET_EXCEEDED = "BUDGET_EXCEEDED";
/**
 * The Messages API's own request limit (32 MB), with the upstream left to
 * judge the last few bytes. Held whole, so it is also this route's share of
 * the body budget below.
 */
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
/**
 * Twice the control plane's workspace bundle ceiling (256 MiB,
 * `DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES`), the largest object a worker writes.
 * Streamed, but Bun holds whatever arrives before the upstream takes it.
 */
const MAX_OBJECT_BODY_BYTES = 512 * 1024 * 1024;
/**
 * Request body bytes all exchanges together may hold. Bun takes a
 * body off the socket as fast as the client sends it, read or not, so a
 * body is held from the moment its request is admitted until its exchange
 * ends: the upstream answers from its head, while the body may still be
 * going out. Each admission reserves its declared length, or the route's
 * cap when it declares none, and one that does not fit is refused at once,
 * before Bun has taken any of it. Two of the largest bundles fit; the
 * container's mem_limit in infra/compose.core.yml is sized from this.
 */
export const DEFAULT_MAX_BODY_BYTES_IN_FLIGHT = 512 * 1024 * 1024;
/**
 * Bun's idle clock before a request is authorized: a client that opens a
 * connection and sends nothing is dropped. An authorized exchange runs on
 * the exchange deadline instead, since a non-streaming Messages call can
 * sit silent for minutes.
 */
const UNAUTHORIZED_IDLE_SECONDS = 30;

export type EgressPurpose =
  | "provider"
  | "repository"
  | "object_store"
  | "mcp"
  | "packages"
  | "judgment";

export type CredentialRoute = {
  purpose: EgressPurpose;
  server?: string;
  /** repository only: the catalog id the path named, for another repository. */
  repository?: string;
  /**
   * repository only: a Git LFS download batch, or one object the proxy
   * fetches from the location a batch answer names.
   */
  lfs?: "batch" | { oid: string; size: number };
  /** The packages route's registry name; the authorizer maps it to a host. */
  registry?: string;
  /**
   * A packages token carried as the `/_token/<token>` segment, already cut
   * from `path`: Go sends no credential to an http proxy in any header.
   */
  pathToken?: string;
  /** Path and query appended to the upstream's base. */
  path: string;
  search: string;
};

// `/v1/responses` is parsed here for every session, but only the authorizer
// knows the session's provider kind: it grants this path to an
// `openai_responses` session and refuses it to every other, and refuses the
// Messages paths to that session in turn.
const RESPONSES_PATH = "/v1/responses";

/**
 * Why a Responses request cannot be metered, or null. A `background` response
 * keeps generating after the connection that would meter it has closed; one
 * that continues a stored response or conversation is billed for context the
 * request does not carry, so a cut stream's input cannot be bounded by its
 * bytes. Both are refused outright.
 */
function unmeterableResponsesRequest(body: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const request = parsed as Record<string, unknown>;
  if (request.background === true) {
    return "a background response outlives the metered connection";
  }
  if (
    (request.previous_response_id ?? null) !== null ||
    (request.conversation ?? null) !== null
  ) {
    return "a stored response or conversation is not carried by the request";
  }
  if (carriesRemoteInput(request.input, 0)) {
    return "a file or image the request only names is not carried by it";
  }
  if ((request.prompt ?? null) !== null) {
    return "a stored prompt template is fetched by the upstream, not carried";
  }
  if (declaresOutsideTool(request.tools, 0)) {
    return "a tool the upstream runs on a host the catalog never named";
  }
  if (declaresOutsideTool(request.input, 0)) {
    return "a tool or generated image the upstream keeps outside the request";
  }
  return null;
}

// Tools the upstream runs itself: a remote MCP server, a vector store, a web
// search, a container, image generation. `function`, `custom`, `local_shell`
// and a `local` shell run on the worker and are not here. Names other than
// `mcp` and `file_search` are from the API reference, not a live request.
function isOutsideTool(tool: Record<string, unknown>): boolean {
  const type = tool.type;
  if (type === "shell") {
    const environment = tool.environment;
    return (
      typeof environment === "object" &&
      environment !== null &&
      (environment as Record<string, unknown>).type !== "local"
    );
  }
  return (
    type === "mcp" ||
    type === "file_search" ||
    type === "code_interpreter" ||
    type === "image_generation" ||
    type === "image_generation_call" ||
    (typeof type === "string" && type.startsWith("web_search"))
  );
}

// `tools`, and the `input` items that register tools of their own
// (`additional_tools`, `tool_search_output`) or reuse a generated image.
function declaresOutsideTool(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (depth > REMOTE_INPUT_DEPTH) return true;
  if (Array.isArray(value)) {
    return value.some((item) => declaresOutsideTool(item, depth + 1));
  }
  const item = value as Record<string, unknown>;
  return isOutsideTool(item) || declaresOutsideTool(item.tools, depth + 1);
}

// Deep enough for `input` items holding `content` parts, no deeper. Past it a
// part is refused rather than skipped: an unread part may name a remote file.
const REMOTE_INPUT_DEPTH = 6;

/**
 * Whether an input part names a file or image the upstream would fetch (by
 * id or URL) instead of carrying it: its size is not in the request bytes.
 * Inline `data:` images and `file_data` are carried, and so are fine.
 */
function carriesRemoteInput(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (depth > REMOTE_INPUT_DEPTH) return true;
  if (Array.isArray(value)) {
    return value.some((part) => carriesRemoteInput(part, depth + 1));
  }
  const part = value as Record<string, unknown>;
  if (part.type === "input_file") {
    return (part.file_id ?? null) !== null || (part.file_url ?? null) !== null;
  }
  // An item that only points at one stored upstream.
  if (part.type === "item_reference") return true;
  // `computer_screenshot` is a computer-use tool result's image.
  if (part.type === "input_image" || part.type === "computer_screenshot") {
    return (
      (part.file_id ?? null) !== null ||
      (typeof part.image_url === "string" &&
        !part.image_url.startsWith("data:"))
    );
  }
  // A message's parts are in `content`; a tool result's, in `output`.
  return (
    carriesRemoteInput(part.content, depth + 1) ||
    carriesRemoteInput(part.output, depth + 1)
  );
}
const PROVIDER_PATHS = new Set([
  "/v1/messages",
  "/v1/messages/count_tokens",
  RESPONSES_PATH,
]);
// The achievement judge's one call, made by the API with a judgment token.
const JUDGMENT_PATH = "/decisions/v1/decisions";
// Claude Code asks for the beta surface with `?beta=true`; nothing else.
const PROVIDER_QUERIES = new Set(["", "?beta=true"]);

const OBJECT_STORE_PREFIX = "/object-store";

// The streamable HTTP transport's three methods, on the server's one URL.
const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
const MCP_PATH = /^\/mcp\/([a-z0-9](?:[a-z0-9-]|_(?!_)){0,31})$/;
// `/repository/<id>/...`: a repository the session may fetch, named by its
// catalog id. The id is the authorizer's to judge; this only keeps it one
// segment. `/.git` is how a `https://github.com/<o>/<r>.git` URL comes out of
// the worker's `insteadOf`.
const REPOSITORY_PATH =
  /^\/repository\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/\.git)?(\/info\/refs|\/git-upload-pack)$/;
// The worker's routes all end in `/.git`, which Git LFS keeps as is when it
// puts its endpoint at the remote URL plus `/info/lfs`. The object path is the
// proxy's own: the batch answer's hrefs are rewritten to it.
const LFS_PATH =
  /^\/repository\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/\.git\/info\/lfs\/objects\/(batch|[0-9a-f]{64})$/;
const LFS_OBJECT_QUERY = /^\?size=(0|[1-9][0-9]{0,15})$/;
const LFS_MEDIA_TYPE = "application/vnd.git-lfs+json";
// The Git LFS API's own ceiling on objects per batch.
const MAX_LFS_BATCH_OBJECTS = 100;
// A hundred objects with presigned hrefs fit many times over.
const MAX_LFS_BATCH_ANSWER_BYTES = 1024 * 1024;

// Reads only: a publish, an unpublish or a yank has no route.
const PACKAGES_METHODS = new Set(["GET", "HEAD"]);
const PACKAGES_PATH = /^\/packages\/([a-z][a-z0-9-]{0,31})(\/.*)$/;
// No npm name starts with `_`, a Go module path's first element holds a dot,
// and the checksum database's paths are fixed, so no registry path is this.
const PACKAGES_TOKEN_SEGMENT = /^\/_token\/([A-Za-z0-9_-]{1,256})(\/.*)$/;
const MAX_PACKAGE_REDIRECTS = 5;
// A 304 answers a cache revalidation and carries no location to follow.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A segment the upstream would resolve as `.` or `..` once decoded, which
 * would step out of the registry's base path; `%2f` inside a segment is how
 * npm names a scoped package, and passes.
 */
function climbs(path: string): boolean {
  return path.split("/").some((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === "." || decoded === "..";
  });
}

/** The exact operations routed, or null for everything else. */
export function routeOf(
  method: string,
  pathname: string,
  search: string,
): CredentialRoute | null {
  // Every object store request is the authorizer's to judge, so a refused
  // delete answers like S3 would, not as a missing route.
  if (pathname.startsWith(`${OBJECT_STORE_PREFIX}/`)) {
    return {
      purpose: "object_store",
      path: pathname.slice(OBJECT_STORE_PREFIX.length),
      search,
    };
  }
  const server = MCP_PATH.exec(pathname)?.[1];
  if (server !== undefined) {
    return MCP_METHODS.has(method) && search === ""
      ? { purpose: "mcp", server, path: "", search }
      : null;
  }
  const packages = PACKAGES_PATH.exec(pathname);
  if (packages !== null) {
    const [, registry = "", full = ""] = packages;
    if (full.startsWith("/_token/") && !PACKAGES_TOKEN_SEGMENT.test(full)) {
      return null;
    }
    const [, pathToken, path = full] = PACKAGES_TOKEN_SEGMENT.exec(full) ?? [];
    if (pathToken !== undefined && path.startsWith("/_token/")) return null;
    // `//` would make the upstream target a protocol-relative URL.
    return PACKAGES_METHODS.has(method) && !path.includes("//") && !climbs(path)
      ? {
          purpose: "packages",
          registry,
          ...(pathToken === undefined ? {} : { pathToken }),
          path,
          search,
        }
      : null;
  }
  if (pathname === JUDGMENT_PATH) {
    return method === "POST" && search === ""
      ? { purpose: "judgment", path: "/v1/decisions", search }
      : null;
  }
  if (pathname.startsWith("/provider/")) {
    const path = pathname.slice("/provider".length);
    if (
      method === "POST" &&
      PROVIDER_PATHS.has(path) &&
      PROVIDER_QUERIES.has(search) &&
      // `?beta=true` is Claude Code's; the Responses API takes no query here.
      (path !== RESPONSES_PATH || search === "")
    ) {
      return { purpose: "provider", path, search };
    }
    return null;
  }
  // Only upload-pack, the read half: receive-pack (a push) has no route, and
  // its advertisement gets the push notice before this is asked.
  if (
    method === "GET" &&
    pathname === "/repository/info/refs" &&
    search === "?service=git-upload-pack"
  ) {
    return { purpose: "repository", path: "/info/refs", search };
  }
  if (
    method === "POST" &&
    pathname === "/repository/git-upload-pack" &&
    search === ""
  ) {
    return { purpose: "repository", path: "/git-upload-pack", search };
  }
  const [, repository, path] = REPOSITORY_PATH.exec(pathname) ?? [];
  if (repository !== undefined && path !== undefined) {
    const upload =
      path === "/info/refs"
        ? method === "GET" && search === "?service=git-upload-pack"
        : method === "POST" && search === "";
    return upload ? { purpose: "repository", repository, path, search } : null;
  }
  const [, lfsRepository, operation] = LFS_PATH.exec(pathname) ?? [];
  if (lfsRepository !== undefined && operation !== undefined) {
    if (operation === "batch") {
      return method === "POST" && search === ""
        ? {
            purpose: "repository",
            repository: lfsRepository,
            lfs: "batch",
            path: "/info/lfs/objects/batch",
            search,
          }
        : null;
    }
    const size = LFS_OBJECT_QUERY.exec(search)?.[1];
    return method === "GET" && size !== undefined
      ? {
          purpose: "repository",
          repository: lfsRepository,
          lfs: { oid: operation, size: Number(size) },
          path: "/info/lfs/objects/batch",
          search: "",
        }
      : null;
  }
  return null;
}

export const PUSH_NOTICE =
  "git push does not reach GitHub here. Push and open pull requests with the platform's GitHub tools (mcp__github__request_push, mcp__github__open_pull_request). If this agent has no GitHub tools, an administrator turns GitHub on in the agent's GitHub tab.";

/**
 * A push's first request, the receive-pack advertisement, on any repository
 * route. Push still has no route; this one request gets {@link pushNotice}.
 */
export function isPushAdvertisement(
  method: string,
  pathname: string,
  search: string,
): boolean {
  if (method !== "GET" || search !== "?service=git-receive-pack") return false;
  return (
    pathname === "/repository/info/refs" ||
    REPOSITORY_PATH.exec(pathname)?.[2] === "/info/refs"
  );
}

/**
 * One `ERR` pkt-line in place of the advertisement, which git prints as
 * `fatal: remote error: <notice>`. The same for every caller, so it asks
 * the authorizer nothing and tells nothing about the token or the session.
 */
export function pushNotice(): Response {
  const line = new TextEncoder().encode(`ERR ${PUSH_NOTICE}\n`);
  const length = (line.length + 4).toString(16).padStart(4, "0");
  return new Response(new Blob([length, line]), {
    status: 200,
    headers: {
      "content-type": "application/x-git-receive-pack-advertisement",
      "cache-control": "no-cache",
    },
  });
}

/**
 * A worker's LFS batch as it goes upstream: a download, of objects named by
 * a SHA-256 and a size, and nothing else it sent. An upload has no route, as
 * receive-pack has none.
 */
export function lfsDownloadBatch(body: Uint8Array): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.operation !== "download") return null;
  const { objects } = parsed;
  if (
    !Array.isArray(objects) ||
    objects.length === 0 ||
    objects.length > MAX_LFS_BATCH_OBJECTS
  ) {
    return null;
  }
  const named: Array<{ oid: string; size: number }> = [];
  for (const object of objects) {
    if (
      !isRecord(object) ||
      typeof object.oid !== "string" ||
      !/^[0-9a-f]{64}$/.test(object.oid) ||
      !Number.isSafeInteger(object.size) ||
      (object.size as number) < 0
    ) {
      return null;
    }
    named.push({ oid: object.oid, size: object.size as number });
  }
  return lfsBatchBody(named);
}

function lfsBatchBody(objects: Array<{ oid: string; size: number }>) {
  return new TextEncoder().encode(
    JSON.stringify({ operation: "download", transfers: ["basic"], objects }),
  );
}

/**
 * A batch answer as the worker gets it: each download pointed at the proxy's
 * own object path under `objectBase`, so the storage location, a capability
 * of its own, never reaches the worker, and nothing else the server offered
 * (an upload, a header) goes along.
 */
export function lfsBatchForWorker(
  answer: unknown,
  objectBase: string,
): Record<string, unknown> | null {
  if (!isRecord(answer) || !Array.isArray(answer.objects)) return null;
  const objects: Array<Record<string, unknown>> = [];
  for (const object of answer.objects) {
    if (
      !isRecord(object) ||
      typeof object.oid !== "string" ||
      !/^[0-9a-f]{64}$/.test(object.oid) ||
      !Number.isSafeInteger(object.size)
    ) {
      return null;
    }
    const kept: Record<string, unknown> = {
      oid: object.oid,
      size: object.size,
    };
    if (isRecord(object.error)) {
      // The server's message is free text that can name anything; the code
      // is what git-lfs acts on.
      kept.error = {
        code: Number.isSafeInteger(object.error.code) ? object.error.code : 500,
        message: "the LFS server refused this object",
      };
    }
    const download = isRecord(object.actions)
      ? object.actions.download
      : undefined;
    if (isRecord(download) && typeof download.href === "string") {
      kept.authenticated = true;
      kept.actions = {
        download: {
          href: `${objectBase}/${object.oid}?size=${object.size}`,
          ...(typeof download.expires_in === "number"
            ? { expires_in: download.expires_in }
            : {}),
          ...(typeof download.expires_at === "string"
            ? { expires_at: download.expires_at }
            : {}),
        },
      };
    }
    objects.push(kept);
  }
  return { transfer: "basic", objects };
}

/** Where a batch answer says to download `oid`, if it says so plainly. */
export function lfsDownloadHref(answer: unknown, oid: string): URL | null {
  if (!isRecord(answer) || !Array.isArray(answer.objects)) return null;
  const object = answer.objects.find(
    (candidate) => isRecord(candidate) && candidate.oid === oid,
  );
  const download =
    isRecord(object) && isRecord(object.actions)
      ? object.actions.download
      : undefined;
  if (!isRecord(download) || typeof download.href !== "string") return null;
  const href = URL.parse(download.href);
  return href !== null &&
    (href.protocol === "https:" || href.protocol === "http:") &&
    href.username === "" &&
    href.password === ""
    ? href
    : null;
}

export type McpCall = { method: string | null; tool: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A key another parser could read as one of these (a case-insensitive
// one, say) would let the upstream act on a method the authorizer never saw.
function hasLookalike(record: Record<string, unknown>, keys: string[]) {
  return Object.keys(record).some((key) => {
    const lower = key.toLowerCase();
    return keys.includes(lower) && key !== lower;
  });
}

/**
 * What the authorizer is shown of an MCP POST, and the body sent upstream:
 * re-serialized, so a duplicate key the authorizer's parse dropped never
 * reaches a parser that keeps the other one. One message only; a batch
 * could hide a refused call among allowed ones. A response to the server
 * (no method) passes as nulls. null for a body that is none of these.
 */
export function mcpCallOf(
  body: Uint8Array,
): { call: McpCall; body: Uint8Array } | null {
  let message: unknown;
  try {
    message = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch {
    return null;
  }
  if (!isRecord(message) || hasLookalike(message, ["method", "params"])) {
    return null;
  }
  const { method, params } = message;
  const canonical = new TextEncoder().encode(JSON.stringify(message));
  if (method === undefined) {
    return { call: { method: null, tool: null }, body: canonical };
  }
  if (typeof method !== "string" || method === "") return null;
  if (method !== "tools/call") {
    return { call: { method, tool: null }, body: canonical };
  }
  if (!isRecord(params) || hasLookalike(params, ["name"])) return null;
  const { name } = params;
  return typeof name === "string" && name !== ""
    ? { call: { method, tool: name }, body: canonical }
    : null;
}

const BEARER = /^Bearer ([!-~]+)$/;
/** An S3 client's header signature; the access key id is the token. */
const SIGV4 = /^AWS4-HMAC-SHA256 Credential=([A-Za-z0-9_-]+)\//;
/**
 * Bundler and Go send a URL's userinfo as Basic, and neither can be given a
 * bearer, so the packages route takes the token as the password; the user
 * name is anything.
 */
const BASIC = /^Basic ([A-Za-z0-9+/]+={0,2})$/;

function basicPassword(encoded: string): string | null {
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return decoded.includes(":") && /^[!-~]+$/.test(password) ? password : null;
}

/**
 * The one token the request carries. Two carriers — an `x-api-key` beside an
 * `authorization`, even equal ones — are refused: which one an upstream
 * would have read is exactly the ambiguity to avoid.
 */
export function tokenOf(
  headers: Headers,
  purpose: EgressPurpose,
): string | null {
  const apiKey = headers.get("x-api-key");
  const authorization = headers.get("authorization");
  if (purpose === "object_store") {
    if (apiKey !== null || authorization === null) return null;
    return SIGV4.exec(authorization)?.[1] ?? null;
  }
  if (apiKey !== null && authorization !== null) return null;
  if (authorization !== null && purpose === "packages") {
    const basic = BASIC.exec(authorization)?.[1];
    if (basic !== undefined) return basicPassword(basic);
  }
  if (authorization !== null) return BEARER.exec(authorization)?.[1] ?? null;
  if (apiKey !== null && purpose === "provider" && /^[!-~]+$/.test(apiKey)) {
    return apiKey;
  }
  return null;
}

export type EgressGrant = {
  /** A session route's grant: the attempt its use is charged to. */
  sessionId: string | null;
  attemptId: string | null;
  /** The judgment route's grant: the judgment its use is charged to. */
  judgmentId: string | null;
  upstream: URL;
  headers: Array<[string, string]>;
  /**
   * The object store route's request line as signed, path and query; null
   * for the other routes, whose path comes from the route itself.
   */
  target: string | null;
  /** The upstream was a `/mcp/<name>` path on the authorizer's listener. */
  builtin: boolean;
};

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const REQUEST_TARGET = /^\/[!-~]*$/;

/**
 * The authorizer's answer, checked field by field: the proxy has no schema
 * library, and it is about to put these bytes on the wire with a credential
 * in them.
 */
export function parseGrant(
  body: unknown,
  /**
   * The authorizer asked. An MCP upstream given as a `/mcp/<name>` path is a
   * server the API serves itself on that listener, which no worker reaches.
   */
  authorizer?: URL,
): EgressGrant | null {
  if (typeof body !== "object" || body === null) return null;
  const { session_id, attempt_id, judgment_id, upstream } = body as Record<
    string,
    unknown
  >;
  const session =
    typeof session_id === "string" &&
    typeof attempt_id === "string" &&
    judgment_id === undefined;
  const judgment =
    typeof judgment_id === "string" &&
    session_id === undefined &&
    attempt_id === undefined;
  if (!session && !judgment) return null;
  if (typeof upstream !== "object" || upstream === null) return null;
  const { url, headers, target } = upstream as Record<string, unknown>;
  if (typeof url !== "string" || !Array.isArray(headers)) return null;
  if (
    target !== undefined &&
    (typeof target !== "string" || !REQUEST_TARGET.test(target))
  ) {
    return null;
  }
  const builtin = authorizer !== undefined && MCP_PATH.test(url);
  let parsed: URL;
  try {
    parsed = builtin ? new URL(url, authorizer) : new URL(url);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  const pairs: Array<[string, string]> = [];
  for (const entry of headers) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      !HEADER_NAME.test(entry[0]) ||
      !HEADER_VALUE.test(entry[1])
    ) {
      return null;
    }
    pairs.push([entry[0].toLowerCase(), entry[1]]);
  }
  return {
    sessionId: session ? (session_id as string) : null,
    attemptId: session ? (attempt_id as string) : null,
    judgmentId: judgment ? (judgment_id as string) : null,
    upstream: parsed,
    headers: pairs,
    target: target ?? null,
    builtin,
  };
}

/**
 * What of an S3 request the authorizer is shown, to judge and sign: the
 * standard headers that change what S3 does, and every `x-amz-` header but
 * the ones a signature is made of, which it replaces. The rest (the SDK's
 * user agent and invocation ids) is dropped. The authorizer refuses any
 * header it does not know, so a copy source or an Object Lock header is a
 * refusal, not a header quietly lost on the way.
 */
const OBJECT_REQUEST_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-md5",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "range",
]);
const SIGNATURE_HEADERS = new Set([
  "x-amz-content-sha256",
  "x-amz-date",
  "x-amz-security-token",
  "x-amz-user-agent",
]);

type ObjectRequest = {
  method: string;
  target: string;
  headers: Array<[string, string]>;
};

function objectRequestOf(
  method: string,
  target: string,
  incoming: Headers,
): ObjectRequest {
  const headers: Array<[string, string]> = [];
  incoming.forEach((value, name) => {
    if (
      OBJECT_REQUEST_HEADERS.has(name) ||
      (name.startsWith("x-amz-") && !SIGNATURE_HEADERS.has(name))
    ) {
      headers.push([name, value]);
    }
  });
  return { method, target, headers };
}

/**
 * The credentials in an object store grant, for the echo checks: the API's
 * access key id inside the signature, and a session token if it signs with
 * one. The rest of what it adds (a date, a length, a signature good for one
 * request) is not worth withholding a response over.
 */
function objectStoreSecrets(grant: EgressGrant): string[] {
  const found: string[] = [];
  for (const [name, value] of grant.headers) {
    if (name === "x-amz-security-token") found.push(value);
    if (name === "authorization") {
      const keyId = /Credential=([^/,\s]+)\//.exec(value)?.[1];
      if (keyId !== undefined) found.push(keyId);
    }
  }
  return found;
}

/** Headers that describe this hop, or that this proxy sets itself. */
const DROPPED_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "authorization",
  "connection",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
  // The injected key reaches whatever organization or project the worker
  // names here, so the connection's own default is the only one.
  "openai-organization",
  "openai-project",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function nominated(headers: Headers): Set<string> {
  return new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ""),
  );
}

export function upstreamRequestHeaders(
  incoming: Headers,
  grant: EgressGrant,
): Headers {
  const byConnection = nominated(incoming);
  const outgoing = new Headers();
  incoming.forEach((value, name) => {
    if (DROPPED_REQUEST_HEADERS.has(name) || byConnection.has(name)) return;
    outgoing.append(name, value);
  });
  outgoing.set("host", grant.upstream.host);
  // Identity so an error body can be checked for the credential below; a
  // compressed one could carry it unseen.
  outgoing.set("accept-encoding", "identity");
  for (const [name, value] of grant.headers) outgoing.set(name, value);
  return outgoing;
}

/**
 * A header that echoes the injected credential, in its value or its name
 * (which arrives lowercased), is dropped, not relayed.
 */
export function responseHeaders(
  incoming: Headers,
  secrets: readonly string[],
): Headers {
  const byConnection = nominated(incoming);
  const outgoing = new Headers();
  incoming.forEach((value, name) => {
    if (DROPPED_RESPONSE_HEADERS.has(name) || byConnection.has(name)) return;
    if (
      secrets.some(
        (secret) =>
          value.includes(secret) || name.includes(secret.toLowerCase()),
      )
    ) {
      return;
    }
    outgoing.append(name, value);
  });
  return outgoing;
}

/**
 * Shortest injected value a streamed body is checked for. A pack file is
 * arbitrary bytes, and a four-byte password would turn up in a large one by
 * chance; at eight the odds are nil. A catalog credential shorter than that
 * is still kept out of headers and error bodies, just not out of a stream.
 */
const MIN_STREAMED_SECRET_BYTES = 8;

/** Length of the longest tail of `window` that some needle starts with. */
function pendingPrefix(window: Buffer, needles: readonly Buffer[]): number {
  let longest = 0;
  for (const needle of needles) {
    const most = Math.min(needle.byteLength - 1, window.byteLength);
    for (let size = most; size > longest; size--) {
      if (
        window
          .subarray(window.byteLength - size)
          .equals(needle.subarray(0, size))
      ) {
        longest = size;
        break;
      }
    }
  }
  return longest;
}

/**
 * Passes a successful body through unless it contains the credential: the
 * tail that could be the start of one is held back until the next chunk
 * shows it is not, and a match errors the stream before any of its bytes
 * are written. The worker sees a broken response, never the value.
 */
export function secretGuard(
  secrets: readonly string[],
  onMatch: () => void = () => {},
): TransformStream<Uint8Array, Uint8Array> {
  const needles = secrets
    .map((secret) => Buffer.from(secret, "utf8"))
    .filter((needle) => needle.byteLength >= MIN_STREAMED_SECRET_BYTES);
  let carry = Buffer.alloc(0);
  return new TransformStream({
    transform(chunk, controller) {
      if (needles.length === 0) {
        controller.enqueue(chunk);
        return;
      }
      const window = Buffer.concat([carry, chunk]);
      if (needles.some((needle) => window.includes(needle))) {
        onMatch();
        controller.error(new Error("upstream body echoed the credential"));
        return;
      }
      // Only a tail that could still become a value waits; anything else,
      // like the blank line closing an event, goes out now.
      const cut = window.byteLength - pendingPrefix(window, needles);
      if (cut > 0) controller.enqueue(new Uint8Array(window.subarray(0, cut)));
      carry = window.subarray(cut);
    },
    flush(controller) {
      if (carry.byteLength > 0) controller.enqueue(new Uint8Array(carry));
    },
  });
}

/** Every spelling of the injected credential an upstream might echo. */
export function secretsOf(grant: EgressGrant): string[] {
  const found = new Set<string>();
  for (const [, value] of grant.headers) {
    found.add(value);
    const [scheme, rest] = value.split(" ", 2);
    if (rest === undefined) continue;
    found.add(rest);
    if (scheme?.toLowerCase() === "basic") {
      const decoded = Buffer.from(rest, "base64").toString("utf8");
      found.add(decoded);
      const colon = decoded.indexOf(":");
      if (colon >= 0) found.add(decoded.slice(colon + 1));
    }
  }
  return [...found].filter((secret) => secret.length >= 4);
}

type AuthorizerClient = {
  url: string;
  token: string;
  timeoutMs?: number;
};

export type CredentialProxyOptions = {
  authorizer: AuthorizerClient;
  /** How long one exchange may take, admission to last response byte. */
  exchangeTimeoutMs?: number;
  /**
   * Starts one exchange's deadline; `AbortSignal.timeout` when absent.
   * Tests pass their own signal so a deadline fires when they say, not when
   * a loaded runner gets round to it.
   */
  exchangeDeadline?: (timeoutMs: number) => AbortSignal;
  hostname?: string;
  logger?: ProxyLogger;
  maxExchanges?: number;
  maxExchangesPerClient?: number;
  maxBodyBytesInFlight?: number;
  policy: EgressPolicy;
  /**
   * Where the packages route follows a registry's redirect, and where the
   * repository route fetches an LFS object from; nowhere when absent.
   */
  packagesRedirect?: EgressPolicy;
  port?: number;
  regrantGraceMs?: number;
  regrantIntervalMs?: number;
  resolve?: EgressResolver;
  /** Waits between tries of a usage report the authorizer could not take. */
  usageReportBackoffMs?: readonly number[];
  /** Roots for https upstreams; tests name a private CA. */
  upstreamCa?: string;
};

export type CredentialProxyServer = {
  readonly port: number;
  stop(): void;
};

type Authorized =
  | { kind: "granted"; grant: EgressGrant }
  | {
      kind: "refused";
      status: number;
      budgetExceeded?: true;
      receiptId?: string;
    };

const RECEIPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function receiptOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { receipt_id } = body as { receipt_id?: unknown };
  return typeof receipt_id === "string" && RECEIPT_ID.test(receipt_id)
    ? receipt_id
    : null;
}

function isBudgetRefusal(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === BUDGET_EXCEEDED
  );
}

export function startCredentialProxy(
  options: CredentialProxyOptions,
): CredentialProxyServer {
  const logger = options.logger ?? createProxyLogger();
  const resolve = options.resolve ?? systemResolver;
  const exchangeTimeoutMs =
    options.exchangeTimeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
  const exchangeDeadline =
    options.exchangeDeadline ?? ((ms: number) => AbortSignal.timeout(ms));
  const maxExchanges = options.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  const regrantIntervalMs =
    options.regrantIntervalMs ?? DEFAULT_REGRANT_INTERVAL_MS;
  const regrantGraceMs = options.regrantGraceMs ?? DEFAULT_REGRANT_GRACE_MS;
  const maxPerClient =
    options.maxExchangesPerClient ?? DEFAULT_MAX_EXCHANGES_PER_CLIENT;
  const authorizeUrl = new URL("/authorize", options.authorizer.url);
  const usageUrl = new URL("/usage", options.authorizer.url);
  const usageBackoffMs =
    options.usageReportBackoffMs ?? DEFAULT_USAGE_REPORT_BACKOFF_MS;
  const maxBodyBytes =
    options.maxBodyBytesInFlight ?? DEFAULT_MAX_BODY_BYTES_IN_FLIGHT;
  const packagesRedirect = options.packagesRedirect ?? {
    allow: [],
    allowPrivate: [],
  };
  // One entry per session that lost a report, never evicted: dropping one
  // would re-approve a session whose stored cost is still too low.
  const unreportedSessions = new Set<string>();
  let open = 0;
  let bodyBytes = 0;
  const perClient = new Map<string, number>();

  function reply(
    status: number,
    message: string,
    purpose?: EgressPurpose,
  ): Response {
    if (purpose === "object_store") return s3Error(status, message);
    return new Response(`${message}\n`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  function builtinUnavailable(): Response {
    return new Response(
      "the control plane is unreachable, probably restarting; retry the tool call in a few seconds\n",
      {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": String(BUILTIN_RETRY_AFTER_SECONDS),
        },
      },
    );
  }

  // In the called API's error shape, so the engine shows why it was
  // refused. The turn's reason comes from the session's spend at finalize,
  // not from this text.
  function budgetExceededReply(path: string): Response {
    const message = `${BUDGET_EXCEEDED}: the session has reached its cost or token limit`;
    return Response.json(
      path === RESPONSES_PATH
        ? {
            error: { type: "permission_error", code: BUDGET_EXCEEDED, message },
          }
        : { type: "error", error: { type: "permission_error", message } },
      { status: 403 },
    );
  }

  async function authorize(
    token: string,
    purpose: EgressPurpose,
    question: Record<string, unknown>,
  ): Promise<Authorized> {
    let response: Response;
    try {
      response = await fetch(authorizeUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.authorizer.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ token, purpose, ...question }),
        redirect: "error",
        signal: AbortSignal.timeout(
          options.authorizer.timeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      logger.warn("Egress authorizer unreachable", {
        error: error instanceof Error ? error.name : "error",
      });
      return { kind: "refused", status: 503 };
    }
    if (response.status !== 200) {
      // Its reasons stay with it: the worker learns only that it was refused,
      // and whether the session's budget is spent, which its turn reports.
      const refusal: unknown =
        response.status === 403
          ? await response.json().catch(() => null)
          : await response.body?.cancel();
      const status = [401, 403, 409].includes(response.status)
        ? response.status
        : 503;
      if (status === 503) {
        logger.warn("Egress authorizer failed", { status: response.status });
      }
      if (isBudgetRefusal(refusal)) {
        return { kind: "refused", status, budgetExceeded: true };
      }
      const receiptId = receiptOf(refusal);
      return receiptId === null
        ? { kind: "refused", status }
        : { kind: "refused", status, receiptId };
    }
    const grant = parseGrant(
      await response.json().catch(() => null),
      authorizeUrl,
    );
    if (grant === null) {
      logger.error("Egress authorizer answered something unusable", {});
      return { kind: "refused", status: 503 };
    }
    return { kind: "granted", grant };
  }

  // What one Messages call used goes to the API, which prices it and adds it
  // to the session's cost. After the exchange, never in its way
  // the worker already has its answer, and the ids come from the grant, so
  // an attempt that has since lost its session is still charged for it.
  async function reportUsage(
    grant: EgressGrant,
    exchangeId: string,
    usage: MessagesUsage,
  ): Promise<void> {
    const charged =
      grant.judgmentId === null
        ? { session_id: grant.sessionId, attempt_id: grant.attemptId }
        : { judgment_id: grant.judgmentId };
    const fields = { ...charged, exchange_id: exchangeId, model: usage.model };
    const body = JSON.stringify({ exchange_id: exchangeId, ...charged, usage });
    for (let tried = 0; ; tried++) {
      let status: number | null = null;
      try {
        const response = await fetch(usageUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.authorizer.token}`,
            "content-type": "application/json",
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(
            options.authorizer.timeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS,
          ),
        });
        status = response.status;
        await response.body?.cancel();
      } catch {}
      if (status !== null && status >= 200 && status < 300) return;
      // A refusal is an answer about the report, and asking again would get
      // the same one; only an authorizer that could not answer is retried.
      const backoff = usageBackoffMs[tried];
      if ((status !== null && status < 500) || backoff === undefined) {
        logger.error("Provider usage went unreported", { ...fields, status });
        // Fail closed: the session's stored cost now undercounts, so its
        // later provider calls are refused as a spent budget.
        if (grant.sessionId !== null) unreportedSessions.add(grant.sessionId);
        return;
      }
      await Bun.sleep(backoff);
    }
  }

  async function authorizerDestination(host: string): Promise<EgressDecision> {
    try {
      const addresses = await resolve(host);
      return addresses.length === 0
        ? {
            allowed: false,
            failure: "unresolved",
            reason: "host does not resolve",
          }
        : { allowed: true, scope: "private", addresses };
    } catch {
      return {
        allowed: false,
        failure: "unresolved",
        reason: "host does not resolve",
      };
    }
  }

  /** Where `upstream` may be dialled under `policy`, or the refusal to send. */
  async function dialable(
    upstream: URL,
    // null: the API's own built-in MCP server, on the authorizer's listener.
    policy: EgressPolicy | null,
    purpose: EgressPurpose,
    who: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<Dialable | Response> {
    const host = normalizeHost(upstream.hostname);
    const port =
      upstream.port === ""
        ? upstream.protocol === "https:"
          ? 443
          : 80
        : Number(upstream.port);
    const fields = { ...who, host, port };
    const decision = await untilEnded(
      policy === null
        ? authorizerDestination(host)
        : decideEgress(policy, { host, port }, resolve),
      signal,
    );
    if (!decision.allowed) {
      if (decision.failure === "unresolved") {
        logger.warn("Credential route lookup failed", {
          ...fields,
          reason: decision.reason,
        });
        return reply(502, decision.reason, purpose);
      }
      logger.warn("Credential route denied", {
        ...fields,
        reason: decision.reason,
      });
      return reply(403, `egress denied: ${decision.reason}`, purpose);
    }
    // A privately listed name may resolve publicly for a worker's own
    // traffic, but a name that carries a login stays inside: an internal git
    // host whose DNS now points outside must not be handed the password.
    const outside = decision.addresses.find(
      (address) => classifyAddress(address) === "public",
    );
    if (decision.scope === "private" && outside !== undefined) {
      logger.warn("Credential route denied", {
        ...fields,
        reason: `${outside} is public, and ${host} is listed as private`,
      });
      return reply(
        403,
        "egress denied: a private upstream resolved publicly",
        purpose,
      );
    }
    // A certificate is checked for a name; an address would have to be
    // checked for itself, which the upstream client does not do. Nothing in
    // the catalog needs it: trigger to add, an https upstream only
    // reachable by IP.
    if (upstream.protocol === "https:" && isIP(host) !== 0) {
      logger.warn("Credential route denied", {
        ...fields,
        reason: "an https upstream must be named, not an address",
      });
      return reply(502, "an https upstream must be named", purpose);
    }
    // The address that was judged, and only it. A POST is never retried
    // against a second address: its body may already have reached the
    // first.
    return { address: decision.addresses[0] ?? "", host, port };
  }

  function send(
    upstream: URL,
    at: Dialable,
    exchange: Parameters<typeof upstreamExchange>[1],
    connectTimeoutMs?: number,
  ): Promise<Response> {
    return upstreamExchange(
      {
        address: at.address,
        port: at.port,
        ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
        tls:
          upstream.protocol === "https:"
            ? {
                serverName: at.host,
                ...(options.upstreamCa === undefined
                  ? {}
                  : { ca: options.upstreamCa }),
              }
            : null,
      },
      exchange,
    );
  }

  /**
   * A registry's redirect, followed here rather than relayed, and only to a
   * host on the packages redirect list: a relayed one would send the worker
   * to a host it cannot reach, and one followed anywhere would make the
   * route an open fetcher. Nothing the grant added goes along, so a
   * credential put on the registry request never reaches the host it
   * redirected to.
   */
  async function followRedirects(
    first: Response,
    from: URL,
    request: Request,
    grant: EgressGrant,
    who: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<{ response: Response } | { refused: Response }> {
    let response = first;
    let at = from;
    for (let hop = 0; REDIRECT_STATUSES.has(response.status); hop++) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      const next = location === null ? null : URL.parse(location, at);
      const unusable =
        next === null
          ? "no usable location"
          : hop >= MAX_PACKAGE_REDIRECTS
            ? "too many redirects"
            : (next.protocol !== "https:" && next.protocol !== "http:") ||
                next.username !== "" ||
                next.password !== ""
              ? "the location is not a plain http(s) URL"
              : null;
      if (next === null || unusable !== null) {
        logger.warn("Credential route redirect refused", {
          ...who,
          status: response.status,
          reason: unusable,
        });
        return { refused: reply(502, "upstream redirected", "packages") };
      }
      const judged = await dialable(
        next,
        packagesRedirect,
        "packages",
        { ...who, redirect: true },
        signal,
      );
      if (judged instanceof Response) {
        await judged.body?.cancel();
        return {
          refused: reply(
            502,
            "upstream redirected to a host the packages route does not follow",
            "packages",
          ),
        };
      }
      logger.info("Credential route redirect followed", {
        ...who,
        status: response.status,
        to_host: judged.host,
        to_port: judged.port,
      });
      try {
        response = await send(next, judged, {
          method: request.method,
          target: `${next.pathname}${next.search}`,
          headers: [
            ...upstreamRequestHeaders(request.headers, {
              ...grant,
              upstream: next,
              headers: [],
            }),
          ],
          body: null,
          signal,
        });
      } catch (error) {
        logger.warn("Credential route upstream failed", {
          ...who,
          host: judged.host,
          port: judged.port,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          refused: reply(502, "upstream connection failed", "packages"),
        };
      }
      at = next;
    }
    return { response };
  }

  /**
   * One LFS object, from where the repository's batch answer put it: a
   * storage host on the packages redirect list, asked with nothing the grant
   * added, as a followed redirect is. The location never reaches the worker.
   */
  async function lfsObject(
    href: URL,
    request: Request,
    grant: EgressGrant,
    who: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<{ response: Response } | { refused: Response }> {
    const judged = await dialable(
      href,
      packagesRedirect,
      "repository",
      { ...who, lfs_object: true },
      signal,
    );
    if (judged instanceof Response) {
      await judged.body?.cancel();
      return {
        refused: reply(
          502,
          "the LFS object is on a host this route does not reach",
        ),
      };
    }
    logger.info("Credential route LFS object", {
      ...who,
      to_host: judged.host,
      to_port: judged.port,
    });
    let response: Response;
    try {
      response = await send(href, judged, {
        method: "GET",
        target: `${href.pathname}${href.search}`,
        headers: [
          ...upstreamRequestHeaders(request.headers, {
            ...grant,
            upstream: href,
            headers: [],
          }),
        ],
        body: null,
        signal,
      });
    } catch (error) {
      logger.warn("Credential route upstream failed", {
        ...who,
        host: judged.host,
        port: judged.port,
        error: error instanceof Error ? error.message : String(error),
      });
      return { refused: reply(502, "upstream connection failed") };
    }
    const fetched = REDIRECT_STATUSES.has(response.status)
      ? await followRedirects(response, href, request, grant, who, signal)
      : { response };
    if ("refused" in fetched) return fetched;
    // A storage answer may echo a presigned location, the first or one it
    // redirected to; only the object and its length, type and encoding go
    // back, the encoding so the encoded-body check below still sees it.
    const answer = fetched.response;
    if (!answer.ok) {
      await answer.body?.cancel();
      logger.warn("Credential route LFS object refused", {
        ...who,
        status: answer.status,
      });
      return {
        refused: reply(502, `the LFS storage answered ${answer.status}`),
      };
    }
    const headers = new Headers();
    for (const name of ["content-length", "content-type", "content-encoding"]) {
      const value = answer.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return {
      response: new Response(answer.body, { status: answer.status, headers }),
    };
  }

  async function exchange(
    request: Request,
    route: CredentialRoute,
    grant: EgressGrant,
    client: string,
    signal: AbortSignal,
    // The route's body as read since admission; null for the object store,
    // whose body streams upstream.
    whole: Promise<UpstreamBody> | null,
  ): Promise<Response> {
    const who = {
      purpose: route.purpose,
      ...(route.registry === undefined ? {} : { registry: route.registry }),
      ...(route.repository === undefined
        ? {}
        : { repository_id: route.repository }),
      ...(grant.judgmentId === null
        ? { session_id: grant.sessionId, attempt_id: grant.attemptId }
        : { judgment_id: grant.judgmentId }),
      client,
    };
    // The upstream is the catalog's, not the worker's, and it is still held
    // to the same allowlist and address rules as anything a worker asks for.
    // The one exception is the API's own built-in MCP server, named by a
    // path on the authorizer's listener: this process's control line, which
    // no allowlist names on purpose. A catalog URL to that origin is not it.
    const retryable = route.purpose === "mcp" && grant.builtin;
    const deadline = Date.now() + BUILTIN_RETRY_BUDGET_MS;
    const dialUpstream = () =>
      dialable(
        grant.upstream,
        retryable ? null : options.policy,
        route.purpose,
        who,
        signal,
      );
    let first = await dialUpstream();
    // The built-in server's name stops resolving while its container is
    // replaced; that is the same restart window as a refused connection.
    for (
      let tried = 0;
      retryable &&
      first instanceof Response &&
      first.status === 502 &&
      !signal.aborted;
      tried++
    ) {
      const backoff = BUILTIN_RETRY_BACKOFF_MS[tried];
      if (backoff === undefined || Date.now() + backoff > deadline) {
        return builtinUnavailable();
      }
      await first.body?.cancel();
      await untilEnded(Bun.sleep(backoff), signal);
      first = await dialUpstream();
    }
    if (first instanceof Response) return first;
    const upstream = grant.upstream;
    const fields = { ...who, host: first.host, port: first.port };
    const trimmed = upstream.pathname.replace(/\/$/, "");
    // As Git LFS finds the endpoint from a remote URL; GitHub answers a batch
    // at the URL without `.git` with a 422.
    const base =
      route.lfs === undefined || trimmed.endsWith(".git")
        ? trimmed
        : `${trimmed}.git`;
    const target = grant.target ?? `${base}${route.path}${route.search}`;
    const objectStore = route.purpose === "object_store";
    if (objectStore && grant.target === null) {
      logger.error("Egress authorizer signed no target", fields);
      return reply(502, "the authorizer signed no request", route.purpose);
    }
    let response: Response;
    // What a Messages answer that says too little about its usage is
    // charged from.
    let sent: Uint8Array | null = null;
    try {
      const body =
        typeof route.lfs === "object"
          ? lfsBatchBody([route.lfs])
          : whole === null
            ? objectBody(request, grant)
            : await whole;
      if (body instanceof Uint8Array) sent = body;
      const headers = upstreamRequestHeaders(request.headers, grant);
      if (route.lfs !== undefined) {
        headers.set("accept", LFS_MEDIA_TYPE);
        headers.set("content-type", LFS_MEDIA_TYPE);
      }
      const call = {
        method: route.lfs === undefined ? request.method : "POST",
        target,
        // Only what the authorizer signed: the worker's own headers are
        // what it was judged on, not what goes upstream.
        headers: objectStore
          ? ([
              ["host", upstream.host],
              ["accept-encoding", "identity"],
              ...grant.headers,
            ] as Array<[string, string]>)
          : [...headers],
        body,
        signal,
      };
      let at = first;
      for (let tried = 0; ; tried++) {
        try {
          response = await send(
            upstream,
            at,
            call,
            retryable
              ? Math.max(
                  1,
                  Math.min(BUILTIN_CONNECT_TIMEOUT_MS, deadline - Date.now()),
                )
              : undefined,
          );
          break;
        } catch (error) {
          // Only a connection that never took a byte is dialled again, and
          // against a fresh lookup: the replaced container has a new address.
          if (!retryable || !failedBeforeRequest(error) || signal.aborted) {
            throw error;
          }
          const backoff = BUILTIN_RETRY_BACKOFF_MS[tried];
          if (backoff === undefined || Date.now() + backoff > deadline) {
            logger.warn("Credential route upstream unavailable", {
              ...fields,
              error: error instanceof Error ? error.message : String(error),
            });
            return builtinUnavailable();
          }
          await untilEnded(Bun.sleep(backoff), signal);
          const again = await dialUpstream();
          if (again instanceof Response) {
            // Only a lookup that came back empty keeps the address judged
            // before; a refusal (an address that turned public) ends it.
            if (again.status !== 502) return again;
            await again.body?.cancel();
          } else at = again;
        }
      }
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return reply(413, "request body too large", route.purpose);
      }
      logger.warn("Credential route upstream failed", {
        ...fields,
        error: error instanceof Error ? error.message : String(error),
      });
      return reply(502, "upstream connection failed", route.purpose);
    }
    logger.info("Credential route", { ...fields, status: response.status });
    let presigned: string[] = [];
    if (route.lfs !== undefined && response.ok) {
      const answered = await lfsAnswer(response);
      if (answered === null) {
        logger.warn("Credential route LFS answer unusable", fields);
        return reply(502, "the LFS server's answer was unusable");
      }
      if (route.lfs === "batch") {
        const url = new URL(request.url);
        const forWorker = lfsBatchForWorker(
          answered,
          `${url.origin}${url.pathname.slice(0, -"/batch".length)}`,
        );
        if (forWorker === null) {
          logger.warn("Credential route LFS answer unusable", fields);
          return reply(502, "the LFS server's answer was unusable");
        }
        response = new Response(JSON.stringify(forWorker), {
          headers: { "content-type": LFS_MEDIA_TYPE },
        });
      } else {
        const href = lfsDownloadHref(answered, route.lfs.oid);
        if (href === null) {
          return reply(404, "the LFS server offered no download");
        }
        const fetched = await lfsObject(href, request, grant, fields, signal);
        if ("refused" in fetched) return fetched.refused;
        response = fetched.response;
        // The presigned location is a credential of its own; a storage
        // error that echoes it must not hand it over.
        presigned = [...href.searchParams.values()].filter(
          (value) => value.length >= 8,
        );
      }
    }
    if (
      route.purpose === "packages" &&
      REDIRECT_STATUSES.has(response.status)
    ) {
      const followed = await followRedirects(
        response,
        new URL(target, upstream),
        request,
        grant,
        fields,
        signal,
      );
      if ("refused" in followed) return followed.refused;
      response = followed.response;
    }
    if (
      response.status >= 300 &&
      response.status < 400 &&
      !(route.purpose === "packages" && response.status === 304)
    ) {
      // A followed redirect would carry the credential somewhere the catalog
      // never named, and a relayed one invites the client to.
      await response.body?.cancel();
      return reply(502, "upstream redirected", route.purpose);
    }
    // Every spelling the upstream could echo back to the worker: headers,
    // a success body and an error body are all checked for them.
    const secrets = objectStore
      ? objectStoreSecrets(grant)
      : [...secretsOf(grant), ...presigned];
    const headers = responseHeaders(response.headers, secrets);
    // A head's answer is its length; there is no body to take it from.
    const length = response.headers.get("content-length");
    if (objectStore && request.method === "HEAD" && length !== null) {
      headers.set("content-length", length);
    }
    if (route.purpose === "mcp") {
      // The service account's credential is the operator's to fix; a 401 and
      // its challenge would send the worker's client after a login of its own.
      headers.delete("www-authenticate");
    }
    if (!response.ok) {
      const relayed = await withheldIfLeaking(
        response,
        headers,
        secrets,
        route.purpose,
        { ...fields, path: route.path },
      );
      return route.purpose === "mcp" && relayed.status === 401
        ? new Response(relayed.body, { status: 403, headers: relayed.headers })
        : relayed;
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity") {
      // Asked for identity; a body it cannot read is one it cannot vouch for.
      await response.body?.cancel();
      return reply(
        502,
        "upstream answered with an encoded body",
        route.purpose,
      );
    }
    const guarded =
      response.body?.pipeThrough(
        secretGuard(secrets, () =>
          logger.error("Credential route upstream echoed the credential", {
            ...fields,
            status: response.status,
          }),
        ),
      ) ?? null;
    // count_tokens is free; only a Messages or Responses answer and a
    // judgment are metered.
    if (
      route.purpose !== "judgment" &&
      (route.purpose !== "provider" ||
        (route.path !== "/v1/messages" && route.path !== RESPONSES_PATH))
    ) {
      return new Response(guarded, { status: response.status, headers });
    }
    const meter = usageMeter(response.headers.get("content-type"), {
      requestModel: route.purpose === "judgment",
      responses: route.purpose === "provider" && route.path === RESPONSES_PATH,
    });
    const exchangeId = crypto.randomUUID();
    return new Response(
      metered(guarded, meter, signal, () => {
        const usage = meter.result(sent);
        if (usage.estimated) {
          logger.warn("Provider usage estimated", {
            ...fields,
            model: usage.model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
          });
        }
        void reportUsage(grant, exchangeId, usage);
      }),
      { status: response.status, headers },
    );
  }

  /**
   * An error body is small and read whole, so it can be checked before the
   * worker sees it: an upstream that echoes the credential it was sent
   * (in a 401 explaining which key failed, say) would otherwise hand it to
   * the very process it was kept from.
   */
  async function withheldIfLeaking(
    response: Response,
    headers: Headers,
    secrets: readonly string[],
    purpose: EgressPurpose,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<Response> {
    const encoding = response.headers.get("content-encoding");
    const body = await readAtMost(response, MAX_ERROR_BODY_BYTES);
    const text = body === null ? null : new TextDecoder().decode(body);
    // readAtMost answers null for a body over the cap and for one that
    // failed mid-read alike.
    const unsafe =
      text === null
        ? "too_large_or_unreadable"
        : encoding !== null && encoding.toLowerCase() !== "identity"
          ? "encoded"
          : secrets.some((secret) => text.includes(secret))
            ? "secret_match"
            : null;
    // The worker's engine reports any 401/403 as a failed login; the
    // upstream's own words are what tell a bad key from, say, a local
    // server refusing the Host header.
    if (
      purpose === "provider" &&
      (response.status === 401 || response.status === 403)
    ) {
      const excerpt = text?.slice(0, REFUSAL_EXCERPT_CHARS) ?? "";
      // Said here rather than left to the logger, which would replace a
      // secret-shaped excerpt with a bare [REDACTED] and no reason.
      const withheld =
        unsafe ??
        (sanitizeText(excerpt) === REDACTED ? "redacted_pattern" : null);
      logger.warn("Provider upstream refused the credential route", {
        ...fields,
        status: response.status,
        ...(withheld === null
          ? { upstream_error: excerpt }
          : {
              upstream_error_withheld: true,
              upstream_error_withheld_reason: withheld,
            }),
      });
    }
    if (unsafe !== null) {
      if (purpose === "object_store") {
        const withheld = s3Error(
          response.status,
          "the upstream error was withheld by the egress proxy",
        );
        return new Response(withheld.body, {
          status: response.status,
          headers: withheld.headers,
        });
      }
      headers.delete("content-encoding");
      headers.set("content-type", "application/json");
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: "The upstream error was withheld by the egress proxy",
          },
        }),
        { status: response.status, headers },
      );
    }
    return new Response(body, { status: response.status, headers });
  }

  function admit(client: string): (() => void) | null {
    const mine = perClient.get(client) ?? 0;
    if (open >= maxExchanges || mine >= maxPerClient) return null;
    open += 1;
    perClient.set(client, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      open -= 1;
      const left = (perClient.get(client) ?? 1) - 1;
      if (left <= 0) perClient.delete(client);
      else perClient.set(client, left);
    };
  }

  function reserveBody(bytes: number): (() => void) | null {
    if (bodyBytes + bytes > maxBodyBytes) return null;
    bodyBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bodyBytes -= bytes;
    };
  }

  const server: Server<undefined> = Bun.serve({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? DEFAULT_CREDENTIAL_PORT,
    idleTimeout: UNAUTHORIZED_IDLE_SECONDS,
    // The object store's cap; the other routes hold to their own below.
    maxRequestBodySize: MAX_OBJECT_BODY_BYTES,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return reply(200, "ok");
      }
      if (isPushAdvertisement(request.method, url.pathname, url.search)) {
        return pushNotice();
      }
      const route = routeOf(request.method, url.pathname, url.search);
      if (route === null) return reply(404, "no such credential route");
      // A path token beside a header token is two carriers, refused alike.
      const token =
        route.pathToken === undefined
          ? tokenOf(request.headers, route.purpose)
          : request.headers.has("authorization") ||
              request.headers.has("x-api-key")
            ? null
            : route.pathToken;
      if (token === null) {
        return reply(401, "one egress token is required", route.purpose);
      }
      const question: Record<string, unknown> =
        route.purpose === "object_store"
          ? {
              request: objectRequestOf(
                request.method,
                `${route.path}${route.search}`,
                request.headers,
              ),
            }
          : route.purpose === "packages"
            ? { registry: route.registry, path: `${route.path}${route.search}` }
            : route.purpose === "provider" && route.path === RESPONSES_PATH
              ? // Sent only for the path that needs a kind check, so a proxy
                // and an authorizer of different releases still agree on
                // every Messages call: no `path` means Messages.
                { path: route.path }
              : route.repository === undefined
                ? {}
                : { repository_id: route.repository };
      // Decided before anything is awaited: Bun takes the body off the
      // socket meanwhile, and only a request answered now is never held.
      const reservation = bodyReservation(request.headers, route.purpose);
      if ("refused" in reservation) {
        return reply(
          reservation.refused,
          reservation.refused === 413
            ? "request body too large"
            : "a request body needs a content-length",
          route.purpose,
        );
      }
      const client = server.requestIP(request)?.address ?? "unknown";
      const admitted = admit(client);
      if (admitted === null) {
        logger.warn("Refusing a credential exchange over the cap", { client });
        return reply(503, "too many exchanges from this client", route.purpose);
      }
      const bodyHeld = reserveBody(reservation.bytes);
      if (bodyHeld === null) {
        admitted();
        logger.warn("Refusing a credential exchange over the body budget", {
          client,
          bytes: reservation.bytes,
        });
        return reply(503, "too many request bytes in flight", route.purpose);
      }
      const revocation = new AbortController();
      // Everything that ends an exchange, the wait for a trickled request
      // body included.
      const ends = AbortSignal.any([
        request.signal,
        revocation.signal,
        exchangeDeadline(exchangeTimeoutMs),
      ]);
      let regrant: ReturnType<typeof setTimeout> | undefined;
      let ended = false;
      let answered = false;
      // Once answered, an ended exchange frees its slot whatever becomes of
      // the body: one handed back after the worker hung up is pulled once by
      // Bun and then neither read nor cancelled. Until then the
      // slot stays held, and `ends` cuts every wait of the exchange short.
      const hungUp = () => {
        if (answered) release();
      };
      const reading = new AbortController();
      const release = () => {
        ended = true;
        clearTimeout(regrant);
        ends.removeEventListener("abort", hungUp);
        reading.abort(new Error("exchange ended"));
        bodyHeld();
        admitted();
      };
      ends.addEventListener("abort", hungUp);
      // Read from admission on, so what Bun takes off the socket moves into
      // the reservation rather than piling up beside it while the
      // authorizer is asked.
      let whole =
        route.purpose === "object_store"
          ? null
          : readWhole(
              request.body,
              AbortSignal.any([ends, reading.signal]),
              reservation.bytes,
            );
      whole?.catch(() => {});
      // A definite refusal cuts the exchange at once. An authorizer that
      // cannot answer does only after the grace: a blip must not break
      // every stream in flight, and an outage must not hide an ended grant.
      let grantedAt = performance.now();
      const watchGrant = (grant: EgressGrant) => {
        regrant = setTimeout(async () => {
          const again = await authorize(
            token,
            route.purpose,
            route.purpose === "mcp" || route.purpose === "packages"
              ? { ...question, regrant: true }
              : question,
          );
          if (ended) return;
          if (again.kind === "granted") grantedAt = performance.now();
          const refused = again.kind === "refused" && again.status !== 503;
          const stale = performance.now() - grantedAt >= regrantGraceMs;
          if (refused || stale) {
            logger.warn("Credential exchange cut: its grant ended", {
              purpose: route.purpose,
              session_id: grant.sessionId,
              attempt_id: grant.attemptId,
              judgment_id: grant.judgmentId,
              status: again.kind === "refused" ? again.status : 200,
              stale,
              client,
            });
            revocation.abort(new Error("egress grant ended"));
            return;
          }
          watchGrant(grant);
        }, regrantIntervalMs);
      };
      try {
        if (route.purpose === "mcp") {
          const read = whole === null ? null : await whole;
          if (request.method === "POST") {
            const parsed = read instanceof Uint8Array ? mcpCallOf(read) : null;
            if (parsed === null) {
              release();
              return reply(400, "one JSON-RPC message is required");
            }
            Object.assign(question, { server: route.server, rpc: parsed.call });
            whole = Promise.resolve(parsed.body);
          } else {
            // Judged as no call at all, so it must carry none: a server that
            // reads a DELETE's body would otherwise run an unchecked one.
            if (read instanceof Uint8Array && read.byteLength > 0) {
              release();
              return reply(400, "a GET or DELETE carries no body");
            }
            Object.assign(question, {
              server: route.server,
              rpc: { method: null, tool: null },
            });
          }
        }
        if (route.lfs === "batch") {
          // Before the authorizer, so an upload costs no token.
          const read = whole === null ? null : await whole;
          const batch =
            read instanceof Uint8Array ? lfsDownloadBatch(read) : null;
          if (batch === null) {
            release();
            return reply(400, "only an LFS download batch is routed");
          }
          whole = Promise.resolve(batch);
        }
        if (route.purpose === "provider" && route.path === RESPONSES_PATH) {
          const read = whole === null ? null : await whole;
          const unmeterable =
            read instanceof Uint8Array
              ? unmeterableResponsesRequest(read)
              : null;
          if (unmeterable !== null) {
            release();
            return reply(400, unmeterable, route.purpose);
          }
        }
        const authorized = await authorize(token, route.purpose, question);
        if (authorized.kind === "refused") {
          release();
          if (authorized.budgetExceeded && route.purpose === "provider") {
            return budgetExceededReply(route.path);
          }
          return reply(
            authorized.status,
            authorized.receiptId === undefined
              ? "egress token refused"
              : `egress denied: credential_unbound (receipt ${authorized.receiptId})`,
            route.purpose,
          );
        }
        // A judgment's grant charges no session, and a session's no
        // judgment: either on the other's route is an authorizer fault.
        if (
          (route.purpose === "judgment") !==
          (authorized.grant.judgmentId !== null)
        ) {
          release();
          logger.error("Egress authorizer granted for another route", {
            purpose: route.purpose,
          });
          return reply(503, "egress token refused", route.purpose);
        }
        // A session whose spend went unreported has a stored cost below its
        // real one, so the budget gate can no longer be trusted for it.
        if (
          route.purpose === "provider" &&
          authorized.grant.sessionId !== null &&
          unreportedSessions.has(authorized.grant.sessionId)
        ) {
          release();
          logger.warn("Provider call refused: session usage unreported", {
            session_id: authorized.grant.sessionId,
          });
          return budgetExceededReply(route.path);
        }
        // Authorized: from here the exchange deadline bounds it, not the
        // idle clock, which a silent non-streaming call would trip.
        server.timeout(request, 0);
        watchGrant(authorized.grant);
        const response = await exchange(
          request,
          route,
          authorized.grant,
          client,
          ends,
          whole,
        );
        const relayed = new Response(tracked(response.body, release), {
          status: response.status,
          headers: response.headers,
        });
        answered = true;
        if (ends.aborted) release();
        return relayed;
      } catch (error) {
        release();
        if (error instanceof BodyTooLargeError) {
          return reply(413, "request body too large", route.purpose);
        }
        logger.error("Credential exchange failed", {
          error: error instanceof Error ? error.name : "error",
        });
        return reply(502, "credential exchange failed", route.purpose);
      }
    },
  });

  logger.info("Credential routes listening", {
    port: server.port,
    authorizer: authorizeUrl.origin,
  });
  return {
    port: server.port ?? 0,
    stop(): void {
      server.stop(true);
    },
  };
}

class BodyTooLargeError extends Error {}

type Dialable = { address: string; host: string; port: number };

/** `work`, or the signal's reason if it fires first: a hung lookup too. */
function untilEnded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}

/**
 * The request body, all of it in hand before the upstream is dialled, given
 * up the moment `signal` fires or it passes `max`. Copied into one buffer of
 * the reserved size as it arrives, so neither a copy nor a trickle of tiny
 * chunks holds more than the reservation.
 */
async function readWhole(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  max: number,
): Promise<UpstreamBody> {
  if (body === null) return null;
  const reader = body.getReader();
  const stop = () => {
    reader.cancel(signal.reason).catch(() => {});
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const whole = new Uint8Array(max);
    let total = 0;
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (total + next.value.byteLength > max) {
        // Bun would otherwise go on taking the rest off the socket.
        reader.cancel().catch(() => {});
        throw new BodyTooLargeError();
      }
      whole.set(next.value, total);
      total += next.value.byteLength;
    }
    return whole.subarray(0, total);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * What an admitted request may make Bun hold: its declared length, or the
 * route's cap for a body sent chunked. An object store body has to declare
 * its length, since that length is what the authorizer signs.
 */
export function bodyReservation(
  headers: Headers,
  purpose: EgressPurpose,
): { bytes: number } | { refused: 411 | 413 } {
  const cap =
    purpose === "object_store" ? MAX_OBJECT_BODY_BYTES : MAX_REQUEST_BODY_BYTES;
  if (headers.has("transfer-encoding")) {
    return purpose === "object_store" ? { refused: 411 } : { bytes: cap };
  }
  const declared = Number(headers.get("content-length") ?? "0");
  return Number.isSafeInteger(declared) && declared >= 0 && declared <= cap
    ? { bytes: declared }
    : { refused: 413 };
}

/**
 * An object store PUT's body, streamed upstream at the length the authorizer
 * signed. Bun already holds the worker to the length it declared, and the
 * authorizer signed that same declaration; the upstream client checks the
 * stream against it again as it writes.
 */
function objectBody(request: Request, grant: EgressGrant): UpstreamBody {
  const declared = grant.headers.find(([name]) => name === "content-length");
  if (declared === undefined || request.body === null) return null;
  return { stream: request.body, length: Number(declared[1]) };
}

const S3_ERROR_CODES: Record<number, string> = {
  401: "InvalidAccessKeyId",
  403: "AccessDenied",
  409: "AccessDenied",
  413: "EntityTooLarge",
  502: "BadGateway",
  503: "ServiceUnavailable",
};

/**
 * A refusal an S3 client can read: its SDK reports the code as the error's
 * name (`AccessDenied`), and retries the ones S3 itself would have it retry.
 */
function s3Error(status: number, message: string): Response {
  const code = S3_ERROR_CODES[status] ?? "InternalError";
  const escaped = message.replace(
    /[<>&]/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char] ?? char,
  );
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${escaped}</Message></Error>\n`,
    { status, headers: { "content-type": "application/xml" } },
  );
}

/** A body that frees its slot once it ends, errors or is cancelled. */
function tracked(
  body: ReadableStream<Uint8Array> | null,
  done: () => void,
): ReadableStream<Uint8Array> | null {
  if (body === null) {
    done();
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          done();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
}

/**
 * A body read through `meter`, which is settled once however the exchange
 * ends: the body in full, broken or cancelled, or the exchange cut, which is
 * all a worker that hung up leaves behind (Bun neither reads nor cancels the
 * body after that, ). A cut stream was still billed for what the
 * upstream had done.
 */
function metered(
  body: ReadableStream<Uint8Array> | null,
  meter: UsageMeter,
  ended: AbortSignal,
  settle: () => void,
): ReadableStream<Uint8Array> | null {
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    ended.removeEventListener("abort", done);
    settle();
  };
  if (body === null || ended.aborted) {
    done();
    if (body === null) return null;
  }
  ended.addEventListener("abort", done);
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          done();
          controller.close();
          return;
        }
        meter.observe(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
}

/** A batch answer's JSON; null for one too large, encoded or not JSON. */
async function lfsAnswer(response: Response): Promise<unknown> {
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    await response.body?.cancel();
    return null;
  }
  const body = await readAtMost(response, MAX_LFS_BATCH_ANSWER_BYTES);
  if (body === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

async function readAtMost(
  response: Response,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
