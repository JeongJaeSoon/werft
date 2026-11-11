import { describe, expect, test } from "bun:test";
import { listPendingRequestsResponseSchema } from "../api/pending.ts";
import { pushRequestPresentationSchema } from "../api/push-request.ts";
import {
  presentPendingRequest,
  presentPushRequest,
  TOOL_VERB_VALUES,
} from "./present-action.ts";

describe("presentPendingRequest", () => {
  test("names what a command does and to what", () => {
    expect(presentPendingRequest("Bash", { command: "ls -la\nrm x" })).toEqual({
      verb: { key: "action.tool.runCommand" },
      target: "ls -la",
      excerpt: null,
    });
  });

  test("prefers a command's description and clips a long target", () => {
    const presented = presentPendingRequest("Bash", {
      description: "x".repeat(500),
      command: "ls",
    });
    expect(presented.target?.length).toBeLessThanOrEqual(120);
  });

  test("shows the first lines of what a file tool writes", () => {
    const presented = presentPendingRequest("Write", {
      file_path: "a.ts",
      content: "1\n2\n3\n4\n5",
    });
    expect(presented.verb.key).toBe("action.tool.writeFile");
    expect(presented.target).toBe("a.ts");
    expect(presented.excerpt).toBe("1\n2\n3\n…");
  });

  test("an excerpt keeps real line breaks, whatever the file tool", () => {
    // The owner's report: a Write card showed this as one JSON string.
    const content =
      "# werft-sandbox\n\nWerft의 GitHub 연동을 점검하기 위한 테스트 저장소입니다.\n\n## 구성\n\n- `notes/`: 예시 텍스트 파일\n";
    const write = presentPendingRequest("Write", {
      file_path: "README.md",
      content,
    });
    expect(write).toEqual({
      verb: { key: "action.tool.writeFile" },
      target: "README.md",
      excerpt:
        "# werft-sandbox\n\nWerft의 GitHub 연동을 점검하기 위한 테스트 저장소입니다.\n…",
    });
    expect(write.excerpt).not.toContain("\\n");
    expect(
      presentPendingRequest("Edit", {
        file_path: "a.ts",
        old_string: "x",
        new_string: "const a = 1;",
      }).excerpt,
    ).toBe("const a = 1;");
    expect(
      presentPendingRequest("MultiEdit", {
        file_path: "a.ts",
        edits: [{ old_string: "x", new_string: "y" }],
      }).excerpt,
    ).toBe("y");
    expect(
      presentPendingRequest("Write", { file_path: "a" }).excerpt,
    ).toBeNull();
    expect(presentPendingRequest("Bash", { command: "ls" }).excerpt).toBeNull();
  });

  test("an excerpt keeps the content's own first lines, marks what it leaves out and stays within 300", () => {
    const write = (text: string) =>
      presentPendingRequest("Write", { file_path: "a", content: text }).excerpt;
    // Indentation and leading blank lines are part of what gets written.
    expect(write("    first\n    second")).toBe("    first\n    second");
    expect(write("\n\n\nfourth")).toBe("\n\n\n…");
    const full = write(
      `${"a".repeat(100)}\n${"b".repeat(100)}\n${"c".repeat(98)}\nd`,
    );
    expect([...(full ?? "")].length).toBeLessThanOrEqual(300);
    expect(full).toEndWith("…");
    expect([...(write("x".repeat(1000)) ?? "")].length).toBeLessThanOrEqual(
      300,
    );
    // A second edit is not hidden behind the first.
    expect(
      presentPendingRequest("MultiEdit", {
        file_path: "a.ts",
        edits: [
          { old_string: "x", new_string: "safe" },
          { old_string: "y", new_string: "dangerous second change" },
        ],
      }).excerpt,
    ).toBe("safe\n…");
  });

  test("built-in tools say what they do and to what", () => {
    const line = (tool: string, input: unknown) => {
      const { verb, target } = presentPendingRequest(tool, input);
      return { verb: verb.key, target };
    };
    expect(line("Bash", { command: "\n  npm test\nnpm run lint" })).toEqual({
      verb: "action.tool.runCommand",
      target: "npm test",
    });
    expect(
      line("Bash", { command: "npm test", description: "Run the tests" }),
    ).toEqual({ verb: "action.tool.runCommand", target: "Run the tests" });
    expect(line("Edit", { file_path: "/w/a.ts" })).toEqual({
      verb: "action.tool.editFile",
      target: "/w/a.ts",
    });
    expect(line("MultiEdit", { file_path: "/w/a.ts" }).verb).toBe(
      "action.tool.editFile",
    );
    expect(line("NotebookEdit", { notebook_path: "/w/n.ipynb" })).toEqual({
      verb: "action.tool.editFile",
      target: "/w/n.ipynb",
    });
    expect(line("Write", { file_path: "/w/b.ts" })).toEqual({
      verb: "action.tool.writeFile",
      target: "/w/b.ts",
    });
    expect(line("Read", { file_path: "/w/c.ts" }).verb).toBe(
      "action.tool.readFile",
    );
    expect(line("Glob", { pattern: "**/*.ts" })).toEqual({
      verb: "action.tool.findFiles",
      target: "**/*.ts",
    });
    expect(line("Grep", { pattern: "TODO" })).toEqual({
      verb: "action.tool.searchContents",
      target: "TODO",
    });
    expect(
      line("WebFetch", {
        url: "https://docs.slack.dev/reference/block-kit?x=1",
      }),
    ).toEqual({
      verb: "action.tool.readWebPage",
      target: "docs.slack.dev/reference/block-kit",
    });
    expect(line("WebFetch", { url: "not a url" })).toEqual({
      verb: "action.tool.readWebPage",
      target: null,
    });
    expect(line("WebSearch", { query: "slack container block" })).toEqual({
      verb: "action.tool.searchWeb",
      target: "slack container block",
    });
  });

  test("a missing or odd input field gives no target", () => {
    expect(presentPendingRequest("Bash", null)).toEqual({
      verb: { key: "action.tool.runCommand" },
      target: null,
      excerpt: null,
    });
    expect(presentPendingRequest("Edit", { file_path: 3 }).target).toBeNull();
  });

  test("reads a GitHub tool's repository and branch from the context", () => {
    expect(
      presentPendingRequest(
        "mcp__github__request_push",
        {},
        { repository: "acme/app", branch: "agent/s1" },
      ),
    ).toEqual({
      verb: { key: "action.tool.requestPush" },
      target: "acme/app ← agent/s1",
      excerpt: null,
    });
  });

  test("falls back to the tool's name, and a remote server's", () => {
    expect(presentPendingRequest("Custom", {}).verb).toEqual({
      key: "action.tool.useTool",
      params: { tool: "Custom" },
    });
    expect(presentPendingRequest("mcp__linear__save_issue", {}).verb).toEqual({
      key: "action.tool.useMcpTool",
      params: { server: "linear", tool: "save_issue" },
    });
    expect(presentPendingRequest("Task", { prompt: "x" })).toEqual({
      verb: { key: "action.tool.useTool", params: { tool: "Task" } },
      target: null,
      excerpt: null,
    });
    expect(presentPendingRequest("mcp__broken", {}).verb).toEqual({
      key: "action.tool.useTool",
      params: { tool: "mcp__broken" },
    });
  });

  test("takes any input without throwing", () => {
    for (const input of [null, undefined, 3, "x", [], { edits: "no" }]) {
      expect(() => presentPendingRequest("Edit", input)).not.toThrow();
    }
  });

  test("every result passes the schema the API carries it in", () => {
    const parsed = listPendingRequestsResponseSchema.safeParse({
      items: TOOL_VERB_VALUES.map((verb, index) => ({
        request_id: `r${index}`,
        turn_id: "1",
        attempt_id: "a",
        created_at: "2026-11-10T00:00:00.000Z",
        expires_at: "2026-11-10T01:00:00.000Z",
        kind: "permission",
        tool: "Bash",
        input: {},
        summary: {
          verb: { key: `action.tool.${verb}` },
          target: null,
          excerpt: null,
        },
      })),
      answerable: true,
    });
    expect(parsed.error).toBeUndefined();
  });
});

describe("presentPushRequest", () => {
  test("an approvable push has no reason", () => {
    expect(presentPushRequest({ approvable: true })).toEqual({
      approvable: true,
      reason: null,
    });
  });

  test("a push that cannot be approved carries the reason's message key", () => {
    for (const reason of [
      "not_requested",
      "checkpoint_moved",
      "pinned_source_invalid",
    ] as const) {
      const presented = presentPushRequest({ approvable: false, reason });
      expect(presented).toEqual({
        approvable: false,
        reason: { key: `action.push.unapprovable.${reason}` },
      });
      expect(pushRequestPresentationSchema.safeParse(presented).success).toBe(
        true,
      );
    }
  });
});
