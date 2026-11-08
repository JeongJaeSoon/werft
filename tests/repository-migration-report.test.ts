import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { GITHUB_CEILING_NONE, GITHUB_FEATURES_NONE } from "@werft-ai/contracts";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { withSeededInstallation } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { Pool } from "pg";
import {
  generateReport,
  type Report,
  withReadOnlySnapshot,
} from "../scripts/lib/repository-migration-report.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const PROVIDER = {
  kind: "litellm",
  endpoint: "https://litellm.invalid",
  auth: {
    kind: "api_key",
    value: "catalog-provider-key",
    ref: { value_env: "PROVIDER_KEY" },
  },
};

/** The in-memory catalog the running image's gate would read. */
const catalog = () =>
  withSeededInstallation({
    profiles: {
      "claude-coding-v1": {
        runtime_kind: "claude_agent_sdk",
        runtime_version: "0.3.270",
        model: "claude-sonnet-5",
        tools: ["Read"],
        permission_mode: "default",
        provider: PROVIDER,
      },
    },
    repositories: {
      "app-1": {
        url: "https://github.com/acme/app-1",
        branch: "main",
        profiles: ["claude-coding-v1"],
        auth: { kind: "github_app", registered: true },
      },
      "pat-url": {
        url: "https://github.com/acme/pat-url",
        branch: "main",
        profiles: ["claude-coding-v1"],
        auth: {
          kind: "basic",
          username: "x-access-token",
          value: "pat-secret-value",
          ref: { value_env: "PAT" },
        },
      },
      "none-url": {
        url: "https://git.invalid/acme/none-url.git",
        branch: "main",
        profiles: ["claude-coding-v1"],
      },
      "bearer-url": {
        url: "https://git.invalid/acme/bearer-url.git",
        branch: "main",
        profiles: ["claude-coding-v1"],
        auth: {
          kind: "bearer",
          value: "bearer-secret-value",
          ref: { value_env: "BEARER" },
        },
      },
    },
  });

const PIN = (repositories: unknown) => ({
  github: {
    repositories,
    push_approval: false,
    features: { ...GITHUB_FEATURES_NONE },
    actions_allow: [],
  },
});

integration("the read-only repository migration report", () => {
  let database: TempDatabase;
  let pool: Pool;
  const ids = {
    a: randomUUID(),
    b: randomUUID(),
    c: randomUUID(),
    user: randomUUID(),
  };
  const sessionIds: Record<string, string> = {};
  let report: Report;
  let rowsBefore: string;

  async function repository(
    id: string,
    authKind: string,
    options: { removed?: boolean; profiles?: string[] } = {},
  ) {
    const auth =
      authKind === "github_app" || authKind === "none"
        ? [null, null]
        : [
            JSON.stringify({ kind: "basic", username: "u", value: "secret" }),
            "external",
          ];
    await pool.query(
      `INSERT INTO catalog_repositories (id, owner, name, url, branch, profiles,
         auth_kind, auth, credential_source, source, removed_at)
       VALUES ($1, 'acme', $1, 'https://example.invalid/' || $1, 'main', $2,
         $3, $4, $5, 'seed', $6)`,
      [
        id,
        options.profiles === undefined
          ? null
          : JSON.stringify(options.profiles),
        authKind,
        auth[0],
        auth[1],
        options.removed ? new Date() : null,
      ],
    );
  }

  async function workspace(id: string, ceiling: unknown | undefined) {
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [id, `ws-${id.slice(0, 8)}`],
    );
    if (ceiling !== undefined) {
      await pool.query(
        `INSERT INTO github_workspace_settings (workspace_id, ceiling, repository_ceiling)
         VALUES ($1, $2, $3)`,
        [
          id,
          JSON.stringify(GITHUB_CEILING_NONE),
          ceiling === null ? null : JSON.stringify(ceiling),
        ],
      );
    }
  }

  /** An agent whose active release carries `pins`, plus an optional settings row. */
  async function agent(
    workspaceId: string,
    name: string,
    options: {
      pins: object;
      releaseRepository?: string;
      settings?: unknown;
      start?: string;
    },
  ) {
    const agentId = randomUUID();
    const versionId = randomUUID();
    const releaseId = `sha256:${randomUUID()}`;
    await pool.query(
      "INSERT INTO agents (id, workspace_id, slug, name, github_enabled) VALUES ($1, $2, $3, $4, true)",
      [agentId, workspaceId, `a-${agentId.slice(0, 8)}`, name],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         runtime_profile_id, repository_id, profile_digest,
         runtime_config_snapshot, effective_tools, policy_pins)
       VALUES ($1, $2, $3, $4, 'claude-coding-v1', $5, $6, '{}', '{}', $7)`,
      [
        releaseId,
        agentId,
        versionId,
        "a".repeat(64),
        options.releaseRepository ?? null,
        `sha256:${"c".repeat(64)}`,
        JSON.stringify(options.pins),
      ],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    if (options.settings !== undefined || options.start !== undefined) {
      await pool.query(
        `INSERT INTO agent_github_settings (agent_id, workspace_id, repositories,
           push_approval, features, actions_allow, start_repository_id)
         VALUES ($1, $2, $3, false, $4, '[]', $5)`,
        [
          agentId,
          workspaceId,
          JSON.stringify(options.settings ?? []),
          JSON.stringify(GITHUB_CEILING_NONE),
          options.start ?? null,
        ],
      );
    }
    return { agentId, releaseId };
  }

  async function session(
    key: string,
    row: {
      workspaceId: string | null;
      releaseId?: string;
      status?: string;
      repositoryId?: string | null;
      attached?: string[] | null;
      source?: "release" | "agent";
      profile?: string;
      ageDays?: number;
    },
  ) {
    const id = randomUUID();
    sessionIds[key] = id;
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, agent_release_id, created_by_user_id, github_policy_source,
         checkpoint_revision, status, attached_repository_ids, profile_id, updated_at)
       VALUES ($1, $2, 'https://example.invalid/r.git', 'main', $3, $4, $5, $6,
         $7, 1, $8, $9, $10, now() - make_interval(days => $11))`,
      [
        id,
        row.workspaceId ?? ids.user,
        row.repositoryId ?? null,
        row.workspaceId,
        row.releaseId ?? null,
        ids.user,
        row.source ?? "release",
        row.status ?? "running",
        row.attached ?? null,
        row.profile ?? "claude-coding-v1",
        row.ageDays ?? 0,
      ],
    );
  }

  async function tableCounts(): Promise<string> {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM workspaces) w, (SELECT count(*) FROM sessions) s,
              (SELECT count(*) FROM github_workspace_settings) g,
              (SELECT count(*) FROM catalog_repositories) c,
              (SELECT count(*) FROM agent_github_settings) a`,
    );
    return JSON.stringify(rows[0]);
  }

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "repo_report_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'owner')",
      [ids.user, `${ids.user}@example.invalid`],
    );

    await repository("app-1", "github_app");
    await repository("pat-url", "basic");
    await repository("none-url", "none");
    await repository("bearer-url", "bearer");
    await repository("gone-url", "none", { removed: true });
    await repository("private-a", "github_app_explicit");
    await repository("shared-x", "github_app_explicit");
    await repository("orphan-x", "github_app_explicit");
    await repository("old-x", "github_app_explicit");
    await repository("recent-x", "github_app_explicit");
    await repository("loose-x", "github_app_explicit");
    // Seed metadata naming a profile is not a grant.
    await repository("stale-meta", "github_app_explicit", {
      profiles: ["p-list"],
    });

    // A holds a URL value in its ceiling; B's ceiling is NULL; C's is not
    // shaped like a ceiling.
    await workspace(ids.a, {
      repository_ids: ["pat-url"],
      github_app_repositories: "listed",
    });
    await workspace(ids.b, null);
    await workspace(ids.c, { repository_ids: "x" });

    for (const [id, list] of [
      ["claude-coding-v1", ["pat-url", "none-url", "bearer-url", "app-1"]],
      ["p-list", ["private-a", "orphan-x"]],
    ] as const) {
      await pool.query(
        `INSERT INTO installation_profiles (id, name, version, origin, definition,
           permission_mode, fingerprint, repository_ids)
         VALUES ($1, $1, 1, 'console', '{"permission_mode":"default"}', 'default', 'fp', $2)`,
        [id, JSON.stringify(list)],
      );
    }

    // Pins that do not fit the schema: a 33rd entry, a scalar and object in
    // the array. The URL value is still a candidate.
    const wide = [
      ...Array.from({ length: 32 }, (_, i) => `filler-${i}`),
      "none-url",
    ];
    const a1 = await agent(ids.a, "agent-one", {
      pins: PIN(["pat-url", 5, { nested: "none-url" }]),
      releaseRepository: "private-a",
    });
    const a2 = await agent(ids.a, "agent-two", {
      pins: PIN(["app-1"]),
      settings: ["bearer-url"],
      start: "bearer-url",
    });
    const a3 = await agent(ids.a, "agent-wide", { pins: PIN(wide) });
    const a4 = await agent(ids.a, "agent-object", {
      pins: PIN({ not: "an array" }),
    });
    const a5 = await agent(ids.a, "agent-valid", {
      pins: PIN(["pat-url", "none-url"]),
    });
    const b1 = await agent(ids.b, "agent-b", { pins: PIN([]) });
    await session("valid-policy", {
      workspaceId: ids.a,
      releaseId: a5.releaseId,
    });

    await session("release-policy", {
      workspaceId: ids.a,
      releaseId: a1.releaseId,
    });
    // the same value by two paths: each path is judged on its own
    await session("dual", {
      workspaceId: ids.a,
      releaseId: a1.releaseId,
      repositoryId: "pat-url",
    });
    await session("agent-policy", {
      workspaceId: ids.a,
      releaseId: a2.releaseId,
      source: "agent",
    });
    await session("primary-idle", {
      workspaceId: ids.a,
      releaseId: a1.releaseId,
      status: "idle",
      repositoryId: "none-url",
      attached: [],
    });
    await session("attached", {
      workspaceId: ids.a,
      releaseId: a2.releaseId,
      attached: ["pat-url"],
    });
    await session("wide", { workspaceId: ids.a, releaseId: a3.releaseId });
    await session("object", { workspaceId: ids.a, releaseId: a4.releaseId });
    await session("stopped", {
      workspaceId: ids.a,
      releaseId: a1.releaseId,
      status: "stopped",
      repositoryId: "none-url",
    });
    await session("failed", {
      workspaceId: ids.a,
      releaseId: a1.releaseId,
      status: "failed",
      repositoryId: "bearer-url",
    });
    await session("normal-app", {
      workspaceId: ids.a,
      releaseId: a1.releaseId,
      repositoryId: "app-1",
      attached: [],
    });
    await session("removed-row", {
      workspaceId: ids.b,
      releaseId: b1.releaseId,
      repositoryId: "gone-url",
      attached: [],
    });
    // Agentless sessions: A's uses private-a, B's uses shared-x; the window
    // keeps a stopped one 5 days old and drops one 40 days old.
    await session("agentless-a", {
      workspaceId: ids.a,
      repositoryId: "private-a",
      profile: "p-list",
    });
    await session("agentless-b", {
      workspaceId: ids.b,
      repositoryId: "shared-x",
      profile: "p-list",
    });
    await session("agentless-url", {
      workspaceId: ids.b,
      repositoryId: "none-url",
      profile: "p-list",
    });
    await session("recent", {
      workspaceId: ids.a,
      status: "stopped",
      repositoryId: "recent-x",
      profile: "p-list",
      ageDays: 5,
    });
    await session("old", {
      workspaceId: ids.a,
      status: "stopped",
      repositoryId: "old-x",
      profile: "p-list",
      ageDays: 40,
    });
    await session("no-workspace", {
      workspaceId: null,
      repositoryId: "loose-x",
      profile: "p-list",
    });

    rowsBefore = await tableCounts();
    report = await generateReport(pool, async () => catalog());
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const workspaceOf = (id: string) =>
    report.workspaces.find((w) => w.workspace_id === id);
  const candidate = (key: string, repository: string, via: string) =>
    report.direct_check.candidates.find(
      (c) =>
        c.session_id === sessionIds[key] &&
        c.repository_id === repository &&
        c.via === via,
    );

  test("counts candidates over every path and every NULL attached source", () => {
    const found = report.direct_check.candidates.map(
      (c) => `${c.via}:${c.repository_id}`,
    );
    // release pin and agent settings, both through NULL attached
    expect(candidate("release-policy", "pat-url", "policy")).toBeDefined();
    expect(candidate("agent-policy", "bearer-url", "policy")).toBeDefined();
    // main repository on an idle session
    expect(candidate("primary-idle", "none-url", "primary")).toBeDefined();
    // attached list wins over the policy list: only its own value counts
    expect(candidate("attached", "pat-url", "attached")).toBeDefined();
    expect(candidate("attached", "pat-url", "policy")).toBeUndefined();
    // a list that does not fit the schema is still expanded
    expect(candidate("wide", "none-url", "policy")).toBeDefined();
    // not an array: nothing to expand
    expect(
      report.direct_check.candidates.some(
        (c) => c.session_id === sessionIds.object,
      ),
    ).toBe(false);
    // ended sessions and App rows are not candidates
    for (const key of ["stopped", "failed", "normal-app"]) {
      expect(
        report.direct_check.candidates.some(
          (c) => c.session_id === sessionIds[key],
        ),
      ).toBe(false);
    }
    // a removed row is still read (removed_at is not consulted)
    expect(candidate("removed-row", "gone-url", "primary")).toBeDefined();
    expect(found.length).toBe(report.direct_check.candidate_count);
    expect(report.direct_check.verdict).toBe("candidates_present");
  });

  test("splits candidates from confirmed and judges by candidates", () => {
    const status = (key: string, repo: string, via: string) =>
      candidate(key, repo, via)?.confirmed;
    expect(status("primary-idle", "none-url", "primary")).toBe("confirmed");
    expect(status("dual", "pat-url", "primary")).toBe("confirmed");
    expect(status("dual", "pat-url", "policy")).toBe("not_reachable");
    // valid pins: only a registered-App repository has a connection; a
    // GitHub-hosted PAT repository has none any more
    expect(status("valid-policy", "pat-url", "policy")).toBe("not_reachable");
    expect(status("valid-policy", "none-url", "policy")).toBe("not_reachable");
    // pins that do not fit the schema are counted as candidates, but the
    // gate reads them as closed
    expect(status("release-policy", "pat-url", "policy")).toBe("not_reachable");
    // no connection for a bearer or an off-GitHub URL repository
    expect(status("agent-policy", "bearer-url", "policy")).toBe(
      "not_reachable",
    );
    expect(status("wide", "none-url", "policy")).toBe("not_reachable");
    // the catalog does not carry a removed row
    expect(status("removed-row", "gone-url", "primary")).toBe("not_in_catalog");
    const direct = report.direct_check;
    expect(direct.candidate_count).toBeGreaterThan(direct.confirmed_count ?? 0);
    expect(direct.confirmed).toMatchObject({
      secret_resolution_checked: false,
    });
  });

  test("says not applicable where the image cannot compute confirmed", async () => {
    const without = await generateReport(pool, null);
    expect(without.direct_check.confirmed).toBe("not_applicable");
    expect(without.direct_check.confirmed_count).toBeNull();
    expect(without.direct_check.candidate_count).toBe(
      report.direct_check.candidate_count,
    );
    expect(
      without.direct_check.candidates.every(
        (c) => c.confirmed === "not_applicable",
      ),
    ).toBe(true);
  });

  test("reports each URL repository with its workspaces, agents and ceilings", () => {
    const pat = report.repositories.find((r) => r.id === "pat-url");
    expect(pat?.auth_kind).toBe("basic");
    const inA = pat?.workspaces.find((w) => w.workspace_id === ids.a);
    expect(inA?.in_ceiling).toBe(true);
    expect(inA?.agents.map((a) => a.name)).toContain("agent-one");
    const bearer = report.repositories.find((r) => r.id === "bearer-url");
    expect(
      bearer?.workspaces
        .flatMap((w) => w.agents)
        .find((a) => a.name === "agent-two")?.via,
    ).toEqual(["active_session", "agent_settings", "start_repository"]);
    // an agentless session still places the value in its workspace
    const none = report.repositories.find((r) => r.id === "none-url");
    expect(
      none?.workspaces.find((w) => w.workspace_id === ids.b)
        ?.active_session_count,
    ).toBe(1);
    expect(report.repositories.find((r) => r.id === "gone-url")?.removed).toBe(
      true,
    );
    expect(report.repositories.some((r) => r.id === "app-1")).toBe(false);
  });

  test("attributes explicit values to the workspace that uses them", () => {
    const a = workspaceOf(ids.a);
    const basis = (id: string) => a?.attributed.find((v) => v.id === id)?.basis;
    expect(basis("private-a")).toEqual(["active_release", "session"]);
    expect(basis("recent-x")).toEqual(["session"]);
    // 40 days old and stopped: outside the window
    expect(basis("old-x")).toBeUndefined();
    const b = workspaceOf(ids.b);
    expect(b?.attributed.map((v) => v.id)).toEqual(["shared-x"]);
  });

  test("keeps a value of workspace A out of workspace B", () => {
    const b = workspaceOf(ids.b);
    expect(b?.ceiling_after_ids.map((v) => v.id)).not.toContain("private-a");
    for (const group of b?.session_groups ?? []) {
      expect(group.after).not.toContain("private-a");
    }
    expect(workspaceOf(ids.a)?.ceiling_after_ids.map((v) => v.id)).toContain(
      "private-a",
    );
  });

  test("shows before and after per workspace for agent and agentless sessions", () => {
    const a = workspaceOf(ids.a);
    expect(a?.ceiling_before).toMatchObject({
      state: "valid",
      github_app_repositories: "listed",
    });
    // an existing URL value stays in the ceiling
    expect(a?.ceiling_after_ids).toContainEqual({
      id: "pat-url",
      kind: "legacy",
    });
    const groups = a?.session_groups ?? [];
    const agentless = groups.find(
      (g) => g.kind === "agentless" && g.profile_id === "p-list",
    );
    expect(agentless?.judged_by).toBe("profile");
    expect(agentless?.before).toEqual(["orphan-x", "private-a"]);
    // the profile-only value is narrowed away; the App row and URL value widen
    expect(agentless?.narrowed).toEqual(["orphan-x"]);
    expect(agentless?.widened).toContain("app-1");
    // agent sessions on the agent policy are judged by the ceiling
    const byCeiling = groups.find(
      (g) => g.kind === "agent" && g.judged_by === "workspace_ceiling",
    );
    expect(byCeiling?.before).toEqual(["pat-url"]);
    expect(byCeiling?.widened_non_app).toEqual(["private-a", "recent-x"]);
    // the profile's own groups stay apart from the ceiling-judged one
    expect(
      groups.some((g) => g.kind === "agent" && g.judged_by === "profile"),
    ).toBe(true);

    expect(workspaceOf(ids.b)?.ceiling_before.state).toBe("absent");
    expect(workspaceOf(ids.c)?.ceiling_before.state).toBe("invalid");
    const bGroup = workspaceOf(ids.b)?.session_groups.find(
      (g) => g.kind === "agentless",
    );
    expect(bGroup?.narrowed).toEqual(["orphan-x", "private-a"]);
    expect(bGroup?.widened_non_app).toEqual(["shared-x"]);
    expect(report.non_app_widening_total).toBeGreaterThan(0);
  });

  test("reports values no workspace uses as unattributed", () => {
    expect(report.unattributed).toContainEqual({
      reason: "profile_list_only",
      profile_id: "p-list",
      repository_id: "orphan-x",
      selectable_by: [ids.a, ids.b, ids.c].sort(),
    });
    expect(report.unattributed).toContainEqual({
      reason: "session_without_workspace",
      session_id: sessionIds["no-workspace"],
      profile_id: "p-list",
      repository_id: "loose-x",
      selectable_by: [],
    });
    expect(
      report.unattributed.some((u) => u.repository_id === "private-a"),
    ).toBe(false);
  });

  test("carries no repository URL, credential or secret", () => {
    const text = JSON.stringify(report);
    for (const secret of [
      "example.invalid",
      "github.com",
      "pat-secret-value",
      "bearer-secret-value",
      "catalog-provider-key",
    ]) {
      expect(text.includes(secret)).toBe(false);
    }
  });

  test("refuses every write and leaves the data as it was", async () => {
    expect(await tableCounts()).toBe(rowsBefore);
    await expect(
      withReadOnlySnapshot(pool, (client) =>
        client.query(
          "INSERT INTO workspaces (id, slug, name) VALUES (gen_random_uuid(), 'w', 'w')",
        ),
      ),
    ).rejects.toMatchObject({ code: "25006" });
    await expect(
      withReadOnlySnapshot(pool, (client) =>
        client.query("UPDATE github_workspace_settings SET revision = 99"),
      ),
    ).rejects.toMatchObject({ code: "25006" });
    // the pool the command line uses starts every transaction read only
    const guarded = createEnforcedPool(
      database.url,
      createLogger(),
      "repository-migration-report-test",
      JOB_POOL_TIMEOUTS,
      { readOnly: true },
    );
    try {
      await expect(
        guarded.query("DELETE FROM catalog_repositories"),
      ).rejects.toMatchObject({ code: "25006" });
    } finally {
      await guarded.end();
    }
    expect(await tableCounts()).toBe(rowsBefore);
  });
});

integration("the report on a one-workspace installation", () => {
  let database: TempDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "repo_report_solo" });
    pool = new Pool({ connectionString: database.url, max: 2 });
    const workspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'solo', 'solo')",
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO catalog_repositories (id, owner, name, url, branch,
         auth_kind, auth, credential_source, source)
       VALUES ('solo-x', 'acme', 'solo-x', 'https://example.invalid/x', 'main',
         'github_app_explicit', '{"kind":"basic"}', 'external', 'seed')`,
    );
    await pool.query(
      `INSERT INTO installation_profiles (id, name, version, origin, definition,
         permission_mode, fingerprint, repository_ids)
       VALUES ('p', 'p', 1, 'console', '{"permission_mode":"default"}', 'default', 'fp', '["solo-x"]')`,
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("attributes every profile value to the only workspace", async () => {
    const report = await generateReport(pool, null);
    expect(report.workspaces[0]?.attributed).toEqual([
      { id: "solo-x", basis: ["single_workspace"] },
    ]);
    expect(report.unattributed).toEqual([]);
    expect(report.direct_check.verdict).toBe("clear");
  });
});
