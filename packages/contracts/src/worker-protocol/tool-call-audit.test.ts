import { describe, expect, test } from "bun:test";
import { appendEventsRequestSchema } from "./index.ts";
import {
  INVALID_TOOL_NAME,
  mcpServerOf,
  sanitizeToolDecision,
  TOOL_AUDIT_BASIS_VALUES,
  TOOL_AUDIT_BASIS_VERDICT,
  toolDecisionReportSchema,
} from "./tool-call-audit.ts";

const SHA = "a".repeat(64);
const scope = {
  session_id: "00000000-0000-4000-8000-000000000001",
  turn_id: "1",
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 1,
};
const event = {
  event: "status",
  data: { phase: "running" },
  occurred_at: "2026-01-01T00:00:00.000Z",
  source_sequence: 1,
};
const report = {
  call_key: "t:toolu_1",
  tool_name: "Bash",
  tool_use_id: "toolu_1",
  input_sha256: SHA,
  input_bytes: 12,
  decision: "allow",
  basis: "trusted_tool",
};

describe("tool call audit contract", () => {
  test("every basis stands under exactly one decision", () => {
    expect(TOOL_AUDIT_BASIS_VALUES).toHaveLength(13);
    expect(TOOL_AUDIT_BASIS_VERDICT.approval_asked).toBe("require_approval");
    expect(TOOL_AUDIT_BASIS_VERDICT.approval_expired).toBe("deny");
  });

  test("a report whose basis contradicts its decision is refused", () => {
    expect(
      toolDecisionReportSchema.safeParse({ ...report, decision: "deny" })
        .success,
    ).toBe(false);
  });

  test("a worker cannot report the platform's own bases", () => {
    for (const basis of ["approval_asked", "approval_unverified"]) {
      const decision = TOOL_AUDIT_BASIS_VERDICT[basis as "approval_asked"];
      expect(
        toolDecisionReportSchema.safeParse({ ...report, basis, decision })
          .success,
      ).toBe(false);
    }
  });

  test("a hash and a byte count come together", () => {
    const { input_bytes: _bytes, ...hashOnly } = report;
    expect(toolDecisionReportSchema.safeParse(hashOnly).success).toBe(false);
  });

  test("a report has no field for input text", () => {
    expect(
      toolDecisionReportSchema.safeParse({ ...report, input: { cmd: "ls" } })
        .success,
    ).toBe(false);
  });

  test("a request without tool_decisions still parses (older worker)", () => {
    const parsed = appendEventsRequestSchema.safeParse({
      ...scope,
      batch_key: "b1",
      events: [event],
    });
    expect(parsed.success).toBe(true);
  });

  test("a malformed item becomes null and does not fail the request", () => {
    const parsed = appendEventsRequestSchema.parse({
      ...scope,
      batch_key: "b1",
      events: [event],
      tool_decisions: [report, { ...report, decision: "maybe" }, "junk", null],
    });
    expect(parsed.tool_decisions?.map((item) => item !== null)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  test("a request still refuses fields it does not know", () => {
    expect(
      appendEventsRequestSchema.safeParse({
        ...scope,
        batch_key: "b1",
        events: [event],
        surprise: true,
      }).success,
    ).toBe(false);
  });

  test("an external tool name outside the id alphabet is not stored", () => {
    const sanitized = sanitizeToolDecision({
      ...toolDecisionReportSchema.parse(report),
      tool_name: "mcp__evil server__rm -rf /",
      tool_use_id: "has space",
      parent_tool_use_id: "x".repeat(129),
      pending_request_id: "req;drop",
    });
    expect(sanitized.toolName).toBe(INVALID_TOOL_NAME);
    expect(sanitized.mcpServer).toBeNull();
    expect(sanitized.toolUseId).toBeNull();
    expect(sanitized.parentToolUseId).toBeNull();
    expect(sanitized.pendingRequestId).toBeNull();
  });

  test("a valid id passes through and a 128-character id is the longest", () => {
    const sanitized = sanitizeToolDecision({
      ...toolDecisionReportSchema.parse(report),
      tool_use_id: "a".repeat(128),
    });
    expect(sanitized.toolUseId).toBe("a".repeat(128));
    expect(sanitized.toolName).toBe("Bash");
  });

  test("a call key must carry its prefix and stay within 130 characters", () => {
    const parse = (call_key: string) =>
      toolDecisionReportSchema.safeParse({ ...report, call_key }).success;
    expect(parse(`t:${"a".repeat(128)}`)).toBe(true);
    expect(parse(`t:${"a".repeat(129)}`)).toBe(false);
    expect(parse("n:3")).toBe(true);
    expect(parse("toolu_1")).toBe(false);
    expect(parse("t:bad key")).toBe(false);
  });

  test("the mcp server is read from the tool name", () => {
    expect(mcpServerOf("mcp__github__create_issue")).toBe("github");
    expect(mcpServerOf("mcp__my_server__do_thing")).toBe("my_server");
    expect(mcpServerOf("Bash")).toBeNull();
  });
});
