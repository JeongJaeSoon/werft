import { describe, expect, test } from "bun:test";
import { decideUsage, type UsageFacts } from "./agent-usage-decision.ts";

const none: UsageFacts = {
  scope: "private",
  agentKey: false,
  personless: false,
  workspaceManager: false,
  directAdmin: false,
  usageTeams: [],
  adminTeams: [],
  managingLead: null,
  managingMember: null,
};

describe("decideUsage", () => {
  test("a workspace agent is open, a service key without a person included", () => {
    expect(
      decideUsage({ ...none, scope: "workspace", personless: true }),
    ).toEqual({ allowed: true, basis: "public", teamId: null });
  });

  test("a private agent refuses a person with no grant", () => {
    expect(decideUsage(none)).toEqual({ allowed: false });
  });

  test("a service key with no agent refuses a private agent, whatever else is true", () => {
    expect(
      decideUsage({ ...none, personless: true, workspaceManager: true }),
    ).toEqual({ allowed: false });
  });

  test("each basis passes, in the recorded order", () => {
    expect(decideUsage({ ...none, agentKey: true })).toEqual({
      allowed: true,
      basis: "agent_key",
      teamId: null,
    });
    expect(
      decideUsage({
        ...none,
        usageTeams: ["b", "a"],
        workspaceManager: true,
        directAdmin: true,
        managingMember: "m",
      }),
    ).toEqual({ allowed: true, basis: "team", teamId: "a" });
    expect(
      decideUsage({ ...none, workspaceManager: true, directAdmin: true }),
    ).toEqual({ allowed: true, basis: "workspace", teamId: null });
    expect(decideUsage({ ...none, directAdmin: true })).toEqual({
      allowed: true,
      basis: "agent_admin",
      teamId: null,
    });
    expect(decideUsage({ ...none, adminTeams: ["t2", "t1"] })).toEqual({
      allowed: true,
      basis: "agent_admin",
      teamId: "t1",
    });
    expect(
      decideUsage({ ...none, managingLead: "m", managingMember: "m" }),
    ).toEqual({ allowed: true, basis: "agent_admin", teamId: "m" });
    expect(decideUsage({ ...none, managingMember: "m" })).toEqual({
      allowed: true,
      basis: "manager",
      teamId: "m",
    });
  });
});
