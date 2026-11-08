import { describe, expect, test } from "bun:test";
import { agentCardSchema } from "@werft-ai/contracts";
import type { CatalogProfile, SessionCatalog } from "../sessions/catalog.ts";
import { planToolUnlock, type ToolUnlockAgentFact } from "./tool-unlock.ts";

const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep", "Edit", "Bash"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const catalog = {
  profiles: { coding: profile },
  repositories: {},
} as unknown as SessionCatalog;

const fact = (
  capabilities: Record<string, unknown>,
  tools: string[],
  extra: Partial<ToolUnlockAgentFact> = {},
): ToolUnlockAgentFact => ({
  workspace_id: "w1",
  agent_id: "a1",
  name: "agent",
  tracking: "follow",
  activation_revision: 3,
  behavior_revision: 1,
  active_release_id: "sha256:old",
  profile_id: "coding",
  card: agentCardSchema.parse({
    role: "r",
    instructions: "i",
    model: "claude-sonnet-5",
    capabilities,
  }),
  tools,
  ...extra,
});

const plan = (facts: ToolUnlockAgentFact[]) =>
  planToolUnlock({ facts, catalog, now: "2026-11-08T00:00:00Z" });

describe("planToolUnlock", () => {
  test("lists what each agent gets back; an agent already on the new tools is `same`", () => {
    const report = plan([
      fact({ tools: ["Read"], mcp: null, forbidden: ["Edit"] }, ["Read"]),
      fact(
        { tools: null, mcp: null, forbidden: [] },
        ["Read", "Grep", "Edit", "Bash"],
        { agent_id: "a2" },
      ),
    ]);
    expect(report.agents[0]).toMatchObject({
      decision: "unlock",
      tools_before: ["Read"],
      tools_after: ["Read", "Grep", "Edit", "Bash"],
      unlocked: ["Grep", "Edit", "Bash"],
      removed: [],
    });
    expect(report.agents[1]?.decision).toBe("same");
    expect(report.totals).toEqual({
      agents: 2,
      unlock: 1,
      same: 1,
      would_fail: 0,
    });
  });

  test("order alone is not a difference", () => {
    const report = plan([
      fact({ tools: null, mcp: null, forbidden: [] }, [
        "Bash",
        "Edit",
        "Grep",
        "Read",
      ]),
    ]);
    expect(report.agents[0]?.decision).toBe("same");
  });

  test("a pinned agent is in the plan", () => {
    const report = plan([
      fact({ tools: ["Read"], mcp: null, forbidden: [] }, ["Read"], {
        tracking: "pinned",
      }),
    ]);
    expect(report.agents[0]).toMatchObject({
      tracking: "pinned",
      decision: "unlock",
    });
  });

  test("MCP ask and deny entries never count as an unlock", () => {
    const report = plan([
      fact(
        {
          tools: ["Read", "Grep", "Edit", "Bash"],
          mcp: null,
          forbidden: [],
          tool_policy: {
            per_tool: { mcp__docs__search: "ask", mcp__docs__write: "deny" },
          },
        },
        ["Read", "Grep", "Edit", "Bash"],
      ),
    ]);
    expect(report.agents[0]?.decision).toBe("same");
    expect(
      report.agents.flatMap((entry) => entry.unlocked).join(" "),
    ).not.toContain("mcp__");
  });

  test("a profile the catalog lacks is reported, not unlocked", () => {
    const report = plan([
      fact({ tools: ["Read"], mcp: null, forbidden: [] }, ["Read"], {
        profile_id: "gone",
      }),
    ]);
    expect(report.agents[0]).toMatchObject({
      decision: "would_fail",
      reason: "profile_unknown",
    });
    expect(report.totals.would_fail).toBe(1);
  });
});
