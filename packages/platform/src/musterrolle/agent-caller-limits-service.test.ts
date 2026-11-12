import { describe, expect, test } from "bun:test";
import type {
  AgentCallerLimits,
  PutAgentCallerLimitsRequest,
} from "@werft-ai/contracts";
import type {
  AgentCallerLimitsStore,
  PutAgentCallerLimitsResult,
} from "../ports/agent-caller-limits-store.ts";
import { createAgentCallerLimitsService } from "./agent-caller-limits-service.ts";
import { callerFor } from "./policy.ts";
import { SessionServiceError } from "./service-errors.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const TEAM = "019a0000-0000-7000-8000-00000000b0a1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";

const LIMITS: AgentCallerLimits = {
  rules: [
    {
      target: { kind: "team", id: TEAM },
      tools_deny: ["shell"],
      repositories: [],
      mcp_servers: null,
      credentials_deny: [],
    },
  ],
  revision: 2,
};
const REQUEST: PutAgentCallerLimitsRequest = { rules: LIMITS.rules };

const caller = callerFor(
  {
    kind: "user",
    id: USER,
    workspace_id: WORKSPACE,
    role: "owner",
    scopes: [],
  },
  { kind: "web" },
  "req-1",
);

function service(
  store: Partial<AgentCallerLimitsStore>,
  allowed = true,
  asked: unknown[] = [],
) {
  return createAgentCallerLimitsService({
    authorization: {
      authorize: async (request) => {
        asked.push(request);
        return {
          outcome: allowed ? "allow" : "deny",
          reason_code: allowed ? "ok" : "role",
          effective_scopes: [],
          policy_version: "test",
          decision_id: crypto.randomUUID(),
        };
      },
    },
    store: store as AgentCallerLimitsStore,
    newId: () => RECEIPT,
  });
}

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(SessionServiceError);
  return error as SessionServiceError;
};

describe("caller limits service", () => {
  test("a read and an edit both ask for agent.usage.manage on the agent", async () => {
    const asked: Array<{ action: string; resource: { id: string } }> = [];
    const api = service({ get: async () => LIMITS }, true, asked);
    expect(await api.getAgentCallerLimits(caller, AGENT)).toEqual(LIMITS);
    expect(asked.map((r) => [r.action, r.resource.id])).toEqual([
      ["agent.usage.manage", AGENT],
    ]);
    const denied = service({ get: async () => LIMITS }, false);
    expect(
      (await refusal(denied.getAgentCallerLimits(caller, AGENT))).code,
    ).toBe("FORBIDDEN");
  });

  test("an unknown agent reads as not found", async () => {
    const api = service({ get: async () => null });
    expect((await refusal(api.getAgentCallerLimits(caller, AGENT))).code).toBe(
      "NOT_FOUND",
    );
  });

  test("the store gets the rules, the If-Match number and the receipt id; a change returns it", async () => {
    let seen: Parameters<AgentCallerLimitsStore["put"]>[0] | undefined;
    const api = service({
      put: async (input) => {
        seen = input;
        return { outcome: "set", limits: LIMITS };
      },
    });
    expect(
      await api.putAgentCallerLimits(caller, AGENT, REQUEST, '"1"'),
    ).toEqual({ limits: LIMITS, receipt_id: RECEIPT });
    expect(seen).toMatchObject({
      receiptId: RECEIPT,
      agentId: AGENT,
      rules: REQUEST.rules,
      ifMatch: 1,
      managerRoles: ["owner", "admin"],
    });
  });

  test("no If-Match is refused before the store is asked", async () => {
    const api = service({
      put: async () => {
        throw new Error("reached the store");
      },
    });
    expect(
      (
        await refusal(
          api.putAgentCallerLimits(caller, AGENT, REQUEST, undefined),
        )
      ).code,
    ).toBe("PRECONDITION_REQUIRED");
  });

  test("a repeat writes no receipt", async () => {
    const api = service({
      put: async () => ({ outcome: "unchanged", limits: LIMITS }),
    });
    expect(await api.putAgentCallerLimits(caller, AGENT, REQUEST, "2")).toEqual(
      {
        limits: LIMITS,
        receipt_id: null,
      },
    );
  });

  test("each store refusal keeps its status and details", async () => {
    const cases: Array<
      [PutAgentCallerLimitsResult, string, Record<string, unknown> | null]
    > = [
      [{ outcome: "not_found" }, "NOT_FOUND", null],
      [{ outcome: "team_not_found" }, "NOT_FOUND", null],
      [
        { outcome: "team_not_allowed" },
        "FORBIDDEN",
        { reason_code: "team_not_allowed" },
      ],
      [{ outcome: "actor_inactive" }, "FORBIDDEN", { reason_code: "role" }],
      [
        { outcome: "version_mismatch", current: 5 },
        "VERSION_MISMATCH",
        { current_version: 5 },
      ],
      [
        { outcome: "repository_not_in_catalog", repositoryIds: ["gone"] },
        "BAD_REQUEST",
        { reason_code: "repository_not_in_catalog", repository_ids: ["gone"] },
      ],
    ];
    for (const [outcome, code, details] of cases) {
      const api = service({ put: async () => outcome });
      const error = await refusal(
        api.putAgentCallerLimits(caller, AGENT, REQUEST, "1"),
      );
      expect(error.code).toBe(code as typeof error.code);
      expect(error.details).toEqual(details);
    }
  });
});
