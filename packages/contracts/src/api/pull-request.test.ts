import { describe, expect, test } from "bun:test";

import { GITHUB_MCP_TOOL_ARGUMENTS } from "../action/github-mcp.ts";
import {
  openPullRequestRequestSchema,
  PULL_REQUEST_FIELD_TEXT_MAX,
  updatePullRequestRequestSchema,
} from "./pull-request.ts";

const PUSH = "22222222-2222-4222-8222-222222222222";

describe("open_pull_request input", () => {
  test("what a session sent before the structured fields still parses", () => {
    expect(openPullRequestRequestSchema.safeParse({}).success).toBe(true);
    expect(
      openPullRequestRequestSchema.safeParse({ title: "T", body: "B" }).success,
    ).toBe(true);
    expect(
      GITHUB_MCP_TOOL_ARGUMENTS.open_pull_request.safeParse({
        push_request_id: PUSH,
        title: "T",
        body: "B",
      }).success,
    ).toBe(true);
  });

  test("structured fields parse, and `related.closes` may be left out", () => {
    const parsed = openPullRequestRequestSchema.parse({
      summary: "s",
      changes: ["a"],
      related: [{ number: 3 }],
    });
    expect(parsed.related).toEqual([{ number: 3 }]);
  });

  test("the schema stays strict: unknown fields, in the request and in `related`", () => {
    expect(openPullRequestRequestSchema.safeParse({ labels: [] }).success).toBe(
      false,
    );
    expect(
      openPullRequestRequestSchema.safeParse({
        related: [{ number: 1, url: "x" }],
      }).success,
    ).toBe(false);
    expect(
      GITHUB_MCP_TOOL_ARGUMENTS.open_pull_request.safeParse({
        push_request_id: PUSH,
        session_id: "x",
      }).success,
    ).toBe(false);
  });

  test("`body` and a structured field together are refused", () => {
    for (const field of [
      { summary: "s" },
      { changes: [] },
      { related: [{ number: 1 }] },
    ]) {
      const result = openPullRequestRequestSchema.safeParse({
        body: "b",
        ...field,
      });
      expect(result.success).toBe(false);
    }
  });

  test("field limits: item count, item length, text length", () => {
    const text = "x".repeat(PULL_REQUEST_FIELD_TEXT_MAX);
    expect(
      openPullRequestRequestSchema.safeParse({ summary: text }).success,
    ).toBe(true);
    expect(
      openPullRequestRequestSchema.safeParse({ summary: `${text}x` }).success,
    ).toBe(false);
    expect(
      openPullRequestRequestSchema.safeParse({
        changes: Array.from({ length: 51 }, () => "c"),
      }).success,
    ).toBe(false);
    expect(
      openPullRequestRequestSchema.safeParse({ changes: ["x".repeat(1001)] })
        .success,
    ).toBe(false);
    expect(
      openPullRequestRequestSchema.safeParse({
        related: Array.from({ length: 21 }, () => ({ number: 1 })),
      }).success,
    ).toBe(false);
  });

  test("the fields' text adds up to at most 60,000", () => {
    const eight = "x".repeat(PULL_REQUEST_FIELD_TEXT_MAX);
    const within = {
      summary: eight,
      rationale: eight,
      testing: eight,
      notes: eight,
      changes: Array.from({ length: 20 }, () => "c".repeat(1000)),
    };
    // 32,000 + 20,000
    expect(openPullRequestRequestSchema.safeParse(within).success).toBe(true);
    const over = {
      ...within,
      changes: Array.from({ length: 29 }, () => "c".repeat(1000)),
    };
    // 32,000 + 29,000 = 61,000
    expect(openPullRequestRequestSchema.safeParse(over).success).toBe(false);
  });
});

describe("update_pull_request input", () => {
  test("needs a title, a body or a structured field", () => {
    expect(updatePullRequestRequestSchema.safeParse({}).success).toBe(false);
    expect(
      updatePullRequestRequestSchema.safeParse({ title: "T" }).success,
    ).toBe(true);
    expect(
      updatePullRequestRequestSchema.safeParse({ body: "B" }).success,
    ).toBe(true);
    expect(
      updatePullRequestRequestSchema.safeParse({ notes: "n" }).success,
    ).toBe(true);
    expect(
      updatePullRequestRequestSchema.safeParse({ changes: [] }).success,
    ).toBe(true);
  });

  test("`body` and a structured field together are refused", () => {
    expect(
      updatePullRequestRequestSchema.safeParse({ body: "b", testing: "t" })
        .success,
    ).toBe(false);
    expect(
      GITHUB_MCP_TOOL_ARGUMENTS.update_pull_request.safeParse({
        push_request_id: PUSH,
        title: "T",
        summary: "s",
      }).success,
    ).toBe(true);
  });
});
