import { describe, expect, test } from "bun:test";
import {
  AGENT_USAGE_TEAM_MAX,
  agentUsageSchema,
  putAgentUsageRequestSchema,
} from "./agent-usage.ts";

const TEAM = "019a0000-0000-7000-8000-00000000b0a1";
const OTHER = "019a0000-0000-7000-8000-00000000b0a2";

describe("putAgentUsageRequestSchema", () => {
  test("a private agent names teams, a workspace agent none", () => {
    expect(
      putAgentUsageRequestSchema.safeParse({
        scope: "private",
        teams: [{ id: TEAM }, { id: OTHER }],
      }).success,
    ).toBe(true);
    expect(
      putAgentUsageRequestSchema.safeParse({ scope: "workspace", teams: [] })
        .success,
    ).toBe(true);
    expect(
      putAgentUsageRequestSchema.safeParse({ scope: "private", teams: [] })
        .success,
    ).toBe(false);
    expect(
      putAgentUsageRequestSchema.safeParse({
        scope: "workspace",
        teams: [{ id: TEAM }],
      }).success,
    ).toBe(false);
  });

  test("refuses a repeated team, another scope, a person target and too many teams", () => {
    const parse = (value: unknown) =>
      putAgentUsageRequestSchema.safeParse(value).success;
    expect(
      parse({
        scope: "private",
        teams: [{ id: TEAM }, { id: TEAM.toUpperCase() }],
      }),
    ).toBe(false);
    expect(parse({ scope: "team", teams: [{ id: TEAM }] })).toBe(false);
    expect(
      parse({ scope: "private", teams: [{ id: TEAM, user_id: TEAM }] }),
    ).toBe(false);
    expect(parse({ scope: "private", teams: [{ user_id: TEAM }] })).toBe(false);
    const many = Array.from({ length: AGENT_USAGE_TEAM_MAX + 1 }, (_, i) => ({
      id: `019a0000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    }));
    expect(parse({ scope: "private", teams: many })).toBe(false);
  });
});

describe("agentUsageSchema", () => {
  test("carries the revision the next edit sends", () => {
    expect(
      agentUsageSchema.parse({
        scope: "private",
        teams: [{ id: TEAM, name: "research" }],
        revision: 2,
      }).revision,
    ).toBe(2);
    expect(
      agentUsageSchema.safeParse({
        scope: "private",
        teams: [],
        revision: 0,
      }).success,
    ).toBe(false);
  });
});
