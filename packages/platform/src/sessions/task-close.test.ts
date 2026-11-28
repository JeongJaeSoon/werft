import { describe, expect, test } from "bun:test";
import type { AuthorizationReason } from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  type AuthorizationPolicy,
  AuthorizationUndecidedError,
} from "../access-control/index.ts";
import { createTaskClose } from "./task-close.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

function policy(
  outcome: "allow" | "deny",
  reason: AuthorizationReason = outcome === "allow" ? "ok" : "role",
): AuthorizationPolicy {
  return {
    authorize: async () => ({
      outcome,
      reason_code: reason,
      effective_scopes: [],
    }),
  } as unknown as AuthorizationPolicy;
}

function closeWith(authorization: AuthorizationPolicy) {
  const closed: unknown[] = [];
  const tasks = createTaskClose({
    authorization,
    closes: {
      close: async (input) => {
        closed.push(input);
        return "closed";
      },
    },
  });
  return { tasks, closed };
}

describe("createTaskClose", () => {
  test("whoever may control the session closes the task with the reason chosen", async () => {
    const { tasks, closed } = closeWith(policy("allow"));
    const caller = testCaller("owner-a");
    expect(await tasks.close(caller, SESSION, "cancelled")).toBe("closed");
    expect(closed).toEqual([
      { principal: caller, sessionId: SESSION, reason: "cancelled" },
    ]);
  });

  test.each(["role", "not_found"] as const)(
    "refused for %s, the task is not closed",
    async (reason) => {
      const { tasks, closed } = closeWith(policy("deny", reason));
      expect(
        await tasks.close(testCaller("owner-a"), SESSION, "completed"),
      ).toBe("not_permitted");
      expect(closed).toEqual([]);
    },
  );

  test("a policy that could not decide is no refusal: it throws, nothing closed", async () => {
    const { tasks, closed } = closeWith({
      authorize: async () => {
        throw new AuthorizationUndecidedError(new Error("store down"));
      },
    } as unknown as AuthorizationPolicy);
    await expect(
      tasks.close(testCaller("owner-a"), SESSION, "completed"),
    ).rejects.toBeInstanceOf(AuthorizationUndecidedError);
    expect(closed).toEqual([]);
  });
});
