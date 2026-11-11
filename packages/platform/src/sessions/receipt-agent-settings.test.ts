import { expect, test } from "bun:test";
import {
  type Receipt,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import { createSessionService } from "./session-service.ts";

// agent-rbac (b), receipt reads: a receipt that records an agent's settings
// is read as agent.settings_read, one about a session as session.read.
const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const SESSION = "019a0000-0000-7000-8000-00000000e0a1";
const PEOPLE = {
  W: ["owner", "019a0000-0000-7000-8000-0000000000c1"],
  L: ["member", "019a0000-0000-7000-8000-0000000000c2"],
  T: ["member", "019a0000-0000-7000-8000-0000000000c3"],
  O: ["member", "019a0000-0000-7000-8000-0000000000c4"],
} as const satisfies Record<string, readonly [WorkspaceRole, string]>;

const base = {
  id: "4d6d1a3e-1f1c-4c3a-9f3e-2b1c1d1e1f10",
  status: "succeeded",
  error: null,
  created_at: "2026-10-28T00:00:00Z",
  updated_at: "2026-10-28T00:00:00Z",
} as const;

const onAgent: Receipt = {
  ...base,
  operation: "bind_credential",
  target_ref: {
    resource: { kind: "agent", id: AGENT },
    workspace_id: WORKSPACE,
  },
  result: { credential_ref: "github" },
};
const onBinding: Receipt = {
  ...base,
  operation: "set_surface_binding",
  target_ref: {
    resource: { kind: "surface_binding", id: crypto.randomUUID() },
    workspace_id: WORKSPACE,
  },
  result: { agent_id: AGENT, channel_id: "C1" },
};
// A start the policy refused for unbound credentials, as
// credential-bindings.ts writes it.
const refusedStart: Receipt = {
  ...base,
  operation: "create_session",
  status: "failed",
  target_ref: {
    resource: { kind: "agent", id: AGENT },
    workspace_id: WORKSPACE,
  },
  result: { agent_id: AGENT, release_id: crypto.randomUUID() },
};
const onSession: Receipt = {
  ...base,
  operation: "close",
  target_ref: { session_id: SESSION, turn_id: null, request_id: null },
  result: null,
};

function service(stored: Receipt, sessionVisible = true) {
  const authorization = createAuthorizationPolicy({
    identity: {
      reread: async (s) => ({ status: "ok", principal: s.principal }),
    },
    agents: {
      agentOf: async (_ws, resource) =>
        resource.kind === "agent" && resource.id === AGENT
          ? AGENT
          : resource.kind === "session" && resource.id === SESSION
            ? AGENT
            : null,
      isAdmin: async (_ws, _agent, userId) => userId === PEOPLE.L[1],
      isInside: async (_ws, _agent, userId) =>
        userId === PEOPLE.L[1] || userId === PEOPLE.T[1],
    },
    sessions: {
      visibleTo: async () => sessionVisible,
      originOf: async () => null,
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
    reader: {
      getReceipt: async () => stored,
      hiddenAgentRefs: async () => ({
        agentIds: new Set<string>(),
        releaseIds: new Set<string>(),
      }),
    } as never,
  });
}

async function readers(stored: Receipt, sessionVisible = true) {
  const got: Record<string, string> = {};
  for (const [who, [role, id]] of Object.entries(PEOPLE)) {
    const caller = callerFor(
      {
        kind: "user",
        id,
        workspace_id: WORKSPACE,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      "r",
    );
    try {
      await service(stored, sessionVisible).getReceipt(caller, stored.id);
      got[who] = "ok";
    } catch (error) {
      got[who] = (error as { code: string }).code;
    }
  }
  return got;
}

test("a receipt on an agent's settings is read by those inside it", async () => {
  const inside = { W: "ok", L: "ok", T: "ok", O: "FORBIDDEN" };
  expect(await readers(onAgent)).toEqual(inside);
  expect(await readers(onBinding)).toEqual(inside);
});

test("a binding receipt that names no agent is shown to nobody", async () => {
  const nameless = { ...onBinding, result: { channel_id: "C1" } };
  expect(await readers(nameless)).toEqual({
    W: "NOT_FOUND",
    L: "NOT_FOUND",
    T: "NOT_FOUND",
    O: "NOT_FOUND",
  });
});

test("a refused start and a session's receipt keep their reads", async () => {
  const everyone = { W: "ok", L: "ok", T: "ok", O: "ok" };
  expect(await readers(refusedStart)).toEqual(everyone);
  expect(await readers(onSession)).toEqual(everyone);
  expect(await readers(onSession, false)).toEqual({
    W: "NOT_FOUND",
    L: "NOT_FOUND",
    T: "NOT_FOUND",
    O: "NOT_FOUND",
  });
});
