import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  ADDITIONAL_REPOSITORY_ID_PATTERN,
  mcpServerIdSchema,
} from "@werft-ai/contracts";
import { RequestDeadline, runWithDeadline } from "@werft-ai/db/pool";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  GITHUB_MCP_UPSTREAM_PATH,
  type GitHubMcpGrant,
  type JsonRpcResponse,
  PACKAGE_REGISTRY_NAMES,
  verifyGitHubMcpGrant,
  type WorkerGateway,
  WorkerGatewayError,
} from "@werft-ai/platform";
import type { ObjectRouteSigner } from "@werft-ai/storage";
import { z } from "zod";
import { isStorageUnavailable } from "./app.ts";

/**
 * The egress proxy's line to the gateway. Every request a worker
 * sends to one of the proxy's credential routes is authorized here, and the
 * answer carries the upstream credential the proxy injects. That is why
 * this is a listener of its own rather than a route on the API's port: the
 * API's port is on the workers' egress allowlist, and this one must never
 * be. The shared bearer is the second lock, not the first.
 *
 * The object store route asks the same question and one more
 * whether this one S3 request is one the session may make. Its answer is a
 * signature for that request, made here with the API's own key.
 */

export const EGRESS_AUTHORIZER_PATH = "/authorize";
// Where the proxy reports what a Messages call used, on the same
// listener for the same reason: only the proxy may say what a session spent.
export const EGRESS_USAGE_PATH = "/usage";
// A token, a purpose and, for the object store, one S3 request line and its
// headers; anything bigger is not a request from the proxy.
const MAX_BODY_BYTES = 16 * 1024;
// The proxy waits for this before the worker's request goes anywhere, so a
// slow database answers 503 rather than holding the engine's call open.
const AUTHORIZE_DEADLINE_MS = 10_000;
// A bearer an operator could type from memory is not a lock.
const MIN_TOKEN_LENGTH = 32;

export type EgressAuthorizerConfig = {
  hostname: string;
  port: number;
  token: string;
};

/**
 * Both variables or neither. Neither leaves the listener off, and then no
 * worker can reach its provider or repository: the claim no longer carries
 * a credential of its own to fall back on.
 */
export function egressAuthorizerConfigFromEnv(
  env: Record<string, string | undefined>,
): EgressAuthorizerConfig | null {
  const port = env.EGRESS_AUTHORIZER_PORT;
  const token = env.EGRESS_AUTHORIZER_TOKEN;
  if (port === undefined && token === undefined) return null;
  if (port === undefined || token === undefined) {
    throw new Error(
      "EGRESS_AUTHORIZER_PORT and EGRESS_AUTHORIZER_TOKEN are set together or not at all",
    );
  }
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`EGRESS_AUTHORIZER_PORT ${port} is not a port`);
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `EGRESS_AUTHORIZER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  return {
    hostname: env.EGRESS_AUTHORIZER_HOST ?? "0.0.0.0",
    port: parsed,
    token,
  };
}

/**
 * The key the built-in `github` MCP server's grants are signed with: derived
 * from the bearer only the API and the proxy hold, under a name of its own
 * so a grant is never also an authorizer bearer.
 */
export function githubMcpGrantKeyOf(config: EgressAuthorizerConfig): Buffer {
  return createHmac("sha256", config.token)
    .update("werft github mcp grant v1", "utf8")
    .digest();
}

// What the built-in server takes in one message: a dispatch's inputs are
// the largest argument (25 inputs of up to 64 KiB).
const GITHUB_MCP_MAX_BODY_BYTES = 2 * 1024 * 1024;

const tokenSchema = z.string().min(1).max(512);

const authorizeRequestSchema = z.union([
  z
    .object({
      token: tokenSchema,
      purpose: z.enum(["provider", "repository"]),
      // repository only: the route named another repository than the
      // session's own (session-multi-repository.md decision 2).
      repository_id: z
        .string()
        .regex(ADDITIONAL_REPOSITORY_ID_PATTERN)
        .optional(),
      // provider only: named for a Responses call. Absent is a Messages
      // call, which is all a proxy sent before that route existed. Whether
      // the session's connection serves the path is the gateway's to judge.
      path: z.literal("/v1/responses").optional(),
    })
    .strict()
    .refine((body) => body.path === undefined || body.purpose === "provider"),
  // The judge's own calls: a judgment token, never a session's.
  z
    .object({ token: tokenSchema, purpose: z.literal("judgment") })
    .strict(),
  z
    .object({
      token: tokenSchema,
      purpose: z.literal("packages"),
      registry: z.enum(PACKAGE_REGISTRY_NAMES),
      // Path and query below the registry; a GitHub Packages registry is
      // judged on it, and a proxy from before them sends none.
      path: z.string().startsWith("/").max(4096).optional(),
      regrant: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      token: tokenSchema,
      purpose: z.literal("object_store"),
      request: z
        .object({
          method: z.string().regex(/^[A-Z]{1,16}$/),
          target: z.string().min(1).max(4096),
          headers: z
            .array(z.tuple([z.string().min(1).max(128), z.string().max(1024)]))
            .max(32),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      token: tokenSchema,
      purpose: z.literal("mcp"),
      server: mcpServerIdSchema,
      rpc: z
        .object({
          method: z.string().min(1).max(128).nullable(),
          tool: z.string().min(1).max(128).nullable(),
        })
        .strict(),
      regrant: z.boolean().default(false),
    })
    .strict(),
]);

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const usageSchema = z
  .object({
    model: z.string().min(1).max(256),
    input_tokens: tokenCount,
    output_tokens: tokenCount,
    cache_creation_input_tokens: tokenCount,
    cache_creation_1h_input_tokens: tokenCount,
    cache_read_input_tokens: tokenCount,
    // Optional so a proxy from before still reports; its calls
    // may have been fast, so a missing speed is priced high.
    speed: z.string().min(1).max(64).default("unknown"),
    // Before as well; the call may have run in the US.
    inference_geo: z.string().min(1).max(64).default("unknown"),
    web_search_requests: tokenCount.default(0),
    web_fetch_requests: tokenCount.default(0),
    code_execution_requests: tokenCount.default(0),
    estimated: z.boolean(),
  })
  .strict();

// A session's call, or one achievement judgment's, which no session pays.
const usageReportSchema = z.union([
  z
    .object({
      exchange_id: z.string().uuid(),
      session_id: z.string().uuid(),
      attempt_id: z.string().min(1).max(256),
      usage: usageSchema,
    })
    .strict(),
  z
    .object({
      exchange_id: z.string().uuid(),
      judgment_id: z.string().uuid(),
      usage: usageSchema,
    })
    .strict(),
]);

/**
 * The egress proxy's credential listener, where the API sends a session's
 * title call so the proxy meters it like the engine's own. Unset, every
 * session keeps the title cut from its first message.
 */
export function sessionTitleEgressUrlFromEnv(
  env: Record<string, string | undefined>,
): string | null {
  const value = env.SESSION_TITLE_EGRESS_URL;
  if (value === undefined || value === "") return null;
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`SESSION_TITLE_EGRESS_URL ${value} is not an http(s) URL`);
  }
  return url.href;
}

/** The body, or null the moment it passes `max`: the rest is never read. */
async function readAtMost(
  request: Request,
  max: number,
): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, total);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

export function createEgressAuthorizer(deps: {
  gateway: Pick<
    WorkerGateway,
    | "authorizeEgress"
    | "authorizeMcpEgress"
    | "authorizeObjectAccess"
    | "authorizePackagesEgress"
    | "recordProviderUsage"
    | "authorizeJudgmentEgress"
    | "recordJudgmentUsage"
  >;
  logger: StructuredLogger;
  /** Absent when the API runs without an object store: the route refuses. */
  objectStore?: ObjectRouteSigner;
  /**
   * The built-in `github` MCP server, reached by the proxy at
   * GITHUB_MCP_UPSTREAM_PATH with a grant this listener's gateway signed.
   */
  githubMcp?: {
    handle: (
      grant: GitHubMcpGrant,
      message: unknown,
      requestId: string,
    ) => Promise<JsonRpcResponse | null>;
    grantKey: Uint8Array;
    now?: () => number;
  };
  token: string;
  deadlineMs?: number;
}): (request: Request) => Promise<Response> {
  const { objectStore } = deps;
  // The fence first, then the request: a token whose attempt lost its
  // session learns nothing about which of its requests would have passed.
  async function authorizeObjectStore(
    token: string,
    request: z.infer<typeof authorizeRequestSchema> & {
      purpose: "object_store";
    },
  ) {
    const access = await deps.gateway.authorizeObjectAccess({ token });
    if (objectStore === undefined) {
      throw new WorkerGatewayError(
        503,
        "BACKEND_UNAVAILABLE",
        "This API has no object store to sign for",
      );
    }
    const signed = await objectStore.sign(request.request, access.scope);
    if (signed.kind === "refused") {
      throw new WorkerGatewayError(403, "FORBIDDEN", signed.reason);
    }
    return {
      session_id: access.session_id,
      attempt_id: access.attempt_id,
      upstream: {
        url: signed.url,
        target: signed.target,
        headers: signed.headers,
      },
    };
  }
  const expected = digest(`Bearer ${deps.token}`);
  const deadlineMs = deps.deadlineMs ?? AUTHORIZE_DEADLINE_MS;
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === GITHUB_MCP_UPSTREAM_PATH) {
      return serveGitHubMcp(request);
    }
    if (
      request.method !== "POST" ||
      (url.pathname !== EGRESS_AUTHORIZER_PATH &&
        url.pathname !== EGRESS_USAGE_PATH)
    ) {
      return problem(404, "NOT_FOUND", "Not found");
    }
    // Compared as digests so neither the length nor a prefix of the secret
    // leaks through timing.
    if (
      !timingSafeEqual(
        digest(request.headers.get("authorization") ?? ""),
        expected,
      )
    ) {
      return problem(401, "UNAUTHORIZED", "Egress authorizer token required");
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    const bytes = await readAtMost(request, MAX_BODY_BYTES);
    if (bytes === null) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    const text = new TextDecoder().decode(bytes);
    if (url.pathname === EGRESS_USAGE_PATH) {
      let report: z.infer<typeof usageReportSchema>;
      try {
        report = usageReportSchema.parse(JSON.parse(text));
      } catch {
        return problem(
          400,
          "BAD_REQUEST",
          "Expected {exchange_id, session_id, attempt_id, usage} or {exchange_id, judgment_id, usage}",
        );
      }
      return answerWithin(() => recordUsage(report), { purpose: "usage" });
    }
    let body: z.infer<typeof authorizeRequestSchema>;
    try {
      body = authorizeRequestSchema.parse(JSON.parse(text));
    } catch {
      return problem(
        400,
        "BAD_REQUEST",
        "Expected {token, purpose} and, for the object store, {request}",
      );
    }
    return answerWithin(
      () => {
        switch (body.purpose) {
          case "object_store":
            return authorizeObjectStore(body.token, body);
          case "mcp":
            return deps.gateway.authorizeMcpEgress(body);
          case "packages":
            return deps.gateway.authorizePackagesEgress(body);
          case "judgment":
            return deps.gateway.authorizeJudgmentEgress(body);
          default:
            return deps.gateway.authorizeEgress(body);
        }
      },
      {
        purpose: body.purpose,
        // Which object store request was refused and why; a key is not a
        // secret, and the worker is told only that it was refused.
        ...(body.purpose === "object_store"
          ? {
              method: body.request.method,
              target: body.request.target.split("?")[0],
            }
          : {}),
        ...(body.purpose === "mcp"
          ? {
              server: body.server,
              method: body.rpc.method ?? undefined,
              tool: body.rpc.tool ?? undefined,
            }
          : {}),
      },
    );
  };

  // Streamable HTTP without sessions or streams: one message in, one JSON
  // answer out. The grant alone names the session.
  async function serveGitHubMcp(request: Request): Promise<Response> {
    const mcp = deps.githubMcp;
    if (mcp === undefined) return problem(404, "NOT_FOUND", "Not found");
    const bearer = /^Bearer (.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const grant =
      bearer === undefined
        ? null
        : verifyGitHubMcpGrant(mcp.grantKey, bearer, (mcp.now ?? Date.now)());
    if (grant === null) {
      return problem(401, "UNAUTHORIZED", "A GitHub MCP grant is required");
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > GITHUB_MCP_MAX_BODY_BYTES) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    const bytes = await readAtMost(request, GITHUB_MCP_MAX_BODY_BYTES);
    if (bytes === null) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        { status: 400 },
      );
    }
    try {
      const answer = await mcp.handle(grant, message, randomUUID());
      return answer === null
        ? new Response(null, { status: 202 })
        : Response.json(answer);
    } catch (error) {
      deps.logger.error("GitHub MCP call failed", {
        session_id: grant.sessionId,
        error: error instanceof Error ? error.name : "error",
      });
      return problem(503, "BACKEND_UNAVAILABLE", "GitHub MCP unavailable");
    }
  }

  async function recordUsage(report: z.infer<typeof usageReportSchema>) {
    const { usage } = report;
    const counted = {
      model: usage.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      cacheCreation1hInputTokens: usage.cache_creation_1h_input_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
      speed: usage.speed,
      inferenceGeo: usage.inference_geo,
      webSearchRequests: usage.web_search_requests,
      webFetchRequests: usage.web_fetch_requests,
      codeExecutionRequests: usage.code_execution_requests,
      estimated: usage.estimated,
    };
    if ("judgment_id" in report) {
      const priced = await deps.gateway.recordJudgmentUsage({
        exchangeId: report.exchange_id,
        judgmentId: report.judgment_id,
        usage: counted,
      });
      if (priced.pricedBy === "fallback") {
        deps.logger.warn("Judgment usage priced at the fallback rate", {
          judgment_id: report.judgment_id,
          model: usage.model,
          cost_usd: priced.costUsd,
        });
      }
      return { cost_usd: priced.costUsd, priced_by: priced.pricedBy };
    }
    const priced = await deps.gateway.recordProviderUsage({
      exchangeId: report.exchange_id,
      sessionId: report.session_id,
      attemptId: report.attempt_id,
      usage: counted,
    });
    if (priced.pricedBy === "fallback") {
      deps.logger.warn("Provider usage priced at the fallback rate", {
        session_id: report.session_id,
        model: usage.model,
        speed: usage.speed,
        inference_geo: usage.inference_geo,
        cost_usd: priced.costUsd,
      });
    }
    return { cost_usd: priced.costUsd, priced_by: priced.pricedBy };
  }

  async function answerWithin(
    work: () => Promise<unknown>,
    fields: Record<string, string | undefined>,
  ): Promise<Response> {
    const deadline = new RequestDeadline(performance.now() + deadlineMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), deadlineMs);
    });
    const answered = runWithDeadline(deadline, work);
    try {
      const outcome = await Promise.race([answered, expired]);
      if (outcome === "expired") {
        deadline.expire();
        answered.catch(() => {});
        deps.logger.warn("Egress authorization deadline exceeded", {
          purpose: fields.purpose,
          deadline_ms: deadlineMs,
        });
        return problem(503, "BACKEND_UNAVAILABLE", "Authorization timed out");
      }
      deadline.finish();
      return Response.json(outcome);
    } catch (error) {
      if (error instanceof WorkerGatewayError) {
        // The reason, never the token: a refused token is still a secret
        // that may belong to a live attempt.
        deps.logger.info("Egress authorization refused", {
          ...fields,
          status: error.status,
          code: error.code,
          ...(fields.purpose === "object_store"
            ? { reason: error.message }
            : {}),
          ...(error.reasonCode === undefined
            ? {}
            : { reason_code: error.reasonCode }),
        });
        if (error.receiptId !== undefined || error.reasonCode !== undefined) {
          return Response.json(
            {
              code: error.code,
              message: error.message,
              ...(error.receiptId === undefined
                ? {}
                : { receipt_id: error.receiptId }),
              ...(error.reasonCode === undefined
                ? {}
                : { details: { reason_code: error.reasonCode } }),
            },
            { status: error.status },
          );
        }
        return problem(error.status, error.code, error.message);
      }
      if (!isStorageUnavailable(error)) {
        deps.logger.error("Egress authorization failed", {
          purpose: fields.purpose,
          error: error instanceof Error ? error.name : "error",
        });
      }
      return problem(503, "BACKEND_UNAVAILABLE", "Authorization unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
