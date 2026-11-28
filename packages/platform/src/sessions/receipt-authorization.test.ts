import { expect, test } from "bun:test";
import type { Receipt } from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createAuthorizationPolicy,
  type IdentityReader,
} from "../access-control/policy.ts";
import { createSessionService } from "./session-service.ts";

const receipt: Receipt = {
  id: "4d6d1a3e-1f1c-4c3a-9f3e-2b1c1d1e1f10",
  operation: "close",
  target_ref: { session_id: "own-session", turn_id: null, request_id: null },
  status: "succeeded",
  result: null,
  error: null,
  created_at: "2026-10-28T00:00:00Z",
  updated_at: "2026-10-28T00:00:00Z",
};

const bound: IdentityReader = {
  reread: async (subject) => ({
    status: "ok",
    principal: subject.principal,
    keyAgentId: "own-agent",
  }),
};

function service(stored: Receipt | null = receipt, identity = bound) {
  const authorization = createAuthorizationPolicy({
    identity,
    agents: {
      agentOf: async (_owner, resource) =>
        resource.id === "own-session" ? "own-agent" : "other-agent",
      isAdmin: async () => false,
    },
  });
  const unreachable = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("unexpected store call");
      },
    },
  ) as never;
  return createSessionService({
    authorization,
    inputs: unreachable,
    controls: unreachable,
    catalog: unreachable,
    limits: unreachable,
    reader: new Proxy(
      {},
      {
        get: (_target, name) =>
          name === "getReceipt"
            ? async (owner: string) => (owner === "owner-a" ? stored : null)
            : () => {
                throw new Error("unexpected reader call");
              },
      },
    ) as never,
  });
}

test("an agent key reads the receipt of its own session", async () => {
  expect(await service().getReceipt(testCaller("owner-a"), receipt.id)).toEqual(
    receipt,
  );
});

test("an agent key cannot read another agent's session receipt", async () => {
  const other = {
    ...receipt,
    target_ref: {
      session_id: "other-session",
      turn_id: null,
      request_id: null,
    },
  };
  await expect(
    service(other).getReceipt(testCaller("owner-a"), receipt.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("non-session receipts and absent receipts do not grant an agent broader access", async () => {
  const other: Receipt = {
    ...receipt,
    target_ref: {
      resource: { kind: "agent", id: "own-agent" },
      workspace_id: "owner-a",
    },
  };
  for (const stored of [other, null]) {
    await expect(
      service(stored).getReceipt(testCaller("owner-a"), receipt.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
  await expect(
    service().getReceipt(testCaller("owner-b"), receipt.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("receipt disclosure still requires a live identity and read scope", async () => {
  await expect(
    service().getReceipt(testCaller("owner-a", ["sessions:write"]), receipt.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  for (const identity of [
    { reread: async () => ({ status: "disabled" as const }) },
    {
      reread: async () => {
        throw new Error("identity unavailable");
      },
    },
  ]) {
    await expect(
      service(receipt, identity).getReceipt(testCaller("owner-a"), receipt.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
});
