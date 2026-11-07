import { describe, expect, test } from "bun:test";
import {
  type AgentRelease,
  type AgentVersion,
  agentCardSchema,
} from "@werft-ai/contracts";
import { callerFor } from "../musterrolle/policy.ts";
import type {
  ActivateResult,
  AgentRecord,
  AgentStore,
  InsertReleaseResult,
} from "../ports/agent-store.ts";
import type { CatalogProfile, SessionCatalog } from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { createAgentService } from "./agent-service.ts";
import { cardContentSha256, deriveReleaseId } from "./release-ids.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000b1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const VERSION = "019a0000-0000-7000-8000-0000000000a2";
const AT = "2026-10-11T00:00:00.000Z";

const profile = (model: string): CatalogProfile => ({
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model,
  tools: ["Read"],
  permission_mode: "default",
  repository: "none",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
});
const CATALOG: SessionCatalog = withSeededInstallation({
  profiles: {
    old: profile("claude-sonnet-5"),
    next: profile("claude-sonnet-5"),
  },
  repositories: {},
});

const card = agentCardSchema.parse({
  agent_instructions: "v1",
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
});
const version: AgentVersion = {
  id: VERSION,
  agent_id: AGENT,
  version_no: 1,
  card,
  content_sha256: cardContentSha256(card),
  created_by: OWNER,
  created_at: AT,
};

function releaseOn(profileId: string): AgentRelease {
  const identity = {
    agent_id: AGENT,
    card_sha256: version.content_sha256,
    runtime_profile_id: profileId,
    repository_id: null,
    profile_digest: `digest-${profileId}`,
    runtime_config_snapshot: { model: "claude-sonnet-5" },
    effective_tools: { tools: ["Read"], mcp: [] },
    policy_pins: {},
  };
  return {
    id: deriveReleaseId(identity),
    version_id: VERSION,
    created_by: OWNER,
    created_at: AT,
    approved_by: OWNER,
    approved_at: AT,
    note: null,
    label: "2026-10-11_09:00:00",
    activated_at: AT,
    deactivated_at: null,
    ...identity,
  };
}

function recordOn(
  active: AgentRelease,
  revisions: { activation: number; behavior: number },
): AgentRecord {
  return {
    agent: {
      id: AGENT,
      workspace_id: WORKSPACE,
      slug: "finance",
      name: "재무",
      description: null,
      managing_team_id: null,
      managing_team_name: null,
      status: "active",
      active_release_id: active.id,
      activation_revision: revisions.activation,
      created_by: OWNER,
      created_at: AT,
      updated_at: AT,
    },
    versions: [version],
    releases: [active],
    active_release: active,
    behavior_revision: revisions.behavior,
    model_source: "fixed",
    draft: null,
  };
}

const caller = callerFor(
  {
    kind: "user",
    id: OWNER,
    workspace_id: WORKSPACE,
    role: "owner",
    scopes: ["sessions:read", "sessions:write"],
  },
  { kind: "api" },
  crypto.randomUUID(),
);

/** `reads` is what each `store.get` answers in turn; the last one repeats. */
function raiseOver(reads: AgentRecord[]) {
  const activations: unknown[] = [];
  let read = 0;
  const store: AgentStore = {
    list: async () => ({ items: [], next_cursor: null }),
    count: async () => ({
      all: 0,
      administered: 0,
      active: 0,
      draft: 0,
      unassigned: 0,
    }),
    summaries: async () => new Map(),
    get: async () => reads[Math.min(read++, reads.length - 1)] ?? null,
    findVersion: async () => version,
    findRelease: async () => null,
    releaseSuperseded: async () => false,
    create: async () => ({ outcome: "slug_taken" }),
    update: async () => ({ outcome: "not_found" }),
    recordDraftFailure: async () => true,
    hasGitHubSettings: async () => false,
    followProfile: async () => ({ outcome: "updated" as const }),
    insertRelease: async (input) =>
      ({
        outcome: "created",
        release: {
          ...input.release,
          created_at: AT,
          approved_by: null,
          approved_at: null,
          label: "2026-10-11_09:00:01",
          activated_at: null,
          deactivated_at: null,
        },
      }) as InsertReleaseResult,
    activate: async (input) => {
      activations.push(input);
      return {
        outcome: "activated",
        revision: 4,
        previousReleaseId: null,
        receiptId: "r",
      } satisfies ActivateResult;
    },
  };
  const service = createAgentService({
    authorization: {
      authorize: async () => ({
        outcome: "allow",
        reason_code: "ok",
        effective_scopes: [],
        policy_version: "test",
        decision_id: crypto.randomUUID(),
      }),
    },
    store,
    catalog: CATALOG,
    credentials: { unboundRefs: async () => [] },
    profileLineage: {
      inspect: async () => ({
        tracking: "pinned",
        sameLineage: true,
        latest: { id: "next", version: 2, definition: {} },
        active: { id: "old", version: 1, definition: {} },
      }),
    },
  });
  return {
    activations,
    raise: () =>
      service.updateAgent(caller, AGENT, { follow_latest_profile: true }),
  };
}

describe("raising an agent to the latest profile while a rollback lands", () => {
  const seen = recordOn(releaseOn("old"), { activation: 3, behavior: 5 });

  test("with nothing in between, the raise is judged on the revisions it read", async () => {
    const { activations, raise } = raiseOver([seen]);
    const answer = await raise();
    expect(answer.release.status).toBe("applied");
    expect(activations).toHaveLength(1);
    expect(activations[0]).toMatchObject({
      expectedRevision: 3,
      intent: { kind: "raise", behaviorRevision: 5 },
    });
  });

  test("a rollback between the first read and the release is refused, not overwritten", async () => {
    // The rollback activated another release and bumped both revisions.
    const rolledBack = recordOn(releaseOn("old"), {
      activation: 4,
      behavior: 6,
    });
    const { activations, raise } = raiseOver([seen, rolledBack]);
    const answer = await raise();
    expect(answer.release).toMatchObject({
      status: "failed",
      reason: "revision_conflict",
    });
    expect(activations).toHaveLength(0);
  });

  // Re-activating the running release moves only the behavior revision; a
  // revision-only swap moves only the activation one. Each is refused alone.
  test.each([
    ["only the activation revision", { activation: 4, behavior: 5 }],
    ["only the behavior revision", { activation: 3, behavior: 6 }],
  ])("a change to %s is refused too", async (_name, revisions) => {
    const { activations, raise } = raiseOver([
      seen,
      recordOn(releaseOn("old"), revisions),
    ]);
    expect((await raise()).release).toMatchObject({
      status: "failed",
      reason: "revision_conflict",
    });
    expect(activations).toHaveLength(0);
  });
});
