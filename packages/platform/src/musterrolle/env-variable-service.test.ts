import { describe, expect, test } from "bun:test";
import {
  ENV_VARIABLE_VALUE_MAX_BYTES,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  DeleteEnvVariableResult,
  EnvVariableRecord,
  EnvVariableScope,
  EnvVariableStore,
  PutEnvVariableResult,
  SetEnvVariableGrantsResult,
} from "../ports/env-variable-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import {
  createEnvVariableService,
  envVariableViewOf,
  ifMatchOf,
  writePreconditionOf,
} from "./env-variable-service.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const ADMIN = "019a0000-0000-7000-8000-0000000000a2";
const MEMBER = "019a0000-0000-7000-8000-0000000000a3";
const AGENT_ADMIN = "019a0000-0000-7000-8000-0000000000a4";
const AGENT = "019a0000-0000-7000-8000-00000000b0a1";
const OTHER_AGENT = "019a0000-0000-7000-8000-00000000b0a2";
const KEY = "019a0000-0000-7000-8000-0000000000e1";

// The agent admin is a member who administers AGENT only.
const agents: AgentAuthority = {
  agentOf: async (_ws, resource) => resource.id,
  isAdmin: async (_ws, agentId, userId) =>
    agentId === AGENT && userId === AGENT_ADMIN,
};

function user(id: string, role: WorkspaceRole): Caller {
  return callerFor(
    {
      kind: "user",
      id,
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    crypto.randomUUID(),
  );
}

const owner = user(OWNER, "owner");
const admin = user(ADMIN, "admin");
const member = user(MEMBER, "member");
const agentAdmin = user(AGENT_ADMIN, "member");
// A key made by an owner is still a key: it holds no management action.
const ownerKey = callerFor(
  {
    kind: "api_key",
    id: KEY,
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: ["sessions:read", "sessions:write"],
  },
  { kind: "api" },
  crypto.randomUUID(),
  { creatorId: OWNER },
);

const at = new Date("2026-11-09T00:00:00.000Z");
function record(over: Partial<EnvVariableRecord> = {}): EnvVariableRecord {
  return {
    id: crypto.randomUUID(),
    name: "REGION",
    kind: "plain",
    value: "ap-northeast-1",
    version: 3,
    grantAll: false,
    grantVersion: 4,
    grantedAgents: [],
    engineDelivery: false,
    allowAutomation: false,
    updatedBy: OWNER,
    updatedAt: at,
    ...over,
  };
}

type Plan = {
  put?: PutEnvVariableResult;
  delete?: DeleteEnvVariableResult;
  grants?: SetEnvVariableGrantsResult;
  hasAgent?: boolean;
  lists?: (scope: EnvVariableScope) => EnvVariableRecord[];
};

function serviceOver(plan: Plan = {}) {
  const calls: { op: string; input: unknown }[] = [];
  const store: EnvVariableStore = {
    hasAgent: async () => plan.hasAgent ?? true,
    list: async (scope) => {
      calls.push({ op: "list", input: scope });
      return plan.lists?.(scope) ?? [];
    },
    readAgentView: async (workspaceId, agentId) => {
      calls.push({ op: "readAgentView", input: { workspaceId, agentId } });
      return {
        own: plan.lists?.({ workspaceId, agentId }) ?? [],
        workspace: plan.lists?.({ workspaceId, agentId: null }) ?? [],
      };
    },
    put: async (input) => {
      calls.push({ op: "put", input });
      return (
        plan.put ?? {
          outcome: "saved",
          version: 9,
          grantVersion: 4,
          created: true,
          receiptId: "r",
        }
      );
    },
    delete: async (input) => {
      calls.push({ op: "delete", input });
      return (
        plan.delete ?? {
          outcome: "deleted",
          affectedAgents: 2,
          openSessions: 1,
          receiptId: "r",
        }
      );
    },
    setGrants: async (input) => {
      calls.push({ op: "setGrants", input });
      return (
        plan.grants ?? { outcome: "saved", grantVersion: 11, receiptId: "r" }
      );
    },
  };
  const service = createEnvVariableService({
    authorization: createAuthorizationPolicy({ agents }),
    store,
  });
  return { service, calls };
}

async function errorOf(
  work: Promise<unknown>,
): Promise<SessionServiceError | null> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) return error;
    throw error;
  }
  return null;
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  return (await errorOf(work))?.code ?? "ok";
}

const none = { ifMatch: undefined, ifNoneMatch: undefined };
const create = { ifMatch: undefined, ifNoneMatch: "*" };
const body = { kind: "plain", value: "ap-northeast-1" } as const;
const grantsBody = { grant_all: false, agents: [{ id: AGENT }] };

type Operation = (
  service: ReturnType<typeof serviceOver>["service"],
  caller: Caller,
  agentId: string,
) => Promise<unknown>;

const WORKSPACE_OPERATIONS: Record<string, Operation> = {
  "GET workspace": (s, c) => s.listWorkspace(c),
  "PUT workspace": (s, c) => s.putWorkspace(c, "REGION", body, create),
  "DELETE workspace": (s, c) => s.deleteWorkspace(c, "REGION", "3"),
  "PUT grants": (s, c) => s.putGrants(c, "REGION", grantsBody, "4"),
};
const AGENT_OPERATIONS: Record<string, Operation> = {
  "GET agent": (s, c, a) => s.listAgent(c, a),
  "PUT agent": (s, c, a) => s.putAgent(c, a, "REGION", body, create),
  "DELETE agent": (s, c, a) => s.deleteAgent(c, a, "REGION", "3"),
};

describe("who may manage variables", () => {
  test("a member, and a key of an owner, are refused every operation before the store is touched", async () => {
    for (const caller of [member, ownerKey]) {
      for (const [label, run] of Object.entries({
        ...WORKSPACE_OPERATIONS,
        ...AGENT_OPERATIONS,
      })) {
        const { service, calls } = serviceOver();
        expect(await codeOf(run(service, caller, AGENT)), label).toBe(
          "FORBIDDEN",
        );
        expect(calls, label).toEqual([]);
      }
    }
  });

  test("owners and admins manage the workspace's own and every agent's", async () => {
    for (const caller of [owner, admin]) {
      for (const [label, run] of Object.entries({
        ...WORKSPACE_OPERATIONS,
        ...AGENT_OPERATIONS,
      })) {
        const { service } = serviceOver();
        expect(await codeOf(run(service, caller, OTHER_AGENT)), label).toBe(
          "ok",
        );
      }
    }
  });

  test("an agent's admin manages that agent's and nothing else", async () => {
    for (const [label, run] of Object.entries(AGENT_OPERATIONS)) {
      const { service } = serviceOver();
      expect(await codeOf(run(service, agentAdmin, AGENT)), label).toBe("ok");
      expect(await codeOf(run(service, agentAdmin, OTHER_AGENT)), label).toBe(
        "FORBIDDEN",
      );
    }
    for (const [label, run] of Object.entries(WORKSPACE_OPERATIONS)) {
      const { service, calls } = serviceOver();
      expect(await codeOf(run(service, agentAdmin, AGENT)), label).toBe(
        "FORBIDDEN",
      );
      expect(calls, label).toEqual([]);
    }
  });
});

describe("preconditions", () => {
  test("a create names If-None-Match, a change names If-Match, a bare write is 428", () => {
    expect(writePreconditionOf(create)).toEqual({ create: true });
    expect(
      writePreconditionOf({ ifMatch: "12", ifNoneMatch: undefined }),
    ).toEqual({ ifMatch: 12 });
    expect(
      writePreconditionOf({ ifMatch: '"12"', ifNoneMatch: undefined }),
    ).toEqual({ ifMatch: 12 });
    expect(() => writePreconditionOf(none)).toThrow(
      expect.objectContaining({ code: "PRECONDITION_REQUIRED" }),
    );
    expect(() => ifMatchOf(undefined)).toThrow(
      expect.objectContaining({ code: "PRECONDITION_REQUIRED" }),
    );
  });

  test("both headers, a value that is not * and a version that is not a number are 400", () => {
    for (const headers of [
      { ifMatch: "3", ifNoneMatch: "*" },
      { ifMatch: undefined, ifNoneMatch: "3" },
      { ifMatch: "latest", ifNoneMatch: undefined },
      { ifMatch: "-1", ifNoneMatch: undefined },
      { ifMatch: "", ifNoneMatch: undefined },
      // A weak tag never matches under strong comparison; quotes must pair.
      { ifMatch: 'W/"3"', ifNoneMatch: undefined },
      { ifMatch: "W/3", ifNoneMatch: undefined },
      { ifMatch: '"3', ifNoneMatch: undefined },
      { ifMatch: '3"', ifNoneMatch: undefined },
    ]) {
      expect(() => writePreconditionOf(headers)).toThrow(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );
    }
  });

  test("the store gets the precondition the headers named", async () => {
    const { service, calls } = serviceOver();
    await service.putWorkspace(owner, "REGION", body, create);
    await service.putWorkspace(owner, "REGION", body, {
      ifMatch: "7",
      ifNoneMatch: undefined,
    });
    expect(
      calls.map((c) => (c.input as { precondition: unknown }).precondition),
    ).toEqual([{ create: true }, { ifMatch: 7 }]);
  });

  test("a missing header is refused before the store is touched", async () => {
    const { service, calls } = serviceOver();
    expect(
      await codeOf(service.putWorkspace(owner, "REGION", body, none)),
    ).toBe("PRECONDITION_REQUIRED");
    expect(
      await codeOf(service.deleteWorkspace(owner, "REGION", undefined)),
    ).toBe("PRECONDITION_REQUIRED");
    expect(
      await codeOf(service.putGrants(owner, "REGION", grantsBody, undefined)),
    ).toBe("PRECONDITION_REQUIRED");
    expect(calls).toEqual([]);
  });
});

describe("what a write accepts", () => {
  const refused = async (name: string, over: object, code: string) => {
    const { service, calls } = serviceOver();
    expect(
      await codeOf(
        service.putWorkspace(owner, name, { ...body, ...over }, create),
      ),
      `${name} ${JSON.stringify(over).slice(0, 40)}`,
    ).toBe(code);
    expect(calls).toEqual([]);
  };

  test("a name must be upper case and not one the platform sets", async () => {
    await refused("region", {}, "VARIABLE_NAME_INVALID");
    await refused("1REGION", {}, "VARIABLE_NAME_INVALID");
    await refused("A".repeat(65), {}, "VARIABLE_NAME_INVALID");
    await refused("PATH", {}, "VARIABLE_NAME_RESERVED");
    await refused("ANTHROPIC_API_KEY", {}, "VARIABLE_NAME_RESERVED");
    await refused("GITHUB_TOKEN", {}, "VARIABLE_NAME_RESERVED");
  });

  test("a value is text without NUL, of at most 48 KB of UTF-8", async () => {
    await refused("REGION", { value: "a\0b" }, "VARIABLE_VALUE_INVALID");
    await refused("REGION", { value: "\ud800" }, "VARIABLE_VALUE_INVALID");
    await refused(
      "REGION",
      { value: "a".repeat(ENV_VARIABLE_VALUE_MAX_BYTES + 1) },
      "VARIABLE_VALUE_TOO_LARGE",
    );
    // Bytes, not characters: 16 385 three-byte characters are over the limit.
    await refused(
      "REGION",
      { value: "한".repeat(ENV_VARIABLE_VALUE_MAX_BYTES / 3 + 1) },
      "VARIABLE_VALUE_TOO_LARGE",
    );
    const { service } = serviceOver();
    expect(
      await codeOf(
        service.putWorkspace(
          owner,
          "REGION",
          { ...body, value: "a".repeat(ENV_VARIABLE_VALUE_MAX_BYTES) },
          create,
        ),
      ),
    ).toBe("ok");
  });

  test("a secret is refused until a runtime can carry one, and the error never holds the value", async () => {
    const value = "opaque-fixture-value-1234";
    const { service, calls } = serviceOver();
    const errors = [
      await errorOf(
        service.putWorkspace(owner, "TOKEN", { kind: "secret", value }, create),
      ),
      await errorOf(
        service.putAgent(
          owner,
          AGENT,
          "TOKEN",
          {
            kind: "secret",
            value,
            engine_delivery: true,
            acknowledge_engine_exposure: true,
          },
          create,
        ),
      ),
    ];
    for (const error of errors) {
      expect(error?.code).toBe("SECRET_ENV_UNSUPPORTED");
      expect(JSON.stringify([error?.message, error?.details])).not.toContain(
        value,
      );
    }
    expect(calls).toEqual([]);
  });

  test("a plain variable takes no engine delivery or automation switch", async () => {
    await refused("REGION", { engine_delivery: true }, "BAD_REQUEST");
    await refused("REGION", { allow_automation: true }, "BAD_REQUEST");
    await refused(
      "REGION",
      { acknowledge_engine_exposure: true },
      "BAD_REQUEST",
    );
  });

  test("grant_all takes no agents", async () => {
    const { service, calls } = serviceOver();
    expect(
      await codeOf(
        service.putGrants(
          owner,
          "REGION",
          { grant_all: true, agents: [{ id: AGENT }] },
          "4",
        ),
      ),
    ).toBe("BAD_REQUEST");
    expect(calls).toEqual([]);
  });
});

describe("what the store's answer becomes", () => {
  test("saved, with the new versions", async () => {
    const { service } = serviceOver();
    expect(await service.putWorkspace(owner, "REGION", body, create)).toEqual({
      name: "REGION",
      version: 9,
      grant_version: 4,
    });
    expect(await service.putGrants(owner, "REGION", grantsBody, "4")).toEqual({
      name: "REGION",
      grant_version: 11,
    });
    expect(await service.deleteWorkspace(owner, "REGION", "3")).toEqual({
      affected_agents: 2,
      open_sessions: 1,
    });
  });

  test("a stale or already existing version is 412 and names the current one", async () => {
    const { service } = serviceOver({
      put: { outcome: "version_mismatch", current: 8 },
      delete: { outcome: "version_mismatch", current: 8 },
      grants: { outcome: "version_mismatch", current: 8 },
    });
    for (const run of [
      () => service.putWorkspace(owner, "REGION", body, create),
      () => service.deleteWorkspace(owner, "REGION", "3"),
      () => service.putGrants(owner, "REGION", grantsBody, "3"),
    ]) {
      const error = await errorOf(run());
      expect(error?.code).toBe("VERSION_MISMATCH");
      expect(error?.details).toEqual({ current_version: 8 });
    }
  });

  test("a full scope is 409, a missing variable or agent is 404", async () => {
    expect(
      await codeOf(
        serviceOver({
          put: { outcome: "quota_exceeded" },
        }).service.putWorkspace(owner, "REGION", body, create),
      ),
    ).toBe("VARIABLE_QUOTA_EXCEEDED");
    expect(
      await codeOf(
        serviceOver({ put: { outcome: "agent_not_found" } }).service.putAgent(
          owner,
          AGENT,
          "REGION",
          body,
          create,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        serviceOver({ delete: { outcome: "not_found" } }).service.deleteAgent(
          owner,
          AGENT,
          "REGION",
          "3",
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        serviceOver({ grants: { outcome: "not_found" } }).service.putGrants(
          owner,
          "REGION",
          grantsBody,
          "4",
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        serviceOver({
          grants: { outcome: "agent_not_found" },
        }).service.putGrants(owner, "REGION", grantsBody, "4"),
      ),
    ).toBe("BAD_REQUEST");
  });

  test("writes go to the scope the route names, in the caller's workspace", async () => {
    const { service, calls } = serviceOver();
    await service.putWorkspace(owner, "REGION", body, create);
    await service.putAgent(agentAdmin, AGENT, "REGION", body, create);
    expect(calls.map((c) => (c.input as { scope: unknown }).scope)).toEqual([
      { workspaceId: WORKSPACE, agentId: null },
      { workspaceId: WORKSPACE, agentId: AGENT },
    ]);
  });
});

describe("what a read shows", () => {
  const HIDDEN_VALUE = "opaque-fixture-value-5678";

  test("a secret row has no value and no last4, even if a value were in the record", () => {
    const view = envVariableViewOf(
      record({
        name: "TOKEN",
        kind: "secret",
        value: HIDDEN_VALUE,
        engineDelivery: true,
      }),
    );
    expect(Object.keys(view).sort()).toEqual([
      "engine_delivery",
      "grant_all",
      "grant_version",
      "granted_agents",
      "kind",
      "name",
      "updated_at",
      "updated_by",
      "version",
    ]);
    expect(JSON.stringify(view)).not.toContain(HIDDEN_VALUE);
  });

  test("the workspace list carries plain values and the grants' agent ids", async () => {
    const { service } = serviceOver({
      lists: () => [
        record({ grantedAgents: [{ id: AGENT, allowAutomation: false }] }),
      ],
    });
    const listed = await service.listWorkspace(admin);
    expect(listed.items).toEqual([
      {
        name: "REGION",
        kind: "plain",
        value: "ap-northeast-1",
        version: 3,
        grant_all: false,
        grant_version: 4,
        granted_agents: [AGENT],
        engine_delivery: false,
        updated_by: OWNER,
        updated_at: at.toISOString(),
      },
    ]);
  });

  test("an agent sees its own, the workspace values granted to it, and only the existence of the rest", async () => {
    const granted = [{ id: AGENT, allowAutomation: false }];
    const workspace = [
      record({
        name: "GRANTED",
        value: "granted-value",
        grantedAgents: granted,
      }),
      record({ name: "EVERYONE", value: "everyone-value", grantAll: true }),
      record({
        name: "SHADOWED",
        value: "shadowed-workspace-value",
        grantedAgents: granted,
      }),
      record({ name: "UNGRANTED", value: "ungranted-workspace-value" }),
      record({
        name: "OTHERS",
        value: "others-value",
        grantedAgents: [{ id: OTHER_AGENT, allowAutomation: false }],
      }),
    ];
    const own = [
      record({ name: "SHADOWED", value: "own-shadow" }),
      record({ name: "UNGRANTED", value: "own-ungranted" }),
      record({ name: "ONLY_MINE", value: "mine" }),
    ];
    const { service } = serviceOver({
      lists: (scope) => (scope.agentId === null ? workspace : own),
    });
    const view = await service.listAgent(agentAdmin, AGENT);
    const entry = (
      name: string,
      source: "agent" | "workspace",
      shadows: boolean,
      ungranted: boolean,
    ) => ({
      name,
      kind: "plain" as const,
      source,
      shadows_workspace: shadows,
      workspace_value_ungranted: ungranted,
    });
    expect(view.effective).toEqual([
      entry("EVERYONE", "workspace", false, false),
      entry("GRANTED", "workspace", false, false),
      entry("ONLY_MINE", "agent", false, false),
      entry("SHADOWED", "agent", true, false),
      entry("UNGRANTED", "agent", false, true),
    ]);
    expect(view.items.map((item) => item.name)).toEqual([
      "SHADOWED",
      "UNGRANTED",
      "ONLY_MINE",
    ]);
    expect(view.granted_workspace_values.map((v) => v.name).sort()).toEqual([
      "EVERYONE",
      "GRANTED",
      "SHADOWED",
    ]);
    // A workspace value that is not granted, or granted to another agent,
    // appears nowhere in the answer.
    const text = JSON.stringify(view);
    expect(text).not.toContain("ungranted-workspace-value");
    expect(text).not.toContain("others-value");
    expect(text).not.toContain("OTHERS");
  });

  test("an upper-case agent id in the path still finds its explicit grants, in one snapshot read", async () => {
    const { service, calls } = serviceOver({
      lists: (scope) =>
        scope.agentId === null
          ? [
              record({
                name: "REGION",
                value: "ap-northeast-1",
                grantedAgents: [{ id: AGENT, allowAutomation: false }],
              }),
              record({ name: "SAME_NAME", value: "workspace-copy" }),
            ]
          : [record({ name: "SAME_NAME", value: "own-copy" })],
    });
    const view = await service.listAgent(owner, AGENT.toUpperCase());
    expect(view.granted_workspace_values).toEqual([
      { name: "REGION", kind: "plain", value: "ap-northeast-1" },
    ]);
    // SAME_NAME is not granted, so the agent learns it exists and nothing more.
    expect(
      view.effective.find((entry) => entry.name === "SAME_NAME"),
    ).toMatchObject({ workspace_value_ungranted: true });
    expect(calls.filter((call) => call.op === "list")).toEqual([]);
    expect(calls.filter((call) => call.op === "readAgentView")).toEqual([
      {
        op: "readAgentView",
        input: { workspaceId: owner.ownerId, agentId: AGENT },
      },
    ]);
  });

  test("an upper-case agent id reaches the store lower-cased on a write and a delete", async () => {
    const { service, calls } = serviceOver();
    await service.putAgent(
      owner,
      AGENT.toUpperCase(),
      "REGION",
      { kind: "plain", value: "v" },
      create,
    );
    await service.deleteAgent(owner, AGENT.toUpperCase(), "REGION", "3");
    const scopes = calls.map(
      (call) => (call.input as { scope: EnvVariableScope }).scope,
    );
    expect(scopes).toEqual([
      { workspaceId: owner.ownerId, agentId: AGENT },
      { workspaceId: owner.ownerId, agentId: AGENT },
    ]);
  });

  test("an unknown agent is 404, and a secret never carries a value", async () => {
    expect(
      await codeOf(
        serviceOver({ hasAgent: false }).service.listAgent(owner, AGENT),
      ),
    ).toBe("NOT_FOUND");
    const { service } = serviceOver({
      lists: (scope) =>
        scope.agentId === null
          ? [
              record({
                name: "TOKEN",
                kind: "secret",
                value: null,
                grantedAgents: [{ id: AGENT, allowAutomation: true }],
              }),
            ]
          : [record({ name: "OWN_TOKEN", kind: "secret", value: null })],
    });
    const view = await service.listAgent(owner, AGENT);
    expect(view.granted_workspace_values).toEqual([
      { name: "TOKEN", kind: "secret" },
    ]);
    expect(view.items[0]).not.toHaveProperty("value");
    expect(view.items[0]).not.toHaveProperty("last4");
  });
});
