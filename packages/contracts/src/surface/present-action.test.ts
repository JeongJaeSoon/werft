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
