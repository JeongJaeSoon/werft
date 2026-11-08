import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type ActionRefusal,
  type ActionResult,
  type AgentGitHub,
  GITHUB_MCP_FIXED_TOOLS,
  GITHUB_MCP_SERVER,
  GITHUB_MCP_TOOL_ARGUMENTS,
  GITHUB_MCP_TOOL_CLASSES,
  GITHUB_MCP_TOOL_DESCRIPTIONS,
  GITHUB_MCP_TOOL_FEATURES,
  GITHUB_MCP_TOOL_OUTPUTS,
  type GitHubMcpTool,
  type GitHubPolicySource,
  githubMcpTools,
  type ReceiptActor,
} from "@werft-ai/contracts";
import { z } from "zod";
import {
  type PersonRejection,
  refusalFromServiceError,
  refusalOf,
} from "../action-broker/refusal.ts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type { GitHubMcpStore } from "../ports/github-mcp.ts";
import type { GitHubWorkService } from "./github-work-service.ts";
import type { PullRequestService } from "./pull-request-service.ts";
import type { PushActor, PushRequestService } from "./push-request-service.ts";
import type { RepositoryAttachmentService } from "./repository-attachment-service.ts";
import { SessionServiceError } from "./session-service.ts";

/**
 * The built-in `github` MCP server (design github-agent.md §3 "내장 MCP 서버
 * github"): the session's agent calls the same service functions as the
 * session API, for its own session only. The egress proxy reaches it with
 * a grant the authorizer signed for one session and attempt; nothing in a
 * request body picks the session.
 */

const GRANT_VERSION = "v1";
export const GITHUB_MCP_GRANT_TTL_MS = 60_000;

export type GitHubMcpGrant = { sessionId: string; attemptId: string };

const grantPayloadSchema = z
  .object({
    session_id: z.string().min(1),
    attempt_id: z.string().min(1),
    exp: z.number().int(),
  })
  .strict();

function mac(key: Uint8Array, signed: string): Buffer {
  return createHmac("sha256", key).update(signed, "utf8").digest();
}

/** The bearer the authorizer hands the proxy for one exchange. */
export function signGitHubMcpGrant(
  key: Uint8Array,
  grant: GitHubMcpGrant,
  nowMs: number,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      session_id: grant.sessionId,
      attempt_id: grant.attemptId,
      exp: nowMs + GITHUB_MCP_GRANT_TTL_MS,
    }),
    "utf8",
  ).toString("base64url");
  const signed = `${GRANT_VERSION}.${payload}`;
  return `${signed}.${mac(key, signed).toString("base64url")}`;
}

/** The session and attempt a bearer names, or null for any other bearer. */
export function verifyGitHubMcpGrant(
  key: Uint8Array,
  bearer: string,
  nowMs: number,
): GitHubMcpGrant | null {
  const parts = bearer.split(".");
  if (parts.length !== 3 || parts[0] !== GRANT_VERSION) return null;
  const [, payload = "", given = ""] = parts;
  const expected = mac(key, `${GRANT_VERSION}.${payload}`);
  const presented = Buffer.from(given, "base64url");
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return null;
  }
  let parsed: z.infer<typeof grantPayloadSchema>;
  try {
    parsed = grantPayloadSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
  if (parsed.exp <= nowMs) return null;
  return { sessionId: parsed.session_id, attemptId: parsed.attempt_id };
}

export type GitHubMcpServices = {
  pushRequests: Pick<
    PushRequestService,
    "create" | "get" | "snapshot" | "requestIntent"
  >;
  pullRequests: Pick<
    PullRequestService,
    "open" | "schedule" | "update" | "comment" | "setState" | "merge"
  >;
  githubWork: Pick<
    GitHubWorkService,
    "dispatch" | "getRun" | "rerun" | "review"
  >;
  attachments: Pick<RepositoryAttachmentService, "list" | "attach">;
};

// The protocol revisions this server answers; an unknown request gets the
// newest, as the specification lets a server do.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcId = string | number;
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The authorization the services see on this route: the attempt's own
 * session, to read and to submit to, and nothing else. The attempt's
 * authority comes from the egress fence, which the proxy re-asks on every
 * exchange; no scope is held, so no push can be decided.
 */
export function sessionBoundAuthorization(
  sessionId: string,
): AuthorizationPolicy {
  return {
    async authorize(request) {
      const allowed =
        (request.action === "session.read" ||
          request.action === "session.submit") &&
        request.resource.kind === "session" &&
        request.resource.id === sessionId;
      return {
        outcome: allowed ? "allow" : "deny",
        reason_code: allowed ? "ok" : "surface_ceiling",
        effective_scopes: [],
        policy_version: "github-mcp-1",
        decision_id: randomUUID(),
      };
    },
  };
}

function actorFor(
  ownerId: string,
  receiptActor: ReceiptActor,
  requestId: string,
): PushActor {
  const { principal } = receiptActor;
  // No scope: a push decision refuses it, and a pull request opens only from
  // a pushed request (design github-agent.md §2 decision 6).
  const unscoped = {
    kind: "api_key" as const,
    id: principal.id,
    owner_id: ownerId,
    workspace_id: null,
    scopes: [],
  };
  const caller: Caller = {
    ownerId,
    // What the receipts name (receiptActorOf).
    actor: {
      principal,
      userId: receiptActor.actor_user_id,
      workspaceId: null,
      apiKeyId: principal.kind === "api_key" ? principal.id : null,
      agentId: receiptActor.agent_id,
    },
    // Only sessionBoundAuthorization reads this, and it judges the session.
    subject: { principal: unscoped, surface: { kind: "api" } },
    requestId,
  };
  return { caller, principal: unscoped, ownerId, verified: true };
}

/**
 * A tool's answer: the envelope as `structuredContent`, and the same JSON as
 * `text` for a client that reads only content. `isError` is for a call that
 * was wrong (`validation_error`) or a server fault; any other refusal is a
 * normal result.
 */
function answerWith(envelope: ActionResult<unknown>) {
  const isError =
    !envelope.ok &&
    (envelope.refusal.code === "validation_error" ||
      envelope.refusal.code === "internal_error");
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    ...(isError ? { isError: true } : {}),
  };
}

const done = (result: unknown) => answerWith({ ok: true, result });
const refused = (refusal: ActionRefusal) => answerWith({ ok: false, refusal });

/** `outputSchema` must be an object schema at its root. */
function outputSchemaOf(tool: GitHubMcpTool) {
  return {
    type: "object",
    ...z.toJSONSchema(GITHUB_MCP_TOOL_OUTPUTS[tool], {
      io: "output",
      unrepresentable: "any",
    }),
  };
}

/**
 * What the person who rejected a push request wrote, read from the push
 * request itself (the web and Slack decisions both store it there), for a
 * pull request call refused because of that rejection.
 */
async function personRejection(
  services: GitHubMcpServices,
  actor: PushActor,
  sessionId: string,
  error: SessionServiceError,
  args: unknown,
): Promise<PersonRejection | null> {
  const { details } = error;
  if (
    !isRecord(details) ||
    details.refusal !== "not_pushed" ||
    details.push_request_state !== "rejected" ||
    !isRecord(args)
  ) {
    return null;
  }
  // A call by intent id learns the request from the refusal's details.
  const pushRequestId =
    typeof args.push_request_id === "string"
      ? args.push_request_id
      : details.push_request_id;
  if (typeof pushRequestId !== "string") return null;
  const request = await services.pushRequests
    .get(actor, sessionId, pushRequestId)
    .catch(() => null);
  return {
    pushRequestId,
    reason: request?.resolution_reason ?? null,
  };
}

export function createGitHubMcpServer(deps: {
  store: GitHubMcpStore;
  /** The session services, made with the authorization they run under. */
  services: (authorization: AuthorizationPolicy) => GitHubMcpServices;
  /**
   * AGENT_ACTION_FLOWS, read on each call. On, a `request_push` inside a
   * running turn is an intent (push what the turn ends with); off, it takes
   * the legacy path. Absent is off.
   */
  actionFlows?: () => boolean;
  /** Where the exception behind an `internal_error` answer goes to be logged. */
  onInternalError?: (
    error: unknown,
    context: { tool: GitHubMcpTool; sessionId: string; requestId: string },
  ) => void;
}) {
  const toolList = (tools: readonly GitHubMcpTool[]) =>
    tools.map((name) => ({
      name,
      description: GITHUB_MCP_TOOL_DESCRIPTIONS[name],
      inputSchema: z.toJSONSchema(GITHUB_MCP_TOOL_ARGUMENTS[name], {
        io: "input",
        unrepresentable: "any",
      }),
      outputSchema: outputSchemaOf(name),
      // The policy unit the tool is judged under; `_meta` is MCP's slot for
      // fields a client need not understand.
      _meta: { class: GITHUB_MCP_TOOL_CLASSES[name] },
    }));

  async function call(
    grant: GitHubMcpGrant,
    tool: GitHubMcpTool,
    args: unknown,
    requestId: string,
    startedAt: number,
    github: AgentGitHub,
    state: {
      ownerId: string;
      actor: ReceiptActor;
      source: GitHubPolicySource;
      enabled: boolean;
    },
  ) {
    if (state.source === "release") {
      if (!githubMcpTools(github).includes(tool)) {
        return refused(refusalOf(tool, "feature_off"));
      }
    } else {
      // The tool stays listed so the session's config never moves: its
      // refusal is the answer, in the model's turn.
      const feature = GITHUB_MCP_TOOL_FEATURES[tool];
      const code = !state.enabled
        ? "github_disabled"
        : feature !== null && !github.features[feature]
          ? "feature_off"
          : null;
      if (code !== null) return refused(refusalOf(tool, code));
    }
    const parsed = GITHUB_MCP_TOOL_ARGUMENTS[tool].safeParse(args ?? {});
    if (!parsed.success) {
      return refused(
        refusalOf(tool, "validation_error", {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        }),
      );
    }
    const actor = actorFor(state.ownerId, state.actor, requestId);
    const services = deps.services(sessionBoundAuthorization(grant.sessionId));
    const { sessionId } = grant;
    // What is left of `seconds` counted from the start of the whole call, so
    // the state read and the validation above are inside the wait. No wait
    // asked for (omitted or 0) leaves the option out; a spent budget is
    // `waitMs: 0`, which the services treat as a deadline already passed.
    const waitLeft = (seconds: number | undefined): { waitMs?: number } =>
      seconds === undefined || seconds === 0
        ? {}
        : {
            waitMs: Math.max(
              0,
              seconds * 1000 - (performance.now() - startedAt),
            ),
          };
    let turnAtCall: number | null = null;
    try {
      if (tool === "list_repositories") {
        return done(
          await services.attachments.list(
            sessionId,
            parsed.data as z.infer<
              (typeof GITHUB_MCP_TOOL_ARGUMENTS)["list_repositories"]
            >,
          ),
        );
      }
      if (tool === "attach_repository") {
        const { repository_id, wait_seconds } = parsed.data as z.infer<
          (typeof GITHUB_MCP_TOOL_ARGUMENTS)["attach_repository"]
        >;
        const attachment = await services.attachments.attach({
          sessionId,
          attemptId: grant.attemptId,
          actor: state.actor,
          repositoryId: repository_id,
          ...waitLeft(wait_seconds),
        });
        return done({ ...attachment, final: attachment.status !== "pending" });
      }
      // Read before the request, so a refusal handled late cannot mark the
      // turn that started after this one ended.
      turnAtCall =
        tool === "request_push" ? await deps.store.runningTurn(grant) : null;
      if (tool === "request_push") {
        const { source_ref, ...body } = parsed.data as z.infer<
          (typeof GITHUB_MCP_TOOL_ARGUMENTS)["request_push"]
        >;
        if (source_ref !== undefined && deps.actionFlows?.() !== true) {
          return refused({
            code: "source_ref_unsupported",
            by: "platform",
            retryable: false,
          });
        }
        // Before anything is written, in either flow: no PR tool is trusted
        // to run unseen yet, so a pull request cannot ride along with the
        // push, and the actions flow must not store an intent for it either.
        if ((body as { pull_request?: unknown }).pull_request !== undefined) {
          throw new SessionServiceError(
            "BAD_REQUEST",
            "pull_request needs a tool call",
            undefined,
            { refusal: "pull_request_needs_tool_call" },
          );
        }
        if (deps.actionFlows?.() === true) {
          if (turnAtCall === null) {
            return refused({
              code: "no_running_turn",
              by: "platform",
              retryable: false,
            });
          }
          const asked = await services.pushRequests.requestIntent(
            actor,
            sessionId,
            {
              attemptId: grant.attemptId,
              turnId: turnAtCall,
              body,
              ...(source_ref === undefined ? {} : { sourceRef: source_ref }),
            },
          );
          if (asked.status === "github_disabled") {
            return refused({
              code: "github_disabled",
              by: "policy",
              retryable: false,
            });
          }
          if (asked.status === "source_ref_required") {
            return refused({
              code: "source_ref_required",
              by: "platform",
              retryable: true,
              details: { target_branch: asked.target_branch },
            });
          }
          if (asked.status === "turn_not_running") {
            return refused({
              code: "no_running_turn",
              by: "platform",
              retryable: false,
            });
          }
          return done({
            status: "deferred",
            push_intent_id: asked.intent.id,
            waits_for: "reply_end",
            repository_id: asked.intent.repository_id,
            target_branch: asked.intent.target_branch,
            pull_request: "none",
            // The model reads this as the end of the job; say that the pull
            // request is still its call, now, approval or not.
            next: "Now call open_pull_request with this push_intent_id, without waiting for the push, also when the push needs approval. When every repository is asked for, tell the user in plain words which repositories were pushed, that a person approves each push, and that each pull request opens after its approval.",
          });
        }
      }
      return done(
        await run(services, actor, sessionId, tool, parsed.data, waitLeft),
      );
    } catch (error) {
      if (error instanceof SessionServiceError) {
        const continued =
          turnAtCall !== null &&
          isRecord(error.details) &&
          error.details.refusal === "no_checkpoint" &&
          (await deps.store.markPushContinuation({
            sessionId,
            turnId: turnAtCall,
          }));
        // Not a refusal: the push still happens, one turn later.
        if (continued) {
          return done({ status: "deferred", continuation: "after_turn" });
        }
        return refused(
          refusalFromServiceError(
            tool,
            error,
            await personRejection(
              services,
              actor,
              sessionId,
              error,
              parsed.data,
            ),
          ),
        );
      }
      throw error;
    }
  }

  return async function handle(
    grant: GitHubMcpGrant,
    message: unknown,
    requestId: string,
  ): Promise<JsonRpcResponse | null> {
    // The clock of a waiting call starts here, not when its service starts.
    const startedAt = performance.now();
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      };
    }
    const id = message.id;
    // A notification, or a response to a request this server never sends.
    if (
      typeof message.method === "string"
        ? id === undefined
        : "result" in message || "error" in message
    ) {
      return null;
    }
    if (typeof message.method !== "string") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      };
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request id" },
      };
    }
    const answer = (result: unknown): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      result,
    });
    const fail = (code: number, text: string): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    });
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return answer({
          protocolVersion:
            typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: GITHUB_MCP_SERVER, version: "1" },
        });
      }
      case "ping":
        return answer({});
      case "tools/list":
      case "tools/call":
        break;
      default:
        return fail(-32601, `Method ${message.method} is not served`);
    }
    // Read for every call: the proxy judged the exchange a moment ago, and
    // the same reads here keep a switch flipped since then from acting.
    const asked = params.name;
    const askedTool =
      message.method === "tools/call" &&
      typeof asked === "string" &&
      Object.hasOwn(GITHUB_MCP_TOOL_ARGUMENTS, asked)
        ? (asked as GitHubMcpTool)
        : null;
    // A fault of the server: the model gets the code, never the exception,
    // and a logger that fails does not take the answer with it.
    const internalFault = (tool: GitHubMcpTool, error: unknown) => {
      try {
        deps.onInternalError?.(error, {
          tool,
          sessionId: grant.sessionId,
          requestId,
        });
      } catch {}
      return answer(refused(refusalOf(tool, "internal_error")));
    };
    let state: Awaited<ReturnType<typeof deps.store.sessionState>>;
    try {
      state = await deps.store.sessionState(grant.sessionId);
    } catch (error) {
      // Other methods have no tool to answer for: the transport reports it.
      if (askedTool === null) throw error;
      return internalFault(askedTool, error);
    }
    if (
      state === null ||
      state.github === null ||
      (!state.enabled && state.source === "release") ||
      state.actor === null
    ) {
      return fail(-32001, "GitHub tools are not available to this session");
    }
    if (message.method === "tools/list") {
      return answer({
        tools: toolList(
          state.source === "release"
            ? githubMcpTools(state.github)
            : GITHUB_MCP_FIXED_TOOLS,
        ),
      });
    }
    const name = params.name;
    if (
      typeof name !== "string" ||
      !Object.hasOwn(GITHUB_MCP_TOOL_ARGUMENTS, name) ||
      !(GITHUB_MCP_FIXED_TOOLS as readonly string[]).includes(name)
    ) {
      return fail(-32602, "Unknown tool");
    }
    const tool = name as GitHubMcpTool;
    try {
      return answer(
        await call(
          grant,
          tool,
          params.arguments,
          requestId,
          startedAt,
          state.github,
          {
            ownerId: state.ownerId,
            actor: state.actor,
            source: state.source,
            enabled: state.enabled,
          },
        ),
      );
    } catch (error) {
      return internalFault(tool, error);
    }
  };
}

// Each tool is one call to the session API's own service function.
async function run(
  services: GitHubMcpServices,
  actor: PushActor,
  sessionId: string,
  tool: GitHubMcpTool,
  args: unknown,
  waitLeft: (seconds: number | undefined) => { waitMs?: number },
): Promise<unknown> {
  switch (tool) {
    case "request_push":
      return services.pushRequests.create(actor, sessionId, {
        idempotencyKey: `mcp-${randomUUID()}`,
        body: args as z.infer<
          (typeof GITHUB_MCP_TOOL_ARGUMENTS)["request_push"]
        >,
      });
    case "open_pull_request": {
      const { push_request_id, push_intent_id, ...body } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["open_pull_request"]
      >;
      // An intent, with no push request yet, can only be scheduled. A push
      // request opens when it is pushed and is scheduled when it is not.
      if (push_intent_id !== undefined) {
        return services.pullRequests.schedule(
          actor,
          sessionId,
          { pushIntentId: push_intent_id },
          { readBody: async () => body },
        );
      }
      if (push_request_id === undefined) {
        throw new Error("open_pull_request without an id passed the schema");
      }
      return services.pullRequests.schedule(
        actor,
        sessionId,
        { pushRequestId: push_request_id },
        { readBody: async () => body },
      );
    }
    case "get_push_request": {
      const { push_request_id, push_intent_id } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["get_push_request"]
      >;
      return services.pushRequests.snapshot(
        actor,
        sessionId,
        push_intent_id !== undefined
          ? { pushIntentId: push_intent_id }
          : { pushRequestId: push_request_id as string },
      );
    }
    case "update_pull_request": {
      const { push_request_id, ...body } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["update_pull_request"]
      >;
      return services.pullRequests.update(actor, sessionId, push_request_id, {
        readBody: async () => body,
      });
    }
    case "comment_pull_request": {
      const { push_request_id, ...body } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["comment_pull_request"]
      >;
      return services.pullRequests.comment(actor, sessionId, push_request_id, {
        readBody: async () => body,
      });
    }
    case "close_pull_request":
    case "reopen_pull_request": {
      const { push_request_id } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["close_pull_request"]
      >;
      return services.pullRequests.setState(
        actor,
        sessionId,
        push_request_id,
        tool === "close_pull_request" ? "closed" : "open",
      );
    }
    case "merge_pull_request": {
      const { push_request_id } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["merge_pull_request"]
      >;
      return services.pullRequests.merge(actor, sessionId, push_request_id);
    }
    case "dispatch_workflow":
      return services.githubWork.dispatch(
        actor,
        sessionId,
        args as z.infer<
          (typeof GITHUB_MCP_TOOL_ARGUMENTS)["dispatch_workflow"]
        >,
      );
    case "get_workflow_run": {
      const { run_id, wait_seconds } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["get_workflow_run"]
      >;
      const view = await services.githubWork.getRun(
        actor,
        sessionId,
        run_id,
        waitLeft(wait_seconds),
      );
      return { ...view, final: view.status === "completed" };
    }
    case "rerun_workflow": {
      const { run_id, ...body } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["rerun_workflow"]
      >;
      return services.githubWork.rerun(actor, sessionId, run_id, body);
    }
    case "submit_review": {
      const { number, ...body } = args as z.infer<
        (typeof GITHUB_MCP_TOOL_ARGUMENTS)["submit_review"]
      >;
      return services.githubWork.review(actor, sessionId, number, body);
    }
    case "list_repositories":
    case "attach_repository":
      throw new Error(`${tool} is not run here`);
  }
}
