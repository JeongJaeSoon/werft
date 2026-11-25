import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ADDITIONAL_REPOSITORY_ID_PATTERN,
  mcpServerIdSchema,
} from "@werft-ai/contracts";
import { RequestDeadline, runWithDeadline } from "@werft-ai/db/pool";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  type BudgetChoice,
  type BuiltinMcpGrant,
  GITHUB_MCP_UPSTREAM_PATH,
  hashToken,
  type JsonRpcResponse,
  PACKAGE_REGISTRY_NAMES,
  type ProviderExchangeLedger,
  type ProviderUsage,
  verifyBuiltinMcpGrant,
  WERFT_MCP_UPSTREAM_PATH,
  type WerftMcpResponse,
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
// Where the proxy opens, renews and releases a provider call in the exchange
// ledger before its usage is known; an open the
// session's budget cannot hold is refused.
export const EGRESS_EXCHANGES_PATH = "/exchanges";
// On an open, `title`: a session title call, which serves no turn and so is
// held on the account of the session's first turn, whichever turn runs now.
// A header, not the body: the open's body is strict, and an API before it
// ignores a header it does not know.
export const EGRESS_EXCHANGE_CALL_HEADER = "x-werft-exchange-call";
// On a provider authorize, the proxy's id for the exchange asking, which a
// conversation call's token is bound to. A header for the reason above.
export const EGRESS_EXCHANGE_ID_HEADER = "x-werft-exchange-id";
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

/**
 * The key the built-in `werft` MCP server's grants are signed with, derived
 * the same way under its own name: a grant for one built-in server opens
 * neither the other nor the authorizer.
 */
export function werftMcpGrantKeyOf(config: EgressAuthorizerConfig): Buffer {
  return createHmac("sha256", config.token)
    .update("werft werft mcp grant v1", "utf8")
    .digest();
}

// What a built-in server takes in one message: a dispatch's inputs are
// the largest argument (25 inputs of up to 64 KiB).
const BUILTIN_MCP_MAX_BODY_BYTES = 2 * 1024 * 1024;

const tokenSchema = z.string().min(1).max(512);

const authorizeRequestSchema = z.union([
  z
    .object({
      token: tokenSchema,
      purpose: z.enum(["provider", "repository"]),
      // repository only: the route named another repository than the
      // session's own.
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

// A session's call, one achievement judgment's, which no session pays, or a
// conversation call's, which its budget account pays.
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
  z
    .object({
      exchange_id: z.string().uuid(),
      conversation_call_id: z.string().uuid(),
      usage: usageSchema,
    })
    .strict(),
]);

// Open a provider call before calling upstream, with what its request alone
// says it may use, where the session's budget is judged; renew one still
// streaming; release one the provider never billed. A session's calls only.
const exchangeCall = {
  exchange_id: z.string().uuid(),
  session_id: z.string().uuid(),
  attempt_id: z.string().min(1).max(256),
  reserve: usageSchema,
};
const exchangeRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("open"), ...exchangeCall }).strict(),
  z.object({ op: z.literal("renew"), exchange_id: z.string().uuid() }).strict(),
  z.object({ op: z.literal("release"), ...exchangeCall }).strict(),
]);

/** The report's snake_case usage as the platform counts it. */
function countedOf(usage: z.infer<typeof usageSchema>): ProviderUsage {
  return {
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
}

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
    | "authorizeConversationCallEgress"
    | "recordConversationCallUsage"
  >;
  logger: StructuredLogger;
  /** Absent, the exchanges route answers 404 as an older API does. */
  exchanges?: ProviderExchangeLedger;
  /**
   * The budget account an open also holds its call on; undefined, or this
   * absent, the session's limit alone. A release frees what the open held.
   */
  budgetOf?: (call: {
    exchangeId: string;
    sessionId: string;
    attemptId: string;
    title?: boolean;
  }) => Promise<{ choice: BudgetChoice | undefined; turnId: string | null }>;
  /** Absent when the API runs without an object store: the route refuses. */
  objectStore?: ObjectRouteSigner;
  /**
   * The built-in `github` MCP server, reached by the proxy at
   * GITHUB_MCP_UPSTREAM_PATH with a grant this listener's gateway signed.
   */
  githubMcp?: {
    handle: (
      grant: BuiltinMcpGrant,
      message: unknown,
      requestId: string,
    ) => Promise<JsonRpcResponse | null>;
    grantKey: Uint8Array;
    now?: () => number;
  };
  /**
   * The built-in `werft` MCP server, reached at WERFT_MCP_UPSTREAM_PATH the
   * same way, with a grant signed under its own key.
   */
  werftMcp?: {
    handle: (
      grant: BuiltinMcpGrant,
      message: unknown,
      requestId: string,
    ) => Promise<WerftMcpResponse | null>;
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
  const expected = hashToken(`Bearer ${deps.token}`);
  const deadlineMs = deps.deadlineMs ?? AUTHORIZE_DEADLINE_MS;
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === GITHUB_MCP_UPSTREAM_PATH) {
      return serveBuiltinMcp(request, deps.githubMcp, "GitHub");
    }
    if (url.pathname === WERFT_MCP_UPSTREAM_PATH) {
      return serveBuiltinMcp(request, deps.werftMcp, "Werft");
    }
    const { exchanges } = deps;
    if (
      request.method !== "POST" ||
      (url.pathname !== EGRESS_AUTHORIZER_PATH &&
        url.pathname !== EGRESS_USAGE_PATH &&
        (url.pathname !== EGRESS_EXCHANGES_PATH || exchanges === undefined))
    ) {
      return problem(404, "NOT_FOUND", "Not found");
    }
    // Compared as digests so neither the length nor a prefix of the secret
    // leaks through timing.
    if (
      !timingSafeEqual(
        hashToken(request.headers.get("authorization") ?? ""),
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
          "Expected {exchange_id, session_id, attempt_id, usage}, {exchange_id, judgment_id, usage} or {exchange_id, conversation_call_id, usage}",
        );
      }
      return answerWithin(() => recordUsage(report), { purpose: "usage" });
    }
    if (url.pathname === EGRESS_EXCHANGES_PATH && exchanges !== undefined) {
      let body: z.infer<typeof exchangeRequestSchema>;
      try {
        body = exchangeRequestSchema.parse(JSON.parse(text));
      } catch {
        return problem(
          400,
          "BAD_REQUEST",
          "Expected {op: open | release, exchange_id, session_id, attempt_id, reserve} or {op: renew, exchange_id}",
        );
      }
      const title =
        request.headers.get(EGRESS_EXCHANGE_CALL_HEADER) === "title";
      return answerWithin(() => recordExchange(exchanges, body, title), {
        purpose: "exchange",
      });
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
            return body.purpose === "provider"
              ? authorizeProvider(body, request)
              : deps.gateway.authorizeEgress(body);
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

  // A conversation call's token first, then a session's.
  async function authorizeProvider(
    body: Extract<
      z.infer<typeof authorizeRequestSchema>,
      { purpose: "provider" | "repository" }
    >,
    request: Request,
  ) {
    const exchangeId = z
      .uuid()
      .safeParse(request.headers.get(EGRESS_EXCHANGE_ID_HEADER));
    const called = await deps.gateway.authorizeConversationCallEgress({
      token: body.token,
      path: body.path,
      exchange_id: exchangeId.success ? exchangeId.data : undefined,
    });
    if (called !== null && "outcome" in called) {
      // A turn's call refused with nothing held: the turn ends on it, and
      // its permit keeps why.
      if (called.outcome === "turn_limited") {
        // A runtime that got past its own count of the turn's calls.
        deps.logger.warn("Conversation turn call refused", {
          turn_id: called.turnId,
          refused_by: "turn_limit",
        });
        throw new WorkerGatewayError(
          403,
          "FORBIDDEN",
          "The conversation turn has made as many provider calls as a turn may",
          false,
          undefined,
          "conversation_turn_call_limit",
        );
      }
      deps.logger.info("Conversation turn call refused", {
        turn_id: called.turnId,
        refused_by: called.outcome === "refused" ? "budget" : "concurrency",
        ...(called.outcome === "refused"
          ? {
              budget_root_kind: called.rootKind,
              budget_account_id: called.accountId ?? undefined,
            }
          : {
              limit: called.limit,
              in_progress: called.inProgress,
              unknown: called.unknown,
            }),
      });
      throw called.outcome === "refused"
        ? new WorkerGatewayError(
            403,
            "BUDGET_EXCEEDED",
            "The turn's budget account cannot hold this call's reserve",
          )
        : new WorkerGatewayError(
            403,
            "FORBIDDEN",
            "Too many conversation calls are in progress",
            false,
            undefined,
            `conversation_call_limit_${called.limit}`,
          );
    }
    return called ?? deps.gateway.authorizeEgress(body);
  }

  // Streamable HTTP without sessions or streams: one message in, one JSON
  // answer out. The grant alone names the session.
  async function serveBuiltinMcp(
    request: Request,
    mcp: typeof deps.githubMcp | typeof deps.werftMcp,
    label: "GitHub" | "Werft",
  ): Promise<Response> {
    if (mcp === undefined) return problem(404, "NOT_FOUND", "Not found");
    const bearer = /^Bearer (.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const grant =
      bearer === undefined
        ? null
        : verifyBuiltinMcpGrant(mcp.grantKey, bearer, (mcp.now ?? Date.now)());
    if (grant === null) {
      return problem(401, "UNAUTHORIZED", `A ${label} MCP grant is required`);
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > BUILTIN_MCP_MAX_BODY_BYTES) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    const bytes = await readAtMost(request, BUILTIN_MCP_MAX_BODY_BYTES);
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
      deps.logger.error(`${label} MCP call failed`, {
        session_id: grant.sessionId,
        error: error instanceof Error ? error.name : "error",
      });
      return problem(503, "BACKEND_UNAVAILABLE", `${label} MCP unavailable`);
    }
  }

  async function recordUsage(report: z.infer<typeof usageReportSchema>) {
    const { usage } = report;
    const counted = countedOf(usage);
    if ("conversation_call_id" in report) {
      const priced = await deps.gateway.recordConversationCallUsage({
        exchangeId: report.exchange_id,
        callId: report.conversation_call_id,
        usage: counted,
      });
      if (priced.pricedBy === "fallback") {
        deps.logger.warn(
          "Conversation call usage priced at the fallback rate",
          {
            conversation_call_id: report.conversation_call_id,
            model: usage.model,
            cost_usd: priced.costUsd,
          },
        );
      }
      return { cost_usd: priced.costUsd, priced_by: priced.pricedBy };
    }
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
    if (priced.ledgerForeignRow) {
      deps.logger.warn("Provider exchange ledger row names another owner", {
        exchange_id: report.exchange_id,
        session_id: report.session_id,
        attempt_id: report.attempt_id,
      });
    }
    return { cost_usd: priced.costUsd, priced_by: priced.pricedBy };
  }

  // The proxy calls upstream only on an open answered `open`; a renewal's
  // and a release's answers only say what was done.
  async function recordExchange(
    ledger: ProviderExchangeLedger,
    body: z.infer<typeof exchangeRequestSchema>,
    title: boolean,
  ): Promise<Response> {
    if (body.op === "renew") {
      return Response.json({ state: await ledger.renew(body.exchange_id) });
    }
    const call = {
      exchangeId: body.exchange_id,
      sessionId: body.session_id,
      attemptId: body.attempt_id,
      reserve: countedOf(body.reserve),
    };
    const unknownAttempt = () =>
      new WorkerGatewayError(
        404,
        "NOT_FOUND",
        "No such attempt of that session",
      );
    const conflict = () =>
      new WorkerGatewayError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "That exchange is another owner's or was opened with another reserve",
      );
    if (body.op === "release") {
      const released = await ledger.release(call);
      if (released === "unknown_attempt") throw unknownAttempt();
      if (released === "conflict") throw conflict();
      return Response.json({ state: released });
    }
    const chosen = await deps.budgetOf?.({
      exchangeId: call.exchangeId,
      sessionId: call.sessionId,
      attemptId: call.attemptId,
      ...(title ? { title: true } : {}),
    });
    const budget = chosen?.choice;
    const opened = await ledger.open(
      budget === undefined ? call : { ...call, budget },
    );
    switch (opened.outcome) {
      case "created":
        return Response.json({ state: "open" }, { status: 201 });
      case "open":
      case "settled":
      case "released":
        return Response.json({ state: opened.outcome });
      case "budget_exceeded":
        deps.logger.info("Provider exchange refused for the budget", {
          session_id: body.session_id,
          attempt_id: body.attempt_id,
          turn_id: chosen?.turnId ?? undefined,
          refused_by: opened.by,
          budget_root_kind: budget?.rootKind,
          budget_account_id: opened.accountId ?? undefined,
        });
        throw new WorkerGatewayError(
          403,
          "BUDGET_EXCEEDED",
          "The session's spend with this call's reserve reaches its cost or token limit",
        );
      case "unknown_attempt":
        throw unknownAttempt();
      case "conflict":
        throw conflict();
    }
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
      return outcome instanceof Response ? outcome : Response.json(outcome);
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
