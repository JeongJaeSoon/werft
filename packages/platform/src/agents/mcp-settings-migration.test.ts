import { describe, expect, test } from "bun:test";
import { mcpValuesOfCard } from "./mcp-release-values.ts";
import {
  copyValuesOf,
  type McpMigrationFact,
  planMcpSettingsMigration,
} from "./mcp-settings-migration.ts";

const card = (
  server: string | null,
  refs: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  capabilities: {
    mcp: server === null ? null : [{ server }],
    credential_refs: refs,
    forbidden: [],
    ...extra,
  },
});

const pins = (per_tool: Record<string, string>) => ({ tools: { per_tool } });

const fact = (
  id: string,
  over: Partial<McpMigrationFact> = {},
): McpMigrationFact => ({
  workspace_id: "w1",
  agent_id: id,
  name: id,
  has_row: false,
  active: null,
  draft_card: null,
  ...over,
});

describe("the values a release carries", () => {
  test("allow pins of the card's server become the tools; ask, deny and forbidden are only counted", () => {
    const values = mcpValuesOfCard(
      card("docs", ["b-key", "docs-key", "b-key"], {
        forbidden: ["mcp__docs__drop", "Bash"],
      }),
      pins({
        mcp__docs__search: "allow",
        mcp__docs__read: "allow",
        mcp__docs__write: "ask",
        mcp__docs__drop: "deny",
        mcp__other__read: "allow",
        Read: "allow",
      }),
    );
    expect(values).toEqual({
      server: "docs",
      allowedTools: ["mcp__docs__read", "mcp__docs__search"],
      credentialRefs: ["b-key", "docs-key"],
      askCount: 1,
      denyCount: 1,
      forbiddenCount: 1,
    });
  });

  test("a card without a server still carries its credential names", () => {
    expect(mcpValuesOfCard(card(null, ["k"]), pins({}))).toMatchObject({
      server: null,
      allowedTools: [],
      credentialRefs: ["k"],
    });
  });

  test("garbage reads as nothing", () => {
    expect(mcpValuesOfCard(null, undefined).server).toBeNull();
    expect(mcpValuesOfCard({ capabilities: 3 }, 4).credentialRefs).toEqual([]);
  });
});

describe("the migration plan", () => {
  const active = (server: string | null, refs: string[], per: object = {}) => ({
    card: card(server, refs),
    policy_pins: pins(per as Record<string, string>),
  });

  test("copies an active release's values and counts what a row cannot carry, per agent", () => {
    const plan = planMcpSettingsMigration({
      includeDrafts: false,
      facts: [
        fact("a2", {
          active: active("docs", ["docs-key"], {
            mcp__docs__read: "allow",
            mcp__docs__a: "ask",
            mcp__docs__b: "ask",
            mcp__docs__c: "deny",
          }),
        }),
        fact("a1", {
          active: active("wiki", ["wiki-key"], { mcp__wiki__read: "allow" }),
        }),
      ],
    });
    expect(plan.agents.map((entry) => entry.agent_id)).toEqual(["a1", "a2"]);
    expect(plan.agents[1]).toMatchObject({
      decision: "copy",
      source: "active_release",
      server: "docs",
      allowed_tools: ["mcp__docs__read"],
      ask_count: 2,
      deny_count: 1,
    });
    expect(plan.totals).toMatchObject({
      copy: 2,
      ask_total: 2,
      deny_total: 1,
    });
  });

  test("an agent with a row is left; an agent with nothing to move says so", () => {
    const plan = planMcpSettingsMigration({
      includeDrafts: false,
      facts: [
        fact("a1", { has_row: true, active: active("docs", ["k"]) }),
        fact("a2", { active: active(null, []) }),
      ],
    });
    expect(plan.agents.map((entry) => entry.skip_reason)).toEqual([
      "has_row",
      "nothing_to_move",
    ]);
    expect(plan.totals).toMatchObject({
      copy: 0,
      has_row: 1,
      nothing_to_move: 1,
    });
  });

  test("a draft moves only when asked, and takes the card's own tool policy", () => {
    const draft = fact("d1", {
      draft_card: card("docs", ["docs-key"], {
        tool_policy: { per_tool: { mcp__docs__read: "allow" } },
      }),
    });
    const without = planMcpSettingsMigration({
      includeDrafts: false,
      facts: [draft],
    });
    expect(without.agents[0]).toMatchObject({
      decision: "skip",
      skip_reason: "draft_not_included",
      source: "draft_card",
    });
    const included = planMcpSettingsMigration({
      includeDrafts: true,
      facts: [draft],
    });
    expect(included.agents[0]).toMatchObject({
      decision: "copy",
      allowed_tools: ["mcp__docs__read"],
    });
    expect(included.include_drafts).toBe(true);
  });

  test("a credential-only agent is copied with no server", () => {
    const plan = planMcpSettingsMigration({
      includeDrafts: false,
      facts: [fact("a1", { active: active(null, ["only-key"]) })],
    });
    expect(plan.agents[0]).toMatchObject({
      decision: "copy",
      server: null,
      allowed_tools: [],
      credential_refs: ["only-key"],
    });
  });

  test("values a row's constraints would refuse are reported, not copied", () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `key-${i}`);
    const long = `mcp__docs__${"x".repeat(130)}`;
    const plan = planMcpSettingsMigration({
      includeDrafts: false,
      facts: [
        fact("a1", { active: active("docs", tooMany) }),
        fact("a2", { active: active("docs", ["k"], { [long]: "allow" }) }),
        fact("a3", { active: active("Bad Server", ["k"]) }),
      ],
    });
    expect(plan.agents.map((entry) => entry.skip_reason)).toEqual([
      "invalid_value",
      "invalid_value",
      "invalid_value",
    ]);
    expect(plan.totals.invalid_value).toBe(3);
  });

  test("the same facts give the same bytes, and the compare key ignores names and counts", () => {
    const facts = [fact("a1", { active: active("docs", ["k"]) })];
    const first = planMcpSettingsMigration({ includeDrafts: false, facts });
    const second = planMcpSettingsMigration({ includeDrafts: false, facts });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const renamed = planMcpSettingsMigration({
      includeDrafts: false,
      facts: [{ ...(facts[0] as McpMigrationFact), name: "other" }],
    });
    expect(copyValuesOf(renamed.agents[0] as never)).toBe(
      copyValuesOf(first.agents[0] as never),
    );
  });
});
