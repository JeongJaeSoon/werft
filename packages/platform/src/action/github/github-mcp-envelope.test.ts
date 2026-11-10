import { describe, expect, test } from "bun:test";
import {
  type AgentGitHub,
  GITHUB_MCP_FIXED_TOOLS,
  GITHUB_MCP_TOOL_OUTPUTS,
  type GitHubMcpTool,
  type PullRequest,
  type PushRequest,
  type ReceiptActor,
} from "@werft-ai/contracts";
import { SessionServiceError } from "../../sessions/session-service.ts";
import {
  createGitHubMcpServer,
  type GitHubMcpServices,
} from "./github-mcp-server.ts";

// Every tool of the built-in server, over the MCP wire: `tools/list` as a
// snapshot, and one success and one refusal of `tools/call` per tool, each
// read against that tool's `outputSchema`.

const SESSION = "11111111-1111-4111-8111-111111111111";
const ID = "55555555-5555-4555-8555-555555555555";
const RECEIPT = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-11-05T00:00:00.000Z";
const grant = { sessionId: SESSION, attemptId: "att_1" };

const creator: ReceiptActor = {
  principal: { kind: "user", id: "33333333-3333-4333-8333-333333333333" },
  actor_user_id: "33333333-3333-4333-8333-333333333333",
  agent_id: "44444444-4444-4444-8444-444444444444",
};

const everything: AgentGitHub = {
  repositories: ["app"],
  push_approval: true,
  features: {
    workflows: true,
    actions: true,
    checks: true,
    issues: true,
    review: true,
  },
  actions_allow: [],
};

const pullRequest: PullRequest = {
  push_request_id: ID,
  session_id: SESSION,
  repository_id: "app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  head: "agent/x",
  base: "main",
  created_at: NOW,
  receipt_id: RECEIPT,
};

const pushRequest: PushRequest = {
  id: ID,
  session_id: SESSION,
  repository_id: "app",
  checkpoint_revision: 1,
  git_commit: "a".repeat(40),
  target_branch: "agent/x",
  state: "requested",
  requested_by: creator,
  requested_at: NOW,
  resolved_by: null,
  resolved_at: null,
  resolution_reason: null,
  request_receipt_id: RECEIPT,
  resolution_receipt_id: null,
  finished_at: null,
  push_receipt_id: null,
  origin: "direct",
  flow: "legacy",
  pr_state: null,
  pr_error: null,
  pr_number: null,
  pr_url: null,
};

const run = {
  id: 42,
  path: ".github/workflows/ci.yml",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/acme/app/actions/runs/42",
};

/** Services answering every tool with a valid result, or one failure. */
function server(failure: SessionServiceError | null) {
  const answer =
    <T>(value: T) =>
    async (): Promise<T> => {
      if (failure !== null) throw failure;
      return value;
    };
  const services = (): GitHubMcpServices => ({
    pushRequests: {
      create: answer(pushRequest),
      get: answer(pushRequest),
      snapshot: answer({
        push_intent_id: null,
        intent_status: null,
        intent_refusal: null,
        push_request_id: ID,
        push_state: "pushed" as const,
        repository_id: "app",
        target_branch: "agent/s",
        pull_request_scheduled: false,
        pull_request_stage: null,
        pull_request_error: null,
        pull_request: null,
      }),
      requestIntent: async (_actor, sessionId, input) => {
        if (failure !== null) throw failure;
        return {
          status: "deferred" as const,
          intent: {
            id: "99999999-9999-4999-8999-999999999999",
            session_id: sessionId,
            repository_id: "app",
            target_branch: `agent/${sessionId}`,
            status: "deferred" as const,
            refusal_code: null,
            push_request_id: null,
            source_ref: input.sourceRef ?? null,
            created_at: "2026-11-05T00:00:00.000Z",
          },
        };
      },
    },
    pullRequests: {
      schedule: answer({
        pull_request: pullRequest,
        created: true,
        body_source: { kind: "platform" as const },
        receipt_id: RECEIPT,
      }),
      open: answer({
        pull_request: pullRequest,
        created: true,
        body_source: { kind: "platform" as const },
        receipt_id: RECEIPT,
      }),
      update: answer({
        pull_request: pullRequest,
        body_source: null,
        receipt_id: RECEIPT,
      }),
      comment: answer({
        pull_request: pullRequest,
        comment: {
          id: 9,
          url: "https://github.com/acme/app/pull/7#issuecomment-9",
          marker: "m",
          created: true,
        },
        receipt_id: RECEIPT,
      }),
      setState: answer({
        pull_request: pullRequest,
        state: "closed" as const,
        changed: true,
        receipt_id: RECEIPT,
      }),
      merge: answer({
        pull_request: pullRequest,
        merged: true as const,
        changed: true,
        head_sha: "a".repeat(40),
        merge_commit_sha: "b".repeat(40),
        method: "squash" as const,
        receipt_id: RECEIPT,
      }),
    },
    githubWork: {
      dispatch: answer({
        receipt_id: RECEIPT,
        run: { id: 42, html_url: run.html_url },
      }),
      getRun: answer(run),
      rerun: answer({ receipt_id: RECEIPT }),
      review: answer({
        receipt_id: RECEIPT,
        review: { id: 3, html_url: "https://github.com/acme/app/pull/7#r3" },
      }),
    },
    attachments: {
      list: answer({
        repositories: [
          {
            id: "app",
            name: "acme/app",
            branch: "main",
            status: "attached" as const,
            remote: "origin",
            meaning: "attached to this session",
          },
        ],
        next_cursor: null,
      }),
      attach: answer({
        repository_id: "docs",
        status: "attached" as const,
        branch: "main",
        commit: "b".repeat(40),
        failure: null,
        already_attached: false,
        receipt_id: RECEIPT,
      }),
    },
  });
  return createGitHubMcpServer({
    store: {
      sessionState: async () => ({
        ownerId: "owner-a",
        agentId: creator.agent_id ?? "",
        releaseId: "release-1",
        source: "release",
        github: everything,
        enabled: true,
        actor: creator,
      }),
      runningTurn: async () => 7,
    },
    services,
  });
}

const ARGUMENTS: Record<GitHubMcpTool, unknown> = {
  request_push: {},
  open_pull_request: { push_request_id: ID, title: "Fix" },
  get_push_request: { push_request_id: ID },
  update_pull_request: { push_request_id: ID, title: "Fix" },
  comment_pull_request: { push_request_id: ID, body: "Note" },
  close_pull_request: { push_request_id: ID },
  merge_pull_request: { push_request_id: ID },
  reopen_pull_request: { push_request_id: ID },
  dispatch_workflow: { workflow: "ci.yml", ref: "main" },
  get_workflow_run: { run_id: 42 },
  rerun_workflow: { run_id: 42 },
  submit_review: {
    number: 7,
    commit_id: "a".repeat(40),
    event: "APPROVE",
  },
  list_repositories: {},
  attach_repository: { repository_id: "docs" },
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent: unknown;
};

async function callTool(
  handle: ReturnType<typeof server>,
  tool: GitHubMcpTool,
): Promise<ToolResult> {
  const answer = await handle(
    grant,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: ARGUMENTS[tool] },
    },
    "req-1",
  );
  return (answer as unknown as { result: ToolResult }).result;
}

describe("tools/list", () => {
  test("every tool has a description of its fields and an outputSchema", async () => {
    const answer = await server(null)(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "req-1",
    );
    const { tools } = (
      answer as unknown as {
        result: {
          tools: Array<{
            name: string;
            description: string;
            outputSchema: { type: string };
          }>;
        };
      }
    ).result;
    expect(tools.map((tool) => tool.name)).toEqual([...GITHUB_MCP_FIXED_TOOLS]);
    for (const tool of tools) expect(tool.outputSchema.type).toBe("object");
    // What the wire carries, not what bun prints of non-enumerable keys.
    expect(JSON.parse(JSON.stringify(tools))).toMatchSnapshot();
  });
});

describe("tools/call", () => {
  test("every tool answers ok with its own result schema, as structuredContent and as text", async () => {
    const handle = server(null);
    for (const tool of GITHUB_MCP_FIXED_TOOLS) {
      const result = await callTool(handle, tool);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual(
        result.structuredContent as never,
      );
      const parsed = GITHUB_MCP_TOOL_OUTPUTS[tool].safeParse(
        result.structuredContent,
      );
      expect({ tool, ok: parsed.success }).toEqual({ tool, ok: true });
      expect(result.structuredContent).toMatchObject({ ok: true });
    }
  });

  test("every tool refuses with code, by and retryable, and no message anywhere", async () => {
    const handle = server(
      new SessionServiceError(
        "BACKEND_UNAVAILABLE",
        "A sentence a model could read as an instruction",
      ),
    );
    for (const tool of GITHUB_MCP_FIXED_TOOLS) {
      const result = await callTool(handle, tool);
      expect(result.isError).toBeUndefined();
      expect(
        GITHUB_MCP_TOOL_OUTPUTS[tool].safeParse(result.structuredContent)
          .success,
      ).toBe(true);
      expect(result.structuredContent).toEqual({
        ok: false,
        refusal: {
          code: "backend_unavailable",
          by: "github",
          retryable: true,
        },
      });
      expect(result.content[0]?.text).not.toContain("instruction");
    }
  });
});
