import { expect, test } from "bun:test";
import type { ReceiptRead } from "@werft-ai/contracts";
import {
  agentRefsOf,
  maskAgentRefs,
  targetsHidden,
} from "./receipt-agent-refs.ts";

const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const RELEASE = "019a0000-0000-7000-8000-00000000b0b1";
const SESSION = "019a0000-0000-7000-8000-00000000e0a1";
const hidden = {
  agentIds: new Set([AGENT]),
  releaseIds: new Set([RELEASE]),
};

const receipt = (over: Partial<ReceiptRead>): ReceiptRead => ({
  id: "4d6d1a3e-1f1c-4c3a-9f3e-2b1c1d1e1f10",
  operation: "operation_from_a_newer_replica",
  target_ref: { session_id: SESSION, turn_id: null, request_id: null },
  status: "succeeded",
  result: { agent_id: AGENT, agent_release_id: RELEASE, note: "kept" },
  error: null,
  created_at: "2026-10-28T00:00:00Z",
  updated_at: "2026-10-28T00:00:00Z",
  ...over,
});

// A newer replica's operation has no table row; it is read as one that may
// carry any id, so a private agent's ids do not leak through it.
test("an operation this build does not know masks the ids its result names", () => {
  const unknown = receipt({});
  expect(agentRefsOf(unknown)).toEqual({
    agentIds: [AGENT],
    releaseIds: [RELEASE],
  });
  expect(maskAgentRefs(unknown, hidden).result).toEqual({
    agent_id: null,
    agent_release_id: null,
    note: "kept",
  });
});

test("an unknown operation aimed at a hidden agent or release is not there", () => {
  for (const [kind, id] of [
    ["agent", AGENT],
    ["agent_release", RELEASE],
  ] as const) {
    const aimed = receipt({
      target_ref: { resource: { kind, id }, workspace_id: null },
    });
    expect(targetsHidden(aimed, hidden)).toBe(true);
  }
});

test("a known operation that carries no ids is left as it is", () => {
  const known = receipt({ operation: "pause" });
  expect(agentRefsOf(known)).toEqual({ agentIds: [], releaseIds: [] });
  expect(maskAgentRefs(known, hidden)).toEqual(known);
});
