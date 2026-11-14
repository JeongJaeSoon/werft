import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "../shared/index.ts";
import {
  AGENT_SUMMARY_INSTRUCTIONS_MAX,
  type AgentCard,
  activateAgentRequestSchema,
  agentCardRequestSchema,
  agentCardSchema,
  agentListItemSchema,
  agentReleaseSchema,
  agentSchema,
  agentVersionSchema,
  behaviorKey,
  createAgentReleaseRequestSchema,
  createAgentRequestSchema,
  DEFAULT_TOOL_POLICY,
  draftAgentRequestSchema,
  listAgentsQuerySchema,
  listAgentsResponseSchema,
  policyPinsSchema,
  storedAgentCapabilitiesSchema,
  storedAgentCardSchema,
  updateAgentRequestSchema,
} from "./agents.ts";

const AGENT_ID = "019a0000-0000-7000-8000-0000000000a1";
const VERSION_ID = "019a0000-0000-7000-8000-0000000000a2";
const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000a3";
const TEAM = "019a0000-0000-7000-8000-0000000000a4";
const AT = "2026-09-22T01:00:00Z";
const PINS = {
  tools: {
    default: { builtin: "allow", mcp: "ask" },
    per_tool: { Read: "allow" },
  },
} as const;

const card = {
  role: "재무 분석가",
  instructions: "분기 보고서를 읽고 이상치를 요약한다.",
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
} satisfies Record<string, unknown>;

function cardHash(value: AgentCard): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

describe("canonical JSON", () => {
  test("sorts object keys so structurally equal values hash alike", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  test("keeps array order, because order is data", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("refuses values it cannot represent the same way twice", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(new Date(AT))).toThrow(TypeError);
    expect(() => canonicalJson({ nested: [1, undefined] })).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
  });

  test("refuses what JSON would drop on the floor", () => {
    // A hole serialises as `null`, so `[ , ]` and `[null]` would hash alike.
    // biome-ignore lint/suspicious/noSparseArray: that is the case under test
    expect(() => canonicalJson([, 1])).toThrow(TypeError);
    expect(() => canonicalJson(Array(1))).toThrow(TypeError);
    const withExtra = [1];
    (withExtra as unknown as Record<string, unknown>).note = "dropped";
    expect(() => canonicalJson(withExtra)).toThrow(TypeError);
    const key = Symbol("hidden");
    expect(() => canonicalJson({ a: 1, [key]: 2 })).toThrow(TypeError);
    // JSON.stringify(-0) is "0", so two values JavaScript tells apart would
    // hash alike — and identity is the whole job here.
    expect(Object.is(-0, 0)).toBe(false);
    expect(() => canonicalJson({ x: -0 })).toThrow(TypeError);
  });
});

describe("AgentCard", () => {
  test("hashes the same however the author ordered the keys", () => {
    const reordered = {
      capabilities: card.capabilities,
      model: card.model,
      instructions: card.instructions,
      role: card.role,
    };
    expect(cardHash(agentCardSchema.parse(reordered))).toBe(
      cardHash(agentCardSchema.parse(card)),
    );
  });

  test("changing any part of the card changes the hash", () => {
    const changed = { ...card, instructions: "다르게 행동한다." };
    expect(cardHash(agentCardSchema.parse(changed))).not.toBe(
      cardHash(agentCardSchema.parse(card)),
    );
    const forbidden = (names: string[]) => ({
      ...card,
      capabilities: { ...card.capabilities, forbidden: names },
    });
    expect(
      cardHash(agentCardSchema.parse(forbidden(["mcp__a__x", "mcp__a__y"]))),
    ).not.toBe(
      cardHash(agentCardSchema.parse(forbidden(["mcp__a__y", "mcp__a__x"]))),
    );
  });

  test("an omitted default hashes like the value spelled out", () => {
    expect(
      cardHash(agentCardSchema.parse({ ...card, language: "follow-user" })),
    ).toBe(cardHash(agentCardSchema.parse(card)));
    expect(
      cardHash(agentCardSchema.parse({ ...card, language: "en" })),
    ).not.toBe(cardHash(agentCardSchema.parse(card)));
  });

  test("an unset optional stays absent rather than becoming undefined", () => {
    // canonicalJson throws on undefined, so a parser that materialised the key
    // would fail the hash outright instead of quietly re-hashing every card.
    const parsed = agentCardSchema.parse(card);
    expect(Object.hasOwn(parsed.capabilities, "tool_policy")).toBe(false);
    expect(parsed.language).toBe("follow-user");
    expect(parsed.rules).toEqual([]);
  });

  test("a new card cannot carry a tone", () => {
    const withTone = { ...card, tone: "공손하게" };
    expect(agentCardSchema.safeParse(withTone).success).toBe(false);
    expect(
      createAgentRequestSchema.safeParse({
        slug: "finance",
        name: "Finance",
        card: withTone,
      }).success,
    ).toBe(false);
    expect(updateAgentRequestSchema.safeParse({ card: withTone }).success).toBe(
      false,
    );
  });

  test("a stored card with a tone reads without it", () => {
    const stored = storedAgentCardSchema.parse({ ...card, tone: "공손하게" });
    expect(Object.hasOwn(stored, "tone")).toBe(false);
    expect(stored).toEqual(agentCardSchema.parse(card));
    expect(storedAgentCardSchema.parse(card)).toEqual(
      agentCardSchema.parse(card),
    );
    expect(
      storedAgentCardSchema.safeParse({ ...card, api_key: "x" }).success,
    ).toBe(false);
  });

  describe("a card from before the built-in tool fields were dropped", () => {
    const old = {
      ...card,
      capabilities: {
        tools: ["Read", "Grep"],
        mcp: [{ server: "docs" }],
        forbidden: ["Bash", "mcp__docs__delete"],
        tool_policy: {
          default: { builtin: "deny", mcp: "deny" },
          per_tool: { Read: "ask", mcp__docs__search: "allow" },
        },
        credential_refs: ["docs"],
      },
    };
    const current = {
      ...card,
      capabilities: {
        mcp: [{ server: "docs" }],
        forbidden: ["mcp__docs__delete"],
        tool_policy: { per_tool: { mcp__docs__search: "allow" } },
        credential_refs: ["docs"],
      },
    };

    test("a request with the old fields is accepted and keeps only MCP entries", () => {
      const parsed = agentCardRequestSchema.parse(old);
      expect(parsed).toEqual(agentCardSchema.parse(current));
      expect(Object.hasOwn(parsed.capabilities, "tools")).toBe(false);
      expect(
        createAgentRequestSchema.shape.card.parse(old).capabilities,
      ).toEqual(parsed.capabilities);
    });

    test("a request whose old fields held nothing for MCP has no policy at all", () => {
      const parsed = agentCardRequestSchema.parse({
        ...card,
        capabilities: {
          tools: null,
          mcp: null,
          forbidden: ["Bash"],
          tool_policy: {
            default: { builtin: "ask" },
            per_tool: { Read: "ask" },
          },
        },
      });
      expect(parsed).toEqual(agentCardSchema.parse(card));
      expect(Object.hasOwn(parsed.capabilities, "tool_policy")).toBe(false);
    });

    test("what is wrong besides the dropped fields is still refused", () => {
      for (const capabilities of [
        { ...old.capabilities, mcp: [] },
        { ...old.capabilities, extra: true },
        {
          ...old.capabilities,
          tool_policy: { per_tool: { mcp__docs__search: "auto" } },
        },
        { ...old.capabilities, tool_policy: "allow" },
        {
          ...old.capabilities,
          tool_policy: { per_tools: { mcp__docs__search: "deny" } },
        },
        { ...old.capabilities, forbidden: "Bash" },
      ]) {
        expect(
          agentCardRequestSchema.safeParse({ ...card, capabilities }).success,
        ).toBe(false);
      }
      expect(
        agentCardRequestSchema.safeParse({ ...old, api_key: "x" }).success,
      ).toBe(false);
    });

    test("a stored card reads without them, and its stored JSON is not touched", () => {
      const before = canonicalJson(old);
      expect(storedAgentCardSchema.parse(old)).toEqual(
        agentCardSchema.parse(current),
      );
      expect(canonicalJson(old)).toBe(before);
      expect(storedAgentCapabilitiesSchema.parse(old.capabilities)).toEqual(
        agentCardSchema.parse(current).capabilities,
      );
    });

    test("the request schema documents the new shape", () => {
      const schema = z.toJSONSchema(createAgentRequestSchema, { io: "input" });
      const body = JSON.stringify(schema);
      expect(body).toContain('"credential_refs"');
      expect(body).not.toContain('"tools"');
      expect(body).not.toContain('"builtin"');
    });
  });

  test("has nowhere to put a credential", () => {
    expect(
      agentCardSchema.safeParse({ ...card, api_key: "sk-live-example" })
        .success,
    ).toBe(false);
    expect(
      agentCardSchema.safeParse({
        ...card,
        capabilities: { ...card.capabilities, token: "t" },
      }).success,
    ).toBe(false);
  });

  test("rejects an empty or oversized card body", () => {
    expect(
      agentCardSchema.safeParse({ ...card, instructions: "" }).success,
    ).toBe(false);
    expect(
      agentCardSchema.safeParse({ ...card, instructions: "a".repeat(20_001) })
        .success,
    ).toBe(false);
    expect(agentCardSchema.safeParse({ ...card, model: "" }).success).toBe(
      false,
    );
  });

  test("holds no built-in tool field: the runtime decides the tools", () => {
    const parsed = agentCardSchema.safeParse({
      ...card,
      capabilities: { ...card.capabilities, tools: ["Read"] },
    });
    expect(parsed.success).toBe(false);
    for (const capabilities of [
      { ...card.capabilities, forbidden: ["Bash"] },
      {
        ...card.capabilities,
        tool_policy: { per_tool: { Read: "allow" } },
      },
      {
        ...card.capabilities,
        tool_policy: { default: { mcp: "deny" }, per_tool: {} },
      },
    ]) {
      expect(agentCardSchema.safeParse({ ...card, capabilities }).success).toBe(
        false,
      );
    }
  });

  test("names at most one catalog MCP server, and null for none", () => {
    expect(
      agentCardSchema.safeParse({
        ...card,
        capabilities: { mcp: [{ server: "notion" }], forbidden: [] },
      }).success,
    ).toBe(true);
    for (const mcp of [
      [],
      ["notion"],
      [{ server: "notion" }, { server: "fake" }],
      [{ server: "a__b" }],
      [{ server: "notion", url: "https://x.test" }],
    ]) {
      expect(
        agentCardSchema.safeParse({
          ...card,
          capabilities: { mcp, forbidden: [] },
        }).success,
      ).toBe(false);
    }
  });

  test("carries approved rules with their provenance", () => {
    const withRules = agentCardSchema.parse({
      ...card,
      rules: [
        { id: "r1", text: "수치는 항상 출처를 단다.", source: "correction" },
      ],
    });
    expect(withRules.rules[0]?.source).toBe("correction");
    expect(
      agentCardSchema.safeParse({
        ...card,
        rules: [{ id: "r1", text: "x", source: "model" }],
      }).success,
    ).toBe(false);
  });
});

describe("credential names", () => {
  const withRefs = (credential_refs: unknown) => ({
    ...card,
    capabilities: { ...card.capabilities, credential_refs },
  });

  test("a card without them keeps the hash it had before they existed", () => {
    const parsed = agentCardSchema.parse(card);
    expect("credential_refs" in parsed.capabilities).toBe(false);
  });

  test("a card names the credentials it runs with, and naming them is a new version", () => {
    const parsed = agentCardSchema.parse(
      withRefs(["slack_bot_token", "mcp:notion/workspace-1"]),
    );
    expect(parsed.capabilities.credential_refs).toEqual([
      "slack_bot_token",
      "mcp:notion/workspace-1",
    ]);
    expect(cardHash(parsed)).not.toBe(cardHash(agentCardSchema.parse(card)));
  });

  test("a name is a lowercase reference, never a value, and named once", () => {
    for (const refs of [
      ["Slack_Bot"],
      ["xoxb 123"],
      ["-leading"],
      ["x".repeat(129)],
      [""],
      ["dup", "dup"],
      Array.from({ length: 33 }, (_, i) => `ref-${i}`),
    ]) {
      expect(agentCardSchema.safeParse(withRefs(refs)).success).toBe(false);
    }
  });
});

describe("behaviorKey", () => {
  const key = (capabilities: Record<string, unknown>) =>
    behaviorKey(
      agentCardSchema.parse({ ...card, capabilities }),
      "claude-sonnet-5",
      "coding",
    );
  const base = { mcp: null, forbidden: [] };

  test("keeps MCP policy entries and forbidden MCP tools", () => {
    const mcp = { ...base, tool_policy: { per_tool: { mcp__a__b: "allow" } } };
    expect(key(mcp)).not.toBe(key(base));
    expect(key({ ...base, forbidden: ["mcp__a__b"] })).not.toBe(key(base));
  });
});

describe("tool policy", () => {
  test("defaults to built-in allow and MCP ask", () => {
    expect(DEFAULT_TOOL_POLICY).toEqual({ builtin: "allow", mcp: "ask" });
  });

  test("a card without a tool policy keeps the hash it had before one existed", () => {
    const parsed = agentCardSchema.parse(card);
    expect("tool_policy" in parsed.capabilities).toBe(false);
  });

  test("a card names allow, ask or deny per MCP tool and nothing else", () => {
    const parsed = agentCardSchema.parse({
      ...card,
      capabilities: {
        ...card.capabilities,
        tool_policy: {
          per_tool: { mcp__docs__read: "ask", mcp__docs__search: "deny" },
        },
      },
    });
    expect(parsed.capabilities.tool_policy?.per_tool.mcp__docs__read).toBe(
      "ask",
    );
    for (const tool_policy of [
      { per_tool: { mcp__docs__read: "auto" } },
      { per_tool: { Read: "allow" } },
      { default: { mcp: "deny" }, per_tool: {} },
      { per_tool: {}, rules: [] },
    ]) {
      expect(
        agentCardSchema.safeParse({
          ...card,
          capabilities: { ...card.capabilities, tool_policy },
        }).success,
      ).toBe(false);
    }
  });

  test("a release pins both defaults and a policy per tool", () => {
    expect(policyPinsSchema.parse(PINS)).toEqual(PINS);
    // A release stored before tool policies existed still reads.
    expect(policyPinsSchema.parse({})).toEqual({});
    for (const pins of [
      { tools: {} },
      { tools: { per_tool: { Read: "allow" } } },
      { tools: { default: { builtin: "allow" }, per_tool: {} } },
      { tools: { ...PINS.tools, per_tool: { Read: "maybe" } } },
      { ...PINS, extra: true },
    ]) {
      expect(policyPinsSchema.safeParse(pins).success).toBe(false);
    }
  });
});

describe("agent, version and release", () => {
  test("names the agent on the row, not inside the immutable card", () => {
    expect(Object.hasOwn(agentCardSchema.parse(card), "name")).toBe(false);
    const agent = agentSchema.parse({
      id: AGENT_ID,
      workspace_id: WORKSPACE_ID,
      slug: "finance-analyst",
      name: "재무 분석가",
      description: null,
      managing_team_id: TEAM,
      managing_team_name: "Finance",
      status: "active",
      active_release_id: null,
      activation_revision: -1,
      auto_model_migration: true,
      created_by: null,
      created_at: AT,
      updated_at: AT,
    });
    expect(agent.activation_revision).toBe(-1);
    expect(
      agentSchema.safeParse({ ...agent, activation_revision: -2 }).success,
    ).toBe(false);
    expect(agentSchema.safeParse({ ...agent, team: "finance" }).success).toBe(
      false,
    );
    expect(
      agentSchema.safeParse({ ...agent, slug: "Finance Analyst" }).success,
    ).toBe(false);
    expect(agentSchema.safeParse({ ...agent, status: "deleted" }).success).toBe(
      false,
    );
  });

  test("a version pins the card by hash", () => {
    const version = agentVersionSchema.parse({
      id: VERSION_ID,
      agent_id: AGENT_ID,
      version_no: 1,
      card,
      content_sha256: cardHash(agentCardSchema.parse(card)),
      created_by: null,
      created_at: AT,
    });
    expect(version.content_sha256).toHaveLength(64);
    expect(
      agentVersionSchema.safeParse({ ...version, content_sha256: "nothex" })
        .success,
    ).toBe(false);
    expect(
      agentVersionSchema.safeParse({ ...version, version_no: 0 }).success,
    ).toBe(false);
  });

  test("a release carries the resolved runtime config, never a credential value", () => {
    const release = agentReleaseSchema.parse({
      id: "rel_9f2c",
      agent_id: AGENT_ID,
      version_id: VERSION_ID,
      card_sha256: "a".repeat(64),
      connection_id: "fake-messages",
      repository_id: null,
      runtime_config_snapshot: {
        model: "claude-sonnet-5",
        api_key_ref: "env:KEY",
      },
      effective_tools: { tools: ["Read"], mcp: [] },
      policy_pins: PINS,
      created_by: null,
      created_at: AT,
      approved_by: null,
      approved_at: null,
      label: "2026-10-30_14:30:28",
      activated_at: null,
      deactivated_at: null,
    });
    expect(release.effective_tools.tools).toEqual(["Read"]);
    for (const [label, ok] of [
      ["2026-10-30_14:30:28-2", true],
      ["2026-10-30_14:30:28-12", true],
      ["2026-10-30_14:30:28-1", false],
      ["2026-10-30 14:30:28", false],
      ["v1", false],
    ] as const) {
      expect(agentReleaseSchema.safeParse({ ...release, label }).success).toBe(
        ok,
      );
    }
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        effective_tools: { tools: [] },
      }).success,
    ).toBe(false);
    expect(
      agentReleaseSchema.safeParse({ ...release, note: null }).success,
    ).toBe(false);
  });

  test("a release carries no pull request settings: the request is strict, so they are refused, not dropped", () => {
    const request = (extra: object) =>
      createAgentReleaseRequestSchema.safeParse({
        version_id: VERSION_ID,
        connection_id: "fake-messages",
        ...extra,
      });
    expect(request({}).success).toBe(true);
    for (const key of [
      "pull_request",
      "pull_request_template",
      "formatting",
      "template",
      "template_name",
    ]) {
      expect(
        request({
          [key]: { formatting: "off", template: null, template_name: null },
        }).success,
      ).toBe(false);
    }
  });

  test("a release request carrying a note is refused", () => {
    const request = (extra: Record<string, unknown>) =>
      createAgentReleaseRequestSchema.safeParse({
        version_id: VERSION_ID,
        connection_id: "fake-messages",
        ...extra,
      }).success;
    expect(request({})).toBe(true);
    expect(request({ note: "hotfix" })).toBe(false);
    expect(request({ note: null })).toBe(false);
  });

  test("a release snapshot has no room for a live credential", () => {
    const release = {
      id: "rel_9f2c",
      agent_id: AGENT_ID,
      version_id: VERSION_ID,
      card_sha256: "a".repeat(64),
      connection_id: "fake-messages",
      repository_id: null,
      runtime_config_snapshot: { model: "claude-sonnet-5" },
      effective_tools: { tools: ["Read"], mcp: [] },
      policy_pins: PINS,
      created_by: null,
      created_at: AT,
      approved_by: null,
      approved_at: null,
      label: "2026-10-30_14:30:28",
      activated_at: null,
      deactivated_at: null,
    };
    // This is the repository's own ClaudeRuntimeConfig shape: handing a
    // resolved runtime config straight to the release used to persist the key.
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        runtime_config_snapshot: {
          endpoint: "https://api.anthropic.com",
          profile: { kind: "anthropic", auth: { kind: "api_key", value: "x" } },
        },
      }).success,
    ).toBe(false);
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        runtime_config_snapshot: { headers: [{ authorization: "Bearer x" }] },
      }).success,
    ).toBe(false);
    // A resolved MCP environment hides live values behind names no word list
    // can recognise, so the container itself has no place in a release.
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        runtime_config_snapshot: {
          mcpServers: { notion: { env: { NOTION_API: "live-value" } } },
        },
      }).success,
    ).toBe(false);
    // The names that actually appear in a runtime config are compound.
    for (const key of [
      "api_key",
      "apiKey",
      "client_secret",
      "signing_secret",
      "botToken",
      "secretAccessKey",
      "private_key",
    ]) {
      expect(
        agentReleaseSchema.safeParse({
          ...release,
          runtime_config_snapshot: { [key]: "x" },
        }).success,
      ).toBe(false);
    }
    // An acronym must not swallow the word after it.
    for (const key of ["APIKey", "JWTToken", "AWSSecretKey"]) {
      expect(
        agentReleaseSchema.safeParse({
          ...release,
          runtime_config_snapshot: { [key]: "x" },
        }).success,
      ).toBe(false);
    }
    // A reference is how a credential is meant to travel, and naming the
    // scheme is not holding it.
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        runtime_config_snapshot: {
          api_key_ref: "env:ANTHROPIC_API_KEY",
          auth_kind: "api_key",
        },
      }).success,
    ).toBe(true);
    // The `_ref` suffix is an exemption from the word scan, so the value has
    // to actually be a reference — otherwise it is the easiest way through.
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        runtime_config_snapshot: { api_key_ref: "sk-live-example" },
      }).success,
    ).toBe(false);
  });

  test("a release snapshot must be hashable, since its id is the hash", () => {
    const release = {
      id: "rel_9f2c",
      agent_id: AGENT_ID,
      version_id: VERSION_ID,
      card_sha256: "a".repeat(64),
      connection_id: "fake-messages",
      repository_id: null,
      runtime_config_snapshot: { model: "claude-sonnet-5" },
      effective_tools: { tools: ["Read"], mcp: [] },
      policy_pins: PINS,
      created_by: null,
      created_at: AT,
      approved_by: null,
      approved_at: null,
      label: "2026-10-30_14:30:28",
      activated_at: null,
      deactivated_at: null,
    };
    // A snapshot canonicalJson refuses is a release that parses and then has
    // no identity, so the two rules have to be the same rule.
    for (const snapshot of [
      { released_at: new Date(AT) },
      { retries: 10n },
      { nested: [1, undefined] },
      { limit: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        agentReleaseSchema.safeParse({
          ...release,
          runtime_config_snapshot: snapshot,
        }).success,
      ).toBe(false);
    }
  });

  test("activation is a compare-and-swap on the agent's revision", () => {
    expect(
      activateAgentRequestSchema.parse({
        release_id: "sha256:abc",
        expected_revision: -1,
      }).expected_revision,
    ).toBe(-1);
    expect(
      activateAgentRequestSchema.safeParse({ release_id: "sha256:abc" })
        .success,
    ).toBe(false);
    expect(
      activateAgentRequestSchema.safeParse({
        release_id: "sha256:abc",
        expected_revision: -2,
      }).success,
    ).toBe(false);
  });

  test("request bodies stay closed and never empty", () => {
    expect(
      createAgentRequestSchema.safeParse({
        slug: "finance-analyst",
        name: "재무 분석가",
        managing_team_id: TEAM,
        card,
      }).success,
    ).toBe(true);
    expect(
      createAgentRequestSchema.safeParse({
        slug: "finance-analyst",
        name: "재무 분석가",
        managing_team_id: TEAM,
      }).success,
    ).toBe(false);
    expect(
      createAgentRequestSchema.safeParse({
        slug: "finance-analyst",
        name: "재무 분석가",
        card,
      }).error?.issues,
    ).toMatchObject([
      { path: ["managing_team_id"], message: "managing_team_id is required" },
    ]);
    expect(updateAgentRequestSchema.safeParse({}).success).toBe(false);
    expect(updateAgentRequestSchema.safeParse({ team: null }).success).toBe(
      false,
    );
    expect(updateAgentRequestSchema.safeParse({ card }).success).toBe(true);
    expect(draftAgentRequestSchema.safeParse({ prompt: "" }).success).toBe(
      false,
    );
  });

  test("a description is the row's: up to 2000 characters, null clears it on update", () => {
    const create = (description: unknown) =>
      createAgentRequestSchema.safeParse({
        slug: "finance-analyst",
        name: "재무 분석가",
        description,
        managing_team_id: TEAM,
        card,
      }).success;
    expect(create("x".repeat(2000))).toBe(true);
    expect(create("")).toBe(true);
    expect(create("x".repeat(2001))).toBe(false);
    expect(create("a\u0000b")).toBe(false);
    expect(create(null)).toBe(false);
    expect(
      updateAgentRequestSchema.safeParse({ description: null }).success,
    ).toBe(true);
    expect(
      updateAgentRequestSchema.safeParse({ description: "x".repeat(2001) })
        .success,
    ).toBe(false);
  });
});

describe("card read and request shapes", () => {
  const { role: _role, instructions: _instructions, ...bare } = card;

  test("a stored card reads without role and instructions, and drops the retired agent_instructions key", () => {
    expect(storedAgentCardSchema.parse(bare)).toMatchObject({
      model: card.model,
    });
    for (const retired of ["Answer in Korean.", "", "x".repeat(20_001)]) {
      const read = storedAgentCardSchema.parse({
        ...bare,
        agent_instructions: retired,
      });
      expect(read).toEqual(storedAgentCardSchema.parse(bare));
      expect("agent_instructions" in read).toBe(false);
    }
    // The strict card schema itself no longer knows the key.
    expect(
      agentCardSchema.safeParse({ ...bare, agent_instructions: "x" }).success,
    ).toBe(false);
  });

  // Writing this shape waited for the rollback floor (bc5f14ad): every image
  // since reads a card without role and instructions.
  test("a request writes the read shape, and an edit may send a stored card back", () => {
    const body = (requestCard: unknown) => ({
      slug: "finance-analyst",
      name: "재무 분석가",
      managing_team_id: TEAM,
      card: requestCard,
    });
    expect(createAgentRequestSchema.safeParse(body(bare)).success).toBe(true);
    // A client from before the field was retired may still send it: the key is
    // dropped, never stored.
    const sentOld = createAgentRequestSchema.parse(
      body({ ...bare, agent_instructions: "Answer in Korean." }),
    );
    expect(sentOld.card).toEqual(
      createAgentRequestSchema.parse(body(bare)).card,
    );
    expect("agent_instructions" in sentOld.card).toBe(false);
    expect(
      updateAgentRequestSchema.safeParse({
        card: { ...card, agent_instructions: "x".repeat(20_001) },
      }).success,
    ).toBe(true);
    expect(
      updateAgentRequestSchema.safeParse({ card: { ...card, secret: "x" } })
        .success,
    ).toBe(false);
  });
});

describe("agent list summary", () => {
  const agent = {
    id: AGENT_ID,
    workspace_id: WORKSPACE_ID,
    slug: "finance-analyst",
    name: "재무 분석가",
    description: "분기 보고서를 읽는다",
    managing_team_id: TEAM,
    managing_team_name: "Finance",
    status: "active",
    active_release_id: null,
    activation_revision: -1,
    auto_model_migration: true,
    created_by: null,
    created_at: AT,
    updated_at: AT,
  } as const;
  const summary = {
    version: {
      version_no: 1,
      role: card.role,
      instructions: card.instructions,
      mcp_servers: [],
      credential_refs: ["github"],
    },
    connection_id: null,
    release_label: null,
    release_model: null,
    bound_credential_refs: [],
    admins: ["Kim"],
    needs_input_count: 1,
    running_count: 2,
    slack_action: "home_unset" as const,
  };

  test("is asked for, and a page without it is the agents as before", () => {
    expect(listAgentsQuerySchema.parse({ limit: 50 })).toEqual({ limit: 50 });
    expect(
      listAgentsQuerySchema.parse({ limit: 50, include: "summary" }).include,
    ).toBe("summary");
    expect(
      listAgentsQuerySchema.safeParse({ limit: 50, include: "detail" }).success,
    ).toBe(false);
    const page = { items: [agent], next_cursor: null };
    expect(listAgentsResponseSchema.parse(page)).toEqual(page);
    expect(
      agentSchema.parse(listAgentsResponseSchema.parse(page).items[0]),
    ).toEqual(agent);
  });

  test("carries a clipped card, never the whole one", () => {
    expect(agentListItemSchema.parse({ ...agent, summary })).toEqual({
      ...agent,
      summary,
    });
    const long = "가".repeat(AGENT_SUMMARY_INSTRUCTIONS_MAX + 1);
    expect(
      agentListItemSchema.safeParse({
        ...agent,
        summary: {
          ...summary,
          version: { ...summary.version, instructions: long },
        },
      }).success,
    ).toBe(false);
    expect(
      agentListItemSchema.safeParse({
        ...agent,
        summary: { ...summary, version: { ...summary.version, card } },
      }).success,
    ).toBe(false);
    expect(
      agentListItemSchema.safeParse({
        ...agent,
        summary: { ...summary, key: "x" },
      }).success,
    ).toBe(false);
  });
});
