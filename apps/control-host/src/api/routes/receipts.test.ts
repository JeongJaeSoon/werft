import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  getReceiptResponseSchema,
  type Receipt,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createSessionService,
  type SessionReader,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerReceiptRoutes } from "./sessions/receipts.ts";

const createApiApp = recordRouteErrors("routes/receipts.test.ts");

const receipt: Receipt = {
  id: "4d6d1a3e-1f1c-4c3a-9f3e-2b1c1d1e1f10",
  operation: "create_session",
  target_ref: {
    session_id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
    turn_id: "1",
    request_id: null,
  },
  status: "accepted",
  result: { session_id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" },
  error: null,
  created_at: "2026-09-22T00:00:00.000Z",
  updated_at: "2026-09-22T00:00:00.000Z",
};

function app(
  getReceipt: SessionReader["getReceipt"],
  hiddenAgentRefs: SessionReader["hiddenAgentRefs"] = async () => ({
    agentIds: new Set<string>(),
    releaseIds: new Set<string>(),
  }),
) {
  const service = createSessionService({
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
    authorization: createAuthorizationPolicy(),
    catalog: { connections: {}, repositories: {} },
    inputs: {
      acceptInputAtomic: async () => {
        throw new Error("not reached");
      },
      appendInputAtomic: async () => {
        throw new Error("not reached");
      },
    },
    controls: {
      terminateAtomic: async () => {
        throw new Error("not reached");
      },
      pauseAtomic: async () => {
        throw new Error("not reached");
      },
      closeAtomic: async () => {
        throw new Error("not reached");
      },
      decideRecoveryAtomic: async () => {
        throw new Error("not reached");
      },
      resumeAtomic: async () => {
        throw new Error("not reached");
      },
      renameAtomic: async () => {
        throw new Error("not reached");
      },
    },
    reader: {
      listSessions: async () => ({ items: [], next_cursor: null }),
      countSessions: async () => {
        throw new Error("not reached");
      },
      getSession: async () => null,
      listTurns: async () => null,
      getTurn: async () => null,
      getReceipt,
      hiddenAgentRefs,
      readEvents: async () => null,
    },
  });
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerReceiptRoutes(router, service),
  });
}

function get(
  api: ReturnType<typeof app>,
  id: string,
  owner: string | null = "owner-a",
) {
  return api.request(`/v1/receipts/${id}`, {
    headers: owner ? { "X-Owner-Id": owner } : {},
  });
}

describe("GET /v1/receipts/{id}", () => {
  test("returns the owner's receipt in contract shape", async () => {
    const seen: string[][] = [];
    const response = await get(
      app(async (ownerId, receiptId) => {
        seen.push([ownerId, receiptId]);
        return receipt;
      }),
      receipt.id,
    );
    expect(response.status).toBe(200);
    expect(getReceiptResponseSchema.parse(await response.json())).toEqual(
      receipt,
    );
    expect(seen).toEqual([["owner-a", receipt.id]]);
  });

  test("answers 404 for another owner's or a missing receipt", async () => {
    const response = await get(
      app(async () => null),
      receipt.id,
    );
    expect(response.status).toBe(404);
    const body = apiErrorResponseSchema.parse(await response.json());
    expect(body.error).toMatchObject({ code: "NOT_FOUND", details: null });
  });

  test("treats a malformed id as not found without hitting storage", async () => {
    let calls = 0;
    const response = await get(
      app(async () => {
        calls += 1;
        return receipt;
      }),
      "not-a-uuid",
    );
    expect(response.status).toBe(404);
    expect(calls).toBe(0);
  });

  test("requires authentication", async () => {
    const response = await get(
      app(async () => receipt),
      receipt.id,
      null,
    );
    expect(response.status).toBe(401);
  });

  describe("agents the reader may not use (94S-902)", () => {
    const HIDDEN = "8d2c4f1a-6b3e-4a9d-b7c5-2e1f0a9b8c7d";
    const OPEN = "9e3d5a2b-7c4f-4bae-88d6-3f2a1b0c9d8e";
    const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
    const hiding = (agentIds: string[], releaseIds: string[] = []) =>
      (async () => ({
        agentIds: new Set(agentIds),
        releaseIds: new Set(releaseIds),
      })) as SessionReader["hiddenAgentRefs"];

    test("a delete_team receipt loses the hidden agents from both lists", async () => {
      const stored: Receipt = {
        ...receipt,
        operation: "delete_team",
        target_ref: {
          resource: {
            kind: "team",
            id: "5f7a1b2c-3d4e-4f60-8a9b-0c1d2e3f4a5b",
          },
          workspace_id: null,
        },
        status: "succeeded",
        result: {
          name: "finance",
          agent_ids: [HIDDEN, OPEN],
          usage_agent_ids: [HIDDEN],
        },
      };
      const response = await get(
        app(async () => stored, hiding([HIDDEN])),
        stored.id,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(HIDDEN);
      expect(JSON.parse(text).result).toEqual({
        name: "finance",
        agent_ids: [OPEN],
        usage_agent_ids: [],
      });
    });

    test("a receipt aimed at a hidden agent is not found, as a missing one is", async () => {
      const stored: Receipt = {
        ...receipt,
        operation: "create_session",
        target_ref: {
          resource: { kind: "agent", id: HIDDEN },
          workspace_id: null,
        },
        status: "failed",
        result: { agent_id: HIDDEN, release_id: "rel-hidden" },
        error: { code: "CREDENTIAL_UNBOUND", message: "unbound" },
      };
      const hidden = await get(
        app(async () => stored, hiding([HIDDEN], ["rel-hidden"])),
        stored.id,
      );
      const missing = await get(
        app(async () => null),
        stored.id,
      );
      expect(hidden.status).toBe(404);
      const { request_id: _hidden, ...hiddenError } = (
        (await hidden.json()) as { error: Record<string, unknown> }
      ).error;
      const { request_id: _missing, ...missingError } = (
        (await missing.json()) as { error: Record<string, unknown> }
      ).error;
      expect(hiddenError).toEqual(missingError);
    });

    test("a gate receipt on a visible session shows without the agent and release", async () => {
      const stored: Receipt = {
        ...receipt,
        operation: "merge_pull_request",
        status: "succeeded",
        result: {
          session_id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
          agent_id: HIDDEN,
          agent_release_id: "rel-hidden",
          repository_id: "sample-app",
        },
      };
      const response = await get(
        app(async () => stored, hiding([HIDDEN], ["rel-hidden"])),
        stored.id,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(HIDDEN);
      expect(text).not.toContain("rel-hidden");
      expect(JSON.parse(text).result).toEqual({
        session_id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
        agent_id: null,
        agent_release_id: null,
        repository_id: "sample-app",
      });
    });

    test("an api key receipt and an env grants receipt lose the hidden agent", async () => {
      const key: Receipt = {
        ...receipt,
        operation: "create_api_key",
        target_ref: {
          resource: { kind: "api_key", id: "key-1" },
          workspace_id: null,
        },
        status: "succeeded",
        result: { agent_id: HIDDEN, scopes: ["sessions:write"] },
      };
      const keyText = await (
        await get(
          app(async () => key, hiding([HIDDEN])),
          key.id,
        )
      ).text();
      expect(keyText).not.toContain(HIDDEN);

      const grants: Receipt = {
        ...receipt,
        operation: "set_env_variable_grants",
        target_ref: {
          resource: { kind: "workspace", id: WORKSPACE },
          workspace_id: WORKSPACE,
        },
        status: "succeeded",
        result: {
          name: "TOKEN",
          before: { grant_all: false, agents: [HIDDEN] },
          after: { grant_all: false, agents: [HIDDEN, OPEN] },
        },
      };
      const response = await get(
        app(async () => grants, hiding([HIDDEN])),
        grants.id,
      );
      const text = await response.text();
      expect(text).not.toContain(HIDDEN);
      expect(JSON.parse(text).result).toEqual({
        name: "TOKEN",
        before: { grant_all: false, agents: [] },
        after: { grant_all: false, agents: [OPEN] },
      });
      expect(
        (grants.result as { before: { agents: string[] } }).before.agents,
      ).toEqual([HIDDEN]);
    });

    test("an opening agent and a policy-approved push release are masked", async () => {
      const review: Receipt = {
        ...receipt,
        operation: "review_pull_request",
        status: "succeeded",
        result: {
          session_id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
          agent_id: OPEN,
          opened_by_agent_id: HIDDEN,
        },
      };
      const reviewed = await (
        await get(
          app(async () => review, hiding([HIDDEN])),
          review.id,
        )
      ).text();
      expect(reviewed).not.toContain(HIDDEN);
      expect(reviewed).toContain(OPEN);

      const push: Receipt = {
        ...receipt,
        operation: "push",
        status: "succeeded",
        result: {
          approved_by: {
            kind: "policy",
            agent_release_id: "rel-hidden",
            policy_source: "agent",
          },
        },
      };
      const pushed = await (
        await get(
          app(async () => push, hiding([], ["rel-hidden"])),
          push.id,
        )
      ).text();
      expect(pushed).not.toContain("rel-hidden");

      const byKey: Receipt = {
        ...push,
        result: {
          approved_by: {
            principal: { kind: "api_key", id: "key" },
            actor_user_id: null,
            agent_id: HIDDEN,
          },
        },
      };
      const keyed = await (
        await get(
          app(async () => byKey, hiding([HIDDEN])),
          byKey.id,
        )
      ).text();
      expect(keyed).not.toContain(HIDDEN);
    });

    test("a receipt that names no agent is not looked up", async () => {
      let asked = 0;
      const response = await get(
        app(async () => ({ ...receipt, operation: "pause" }), (async () => {
          asked += 1;
          return { agentIds: new Set<string>(), releaseIds: new Set<string>() };
        }) as SessionReader["hiddenAgentRefs"]),
        receipt.id,
      );
      expect(response.status).toBe(200);
      expect(asked).toBe(0);
    });
  });

  test("maps a storage outage to a retryable 503", async () => {
    const response = await get(
      app(async () => {
        throw Object.assign(new Error("connection refused"), {
          code: "ECONNREFUSED",
        });
      }),
      receipt.id,
    );
    expect(response.status).toBe(503);
    expect(
      apiErrorResponseSchema.parse(await response.json()).error,
    ).toMatchObject({ code: "BACKEND_UNAVAILABLE", retryable: true });
  });
});
