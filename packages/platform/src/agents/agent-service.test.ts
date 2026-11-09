import { describe, expect, test } from "bun:test";
import {
  type AgentGitHub,
  type AgentRelease,
  storedAgentCardSchema,
} from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type {
  AgentReader,
  AgentRecord,
  AgentStore,
} from "../ports/agent-store.ts";
import {
  type CatalogProfile,
  profileFingerprint,
  profilePins,
  type SessionCatalog,
} from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createAgentService } from "./agent-service.ts";
import { deriveReleaseId } from "./release-ids.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000b1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_AGENT = "019a0000-0000-7000-8000-0000000000a9";
const VERSION = "019a0000-0000-7000-8000-0000000000a2";
const KEY = "019a0000-0000-7000-8000-0000000000e1";
const AT = "2026-10-11T00:00:00.000Z";

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep"],
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

const catalogOf = (profile: CatalogProfile): SessionCatalog =>
  withSeededInstallation({
    profiles: {
      coding: profile,
      scratch: { ...profile, repository: "none" },
      either: { ...profile, repository: "optional" },
    },
    repositories: {
      "sample-app": {
        url: "https://github.com/acme/sample-app",
        branch: "main",
        profiles: ["coding", "either"],
        auth: { kind: "github_app", registered: true },
      },
      "other-app": {
        url: "https://github.com/acme/other-app",
        branch: "main",
        profiles: ["either"],
        auth: { kind: "github_app", registered: true },
      },
    },
  });

function cardWith(tools: string[]) {
  return storedAgentCardSchema.parse({
    role: "재무 분석가",
    instructions: "분기 보고서를 읽고 이상치를 요약한다.",
    model: "claude-sonnet-5",
    capabilities: { tools, mcp: null, forbidden: [] },
  });
}

const detail: AgentRecord = {
  behavior_revision: 0,
  model_source: "fixed",
  draft: null,
  agent: {
    id: AGENT,
    workspace_id: WORKSPACE,
    slug: "finance",
    name: "재무 분석가",
    description: null,
    managing_team_id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
    managing_team_name: "Finance",
    status: "active",
    active_release_id: null,
    activation_revision: -1,
    created_by: OWNER,
    created_at: AT,
    updated_at: AT,
  },
  versions: [],
  releases: [],
  active_release: null,
};

/** A store keeping inserted releases, as PostgreSQL returns them. */
function memoryStore(
  tools: string[] = ["Read"],
  /** The agent has an `agent_github_settings` row. */
  settingsRow = false,
) {
  const releases = new Map<string, AgentRelease>();
  let activations = 0;
  // A first save may land between the service's read and the insert.
  const racing = { settingsRow: false };
  const store: AgentStore = {
    list: async () => ({ items: [detail.agent], next_cursor: null }),
    count: async () => ({
      all: 1,
      administered: 0,
      active: 1,
      draft: 0,
    }),
    summaries: async () => new Map(),
    get: async () => detail,
    findVersion: async () => ({
      id: VERSION,
      agent_id: AGENT,
      version_no: 1,
      card: cardWith(tools),
      content_sha256: "a".repeat(64),
      created_by: OWNER,
      created_at: AT,
    }),
    findRelease: async (_workspace, id) => releases.get(id) ?? null,
    releaseSuperseded: async () => false,
    create: async () => ({ outcome: "created", detail }),
    update: async () => ({ outcome: "updated", detail, saved: null }),
    recordDraftFailure: async () => true,
    hasGitHubSettings: async () => settingsRow,
    followProfile: async () => ({ outcome: "updated" as const }),
    insertRelease: async ({ release, refuseGitHubWhenSettings }) => {
      if (
        refuseGitHubWhenSettings === true &&
        (settingsRow || racing.settingsRow)
      ) {
        return { outcome: "github_settings_exist" };
      }
      const existing = releases.get(release.id);
      if (existing) return { outcome: "exists", release: existing };
      const stored = {
        ...release,
        created_at: AT,
        approved_by: null,
        approved_at: null,
        label: "2026-10-11_09:00:00",
        activated_at: null,
        deactivated_at: null,
      };
      releases.set(release.id, stored);
      return { outcome: "created", release: stored };
    },
    activate: async ({ expectedRevision }) => {
      activations += 1;
      return expectedRevision === -1
        ? {
            outcome: "activated",
            revision: 0,
            previousReleaseId: null,
            receiptId: crypto.randomUUID(),
          }
        : { outcome: "conflict", activeReleaseId: null, revision: 0 };
    },
  };
  return { store, releases, racing, activations: () => activations };
}

function serviceOver(
  store: AgentStore,
  profile: CatalogProfile = PROFILE,
  unbound: Record<string, string[]> = {},
) {
  return createAgentService({
    authorization: createAuthorizationPolicy(),
    store,
    catalog: catalogOf(profile),
    credentials: {
      unboundRefs: async (_workspaceId, releaseId) => unbound[releaseId] ?? [],
    },
  });
}

const person = (role: "owner" | "member") =>
  callerFor(
    {
      kind: "user",
      id: OWNER,
      workspace_id: WORKSPACE,
      role,
      scopes: ["sessions:read", "sessions:write"],
    },
    { kind: "api" },
    crypto.randomUUID(),
  );

const owner = person("owner");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return (error as { code?: string }).code ?? "thrown";
  }
}

const release = {
  version_id: VERSION,
  runtime_profile_id: "coding",
  repository_id: "sample-app",
};
const PAGE = { limit: 50 };

describe("agent service", () => {
  test("every member lists and counts agents, the store judging each row; an API key is refused before it", async () => {
    let reached = false;
    const readers: AgentReader[] = [];
    const { store } = memoryStore();
    const service = serviceOver({
      ...store,
      list: async (_workspace, _query, reader) => {
        reached = true;
        readers.push(reader);
        return { items: [], next_cursor: null };
      },
      count: async (_workspace, reader) => {
        reached = true;
        readers.push(reader);
        return { all: 0, administered: 0, active: 0, draft: 0 };
      },
    });
    const key = callerFor(
      {
        kind: "api_key",
        id: KEY,
        owner_id: WORKSPACE,
        workspace_id: WORKSPACE,
        scopes: ["sessions:read", "sessions:write"],
      },
      { kind: "api" },
      crypto.randomUUID(),
    );
    expect(await codeOf(service.listAgents(key, PAGE))).toBe("FORBIDDEN");
    expect(await codeOf(service.countAgents(key))).toBe("FORBIDDEN");
    expect(reached).toBe(false);
    expect((await service.listAgents(person("member"), PAGE)).items).toEqual(
      [],
    );
    await service.countAgents(person("member"));
    expect(readers).toEqual([
      { userId: OWNER, outsideAccess: "use" },
      { userId: OWNER, outsideAccess: "use" },
    ]);
  });

  test("a member outside the agent reads none of its settings", async () => {
    const service = serviceOver(memoryStore().store);
    expect(await codeOf(service.getAgent(person("member"), AGENT))).toBe(
      "FORBIDDEN",
    );
    expect((await service.getAgent(owner, AGENT)).agent.id).toBe(AGENT);
  });

  test("a summary is read for the whole page only when asked for", async () => {
    const asked: (readonly string[])[] = [];
    const { store } = memoryStore();
    const summary = {
      version: {
        version_no: 1,
        role: "r",
        instructions: "i",
        mcp_servers: [],
        credential_refs: [],
      },
      runtime_profile_id: null,
      release_label: null,
      release_model: null,
      bound_credential_refs: [],
      admins: [],
      needs_input_count: 0,
      running_count: 0,
      slack_action: null,
    };
    const service = serviceOver({
      ...store,
      summaries: async (_workspace, ids) => {
        asked.push(ids);
        return new Map([[AGENT, summary]]);
      },
    });
    expect((await service.listAgents(owner, PAGE)).items).toEqual([
      detail.agent,
    ]);
    expect(asked).toEqual([]);
    expect(
      (await service.listAgents(owner, { ...PAGE, include: "summary" })).items,
    ).toEqual([{ ...detail.agent, summary }]);
    expect(asked).toEqual([[AGENT]]);
  });

  test("a release is named by its content, and the same content again is the same release", async () => {
    const { store } = memoryStore();
    const service = serviceOver(store);
    const first = await service.createRelease(owner, AGENT, release);
    expect(first.created).toBe(true);
    expect(first.release.effective_tools).toEqual({
      tools: ["Read", "Grep"],
      mcp: [],
    });
    // The path accepts an upper-case uuid; the hash is over the stored id.
    const again = await service.createRelease(
      owner,
      AGENT.toUpperCase(),
      release,
    );
    expect(again).toEqual({ release: first.release, created: false });
  });

  test("a release names the repository its sessions work on, as the profile's repository mode allows", async () => {
    const service = serviceOver(memoryStore().store);
    const refused = async (body: Record<string, unknown>) => {
      const error = await service
        .createRelease(owner, AGENT, { ...release, ...body })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(SessionServiceError);
      return [(error as SessionServiceError).code, (error as Error).message];
    };
    expect(await refused({ repository_id: undefined })).toEqual([
      "UNSUPPORTED_CAPABILITY",
      "repository_id: Profile coding needs a repository: send repository_id",
    ]);
    expect(
      await refused({
        runtime_profile_id: "scratch",
        repository_id: "sample-app",
      }),
    ).toEqual([
      "UNSUPPORTED_CAPABILITY",
      "repository_id: Profile scratch runs without a repository: omit repository_id",
    ]);
    expect(await refused({ repository_id: "other-app" })).toEqual([
      "UNSUPPORTED_CAPABILITY",
      "repository_id: Repository other-app is not in the catalog or does not allow profile coding",
    ]);
    expect(await refused({ repository_id: "missing" })).toEqual([
      "UNSUPPORTED_CAPABILITY",
      "repository_id: Repository missing is not in the catalog or does not allow profile coding",
    ]);

    const made = await service.createRelease(owner, AGENT, release);
    expect(made.release.repository_id).toBe("sample-app");
    const none = await service.createRelease(owner, AGENT, {
      version_id: VERSION,
      runtime_profile_id: "either",
    });
    expect(none.release.repository_id).toBeNull();
    // The repository is part of what the id names.
    const elsewhere = await service.createRelease(owner, AGENT, {
      version_id: VERSION,
      runtime_profile_id: "either",
      repository_id: "other-app",
    });
    expect(elsewhere.release.id).not.toBe(none.release.id);
    expect(elsewhere.release.repository_id).toBe("other-app");
  });

  test("a new release keeps the active release's GitHub settings; only they and the id differ", async () => {
    const { store } = memoryStore();
    const plain = (
      await serviceOver(store).createRelease(owner, AGENT, release)
    ).release;
    expect(plain.policy_pins.github).toBeUndefined();
    const github: AgentGitHub = {
      repositories: ["sample-app"],
      push_approval: false,
      features: {
        workflows: false,
        actions: false,
        checks: false,
        issues: false,
        review: false,
      },
      actions_allow: [],
    };
    const active = { ...plain, policy_pins: { ...plain.policy_pins, github } };
    const service = serviceOver({
      ...store,
      get: async () => ({ ...detail, active_release: active }),
    });

    const kept = (await service.createRelease(owner, AGENT, release)).release;
    expect(kept.policy_pins.github).toEqual(github);
    expect(kept.id).not.toBe(plain.id);
    const { id: _a, policy_pins: pinsKept, ...restKept } = kept;
    const { id: _b, policy_pins: pinsPlain, ...restPlain } = plain;
    expect(restKept).toEqual(restPlain);
    expect(pinsKept.tools).toEqual(pinsPlain.tools);

    // An optional release with no repository attaches them; a none one has
    // nothing for them to act on.
    const repositoryless = await service.createRelease(owner, AGENT, {
      version_id: VERSION,
      runtime_profile_id: "either",
    });
    expect(repositoryless.release.policy_pins.github).toEqual(github);
    const none = await service.createRelease(owner, AGENT, {
      version_id: VERSION,
      runtime_profile_id: "scratch",
    });
    expect(none.release.policy_pins.github).toBeUndefined();
  });

  test("an unknown profile is UNSUPPORTED_CAPABILITY; a tool the profile lacks is not read from the card", async () => {
    expect(
      await codeOf(
        serviceOver(memoryStore().store).createRelease(owner, AGENT, {
          ...release,
          runtime_profile_id: "missing",
        }),
      ),
    ).toBe("UNSUPPORTED_CAPABILITY");
    expect(
      await codeOf(
        serviceOver(memoryStore(["Read", "WebFetch"]).store).createRelease(
          owner,
          AGENT,
          release,
        ),
      ),
    ).toBe("resolved");
  });

  test("a blocked ceiling refuses a new release and the activation of one made before by name", async () => {
    const memory = memoryStore();
    const { release: made } = await serviceOver(memory.store).createRelease(
      owner,
      AGENT,
      release,
    );
    const open = catalogOf(PROFILE);
    const coding = open.installation?.get("coding");
    if (!open.installation || !coding) throw new Error("no seeded ceiling");
    const blocked = createAgentService({
      authorization: createAuthorizationPolicy(),
      store: memory.store,
      catalog: {
        ...open,
        installation: new Map([
          ...open.installation,
          ["coding", { ...coding, state: "blocked" }],
        ]),
      },
      credentials: { unboundRefs: async () => [] },
    });
    const byName = {
      code: "PROFILE_BLOCKED",
      details: { reason_code: "blocked", profile_id: "coding" },
    };
    expect(
      await blocked
        .activateAgent(owner, AGENT, {
          release_id: made.id,
          expected_revision: -1,
        })
        .catch((error: unknown) => error),
    ).toMatchObject(byName);
    expect(
      await blocked
        .createRelease(owner, AGENT, release)
        .catch((error: unknown) => error),
    ).toMatchObject(byName);
  });

  test("activation refuses a release whose profile changed, or of another agent, without reaching the store", async () => {
    const memory = memoryStore();
    const { release: made } = await serviceOver(memory.store).createRelease(
      owner,
      AGENT,
      release,
    );
    const edited = serviceOver(memory.store, {
      ...PROFILE,
      permission_mode: "acceptEdits",
    });
    expect(
      await codeOf(
        edited.activateAgent(owner, AGENT, {
          release_id: made.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("PROFILE_DIGEST_MISMATCH");
    const service = serviceOver(memory.store);
    expect(
      await codeOf(
        service.activateAgent(owner, OTHER_AGENT, {
          release_id: made.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(memory.activations()).toBe(0);
  });

  test("a release's digest leaves the models out, and one from before version 2 still activates", async () => {
    const memory = memoryStore();
    const { release: made } = await serviceOver(memory.store).createRelease(
      owner,
      AGENT,
      release,
    );
    expect(made.profile_digest).toBe(profileFingerprint(PROFILE));
    const listed = serviceOver(memory.store, {
      ...PROFILE,
      models: ["claude-opus-5-5"],
    });
    await listed.activateAgent(owner, AGENT, {
      release_id: made.id,
      expected_revision: -1,
    });
    expect(memory.activations()).toBe(1);
    const v1 = profilePins(PROFILE, [])[1]?.fingerprint;
    if (!v1) throw new Error("no version 1 pin");
    const legacy: AgentRelease = {
      ...made,
      profile_digest: v1,
      id: deriveReleaseId({ ...made, profile_digest: v1 }),
    };
    memory.releases.set(legacy.id, legacy);
    await listed.activateAgent(owner, AGENT, {
      release_id: legacy.id,
      expected_revision: -1,
    });
    expect(memory.activations()).toBe(2);
    expect(
      await codeOf(
        serviceOver(memory.store, {
          ...PROFILE,
          permission_mode: "acceptEdits",
        }).activateAgent(owner, AGENT, {
          release_id: legacy.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("PROFILE_DIGEST_MISMATCH");
  });

  test("a release whose card model left the profile's list no longer activates", async () => {
    const memory = memoryStore();
    const offers = serviceOver(memory.store, {
      ...PROFILE,
      model: "claude-opus-5-5",
      models: ["claude-sonnet-5"],
    });
    const { release: made } = await offers.createRelease(owner, AGENT, release);
    expect(made.runtime_config_snapshot.model).toBe("claude-sonnet-5");
    await offers.activateAgent(owner, AGENT, {
      release_id: made.id,
      expected_revision: -1,
    });
    expect(memory.activations()).toBe(1);
    const dropped = { ...PROFILE, model: "claude-opus-5-5" };
    expect(profileFingerprint(dropped)).toBe(made.profile_digest);
    const refused = await serviceOver(memory.store, dropped)
      .activateAgent(owner, AGENT, {
        release_id: made.id,
        expected_revision: -1,
      })
      .catch((error: unknown) => error);
    // The refusal names the model that left, not only that the profile moved.
    expect(refused).toMatchObject({
      code: "PROFILE_DIGEST_MISMATCH",
      message: expect.stringContaining("claude-sonnet-5"),
    });
    expect(memory.activations()).toBe(1);
  });

  test("activation names the credentials not bound to the agent, without reaching the store", async () => {
    const memory = memoryStore();
    const { release: made } = await serviceOver(memory.store).createRelease(
      owner,
      AGENT,
      release,
    );
    const refused = await serviceOver(memory.store, PROFILE, {
      [made.id]: ["mcp-notion", "slack_bot_token"],
    })
      .activateAgent(owner, AGENT, {
        release_id: made.id,
        expected_revision: -1,
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionServiceError);
    expect(refused).toMatchObject({
      code: "CREDENTIAL_UNBOUND",
      details: {
        reason_code: "credential_unbound",
        missing: ["mcp-notion", "slack_bot_token"],
      },
    });
    expect((refused as Error).message).toContain("mcp-notion, slack_bot_token");
    expect(memory.activations()).toBe(0);
  });

  test("a lost compare-and-swap is REVISION_CONFLICT", async () => {
    const memory = memoryStore();
    const service = serviceOver(memory.store);
    const { release: made } = await service.createRelease(
      owner,
      AGENT,
      release,
    );
    const activated = await service.activateAgent(owner, AGENT, {
      release_id: made.id,
      expected_revision: -1,
    });
    expect(activated.activation_revision).toBe(0);
    expect(
      await codeOf(
        service.activateAgent(owner, AGENT, {
          release_id: made.id,
          expected_revision: 5,
        }),
      ),
    ).toBe("REVISION_CONFLICT");
  });

  test("an activation hands the welcome its release; a refused one does not", async () => {
    const memory = memoryStore();
    const welcomed: unknown[][] = [];
    const service = createAgentService({
      authorization: createAuthorizationPolicy(),
      store: memory.store,
      catalog: catalogOf(PROFILE),
      credentials: { unboundRefs: async () => [] },
      welcome: {
        activated: async (...args) => {
          welcomed.push(args);
          return null;
        },
      },
    });
    const { release: made } = await service.createRelease(
      owner,
      AGENT,
      release,
    );
    await service.activateAgent(owner, AGENT, {
      release_id: made.id,
      expected_revision: -1,
    });
    await codeOf(
      service.activateAgent(owner, AGENT, {
        release_id: made.id,
        expected_revision: 5,
      }),
    );
    expect(welcomed).toEqual([[WORKSPACE, AGENT, made.id]]);
  });
});

describe("a release's GitHub settings", () => {
  const app = { kind: "github_app" as const, registered: true as const };
  const catalog = withSeededInstallation({
    profiles: {
      coding: PROFILE,
      scratch: { ...PROFILE, repository: "none" as const },
      either: { ...PROFILE, repository: "optional" as const },
    },
    repositories: {
      "sample-app": {
        url: "https://github.com/acme/sample-app",
        branch: "main",
        profiles: ["coding", "either"],
        auth: app,
      },
      "docs-app": {
        url: "https://github.com/acme/docs-app",
        branch: "main",
        profiles: ["coding", "either"],
        auth: app,
      },
      "review-only": {
        url: "https://github.com/acme/review-only",
        branch: "main",
        profiles: ["either"],
        auth: app,
      },
    },
  });
  const OFF = {
    workflows: false,
    actions: false,
    checks: false,
    issues: false,
    review: false,
    merge: false,
  };
  const github: AgentGitHub = {
    repositories: ["sample-app"],
    push_approval: true,
    features: OFF,
    actions_allow: [],
  };

  function service(store: AgentStore = memoryStore().store, ceiling = OFF) {
    return createAgentService({
      authorization: createAuthorizationPolicy(),
      store,
      catalog,
      credentials: { unboundRefs: async () => [] },
      githubSettings: { get: async () => ({ ceiling, revision: 1 }) },
    });
  }

  async function refusal(
    body: Record<string, unknown>,
    ceiling = OFF,
  ): Promise<unknown> {
    const error = await service(memoryStore().store, ceiling)
      .createRelease(owner, AGENT, { ...release, ...body })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(SessionServiceError);
    const { code, details } = error as SessionServiceError;
    return { code, details };
  }

  test("is pinned on the release when it fits the catalog and the ceiling", async () => {
    const withActions: AgentGitHub = {
      ...github,
      repositories: ["sample-app", "docs-app"],
      features: { ...OFF, actions: true },
      actions_allow: [{ workflow: "ci.yml" }],
    };
    const made = await service(memoryStore().store, {
      ...OFF,
      actions: true,
    }).createRelease(owner, AGENT, { ...release, github: withActions });
    expect(made.release.policy_pins.github).toEqual(withActions);
  });

  describe("an agent with a settings row", () => {
    const owned = {
      code: "ALREADY_EXISTS" as const,
      details: { field: "github", reason_code: "github_settings_exist" },
    };
    const attempt = async (
      store: AgentStore,
      body: Record<string, unknown>,
    ) => {
      const error = await service(store)
        .createRelease(owner, AGENT, { ...release, ...body })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      if (error === null) return null;
      const { code, details } = error as SessionServiceError;
      return { code, details };
    };

    test("a release request carrying `github` is 409", async () => {
      const held = memoryStore(["Read"], true);
      expect(await attempt(held.store, { github })).toEqual(owned);
      expect(held.releases.size).toBe(0);
    });

    test("the refusal comes before the other checks", async () => {
      const held = memoryStore(["Read"], true);
      // Unknown repository and a profile that does not exist would also fail.
      expect(
        await attempt(held.store, {
          github: { ...github, repositories: ["nowhere"] },
          runtime_profile_id: "nope",
        }),
      ).toEqual(owned);
    });

    test("a first save landing after the read is refused under the lock", async () => {
      const racing = memoryStore();
      racing.racing.settingsRow = true;
      expect(await attempt(racing.store, { github })).toEqual(owned);
      expect(racing.releases.size).toBe(0);
    });

    test("a release without `github` still goes through, and so does one for an agent without a row", async () => {
      expect(await attempt(memoryStore(["Read"], true).store, {})).toBeNull();
      expect(await attempt(memoryStore().store, { github })).toBeNull();
    });

    test("a card-edit release does not inherit or re-check the old release's pins", async () => {
      const held = memoryStore(["Read"], true);
      const old: AgentGitHub = {
        ...github,
        features: { ...github.features, actions: true },
      };
      const withPins = {
        ...held.store,
        get: async () => ({
          ...detail,
          active_release: {
            policy_pins: { github: old },
          } as unknown as AgentRelease,
        }),
      };
      const made = await serviceOver(withPins).createRelease(
        owner,
        AGENT,
        release,
      );
      expect(made.release.policy_pins.github).toBeUndefined();
    });
  });

  test("an optional release with no repository keeps settings for the repositories it attaches", async () => {
    const attaches: AgentGitHub = {
      ...github,
      repositories: ["sample-app", "docs-app"],
    };
    const made = await service().createRelease(owner, AGENT, {
      ...release,
      runtime_profile_id: "either",
      repository_id: undefined,
      github: attaches,
    });
    expect(made.release.repository_id).toBeNull();
    expect(made.release.policy_pins.github).toEqual(attaches);
  });

  test("a release on a none profile is repository_none", async () => {
    expect(
      await refusal({
        runtime_profile_id: "scratch",
        repository_id: undefined,
        github,
      }),
    ).toEqual({
      code: "BAD_REQUEST",
      details: { field: "github", reason_code: "repository_none" },
    });
  });

  test("a repository the profile does not allow is repository_not_allowed", async () => {
    for (const id of ["missing", "review-only"]) {
      expect(
        await refusal({
          github: { ...github, repositories: ["sample-app", id] },
        }),
      ).toEqual({
        code: "BAD_REQUEST",
        details: {
          field: "github.repositories.1",
          reason_code: "repository_not_allowed",
        },
      });
    }
  });

  test("repositories that leave out the release's own are release_repository_outside", async () => {
    expect(
      await refusal({ github: { ...github, repositories: ["docs-app"] } }),
    ).toEqual({
      code: "BAD_REQUEST",
      details: {
        field: "github.repositories",
        reason_code: "release_repository_outside",
      },
    });
  });

  test("an allow-list without Actions is actions_off", async () => {
    expect(
      await refusal(
        { github: { ...github, actions_allow: [{ workflow: "ci.yml" }] } },
        { ...OFF, actions: true },
      ),
    ).toEqual({
      code: "BAD_REQUEST",
      details: { field: "github.actions_allow", reason_code: "actions_off" },
    });
  });

  test("a feature over the workspace's ceiling is over_workspace_ceiling", async () => {
    expect(
      await refusal({
        github: { ...github, features: { ...OFF, review: true } },
      }),
    ).toEqual({
      code: "BAD_REQUEST",
      details: {
        field: "github.features.review",
        reason_code: "over_workspace_ceiling",
      },
    });
  });

  test("a release without github inherits the active release's; a move to a repository_mode none profile drops it", async () => {
    const { store } = memoryStore();
    const first = (
      await service(store).createRelease(owner, AGENT, { ...release, github })
    ).release;
    const over = service({
      ...store,
      get: async () => ({ ...detail, active_release: first }),
    });
    const inherited = (await over.createRelease(owner, AGENT, release)).release;
    expect(inherited.policy_pins.github).toEqual(github);
    const moved = (
      await over.createRelease(owner, AGENT, {
        version_id: VERSION,
        runtime_profile_id: "scratch",
      })
    ).release;
    expect(moved.repository_id).toBeNull();
    expect(moved.policy_pins.github).toBeUndefined();
  });

  test("inherited settings are checked as sent ones: a move to a repository outside them is release_repository_outside", async () => {
    const { store } = memoryStore();
    const first = (
      await service(store).createRelease(owner, AGENT, { ...release, github })
    ).release;
    const over = service({
      ...store,
      get: async () => ({ ...detail, active_release: first }),
    });
    const error = await over
      .createRelease(owner, AGENT, { ...release, repository_id: "docs-app" })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).details).toMatchObject({
      reason_code: "release_repository_outside",
    });
  });
});
