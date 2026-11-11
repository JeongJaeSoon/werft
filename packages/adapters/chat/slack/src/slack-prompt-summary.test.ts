import { describe, expect, test } from "bun:test";
import {
  GITHUB_MCP_TOOL_ARGUMENTS,
  type GitHubMcpTool,
  USER_LOCALE_VALUES,
} from "@werft-ai/contracts";
import {
  SLACK_SUMMARY_MESSAGES,
  summarizeToolRequest,
} from "./slack-prompt-summary.ts";

const PUSH_ID = "019a0000-0000-7000-8000-0000000000b1";
const REPO = "JeongJaeSoon/werft-sandbox";
const BRANCH = "agent/8daa1a1e-0000-7000-8000-000000000000";

/** A GitHub tool's input as the engine would send it: parsed, not guessed. */
function githubInput(tool: GitHubMcpTool, raw: unknown): unknown {
  return GITHUB_MCP_TOOL_ARGUMENTS[tool].parse(raw);
}

/** The line alone; which verb and target a tool gets is contracts' to test. */
const ko = (tool: string, input: unknown, context = {}) => {
  const { verb, target } = summarizeToolRequest(tool, input, context, "ko");
  return { verb, target };
};

describe("summarizeToolRequest", () => {
  test("a tool's verb, target and excerpt arrive in the reader's language", () => {
    expect(
      summarizeToolRequest(
        "Bash",
        { command: "npm test", description: "Run the tests" },
        {},
        "ko",
      ),
    ).toEqual({ verb: "명령 실행", target: "Run the tests", excerpt: null });
    expect(
      summarizeToolRequest(
        "Write",
        { file_path: "a.ts", content: "1\n2\n3\n4" },
        {},
        "en",
      ),
    ).toEqual({ verb: "Write a file", target: "a.ts", excerpt: "1\n2\n3\n…" });
  });

  test("GitHub tools read the push row and the catalog through their context", () => {
    expect(
      ko(
        "mcp__github__request_push",
        githubInput("request_push", { branch: "docs" }),
        { repository: REPO, branch: `${BRANCH}-docs` },
      ),
    ).toEqual({ verb: "push 요청", target: `${REPO} ← ${BRANCH}-docs` });
    expect(
      ko(
        "mcp__github__open_pull_request",
        githubInput("open_pull_request", {
          title: "feat: e2e 추가",
          push_request_id: PUSH_ID,
        }),
        { repository: REPO, branch: BRANCH },
      ),
    ).toEqual({
      verb: "PR 열기",
      target: `feat: e2e 추가 (${REPO} ← ${BRANCH})`,
    });
    expect(
      ko(
        "mcp__github__update_pull_request",
        githubInput("update_pull_request", {
          body: "more",
          push_request_id: PUSH_ID,
        }),
        { repository: REPO, branch: BRANCH },
      ),
    ).toEqual({ verb: "PR 고치기", target: `${REPO} ← ${BRANCH}` });
    expect(
      ko(
        "mcp__github__comment_pull_request",
        githubInput("comment_pull_request", {
          body: "hi",
          push_request_id: PUSH_ID,
        }),
        { repository: REPO, branch: BRANCH },
      ),
    ).toEqual({ verb: "PR에 댓글", target: `${REPO} ← ${BRANCH}` });
    expect(
      ko(
        "mcp__github__close_pull_request",
        githubInput("close_pull_request", { push_request_id: PUSH_ID }),
        { repository: REPO, branch: BRANCH },
      ),
    ).toEqual({ verb: "PR 닫기", target: `${REPO} ← ${BRANCH}` });
    expect(
      ko(
        "mcp__github__reopen_pull_request",
        githubInput("reopen_pull_request", { push_request_id: PUSH_ID }),
        { repository: REPO, branch: BRANCH },
      ),
    ).toEqual({ verb: "PR 다시 열기", target: `${REPO} ← ${BRANCH}` });
    expect(
      ko(
        "mcp__github__attach_repository",
        githubInput("attach_repository", { repository_id: "repo-2" }),
        { repository: "JeongJaeSoon/other" },
      ),
    ).toEqual({ verb: "저장소 붙이기", target: "JeongJaeSoon/other" });
  });

  test("opening a PR with no title is still summarized, not a generic line", () => {
    const input = githubInput("open_pull_request", {
      push_request_id: PUSH_ID,
    });
    expect(
      ko("mcp__github__open_pull_request", input, {
        repository: REPO,
        branch: BRANCH,
      }),
    ).toEqual({ verb: "PR 열기", target: `${REPO} ← ${BRANCH}` });
  });

  test("an unreadable push row leaves out what it would have given", () => {
    const input = githubInput("open_pull_request", {
      title: "feat: x",
      push_request_id: PUSH_ID,
    });
    expect(ko("mcp__github__open_pull_request", input)).toEqual({
      verb: "PR 열기",
      target: "feat: x",
    });
    // Nothing left to say: the generic remote MCP line.
    expect(
      ko(
        "mcp__github__open_pull_request",
        githubInput("open_pull_request", { push_request_id: PUSH_ID }),
      ),
    ).toEqual({ verb: "github의 open_pull_request 도구 사용", target: null });
    expect(
      ko(
        "mcp__github__update_pull_request",
        githubInput("update_pull_request", {
          title: "t",
          push_request_id: PUSH_ID,
        }),
        { branch: BRANCH },
      ),
    ).toEqual({ verb: "PR 고치기", target: BRANCH });
  });

  test("the tool and server names are filled into each language's wording", () => {
    expect(ko("mcp__linear__save_issue", { title: "x" })).toEqual({
      verb: "linear의 save_issue 도구 사용",
      target: null,
    });
    expect(
      summarizeToolRequest("mcp__linear__save_issue", {}, {}, "en"),
    ).toEqual({
      verb: "Use the save_issue tool of linear",
      target: null,
      excerpt: null,
    });
    expect(ko("Task", { prompt: "x" })).toEqual({
      verb: "Task 도구 사용",
      target: null,
    });
  });

  test("every language has every summary", () => {
    for (const locale of USER_LOCALE_VALUES) {
      for (const word of Object.values(SLACK_SUMMARY_MESSAGES[locale])) {
        expect(word).not.toBe("");
      }
      expect(SLACK_SUMMARY_MESSAGES[locale].useTool).toContain("{tool}");
      expect(SLACK_SUMMARY_MESSAGES[locale].useMcpTool).toContain("{server}");
    }
  });
});
