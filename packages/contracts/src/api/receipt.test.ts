import { describe, expect, test } from "bun:test";

import { receiptSchema } from "./receipt.ts";

const RECEIPT_ID = "019a0000-0000-7000-8000-000000000101";
const SESSION_ID = "019a0000-0000-7000-8000-000000000102";
const WORKSPACE_ID = "019a0000-0000-7000-8000-000000000103";
const USER_ID = "019a0000-0000-7000-8000-000000000104";
const AT = "2026-09-22T01:00:00Z";

const base = {
  id: RECEIPT_ID,
  operation: "create_session",
  status: "accepted",
  result: null,
  error: null,
  created_at: AT,
  updated_at: AT,
};

describe("receipt target union", () => {
  test("the alpha session target is unchanged and still required in full", () => {
    expect(
      receiptSchema.safeParse({
        ...base,
        target_ref: { session_id: SESSION_ID, turn_id: "1", request_id: null },
      }).success,
    ).toBe(true);
    // Dropping a field does not silently fall through to the resource variant.
    expect(
      receiptSchema.safeParse({
        ...base,
        target_ref: { session_id: SESSION_ID },
      }).success,
    ).toBe(false);
    expect(receiptSchema.safeParse({ ...base, target_ref: {} }).success).toBe(
      false,
    );
  });

  test("a mutation outside a session names its resource instead", () => {
    const parsed = receiptSchema.parse({
      ...base,
      target_ref: {
        resource: {
          kind: "invite",
          id: "019a0000-0000-7000-8000-000000000105",
        },
        workspace_id: WORKSPACE_ID,
      },
    });
    expect(parsed.target_ref).toEqual({
      resource: { kind: "invite", id: "019a0000-0000-7000-8000-000000000105" },
      workspace_id: WORKSPACE_ID,
    });
    expect(
      receiptSchema.safeParse({
        ...base,
        target_ref: {
          resource: { kind: "kollege", id: "x" },
          workspace_id: null,
        },
      }).success,
    ).toBe(false);
  });

  test("a target is one variant or the other, never a blend of both", () => {
    // Non-strict variants would match the session branch here and drop the
    // resource fields on the floor, which is a target nobody wrote.
    expect(
      receiptSchema.safeParse({
        ...base,
        target_ref: {
          session_id: SESSION_ID,
          turn_id: null,
          request_id: null,
          resource: { kind: "invite", id: "x" },
          workspace_id: WORKSPACE_ID,
        },
      }).success,
    ).toBe(false);
    expect(
      receiptSchema.safeParse({
        ...base,
        target_ref: {
          session_id: SESSION_ID,
          turn_id: null,
          request_id: null,
          owner_id: "owner_1",
        },
      }).success,
    ).toBe(false);
  });

  test("actor is optional so alpha rows written before it still parse", () => {
    const withoutActor = receiptSchema.parse({
      ...base,
      target_ref: { session_id: SESSION_ID, turn_id: null, request_id: null },
    });
    expect(Object.hasOwn(withoutActor, "actor")).toBe(false);
    const withActor = receiptSchema.parse({
      ...base,
      target_ref: { session_id: SESSION_ID, turn_id: null, request_id: null },
      actor: {
        principal: { kind: "user", id: USER_ID },
        actor_user_id: USER_ID,
        agent_id: null,
      },
    });
    expect(withActor.actor?.actor_user_id).toBe(USER_ID);
  });
});

describe("push resolution receipts", () => {
  // Stage 5 of the rename writes the new names; servers of this version
  // must read them first, mid-deploy.
  test("old and new operation and error names both parse", () => {
    const target = { session_id: SESSION_ID, turn_id: null, request_id: null };
    for (const operation of ["decide_push", "resolve_push"]) {
      for (const code of ["PUSH_REQUEST_DECIDED", "PUSH_REQUEST_RESOLVED"]) {
        const receipt = {
          ...base,
          operation,
          status: "failed",
          target_ref: target,
          error: { code, message: "The push request was already decided" },
        };
        expect(receiptSchema.safeParse(receipt).success).toBe(true);
      }
    }
  });
});
