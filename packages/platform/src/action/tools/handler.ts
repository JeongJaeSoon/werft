import type {
  ActionRefusal,
  ActionResult,
  GITHUB_MCP_TOOL_ARGUMENTS,
  GitHubMcpTool,
  ReceiptActor,
} from "@werft-ai/contracts";
import type { z } from "zod";
import type { RepositoryAttachmentService } from "../../sessions/index.ts";
import type { PullRequestService } from "../change-request/pull-request-service.ts";
import type {
  PushActor,
  PushRequestService,
} from "../change-request/push-request-service.ts";
import type { GitHubWorkService } from "../github/github-work-service.ts";

/** The session services a built-in tool calls, made with the call's authorization. */
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

/** What a handler needs of one call; nothing in it is chosen by the model. */
export type ToolContext = {
  services: GitHubMcpServices;
  actor: PushActor;
  receiptActor: ReceiptActor;
  sessionId: string;
  attemptId: string;
  /** What is left of `seconds` counted from the start of the whole call. */
  waitLeft: (seconds: number | undefined) => { waitMs?: number };
  /** The turn running now, read when the handler asks. */
  runningTurn: () => Promise<number | null>;
};

export type ToolArguments<Tool extends GitHubMcpTool> = z.infer<
  (typeof GITHUB_MCP_TOOL_ARGUMENTS)[Tool]
>;

/** One tool's body: the parsed arguments in, the result envelope out. */
export type ToolHandler<Tool extends GitHubMcpTool> = (
  context: ToolContext,
  args: ToolArguments<Tool>,
) => Promise<ActionResult<unknown>>;

/** A table with one handler for every tool: a tool added to the contracts without a line here does not compile. */
export type ToolHandlers = { [Tool in GitHubMcpTool]: ToolHandler<Tool> };

export const done = (result: unknown): ActionResult<unknown> => ({
  ok: true,
  result,
});
export const refused = (refusal: ActionRefusal): ActionResult<unknown> => ({
  ok: false,
  refusal,
});
