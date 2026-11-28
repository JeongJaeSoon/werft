import { describe, expect, test } from "bun:test";
import type { AuthorizationRequest } from "@werft-ai/contracts";
import { createAuthorizationPolicy } from "./policy.ts";
import type { DecisionEntry } from "./ports/decision-log.ts";

// 94S-2538: a refusal decided before the policy is kept as its own deny.

const request: AuthorizationRequest = {
  subject: {
    principal: {
      kind: "installation",
      id: "019a0000-0000-7000-8000-0000000000a3",
      owner_id: "019a0000-0000-7000-8000-0000000000a1",
      workspace_id: "019a0000-0000-7000-8000-0000000000a1",
      scopes: ["sessions:read", "sessions:write"],
    },
    surface: {
      kind: "slack",
      slack_user_kind: "member",
      ceiling: { actions: ["session.submit"], disclosure: "full" },
      agent_id: "019a0000-0000-7000-8000-0000000000a2",
      channel_id: "C0OPS",
    },
  },
  action: "session.submit",
  resource: {
    kind: "session",
    id: "019a0000-0000-7000-8000-0000000000a5",
    owner_scope: "019a0000-0000-7000-8000-0000000000a1",
  },
  request_id: "req-1",
};

describe("a refusal the caller decided", () => {
  test("is a deny for its reason, kept in the decision log", async () => {
    const kept: DecisionEntry[] = [];
    const policy = createAuthorizationPolicy({
      newDecisionId: () => "decision-1",
      decisions: {
        record: async (entry) => {
          kept.push(entry);
        },
      },
    });
    const decision = await policy.refuse(request, "surface_mismatch");
    expect(decision).toMatchObject({
      outcome: "deny",
      reason_code: "surface_mismatch",
      effective_scopes: [],
      decision_id: "decision-1",
    });
    expect(kept).toEqual([{ request, decision }]);
  });

  test("stands a deny when it cannot be kept", async () => {
    const warned: string[] = [];
    const policy = createAuthorizationPolicy({
      decisions: {
        record: () => Promise.reject(new Error("down")),
      },
      logger: { warn: (message) => warned.push(message) },
    });
    expect((await policy.refuse(request, "surface_mismatch")).outcome).toBe(
      "deny",
    );
    expect(warned).toEqual(["Authorization decision could not be recorded"]);
  });
});
