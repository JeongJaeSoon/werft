import {
  type ActionResult,
  type AgentGitHub,
  GITHUB_MCP_FIXED_TOOLS,
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
import type { GitHubMcpStore } from "../../github/ports/github-mcp.ts";
import { SessionServiceError } from "../../musterrolle/index.ts";
import type { PushActor } from "../change-request/push-decision.ts";
import {
  type PersonRejection,
  refusalFromServiceError,
  refusalOf,
} from "../refusal.ts";
import {
  type GitHubMcpServices,
  refused,
  type ToolContext,
  type ToolHandlers,
} from "./handler.ts";
import { actorFor } from "./session-bound.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A tool's answer: the envelope as `structuredContent`, and the same JSON as
 * `text` for a client that reads only content. `isError` is for a call that
 * was wrong (`validation_error`) or a server fault; any other refusal is a
 * normal result.
 */
export function toolAnswer(envelope: ActionResult<unknown>) {
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

/** A name the contracts define a tool under, listed or not. */
export function definedTool(name: unknown): GitHubMcpTool | null {
  return typeof name === "string" &&
    Object.hasOwn(GITHUB_MCP_TOOL_ARGUMENTS, name)
    ? (name as GitHubMcpTool)
    : null;
}

/** A defined tool that this server can ever list. */
export function servedTool(name: unknown): GitHubMcpTool | null {
  const tool = definedTool(name);
  return tool !== null &&
    (GITHUB_MCP_FIXED_TOOLS as readonly string[]).includes(tool)
    ? tool
    : null;
}

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

/** The `tools/list` entries for these tools. */
export function describeTools(tools: readonly GitHubMcpTool[]) {
  return tools.map((name) => ({
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

/** What one `tools/call` is, once the session behind it has been read. */
export type ToolCall = {
  grant: { sessionId: string; attemptId: string };
  tool: GitHubMcpTool;
  args: unknown;
  requestId: string;
  /** `performance.now()` at the start of the whole call. */
  startedAt: number;
  github: AgentGitHub;
  state: {
    ownerId: string;
    actor: ReceiptActor;
    source: GitHubPolicySource;
    enabled: boolean;
  };
};

/**
 * The pipeline every tool shares: the feature gate, argument validation, the
 * tool's handler, and the envelope. Authorization, credentials and receipts
 * stay with the services the handlers call.
 */
export function createToolDispatcher(deps: {
  handlers: ToolHandlers;
  store: Pick<GitHubMcpStore, "runningTurn">;
  /** The session services for a call bound to this session. */
  services: (sessionId: string) => GitHubMcpServices;
}) {
  return async function dispatch(call: ToolCall) {
    const { grant, tool, args, requestId, startedAt, github, state } = call;
    if (state.source === "release") {
      if (!githubMcpTools(github).includes(tool)) {
        return toolAnswer(refused(refusalOf(tool, "feature_off")));
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
      if (code !== null) return toolAnswer(refused(refusalOf(tool, code)));
    }
    const parsed = GITHUB_MCP_TOOL_ARGUMENTS[tool].safeParse(args ?? {});
    if (!parsed.success) {
      return toolAnswer(
        refused(
          refusalOf(tool, "validation_error", {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          }),
        ),
      );
    }
    const actor = actorFor(state.ownerId, state.actor, requestId);
    const services = deps.services(grant.sessionId);
    const { sessionId } = grant;
    const context: ToolContext = {
      services,
      actor,
      receiptActor: state.actor,
      sessionId,
      attemptId: grant.attemptId,
      // The state read and the validation above are inside the wait. No wait
      // asked for (omitted or 0) leaves the option out; a spent budget is
      // `waitMs: 0`, which the services treat as a deadline already passed.
      waitLeft: (seconds) =>
        seconds === undefined || seconds === 0
          ? {}
          : {
              waitMs: Math.max(
                0,
                seconds * 1000 - (performance.now() - startedAt),
              ),
            },
      runningTurn: () => deps.store.runningTurn(grant),
    };
    try {
      // The table pairs each tool with its own argument type; the lookup by a
      // runtime name cannot, so the pairing is asserted here, once.
      const handler = deps.handlers[tool] as (
        context: ToolContext,
        args: unknown,
      ) => ReturnType<ToolHandlers[GitHubMcpTool]>;
      return toolAnswer(await handler(context, parsed.data));
    } catch (error) {
      if (error instanceof SessionServiceError) {
        return toolAnswer(
          refused(
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
          ),
        );
      }
      throw error;
    }
  };
}
