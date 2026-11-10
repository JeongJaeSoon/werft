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

/** The line alone; the file tools' excerpt has tests of its own. */
const ko = (tool: string, input: unknown, context = {}) => {
  const { verb, target } = summarizeToolRequest(tool, input, context, "ko");
  return { verb, target };
};

describe("summarizeToolRequest", () => {
  test("a file tool's excerpt is the first lines of what it writes, with real line breaks", () => {
    // The owner's report: a Write card showed this as one JSON string.
    const content =
      "# werft-sandbox\n\nWerft의 GitHub 연동을 점검하기 위한 테스트 저장소입니다.\n\n## 구성\n\n- `notes/`: 예시 텍스트 파일\n";
    const write = summarizeToolRequest(
      "Write",
      { file_path: "README.md", content },
      {},
      "ko",
    );
    expect(write).toEqual({
      verb: "파일 쓰기",
      target: "README.md",
      excerpt:
        "# werft-sandbox\n\nWerft의 GitHub 연동을 점검하기 위한 테스트 저장소입니다.\n…",
    });
    expect(write.excerpt).not.toContain("\\n");
    expect(
      summarizeToolRequest(
        "Edit",
        { file_path: "a.ts", old_string: "x", new_string: "const a = 1;" },
        {},
        "ko",
      ).excerpt,
    ).toBe("const a = 1;");
    expect(
      summarizeToolRequest(
        "MultiEdit",
        { file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] },
        {},
        "ko",
      ).excerpt,
    ).toBe("y");
    expect(
      summarizeToolRequest("Write", { file_path: "a" }, {}, "ko").excerpt,
    ).toBeNull();
    expect(
      summarizeToolRequest("Bash", { command: "ls" }, {}, "ko").excerpt,
    ).toBeNull();
    const long = summarizeToolRequest(
      "Write",
      { file_path: "a", content: "x".repeat(1000) },
      {},
      "ko",
    ).excerpt;
    expect([...(long ?? "")].length).toBeLessThanOrEqual(300);
  });

  test("an excerpt keeps the content's own first lines, marks what it leaves out and stays within 300", () => {
    const write = (text: string) =>
      summarizeToolRequest("Write", { file_path: "a", content: text }, {}, "ko")
        .excerpt;
    // Indentation and leading blank lines are part of what gets written.
    expect(write("    first\n    second")).toBe("    first\n    second");
    expect(write("\n\n\nfourth")).toBe("\n\n\n…");
    const full = write(
      `${"a".repeat(100)}\n${"b".repeat(100)}\n${"c".repeat(98)}\nd`,
    );
    expect([...(full ?? "")].length).toBeLessThanOrEqual(300);
    expect(full).toEndWith("…");
    // A second edit is not hidden behind the first.
    expect(
      summarizeToolRequest(
        "MultiEdit",
        {
          file_path: "a.ts",
          edits: [
            { old_string: "x", new_string: "safe" },
            { old_string: "y", new_string: "dangerous second change" },
          ],
        },
        {},
        "ko",
      ).excerpt,
    ).toBe("safe\n…");
  });

  test("built-in tools", () => {
    expect(
      ko("Bash", { command: "npm test", description: "Run the tests" }),
    ).toEqual({ verb: "명령 실행", target: "Run the tests" });
    expect(ko("Bash", { command: "\n  npm test\nnpm run lint" })).toEqual({
      verb: "명령 실행",
      target: "npm test",
    });
    expect(ko("Bash", { command: "x".repeat(500) }).target).toHaveLength(120);
    expect(ko("Edit", { file_path: "/w/a.ts" })).toEqual({
      verb: "파일 수정",
      target: "/w/a.ts",
    });
    expect(ko("MultiEdit", { file_path: "/w/a.ts" }).verb).toBe("파일 수정");
    expect(ko("NotebookEdit", { notebook_path: "/w/n.ipynb" })).toEqual({
      verb: "파일 수정",
      target: "/w/n.ipynb",
    });
    expect(ko("Write", { file_path: "/w/b.ts" })).toEqual({
      verb: "파일 쓰기",
      target: "/w/b.ts",
    });
    expect(ko("Read", { file_path: "/w/c.ts" }).verb).toBe("파일 읽기");
    expect(ko("Glob", { pattern: "**/*.ts" })).toEqual({
      verb: "파일 찾기",
      target: "**/*.ts",
    });
    expect(ko("Grep", { pattern: "TODO" })).toEqual({
      verb: "내용 찾기",
      target: "TODO",
    });
    expect(
      ko("WebFetch", { url: "https://docs.slack.dev/reference/block-kit?x=1" }),
    ).toEqual({
      verb: "웹 페이지 읽기",
      target: "docs.slack.dev/reference/block-kit",
    });
    expect(ko("WebFetch", { url: "not a url" })).toEqual({
      verb: "웹 페이지 읽기",
      target: null,
    });
    expect(ko("WebSearch", { query: "slack container block" })).toEqual({
      verb: "웹 검색",
      target: "slack container block",
    });
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

  test("other tools say which tool, and which remote MCP server", () => {
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
    expect(ko("mcp__broken", {})).toEqual({
      verb: "mcp__broken 도구 사용",
      target: null,
    });
  });

  test("a missing or odd input field gives no target", () => {
    expect(ko("Bash", null)).toEqual({ verb: "명령 실행", target: null });
    expect(ko("Edit", { file_path: 3 })).toEqual({
      verb: "파일 수정",
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
