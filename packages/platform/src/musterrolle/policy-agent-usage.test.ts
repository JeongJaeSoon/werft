import { describe, expect, test } from "bun:test";
import {
  type AuthorizationRequest,
  type Principal,
  SESSION_SCOPE_VALUES,
  type SessionScope,
} from "@werft-ai/contracts";
import type { DecisionLog } from "../ports/decision-log.ts";
import type { UsageDecision } from "./agent-usage-decision.ts";
import {
  type AgentAuthority,
  type AuthorizationPolicy,
  callerFor,
  createAuthorizationPolicy,
  type IdentityReader,
  type UsageRequester,
} from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const KEY = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-00000000b0c1";
const OTHER_AGENT = "019a0000-0000-7000-8000-00000000b0c2";
const SESSION = "019a0000-0000-7000-8000-0000000000e1";
const RELEASE = "rel-1";

const without = (scope: SessionScope) =>
  SESSION_SCOPE_VALUES.filter((held) => held !== scope);

const member: Principal = {
  kind: "user",
  id: USER,
  workspace_id: WORKSPACE,
  role: "member",
  scopes: without("sessions:recover"),
};

const OPEN: UsageDecision = { allowed: true, basis: "public", teamId: null };
const CLOSED: UsageDecision = { allowed: false };

// Records who each usage question was asked for, and answers with `answer`.
function authority(
  answer: UsageDecision,
  overrides: Partial<AgentAuthority> = {},
) {
  const asked: { agentId: string; who: UsageRequester }[] = [];
  const agents: AgentAuthority = {
    agentOf: async (_workspace, resource) =>
      resource.kind === "session" ? AGENT : resource.id,
    isAdmin: async () => false,
    agentOfRelease: async () => AGENT,
    usageOf: async (_workspace, agentId, who) => {
      asked.push({ agentId, who });
      return answer;
    },
    ...overrides,
  };
  return { agents, asked };
}

function policyOf(
  agents: AgentAuthority,
  extra: {
    identity?: IdentityReader;
    unbound?: string[];
    decisions?: DecisionLog;
  } = {},
): AuthorizationPolicy {
  return createAuthorizationPolicy({
    agents,
    credentials: { unboundRefs: async () => extra.unbound ?? [] },
    ...(extra.identity ? { identity: extra.identity } : {}),
    ...(extra.decisions ? { decisions: extra.decisions } : {}),
  });
}

const web = callerFor(member, { kind: "web" }, "req-1");

function starting(caller = web): AuthorizationRequest {
  return {
    subject: caller.subject,
    action: "session.submit",
    resource: {
      kind: "session",
      id: null,
      owner_scope: caller.ownerId,
      agent_id: AGENT,
      release_id: RELEASE,
    },
    request_id: caller.requestId,
  };
}

function feeding(caller = web): AuthorizationRequest {
  return {
    subject: caller.subject,
    action: "session.submit",
    resource: { kind: "session", id: SESSION, owner_scope: caller.ownerId },
    request_id: caller.requestId,
  };
}

describe("a private agent's usage", () => {
  test("an outsider's start and input are agent_private", async () => {
    const { agents } = authority(CLOSED);
    const policy = policyOf(agents);
    expect(await policy.authorize(starting())).toMatchObject({
      outcome: "deny",
      reason_code: "agent_private",
    });
    expect(await policy.authorize(feeding())).toMatchObject({
      outcome: "deny",
      reason_code: "agent_private",
    });
  });

  test("a person with a basis starts and feeds, whichever it is", async () => {
    for (const basis of [
      "public",
      "team",
      "workspace",
      "agent_admin",
      "manager",
    ] as const) {
      const { agents } = authority({ allowed: true, basis, teamId: null });
      const policy = policyOf(agents);
      expect(await policy.authorize(starting())).toMatchObject({
        outcome: "allow",
      });
      expect(await policy.authorize(feeding())).toMatchObject({
        outcome: "allow",
      });
    }
  });

  test("asks about the person, their role and the agent the release names", async () => {
    const { agents, asked } = authority(OPEN);
    await policyOf(agents).authorize(starting());
    expect(asked).toEqual([
      {
        agentId: AGENT,
        who: { userId: USER, role: "member", keyAgentId: null },
      },
    ]);
  });

  test("the refusal is kept under agent_private and the credentials are not read", async () => {
    const kept: Parameters<DecisionLog["record"]>[0][] = [];
    let read = false;
    const { agents } = authority(CLOSED);
    const policy = createAuthorizationPolicy({
      agents,
      credentials: {
        unboundRefs: async () => {
          read = true;
          return ["mcp-x"];
        },
      },
      decisions: {
        async record(entry) {
          kept.push(entry);
        },
      },
    });
    await policy.authorize(starting());
    expect(read).toBe(false);
    expect(kept.map((entry) => entry.decision.reason_code)).toEqual([
      "agent_private",
    ]);
  });

  test("a person with the grant meets the credential check after it", async () => {
    const { agents } = authority(OPEN);
    expect(
      await policyOf(agents, { unbound: ["mcp-x"] }).authorize(starting()),
    ).toMatchObject({ reason_code: "credential_unbound" });
  });

  test("a refusal that is the same for a public agent keeps its reason", async () => {
    const { agents, asked } = authority(CLOSED);
    const policy = policyOf(agents);
    const reader = callerFor(
      {
        ...member,
        scopes: without("sessions:write").filter(
          (s) => s !== "sessions:recover",
        ),
      },
      { kind: "web" },
      "req-2",
    );
    expect(await policy.authorize(starting(reader))).toMatchObject({
      reason_code: "role",
    });
    expect(asked).toEqual([]);

    const boundElsewhere = (): IdentityReader => ({
      reread: async (subject) => ({
        status: "ok",
        principal: subject.principal as Principal,
        keyAgentId: OTHER_AGENT,
      }),
    });
    const key = callerFor(
      {
        kind: "api_key",
        id: KEY,
        owner_id: WORKSPACE,
        workspace_id: WORKSPACE,
        scopes: [...SESSION_SCOPE_VALUES],
      },
      { kind: "api" },
      "req-3",
      { creatorId: null, agentId: OTHER_AGENT },
    );
    expect(
      await policyOf(agents, { identity: boundElsewhere() }).authorize(
        starting(key),
      ),
    ).toMatchObject({ reason_code: "agent_ceiling" });
    expect(asked).toEqual([]);
  });

  test("a key with no person and no agent is asked as personless", async () => {
    const { agents, asked } = authority(CLOSED);
    const key = callerFor(
      {
        kind: "api_key",
        id: KEY,
        owner_id: WORKSPACE,
        workspace_id: WORKSPACE,
        scopes: [...SESSION_SCOPE_VALUES],
      },
      { kind: "api" },
      "req-4",
      { creatorId: null },
    );
    const identity: IdentityReader = {
      reread: async (subject) => ({
        status: "ok",
        principal: subject.principal as Principal,
      }),
    };
    expect(
      await policyOf(agents, { identity }).authorize(starting(key)),
    ).toMatchObject({ reason_code: "agent_private" });
    expect(asked[0]?.who).toEqual({
      userId: null,
      role: null,
      keyAgentId: null,
    });
  });

  test("an approval does not read usage", async () => {
    const { agents, asked } = authority(CLOSED, {
      // The creator answers for their own session.
    });
    const policy = createAuthorizationPolicy({
      agents,
      sessions: {
        visibleTo: async () => true,
        originOf: async () => ({
          creatorUserId: USER,
          creatorApiKeyId: null,
        }),
      },
    });
    expect(
      await policy.authorize({
        subject: web.subject,
        action: "session.approve",
        resource: { kind: "session", id: SESSION, owner_scope: web.ownerId },
        request_id: web.requestId,
      }),
    ).toMatchObject({ outcome: "allow" });
    expect(asked).toEqual([]);
  });

  test("a deployment with no usage reader opens every agent", async () => {
    const { agents: withReader } = authority(CLOSED);
    const { usageOf: _unused, ...agents } = withReader;
    expect(await policyOf(agents).authorize(starting())).toMatchObject({
      outcome: "allow",
    });
  });
});

describe("usageOfRelease", () => {
  test("names the release's agent and what the person may do with it", async () => {
    const { agents } = authority(CLOSED);
    expect(
      await policyOf(agents).usageOfRelease?.(web.subject, WORKSPACE, RELEASE),
    ).toEqual({ agentId: AGENT, usage: CLOSED });
  });

  test("is null for a release the workspace does not have", async () => {
    const { agents } = authority(CLOSED, { agentOfRelease: async () => null });
    expect(
      await policyOf(agents).usageOfRelease?.(web.subject, WORKSPACE, RELEASE),
    ).toBeNull();
  });

  test("is null for another workspace's partition", async () => {
    const { agents } = authority(CLOSED);
    expect(
      await policyOf(agents).usageOfRelease?.(web.subject, "other", RELEASE),
    ).toBeNull();
  });
});
