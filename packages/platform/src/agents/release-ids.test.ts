import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  type AgentRelease,
  agentCardSchema,
  agentReleaseSchema,
  storedAgentCardSchema,
} from "@werft-ai/contracts";
import { testConnection } from "../testing/catalog-fakes.ts";
import {
  assertReleaseIdentity,
  cardContentSha256,
  deriveReleaseId,
  type ReleaseIdentity,
  ReleaseIdentityError,
  type ReleaseRun,
  resolveReleaseContent,
} from "./release-ids.ts";

const AGENT_ID = "019a0000-0000-7000-8000-0000000000a1";
// Taken independently: sha256 of the canonical JSON of the v5 shape.
const PINNED_V5 =
  "sha256:38b426bd4dd9ca9bd1727baf8176727b4f05410cc3876072fe8fbe8297281905";
const VERSION_ID = "019a0000-0000-7000-8000-0000000000a2";
const USER_A = "019a0000-0000-7000-8000-0000000000b1";
const USER_B = "019a0000-0000-7000-8000-0000000000b2";

const run: ReleaseRun = {
  connection_id: "conn-1",
  connection: testConnection({
    provider: {
      kind: "litellm",
      endpoint: "https://litellm.invalid",
      auth: {
        kind: "api_key",
        value: "catalog-provider-key",
        ref: { value_env: "PROVIDER_KEY" },
      },
    },
    models: ["claude-sonnet-5", "claude-opus-5"],
  }),
  runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
  tools: ["Read", "Grep", "Edit", "Bash"],
  permission_mode: "default",
  project_settings: { claude_md: false },
};

const card: AgentCard = agentCardSchema.parse({
  role: "재무 분석가",
  instructions: "분기 보고서를 읽고 이상치를 요약한다.",
  // Spelled out: the pinned digests below were taken with `ko`, not the default.
  language: "ko",
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
});

function identityOf(
  value: AgentCard = card,
  against: ReleaseRun = run,
): ReleaseIdentity {
  const resolved = resolveReleaseContent(value, against);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return {
    agent_id: AGENT_ID,
    card_sha256: cardContentSha256(value),
    repository_id: null,
    ...resolved.content,
  };
}

function releaseOf(identity: ReleaseIdentity): AgentRelease {
  return agentReleaseSchema.parse({
    id: deriveReleaseId(identity),
    version_id: VERSION_ID,
    created_by: USER_A,
    created_at: "2026-10-11T00:00:00.000Z",
    approved_by: null,
    approved_at: null,
    note: null,
    label: "2026-10-11_09:00:00",
    activated_at: null,
    deactivated_at: null,
    ...identity,
  });
}

describe("deriveReleaseId", () => {
  test("is the same for the same input however its keys were ordered", () => {
    const identity = identityOf();
    const reordered = Object.fromEntries(
      Object.entries(identity).reverse(),
    ) as ReleaseIdentity;
    expect(deriveReleaseId(reordered)).toBe(deriveReleaseId(identity));
    expect(deriveReleaseId(identity)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const cardReordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(card).reverse())),
    ) as AgentCard;
    expect(cardContentSha256(cardReordered)).toBe(cardContentSha256(card));
  });

  test("keeps stored ids valid: changing the hashed shape needs a version bump", () => {
    expect(
      deriveReleaseId({
        agent_id: AGENT_ID,
        card_sha256: "a".repeat(64),
        connection_id: "conn-1",
        repository_id: null,
        runtime_config_snapshot: {
          model: "claude-sonnet-5",
          tools: ["Read"],
          runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
        },
        effective_tools: { tools: ["Read"], mcp: [] },
        policy_pins: {},
      }),
    ).toBe(PINNED_V5);
  });

  test("a repository is hashed only when the release names one", () => {
    const identity = identityOf();
    expect(deriveReleaseId({ ...identity, repository_id: "sample-app" })).not.toBe(
      deriveReleaseId(identity),
    );
  });

  test("treats array order as data", () => {
    const identity = identityOf();
    expect(
      deriveReleaseId({
        ...identity,
        effective_tools: {
          tools: [...identity.effective_tools.tools].reverse(),
          mcp: [],
        },
      }),
    ).not.toBe(deriveReleaseId(identity));
  });

  test("changes with every part of what the release runs", () => {
    const base = identityOf();
    const id = deriveReleaseId(base);
    const variants: ReleaseIdentity[] = [
      { ...base, agent_id: "019a0000-0000-7000-8000-0000000000ff" },
      { ...base, card_sha256: "b".repeat(64) },
      { ...base, connection_id: "conn-2" },
      { ...base, repository_id: "sample-app" },
      {
        ...base,
        runtime_config_snapshot: {
          ...base.runtime_config_snapshot,
          runtime: { kind: "claude_agent_sdk", version: "0.3.271" },
        },
      },
      {
        ...base,
        runtime_config_snapshot: { ...base.runtime_config_snapshot, x: 1 },
      },
      {
        ...base,
        policy_pins: {
          tools: {
            default: { builtin: "allow", mcp: "ask" },
            per_tool: { ...base.policy_pins.tools?.per_tool, Read: "ask" },
          },
        },
      },
    ];
    for (const variant of variants) {
      expect(deriveReleaseId(variant)).not.toBe(id);
    }
  });

  test("leaves who made or approved the release, its note, label and activation times out of the id", () => {
    const release = releaseOf(identityOf());
    const approved = {
      ...release,
      created_by: USER_B,
      approved_by: USER_B,
      approved_at: "2026-10-12T00:00:00.000Z",
      note: "hotfix",
      label: "2026-10-11_09:00:00-2",
      activated_at: "2026-10-12T00:00:00.000Z",
      deactivated_at: "2026-10-13T00:00:00.000Z",
    };
    expect(deriveReleaseId(approved)).toBe(release.id);
    expect(() => assertReleaseIdentity(approved)).not.toThrow();
  });

  test("refuses a stored release whose content does not hash to its id", () => {
    const release = releaseOf(identityOf());
    expect(() => assertReleaseIdentity(release)).not.toThrow();
    expect(() =>
      assertReleaseIdentity({
        ...release,
        effective_tools: { tools: ["Bash"], mcp: [] },
      }),
    ).toThrow(ReleaseIdentityError);
  });

  test("a release made from a card with a tone still verifies once read", () => {
    // As written before 94S-761: the stored card, tone included, is hashed.
    const storedCard = { ...card, tone: "공손하게" };
    const storedSha = cardContentSha256(storedCard as AgentCard);
    const resolved = resolveReleaseContent(card, run);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const release = releaseOf({
      agent_id: AGENT_ID,
      card_sha256: storedSha,
      repository_id: null,
      ...resolved.content,
    });

    const read = storedAgentCardSchema.parse(storedCard);
    expect(Object.hasOwn(read, "tone")).toBe(false);
    expect(cardContentSha256(read)).not.toBe(storedSha);
    expect(resolveReleaseContent(read, run)).toEqual(resolved);
    expect(() => assertReleaseIdentity(release)).not.toThrow();
  });
});

describe("resolveReleaseContent", () => {
  test("names the connection and pins a snapshot without the credential", () => {
    const identity = identityOf();
    expect(identity.connection_id).toBe("conn-1");
    const text = JSON.stringify(identity);
    expect(text).not.toContain("catalog-provider-key");
    expect(identity.runtime_config_snapshot).toEqual({
      model: "claude-sonnet-5",
      tools: ["Read", "Grep", "Edit", "Bash"],
      permission_mode: "default",
      provider: { kind: "litellm", endpoint: "https://litellm.invalid" },
      runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
      language: "ko",
    });
    expect(() => releaseOf(identity)).not.toThrow();
  });

  test("a release records the card's language, so a card edit never reaches a session that opened it", () => {
    for (const language of ["follow-user", "ko", "en", "ja"] as const) {
      expect(
        identityOf({ ...card, language }).runtime_config_snapshot.language,
      ).toBe(language);
    }
    expect(deriveReleaseId(identityOf({ ...card, language: "ja" }))).not.toBe(
      deriveReleaseId(identityOf({ ...card, language: "en" })),
    );
  });

  test("a changed run is a different release; a rotated credential is not", () => {
    for (const edited of [
      { ...run, permission_mode: "auto" as const },
      { ...run, runtime: { ...run.runtime, version: "0.3.271" } },
      { ...run, project_settings: { claude_md: true } },
      {
        ...run,
        connection: {
          ...run.connection,
          provider: { ...run.connection.provider, endpoint: "https://other.invalid" },
        },
      },
    ]) {
      expect(deriveReleaseId(identityOf(card, edited))).not.toBe(
        deriveReleaseId(identityOf()),
      );
    }
    const rotated: ReleaseRun = {
      ...run,
      connection: testConnection({
        provider: {
          kind: "litellm",
          endpoint: "https://litellm.invalid",
          auth: {
            kind: "api_key",
            value: "rotated-provider-key",
            ref: { value_env: "PROVIDER_KEY" },
          },
        },
        models: ["claude-sonnet-5", "claude-opus-5"],
      }),
    };
    expect(deriveReleaseId(identityOf(card, rotated))).toBe(
      deriveReleaseId(identityOf()),
    );
  });

  test("a repository's CLAUDE.md setting is pinned only when the run reads it", () => {
    expect(
      identityOf(card, { ...run, project_settings: { claude_md: true } })
        .runtime_config_snapshot.project_settings,
    ).toEqual({ claude_md: true });
    expect(
      Object.keys(identityOf().runtime_config_snapshot),
    ).not.toContain("project_settings");
  });

  test("runs every tool the runtime offers, whatever a card stored earlier lists or forbids", () => {
    const withTools = (capabilities: Record<string, unknown>) =>
      identityOf(storedAgentCardSchema.parse({ ...card, capabilities }));
    for (const capabilities of [
      { tools: null, mcp: null, forbidden: ["Bash"] },
      { tools: [], mcp: null, forbidden: [] },
      { tools: ["Read", "WebFetch"], mcp: null, forbidden: ["Read", "Edit"] },
    ]) {
      const identity = withTools(capabilities);
      expect(identity.effective_tools).toEqual({
        tools: ["Read", "Grep", "Edit", "Bash"],
        mcp: [],
      });
      expect(identity.runtime_config_snapshot.tools).toEqual([
        "Read",
        "Grep",
        "Edit",
        "Bash",
      ]);
    }
  });

  test("a stored card's tools, forbidden and built-in policy change nothing the release runs", () => {
    const plain = resolveReleaseContent(
      agentCardSchema.parse({
        ...card,
        capabilities: { mcp: null, forbidden: [] },
      }),
      run,
    );
    const edited = resolveReleaseContent(
      storedAgentCardSchema.parse({
        ...card,
        capabilities: {
          tools: ["Read"],
          mcp: null,
          forbidden: ["Bash"],
          tool_policy: {
            default: { builtin: "deny", mcp: "deny" },
            per_tool: { Bash: "ask", Grep: "deny", NotATool: "allow" },
          },
        },
      }),
      run,
    );
    expect(edited).toEqual(plain);
  });

  test("pins the default policy for every built-in tool", () => {
    expect(identityOf().policy_pins).toEqual({
      tools: {
        default: { builtin: "allow", mcp: "ask" },
        per_tool: {
          Read: "allow",
          Grep: "allow",
          Edit: "allow",
          Bash: "allow",
        },
      },
    });
  });

  test("keeps the card's MCP per_tool entries", () => {
    const declared = identityOf(
      agentCardSchema.parse({
        ...card,
        capabilities: {
          mcp: null,
          forbidden: [],
          tool_policy: { per_tool: { mcp__docs__search: "allow" } },
        },
      }),
    );
    expect(declared.policy_pins.tools?.per_tool.mcp__docs__search).toBe(
      "allow",
    );
  });

  test("refuses a per_tool policy for a built-in github server tool; other MCP servers keep theirs", () => {
    const withPerTool = (per_tool: Record<string, "allow" | "ask" | "deny">) =>
      resolveReleaseContent(
        agentCardSchema.parse({
          ...card,
          capabilities: { ...card.capabilities, tool_policy: { per_tool } },
        }),
        run,
      );
    const refused = withPerTool({ mcp__github__request_push: "allow" });
    expect(!refused.ok && refused.error.field).toBe(
      "card.capabilities.tool_policy.per_tool",
    );
    expect(!refused.ok && refused.error.message).toContain(
      "mcp__github__request_push",
    );
    // Any tool under the server's prefix, listed or not.
    expect(withPerTool({ mcp__github__made_up: "deny" }).ok).toBe(false);
    // A server that only starts with the same letters is another server.
    expect(withPerTool({ mcp__github_enterprise__x: "allow" }).ok).toBe(true);
  });

  test("refuses a card on a model the connection does not offer", () => {
    const resolved = resolveReleaseContent(
      { ...card, model: "claude-haiku-5" },
      run,
    );
    expect(!resolved.ok && resolved.error.field).toBe("card.model");
    expect(!resolved.ok && resolved.error.message).toBe(
      "model claude-haiku-5 is not a model of connection conn-1",
    );
  });

  test("takes a card on any model the connection offers and runs the card's", () => {
    const resolved = resolveReleaseContent(
      { ...card, model: "claude-opus-5" },
      run,
    );
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.content.runtime_config_snapshot.model).toBe(
      "claude-opus-5",
    );
  });
});

describe("a card naming a remote MCP server", () => {
  const servers = {
    fake: {
      url: "http://fake-mcp:4020/mcp",
      credential_ref: "mcp/fake",
      auth: {
        kind: "bearer" as const,
        value: "sa-value",
        ref: { value_env: "FAKE_MCP_SA" },
      },
      workspaces: ["default"],
    },
  };
  const mcpCard = agentCardSchema.parse({
    ...card,
    capabilities: {
      ...card.capabilities,
      mcp: [{ server: "fake" }],
      credential_refs: ["mcp/fake"],
      tool_policy: {
        per_tool: { mcp__fake__whoami: "allow", mcp__fake__other: "ask" },
      },
    },
  });
  const resolve = (value: AgentCard) =>
    resolveReleaseContent(value, run, servers);

  test("pins the server's allowed tools, and only those", () => {
    const resolved = resolve(mcpCard);
    expect(resolved.ok && resolved.content.effective_tools).toEqual({
      tools: ["Read", "Grep", "Edit", "Bash"],
      mcp: ["mcp__fake__whoami"],
    });
    expect(JSON.stringify(resolved)).not.toContain("sa-value");
  });

  test("a card without one resolves as it did before the catalog had any", () => {
    expect(resolveReleaseContent(card, run, servers)).toEqual(
      resolveReleaseContent(card, run),
    );
  });

  test("refuses a server the catalog lacks, a credential the card does not name, no allowed tool, or an allowed tool it forbids", () => {
    const capabilities = mcpCard.capabilities;
    for (const [value, field] of [
      [
        {
          ...mcpCard,
          capabilities: { ...capabilities, mcp: [{ server: "gone" }] },
        },
        "card.capabilities.mcp",
      ],
      [
        { ...mcpCard, capabilities: { ...capabilities, credential_refs: [] } },
        "card.capabilities.credential_refs",
      ],
      [
        {
          ...mcpCard,
          capabilities: {
            ...capabilities,
            tool_policy: { per_tool: { mcp__fake__whoami: "ask" } },
          },
        },
        "card.capabilities.tool_policy.per_tool",
      ],
      [
        {
          ...mcpCard,
          capabilities: { ...capabilities, forbidden: ["mcp__fake__whoami"] },
        },
        "card.capabilities.forbidden",
      ],
    ] as const) {
      const resolved = resolve(agentCardSchema.parse(value));
      expect(!resolved.ok && resolved.error.field).toBe(field);
    }
  });
});
