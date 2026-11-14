import { describe, expect, test } from "bun:test";
import {
  type AgentGitHub,
  type AgentRelease,
  type AgentVersion,
  agentCardSchema,
} from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type {
  ActivateResult,
  AgentRecord,
  AgentStore,
  InsertReleaseResult,
  UpdateAgentResult,
} from "../ports/agent-store.ts";
import {
  TEST_CONNECTION_ID,
  TEST_RUNTIMES,
  testCatalog,
} from "../testing/catalog-fakes.ts";
import { createAgentService } from "./agent-service.ts";
import { cardContentSha256, deriveReleaseId } from "./release-ids.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000b1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const VERSION = "019a0000-0000-7000-8000-0000000000a2";
const AT = "2026-10-11T00:00:00.000Z";

const CATALOG = testCatalog({
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

const card = agentCardSchema.parse({
  rules: [{ id: "r1", text: "v2", source: "user" }],
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
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

const GITHUB: AgentGitHub = {
  repositories: ["app"],
  push_approval: true,
  features: {
    workflows: false,
    actions: false,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [],
};

function activeRelease(): AgentRelease {
  const identity = {
    agent_id: AGENT,
    card_sha256: "b".repeat(64),
    connection_id: TEST_CONNECTION_ID,
    repository_id: "app",
    runtime_config_snapshot: { model: "claude-sonnet-5" },
    effective_tools: { tools: ["Read"], mcp: [] },
    policy_pins: { github: GITHUB },
  };
  return {
    id: deriveReleaseId(identity),
    version_id: VERSION,
    created_by: OWNER,
    created_at: AT,
    approved_by: OWNER,
    approved_at: AT,
    label: "2026-10-11_09:00:00",
    activated_at: AT,
    deactivated_at: null,
    ...identity,
  };
}

function record(): AgentRecord {
  const active = activeRelease();
  return {
    agent: {
      id: AGENT,
      workspace_id: WORKSPACE,
      slug: "finance",
      name: "재무",
      description: null,
      managing_team_id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
      managing_team_name: "Finance",
      status: "active",
      active_release_id: active.id,
      activation_revision: 3,
      auto_model_migration: true,
      created_by: OWNER,
      created_at: AT,
      updated_at: AT,
    },
    versions: [version],
    releases: [active],
    active_release: active,
    behavior_revision: 5,
    draft: null,
  };
}

type Script = {
  update?: UpdateAgentResult[];
  insert?: InsertReleaseResult["outcome"][];
  activate?: ActivateResult[];
  hasRow?: boolean;
};

function scripted(script: Script) {
  const calls = {
    update: [] as unknown[],
    insert: [] as unknown[],
    activate: [] as unknown[],
    failure: [] as unknown[],
  };
  const updates = [...(script.update ?? [])];
  const inserts = [...(script.insert ?? [])];
  const activations = [...(script.activate ?? [])];
  const pending: UpdateAgentResult = {
    outcome: "updated",
    detail: record(),
    saved: { status: "pending", versionId: VERSION, behaviorRevision: 6 },
  };
  const store: AgentStore = {
    list: async () => ({ items: [], next_cursor: null }),
    listUsable: async () => [],
    count: async () => ({
      all: 0,
      administered: 0,
      active: 0,
      draft: 0,
    }),
    summaries: async () => new Map(),
    get: async () => record(),
    findVersion: async () => version,
    findRelease: async () => null,
    agentStatus: async () => "active",
    releaseSuperseded: async () => false,
    create: async () => ({ outcome: "slug_taken" }),
    update: async (input) => {
      calls.update.push(input);
      return updates.shift() ?? pending;
    },
    recordDraftFailure: async (input) => {
      calls.failure.push(input);
      return true;
    },
    hasGitHubSettings: async () => script.hasRow ?? false,
    autoModelMigration: async () => true,
    modelMigrationCandidates: async () => [],
    activationActor: async () => null,
    notifyModelMigrationFailed: async () => 0,
    insertRelease: async (input) => {
      calls.insert.push(input);
      const outcome = inserts.shift() ?? "created";
      if (outcome === "github_settings_exist") return { outcome };
      return {
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
      } as InsertReleaseResult;
    },
    activate: async (input) => {
      calls.activate.push(input);
      return (
        activations.shift() ?? {
          outcome: "activated",
          revision: 4,
          previousReleaseId: null,
          receiptId: "r",
        }
      );
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
    runtimes: TEST_RUNTIMES,
  });
  void createAuthorizationPolicy;
  return { service, calls };
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

const save = (script: Script, body = { card }) => {
  const { service, calls } = scripted(script);
  return {
    calls,
    result: service.updateAgent(caller, AGENT, body),
  };
};

describe("a card save asks releaseAgent for what the request changes", () => {
  test("it carries the active release's GitHub pin and repository when the agent has no settings row", async () => {
    const { calls, result } = save({});
    const saved = await result;
    expect(saved.release.status).toBe("applied");
    const [insert] = calls.insert as {
      release: AgentRelease;
      refuseGitHubWhenSettings: boolean;
    }[];
    expect(insert?.release.policy_pins.github).toEqual(GITHUB);
    expect(insert?.release.repository_id).toBe("app");
    // The lock re-checks a first settings row saved since the read.
    expect(insert?.refuseGitHubWhenSettings).toBe(true);
  });

  test("with a settings row it carries neither", async () => {
    const { calls, result } = save({ hasRow: true });
    await result;
    const [insert] = calls.insert as { release: AgentRelease }[];
    expect(insert?.release.policy_pins.github).toBeUndefined();
    expect(insert?.release.repository_id).toBeNull();
  });

  test("a settings row that appears after the read makes the release judge again, not carry stale pins", async () => {
    const { calls, result } = save({ insert: ["github_settings_exist"] });
    const saved = await result;
    expect(saved.release.status).toBe("applied");
    // The save is written once; only the release is asked again.
    expect(calls.update).toHaveLength(1);
    expect(calls.insert).toHaveLength(2);
  });

  test("a lost activation compare-and-swap asks the release again with the revision the save was given", async () => {
    const { calls, result } = save({
      activate: [{ outcome: "conflict", activeReleaseId: null, revision: 4 }],
    });
    expect((await result).release.status).toBe("applied");
    expect(calls.update).toHaveLength(1);
    const intents = (
      calls.activate as { intent: { behaviorRevision: number } }[]
    ).map((call) => call.intent.behaviorRevision);
    // A second save issuing a new revision here would overwrite a later save.
    expect(intents).toEqual([6, 6]);
  });

  test("conflicts that never end are a failed draft with a reason, not a pending one", async () => {
    const conflict: ActivateResult = {
      outcome: "conflict",
      activeReleaseId: null,
      revision: 4,
    };
    const { calls, result } = save({
      activate: [conflict, conflict, conflict],
    });
    const saved = await result;
    expect(saved.release).toEqual({
      status: "failed",
      reason: "revision_conflict",
      release_id: null,
      version_id: VERSION,
    });
    expect(calls.failure).toEqual([
      {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        behaviorRevision: 6,
        draftVersionId: VERSION,
        failure: "revision_conflict",
      },
    ]);
  });

  test("an agent that moved since the omitted values were read is read again", async () => {
    const { calls, result } = save({ update: [{ outcome: "stale" }] });
    expect((await result).release.status).toBe("applied");
    expect(calls.update).toHaveLength(2);
    const [first] = calls.update as { behavior: { basedOn?: unknown } }[];
    expect(first?.behavior.basedOn).toEqual({
      behaviorRevision: 5,
      activationRevision: 3,
    });
  });

  test("a save the store superseded answers superseded and writes no failure", async () => {
    const { calls, result } = save({ activate: [{ outcome: "superseded" }] });
    expect((await result).release.status).toBe("superseded");
    expect(calls.failure).toEqual([]);
  });

  test("a request equal to what runs answers unchanged and reaches no release", async () => {
    const { calls, result } = save({
      update: [
        {
          outcome: "updated",
          detail: record(),
          saved: {
            status: "unchanged",
            versionId: VERSION,
            behaviorRevision: 6,
          },
        },
      ],
    });
    expect((await result).release).toEqual({
      status: "unchanged",
      reason: null,
      release_id: null,
      version_id: VERSION,
    });
    expect(calls.insert).toEqual([]);
    expect(calls.activate).toEqual([]);
  });

  test("every answer names the version this request resolved to, not the agent's latest draft", async () => {
    const applied = await save({}).result;
    expect(applied.release.version_id).toBe(VERSION);
    const superseded = await save({ activate: [{ outcome: "superseded" }] })
      .result;
    expect(superseded.release.version_id).toBe(VERSION);
  });

  test("a model the connection does not offer is a failed draft naming model_not_in_connection", async () => {
    const wrong = agentCardSchema.parse({
      ...card,
      model: "other-model",
    });
    const { calls, result } = save(
      {
        update: [
          {
            outcome: "updated",
            detail: {
              ...record(),
              versions: [{ ...version, card: wrong }],
            },
            saved: {
              status: "pending",
              versionId: VERSION,
              behaviorRevision: 6,
            },
          },
        ],
      },
      { card: wrong },
    );
    const saved = await result;
    expect(saved.release.reason).toBe("model_not_in_connection");
    expect(calls.insert).toEqual([]);
  });
});
