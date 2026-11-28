import {
  type ActionResult,
  type AgentGitHub,
  GITHUB_MCP_FIXED_TOOLS,
  GITHUB_MCP_TOOL_ARGUMENTS,
  GITHUB_MCP_TOOL_CLASSES,
  GITHUB_MCP_TOOL_DESCRIPTIONS,
  GITHUB_MCP_TOOL_FEATURES,
  GITHUB_MCP_TOOL_OUTPUTS,
  type GitHubCeiling,
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
  isRecord,
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

/** The console's name of each switch a refusal names (apps/web agentGitHub.feature.*). */
const SWITCH_LABELS = {
  actions: {
    en: "Run workflows directly (run, rerun, cancel)",
    ko: "workflow 직접 실행 (실행·재실행·취소)",
    ja: "ワークフローの直接実行 (実行・再実行・キャンセル)",
  },
  workflows: {
    en: "Edit workflow files and see CI results",
    ko: "workflow 파일 수정과 CI 결과 보기",
    ja: "ワークフローファイルの変更と CI 結果の確認",
  },
  review: {
    en: "Approve reviews",
    ko: "리뷰 승인",
    ja: "レビュー承認",
  },
  merge: {
    en: "Merge its own pull requests",
    ko: "자기 PR 머지",
    ja: "自分の PR のマージ",
  },
} as const;
type Switch = keyof typeof SWITCH_LABELS;
const isSwitch = (feature: string | null): feature is Switch =>
  feature !== null && Object.hasOwn(SWITCH_LABELS, feature);

/**
 * Where a switch is off, and who turns it on: the agent's GitHub settings
 * (an admin), the workspace ceiling (an owner or admin only), or both, the
 * ceiling first.
 */
export function switchOffDetails(
  feature: Switch,
  offIn: "agent" | "ceiling" | "both",
) {
  const label = SWITCH_LABELS[feature].en;
  return {
    reason_code: `${feature}_off` as const,
    off_in: offIn,
    switch_labels: SWITCH_LABELS[feature],
    hint:
      offIn === "agent"
        ? `"${label}" is off in this agent's GitHub settings; a workspace admin turns it on there. A session that started with it off keeps it off; a new session takes the change.`
        : offIn === "ceiling"
          ? `"${label}" is off in the workspace GitHub ceiling; only a workspace owner or admin turns it on. The ceiling is read on every call, so the next call takes the change.`
          : `"${label}" is off in both the workspace GitHub ceiling and this agent's GitHub settings; a workspace owner or admin turns on the ceiling first, then the agent's settings. The ceiling applies from the next call; a session that started with the agent's switch off keeps it off, and a new session takes the change.`,
  };
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
    /** The workspace ceiling now; absent when it was not read. */
    ceiling?: GitHubCeiling;
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
    // A run started directly, reading CI and approving a review each have
    // their own switch; the code names it, and where it is off. The agent's
    // side is off here (its settings are why the tool is refused); the
    // ceiling may be off too.
    const off = () => {
      const feature = GITHUB_MCP_TOOL_FEATURES[tool];
      return refusalOf(
        tool,
        "feature_off",
        isSwitch(feature)
          ? switchOffDetails(
              feature,
              state.ceiling?.[feature] === false ? "both" : "agent",
            )
          : undefined,
      );
    };
    if (state.source === "release") {
      if (!githubMcpTools(github).includes(tool)) {
        return toolAnswer(refused(off()));
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
      if (code === "feature_off") return toolAnswer(refused(off()));
      if (code !== null) return toolAnswer(refused(refusalOf(tool, code)));
    }
    // On for the agent, off in the ceiling: the same code, naming the
    // ceiling, before the gate would refuse it as over_workspace_ceiling.
    const switched = GITHUB_MCP_TOOL_FEATURES[tool];
    if (isSwitch(switched) && state.ceiling?.[switched] === false) {
      return toolAnswer(
        refused(
          refusalOf(tool, "feature_off", switchOffDetails(switched, "ceiling")),
        ),
      );
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
        const refusal = refusalFromServiceError(
          tool,
          error,
          await personRejection(services, actor, sessionId, error, parsed.data),
        );
        // The gate says where merging is off; the switch's name and who
        // turns it on are added here, as for the switches judged above.
        const offIn = refusal.details?.off_in;
        return toolAnswer(
          refused(
            refusal.details?.reason_code === "merge_off" &&
              (offIn === "agent" || offIn === "ceiling" || offIn === "both")
              ? {
                  ...refusal,
                  details: {
                    ...refusal.details,
                    ...switchOffDetails("merge", offIn),
                  },
                }
              : refusal,
          ),
        );
      }
      throw error;
    }
  };
}
