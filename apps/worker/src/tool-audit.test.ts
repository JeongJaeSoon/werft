import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  INVALID_TOOL_NAME,
  type ToolDecisionReport,
  toolDecisionReportSchema,
} from "@werft-ai/contracts";
import type { ObservedToolDecision } from "@werft-ai/runtime-core";

import { SecretScrubber } from "./secret-scrubber.ts";
import { ToolAuditCollector } from "./tool-audit.ts";

// Built at run time so no secret-shaped literal sits in the source.
const SECRET = ["synthetic", "worker", "token", "0123456789"].join("-");

function rig(
  options: { turnId?: string | null; requests?: Record<string, string> } = {},
) {
  const sent: Array<{ report: ToolDecisionReport; turnId: string }> = [];
  const state = { turnId: options.turnId === undefined ? "7" : options.turnId };
  const collector = new ToolAuditCollector({
    scrubber: () => new SecretScrubber([SECRET]),
    turnId: () => state.turnId,
    requestIdOf: (localId) => options.requests?.[localId],
    enqueue: (report, turnId) => sent.push({ report, turnId }),
  });
  return { collector, sent, state };
}

const decision = (
  extra: Partial<ObservedToolDecision> = {},
): ObservedToolDecision => ({
  toolUseId: "toolu_1",
  parentToolUseId: undefined,
  tool: "Bash",
  input: { command: "ls", cwd: "/work" },
  decision: "allow",
  basis: "permission_mode",
  ...extra,
});

describe("ToolAuditCollector", () => {
  test("reports the digest and size of the key-sorted input, and nothing of its text", () => {
    const { collector, sent } = rig();
    collector.observe(decision());
    const canonical = canonicalJson({ command: "ls", cwd: "/work" });
    expect(sent).toEqual([
      {
        turnId: "7",
        report: {
          call_key: "t:toolu_1",
          tool_name: "Bash",
          tool_use_id: "toolu_1",
          input_sha256: createHash("sha256").update(canonical).digest("hex"),
          input_bytes: Buffer.byteLength(canonical),
          decision: "allow",
          basis: "permission_mode",
        },
      },
    ]);
    expect(toolDecisionReportSchema.safeParse(sent[0]?.report).success).toBe(
      true,
    );
    expect(JSON.stringify(sent)).not.toContain("/work");
  });

  test("hashes the input after this worker's secrets are removed from it", () => {
    const { collector, sent } = rig();
    collector.observe(decision({ input: { command: `echo ${SECRET}` } }));
    const scrubbed = canonicalJson({ command: "echo <redacted>" });
    expect(sent[0]?.report.input_sha256).toBe(
      createHash("sha256").update(scrubbed).digest("hex"),
    );
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  test("a secret in a name or an id is never stored: the tool is invalid and the call is numbered", () => {
    const { collector, sent } = rig();
    collector.observe(
      decision({ toolUseId: `toolu_${SECRET}`, tool: `mcp__${SECRET}__run` }),
    );
    collector.observe(decision({ toolUseId: undefined }));
    collector.observe(decision({ toolUseId: "has space" }));
    const reports = sent.map((entry) => entry.report);
    expect(reports.map((r) => r.call_key)).toEqual(["n:1", "n:2", "n:3"]);
    expect(reports[0]?.tool_name).toBe(INVALID_TOOL_NAME);
    expect(reports.every((r) => r.tool_use_id === undefined)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  test("an id or a name shaped like a credential is not kept even when the claim never named it", () => {
    // Fits the id alphabet and is in no claim; only the text masking sees it.
    const token = ["ghp", "A".repeat(36)].join("_");
    const { collector, sent } = rig();
    collector.observe(decision({ toolUseId: token, tool: token }));
    const [entry] = sent;
    expect(entry?.report.call_key).toBe("n:1");
    expect(entry?.report.tool_use_id).toBeUndefined();
    expect(entry?.report.tool_name).toBe(INVALID_TOOL_NAME);
    expect(JSON.stringify(sent)).not.toContain(token);
  });

  test("the ordinal restarts with the turn", () => {
    const { collector, sent, state } = rig();
    collector.observe(decision({ toolUseId: undefined }));
    collector.observe(decision({ toolUseId: undefined }));
    state.turnId = "8";
    collector.observe(decision({ toolUseId: undefined }));
    expect(sent.map((entry) => [entry.turnId, entry.report.call_key])).toEqual([
      ["7", "n:1"],
      ["7", "n:2"],
      ["8", "n:1"],
    ]);
  });

  test("an approval names the request this worker registered and carries the hash to compare", () => {
    const { collector, sent } = rig({ requests: { local_1: "req_abc" } });
    collector.observe(
      decision({
        decision: "allow",
        basis: "approval",
        approval: { localId: "local_1", inputHash: "a".repeat(64) },
      }),
    );
    collector.observe(
      decision({
        toolUseId: "toolu_2",
        decision: "deny",
        basis: "approval_denied",
        approval: { localId: "unregistered", inputHash: "b".repeat(64) },
      }),
    );
    expect(sent[0]?.report).toMatchObject({
      pending_request_id: "req_abc",
      approval_input_hash: "a".repeat(64),
    });
    expect(sent[1]?.report).not.toHaveProperty("pending_request_id");
    expect(sent[1]?.report.approval_input_hash).toBe("b".repeat(64));
  });

  test("a call that cannot be hashed is still recorded, without one", () => {
    const { collector, sent } = rig();
    collector.observe(decision({ input: { n: Number.NaN, big: 1n } as never }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.report.input_sha256).toBeUndefined();
    expect(sent[0]?.report.input_bytes).toBeUndefined();
  });

  test("nothing is recorded outside a turn, and a failing queue changes nothing", () => {
    const outside = rig({ turnId: null });
    outside.collector.observe(decision());
    expect(outside.sent).toEqual([]);

    const failing = new ToolAuditCollector({
      scrubber: () => new SecretScrubber([]),
      turnId: () => "7",
      requestIdOf: () => undefined,
      enqueue: () => {
        throw new Error("queue full");
      },
    });
    expect(() => failing.observe(decision())).not.toThrow();
  });
});
