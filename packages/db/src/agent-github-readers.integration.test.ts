import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  GITHUB_CEILING_NONE,
  GITHUB_FEATURES_NONE,
  GITHUB_POLICY_CLOSED,
  type ReceiptActor,
} from "@werft-ai/contracts";
import type { PushRequestStore } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentGitHubStore } from "./agent-github.ts";
import {
  agentGitHubSettingsOf,
  captureGitHubPolicyStart,
  createPostgresGitHubGateStore,
  createPostgresGitHubSettingsStore,
  ensureInstalledRepositoryCeiling,
  workspaceRepositoryCeiling,
} from "./github-settings.ts";
import { createPostgresGitHubMcpStore } from "./mcp-egress.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const ACTOR: ReceiptActor = {
  principal: { kind: "api_key", id: "key-writer" },
  actor_user_id: null,
  agent_id: null,
};
const COMMIT = "b".repeat(40);
const PIN_OFF = {
  repositories: ["sample-app"],
  push_approval: false,
  features: { ...GITHUB_FEATURES_NONE },
  actions_allow: [],
};

const START_ATTACHED_ALLOW = {
  enabled: true,
  revision: 1,
  settings: {
    repositories: ["sample-app"],
    push_approval: false,
    features: { ...GITHUB_FEATURES_NONE },
    actions_allow: [],
  },
  push_attached: "allow",
};

integration("the readers of an agent's GitHub settings", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pushes: PushRequestStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_github_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    pushes = createPostgresPushRequests(db);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  /** A workspace, its agent and a session of the agent's active release. */
  async function fixture(
    options: {
      source?: "release" | "agent";
      pins?: object;
      start?: object;
      githubEnabled?: boolean;
    } = {},
  ) {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    const versionId = randomUUID();
    const releaseId = `sha256:${randomUUID()}`;
    const sessionId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'owner')",
      [userId, `${userId}@example.invalid`],
    );
    await pool.query(
      "WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, github_enabled, managing_team_id) VALUES ($1, $2, $3, 'a', $4, (SELECT id FROM t))",
      [
        agentId,
        workspaceId,
        `a-${agentId.slice(0, 8)}`,
        options.githubEnabled ?? true,
      ],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         repository_id, runtime_config_snapshot, effective_tools, policy_pins,
         ${RELEASE_SPEC_SQL_COLUMNS})
       VALUES ($1, $2, $3, $4, 'sample-app', '{}', '{}', $5, ${releaseSpecSqlValues()})`,
      [
        releaseId,
        agentId,
        versionId,
        "a".repeat(64),
        JSON.stringify({ github: PIN_OFF, ...options.pins }),
      ],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, agent_release_id, created_by_user_id,
         github_policy_source, checkpoint_revision, github_policy_start)
       VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', 'sample-app',
         $3, $4, $5, $6, 1, $7)`,
      [
        sessionId,
        workspaceId,
        workspaceId,
        releaseId,
        userId,
        options.source ?? "release",
        options.start === undefined ? null : JSON.stringify(options.start),
      ],
    );
    return { workspaceId, agentId, releaseId, sessionId };
  }

  async function settingsRow(
    workspaceId: string,
    agentId: string,
    row: {
      repositories?: unknown[];
      pushApproval?: boolean;
      features?: object;
      actionsAllow?: object[];
      revision?: number;
      /** A person's id for a row a person saved; absent for a migration's. */
      updatedBy?: string;
      /** Absent: null, a row saved before the column. */
      pushAttached?: string;
    },
  ) {
    await pool.query(
      `INSERT INTO agent_github_settings (agent_id, workspace_id, repositories,
         push_approval, features, actions_allow, revision, updated_by, push_attached)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (agent_id) DO UPDATE SET
         repositories = EXCLUDED.repositories,
         push_approval = EXCLUDED.push_approval,
         features = EXCLUDED.features,
         actions_allow = EXCLUDED.actions_allow,
         revision = EXCLUDED.revision,
         updated_by = EXCLUDED.updated_by,
         push_attached = EXCLUDED.push_attached`,
      [
        agentId,
        workspaceId,
        JSON.stringify(row.repositories ?? ["sample-app"]),
        row.pushApproval ?? true,
        JSON.stringify(row.features ?? GITHUB_FEATURES_NONE),
        JSON.stringify(row.actionsAllow ?? []),
        row.revision ?? 1,
        row.updatedBy ?? null,
        row.pushAttached ?? null,
      ],
    );
  }

  const request = (input: {
    workspaceId: string;
    sessionId: string;
    policyApproval: Awaited<
      ReturnType<PushRequestStore["findSession"]>
    > extends infer Found
      ? Found extends { policyApproval: infer Approval }
        ? Approval
        : never
      : never;
    policyFields?: object;
    /** Default: the session's own repository. */
    repositoryId?: string;
  }) =>
    pushes.create({
      ownerId: input.workspaceId,
      sessionId: input.sessionId,
      actor: ACTOR,
      idempotencyKey: `k-${randomUUID()}`,
      payloadHash: "h",
      repositoryId: input.repositoryId ?? "sample-app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: COMMIT,
      policyApproval: input.policyApproval,
      policyFields: input.policyFields ?? {},
    });

  async function claimed(): Promise<string[]> {
    const sessionIds: string[] = [];
    for (;;) {
      const job = await pushes.claimNextApproved(60_000);
      if (job === null) return sessionIds;
      sessionIds.push(job.sessionId);
    }
  }

  const stateOf = async (id: string) => {
    const { rows } = await pool.query<{
      state: string;
      approval_basis: string | null;
      approval_settings_revision: number | null;
    }>(
      "SELECT state, approval_basis, approval_settings_revision FROM push_requests WHERE id = $1",
      [id],
    );
    return rows[0];
  };

  test("the gate reads a row on an `agent` session, and the pin on a `release` one", async () => {
    const { workspaceId, agentId, sessionId } = await fixture({
      source: "agent",
    });
    const gate = createPostgresGitHubGateStore(db);
    expect((await gate.context(sessionId))?.policy).toEqual({
      source: "agent",
      settings: GITHUB_POLICY_CLOSED,
      startRepositoryId: null,
      agentSettingsRevision: null,
      currentRepositories: null,
      startActionsAllow: null,
      enabledAtStart: true,
      pushAttached: "ask",
    });
    await settingsRow(workspaceId, agentId, {
      repositories: ["sample-app", "docs"],
      revision: 4,
    });
    expect((await gate.context(sessionId))?.policy).toMatchObject({
      source: "agent",
      settings: { repositories: ["sample-app", "docs"] },
      agentSettingsRevision: 4,
    });
    await settingsRow(workspaceId, agentId, { repositories: [1], revision: 5 });
    expect((await gate.context(sessionId))?.policy).toMatchObject({
      source: "agent",
      settings: "invalid",
      agentSettingsRevision: 5,
    });

    const release = await fixture();
    await settingsRow(release.workspaceId, release.agentId, {
      repositories: ["docs"],
    });
    expect((await gate.context(release.sessionId))?.policy).toEqual({
      source: "release",
      settings: PIN_OFF,
      startRepositoryId: null,
      agentSettingsRevision: null,
      currentRepositories: null,
      startActionsAllow: null,
      enabledAtStart: true,
      pushAttached: "ask",
    });
  });

  test("the workspace's repository ceiling and the row reach session start", async () => {
    const { workspaceId, agentId, sessionId } = await fixture({
      source: "agent",
    });
    expect(await workspaceRepositoryCeiling(db, workspaceId)).toBeNull();
    expect(await agentGitHubSettingsOf(db, agentId)).toBeNull();
    await settingsRow(workspaceId, agentId, { revision: 2 });
    expect(await agentGitHubSettingsOf(db, agentId)).toMatchObject({
      repositories: ["sample-app"],
      revision: 2,
    });
    const ceiling = {
      repository_ids: ["sample-app"],
      github_app_repositories: "listed" as const,
    };
    await pool.query(
      "INSERT INTO github_workspace_settings (workspace_id, ceiling, repository_ceiling, revision) VALUES ($1, $2, $3, 3)",
      [
        workspaceId,
        JSON.stringify(GITHUB_CEILING_NONE),
        JSON.stringify(ceiling),
      ],
    );
    expect(await workspaceRepositoryCeiling(db, workspaceId)).toEqual(ceiling);
    expect(
      await createPostgresGitHubGateStore(db).context(sessionId),
    ).toMatchObject({ repositoryCeiling: ceiling, ceilingRevision: 3 });
  });

  test("the feature count reads each agent's policy; a row that cannot be read counts for nothing", async () => {
    const features = { ...GITHUB_FEATURES_NONE, review: true };
    const { workspaceId, agentId } = await fixture({
      pins: { github: { ...PIN_OFF, features } },
    });
    const store = createPostgresGitHubSettingsStore(db);
    expect((await store.agentsUsing(workspaceId)).review).toBe(1);
    await settingsRow(workspaceId, agentId, { features });
    expect((await store.agentsUsing(workspaceId)).review).toBe(1);
    await settingsRow(workspaceId, agentId, {
      features: GITHUB_FEATURES_NONE,
    });
    expect((await store.agentsUsing(workspaceId)).review).toBe(0);
    await settingsRow(workspaceId, agentId, {
      repositories: [1],
      features,
    });
    expect((await store.agentsUsing(workspaceId)).review).toBe(0);
  });

  test("the built-in server's state carries the source; a bad row reads as none", async () => {
    const { workspaceId, agentId, sessionId } = await fixture({
      source: "agent",
    });
    const mcp = createPostgresGitHubMcpStore(db);
    await settingsRow(workspaceId, agentId, {});
    expect(await mcp.sessionState(sessionId)).toMatchObject({
      source: "agent",
      github: { repositories: ["sample-app"] },
    });
    await settingsRow(workspaceId, agentId, { repositories: [1] });
    expect(await mcp.sessionState(sessionId)).toMatchObject({
      source: "agent",
      github: null,
    });
    const release = await fixture();
    expect(await mcp.sessionState(release.sessionId)).toMatchObject({
      source: "release",
      github: PIN_OFF,
    });
  });

  test("a push the agent's row approved goes back to a person when the row turns approval on before the claim", async () => {
    const { workspaceId, agentId, sessionId } = await fixture({
      source: "agent",
    });
    await settingsRow(workspaceId, agentId, {
      pushApproval: false,
      revision: 2,
    });
    const found = await pushes.findSession(workspaceId, sessionId);
    expect(found?.policyApproval).toMatchObject({
      source: "agent",
      settingsRevision: 2,
    });
    const created = await request({
      workspaceId,
      sessionId,
      policyApproval: found?.policyApproval ?? null,
      policyFields: found?.policyFields ?? {},
    });
    if (created.outcome !== "written") throw new Error("not written");
    expect(await stateOf(created.request.id)).toEqual({
      state: "approved",
      approval_basis: "policy",
      approval_settings_revision: 2,
    });

    await settingsRow(workspaceId, agentId, {
      pushApproval: true,
      revision: 3,
    });
    expect(await claimed()).not.toContain(sessionId);
    expect(await stateOf(created.request.id)).toEqual({
      state: "requested",
      approval_basis: null,
      approval_settings_revision: null,
    });
    const { rows } = await pool.query<{ result: Record<string, unknown> }>(
      `SELECT result FROM receipts
        WHERE owner_id = $1 AND operation = 'resolve_push'
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
    expect(rows[0]?.result).toMatchObject({
      refusal: "approval_required",
      policy_source: "agent",
      agent_settings_revision: 2,
    });
  });

  describe("push_attached", () => {
    const columnOf = async (agentId: string) => {
      const { rows } = await pool.query<{ push_attached: string | null }>(
        "SELECT push_attached FROM agent_github_settings WHERE agent_id = $1",
        [agentId],
      );
      return rows[0]?.push_attached;
    };

    test("a row written without the column holds null and reads as ask, with no approval by policy", async () => {
      const { workspaceId, agentId, sessionId } = await fixture({
        source: "agent",
      });
      // The row as it was stored before the column existed.
      await settingsRow(workspaceId, agentId, {
        pushApproval: false,
        updatedBy: randomUUID(),
      });
      expect(await columnOf(agentId)).toBeNull();
      expect(await agentGitHubSettingsOf(db, agentId)).toMatchObject({
        pushAttached: null,
      });
      const found = await pushes.findSession(workspaceId, sessionId);
      expect(found).toMatchObject({ push: "ask" });
      // Reading it does not write the column.
      expect(await columnOf(agentId)).toBeNull();
    });

    test("the column accepts allow, ask and deny and nothing else", async () => {
      const { workspaceId, agentId } = await fixture({ source: "agent" });
      for (const value of ["allow", "ask", "deny"]) {
        await settingsRow(workspaceId, agentId, { pushAttached: value });
        expect(await columnOf(agentId)).toBe(value);
      }
      await expect(
        settingsRow(workspaceId, agentId, { pushAttached: "sometimes" }),
      ).rejects.toThrow();
    });

    test("approval off with push_attached allow is a policy approval for any repository; narrowing either setting sends it back to a person", async () => {
      // The two cases the old split rule let through: the own repository with
      // push_attached narrowed, an attached one with push_approval turned on.
      const NARROWED = [
        { repositoryId: "docs", pushApproval: false, pushAttached: "ask" },
        { repositoryId: "docs", pushApproval: false, pushAttached: "deny" },
        { repositoryId: "docs", pushApproval: true, pushAttached: "allow" },
        {
          repositoryId: "sample-app",
          pushApproval: false,
          pushAttached: "ask",
        },
        {
          repositoryId: "sample-app",
          pushApproval: false,
          pushAttached: "deny",
        },
        {
          repositoryId: "sample-app",
          pushApproval: true,
          pushAttached: "allow",
        },
      ];
      for (const narrowed of NARROWED) {
        const { workspaceId, agentId, sessionId } = await fixture({
          source: "agent",
          start: START_ATTACHED_ALLOW,
        });
        await settingsRow(workspaceId, agentId, {
          pushApproval: false,
          pushAttached: "allow",
          revision: 2,
          updatedBy: randomUUID(),
        });
        const found = await pushes.findSession(workspaceId, sessionId);
        expect(found?.push).toBe("allow");
        expect(found?.policyApproval).toMatchObject({
          source: "agent",
          settingsRevision: 2,
        });
        const created = await request({
          workspaceId,
          sessionId,
          repositoryId: narrowed.repositoryId,
          policyApproval: found?.policyApproval ?? null,
          policyFields: found?.policyFields ?? {},
        });
        if (created.outcome !== "written") throw new Error("not written");
        expect(await stateOf(created.request.id)).toMatchObject({
          state: "approved",
          approval_basis: "policy",
        });

        await settingsRow(workspaceId, agentId, {
          pushApproval: narrowed.pushApproval,
          pushAttached: narrowed.pushAttached,
          revision: 3,
          updatedBy: randomUUID(),
        });
        expect(await claimed()).not.toContain(sessionId);
        expect(await stateOf(created.request.id)).toMatchObject({
          state: "requested",
          approval_basis: null,
        });
      }
    });

    test("the store decides the stricter of push_approval and push_attached across snapshot, no snapshot, unreadable snapshot and release sources", async () => {
      const AGENT = [
        // [push_approval, push_attached, decision]
        [false, "allow", "allow"],
        [false, "ask", "ask"],
        [false, "deny", "deny"],
        [true, "allow", "ask"],
        [true, "ask", "ask"],
        [true, "deny", "deny"],
      ] as const;
      for (const [pushApproval, pushAttached, decision] of AGENT) {
        const { workspaceId, agentId, sessionId } = await fixture({
          source: "agent",
          start: START_ATTACHED_ALLOW,
        });
        await settingsRow(workspaceId, agentId, {
          pushApproval,
          pushAttached,
          revision: 2,
          updatedBy: randomUUID(),
        });
        expect((await pushes.findSession(workspaceId, sessionId))?.push).toBe(
          decision,
        );
      }
      // No snapshot means no recorded start value for push_attached: it counts
      // as ask, so a later allow cannot loosen the session, but deny still binds.
      const NO_SNAPSHOT = [
        [false, "allow", "ask"],
        [false, "ask", "ask"],
        [false, "deny", "deny"],
        [true, "allow", "ask"],
        [true, "ask", "ask"],
        [true, "deny", "deny"],
      ] as const;
      for (const [pushApproval, pushAttached, decision] of NO_SNAPSHOT) {
        const { workspaceId, agentId, sessionId } = await fixture({
          source: "agent",
        });
        await settingsRow(workspaceId, agentId, {
          pushApproval,
          pushAttached,
          revision: 2,
          updatedBy: randomUUID(),
        });
        expect((await pushes.findSession(workspaceId, sessionId))?.push).toBe(
          decision,
        );
      }
      // A release pin carries no push_attached: it reads as ask, so a release
      // session never gets a policy approval.
      for (const pushApproval of [false, true]) {
        const { workspaceId, sessionId } = await fixture({
          pins: { github: { ...PIN_OFF, push_approval: pushApproval } },
        });
        expect((await pushes.findSession(workspaceId, sessionId))?.push).toBe(
          "ask",
        );
      }
      // A row a person saved for the agent afterwards can take a release
      // session from ask to deny, never to allow.
      for (const [pushAttached, decision] of [
        ["allow", "ask"],
        ["ask", "ask"],
        ["deny", "deny"],
      ] as const) {
        const { workspaceId, agentId, sessionId } = await fixture();
        await settingsRow(workspaceId, agentId, {
          pushApproval: false,
          pushAttached,
          revision: 2,
          updatedBy: randomUUID(),
        });
        expect((await pushes.findSession(workspaceId, sessionId))?.push).toBe(
          decision,
        );
      }
      // A snapshot this image cannot read decides nothing looser than ask.
      for (const pushAttached of ["allow", "ask", "deny"]) {
        const { workspaceId, agentId, sessionId } = await fixture({
          source: "agent",
          start: { enabled: true },
        });
        await settingsRow(workspaceId, agentId, {
          pushApproval: false,
          pushAttached,
          revision: 2,
          updatedBy: randomUUID(),
        });
        expect((await pushes.findSession(workspaceId, sessionId))?.push).toBe(
          "ask",
        );
      }
    });

    // The real save path, as the PUT route reaches it. `pushAttached` is left
    // out of the input unless a test names it.
    const save = (
      workspaceId: string,
      agentId: string,
      input: {
        expectedRevision: number | null;
        pushApproval: boolean;
        pushAttached?: "allow" | "ask" | "deny";
      },
    ) =>
      createPostgresAgentGitHubStore(db).putSettings({
        workspaceId,
        agentId,
        expectedRevision: input.expectedRevision,
        settings: {
          repositories: ["sample-app"],
          push_approval: input.pushApproval,
          features: { ...GITHUB_FEATURES_NONE },
          actions_allow: [],
        },
        startRepositoryId: null,
        ...(input.pushAttached === undefined
          ? {}
          : { pushAttached: input.pushAttached }),
        userId: randomUUID(),
        principal: { ownerId: workspaceId },
        managerRoles: [],
        check: () => {},
      });

    test("a row from before the column stays null, and asks, after a save that changes another field", async () => {
      const { workspaceId, agentId } = await fixture({ source: "agent" });
      await settingsRow(workspaceId, agentId, {
        pushApproval: true,
        updatedBy: randomUUID(),
      });
      expect(await columnOf(agentId)).toBeNull();
      const saved = await save(workspaceId, agentId, {
        expectedRevision: 1,
        pushApproval: false,
      });
      expect(saved).toMatchObject({ outcome: "saved", revision: 2 });
      expect(await columnOf(agentId)).toBeNull();
      expect(await agentGitHubSettingsOf(db, agentId)).toMatchObject({
        pushApproval: false,
        pushAttached: null,
      });
    });

    test("a first save that leaves the field out stores allow", async () => {
      const { workspaceId, agentId } = await fixture({ source: "agent" });
      expect(await columnOf(agentId)).toBeUndefined();
      const saved = await save(workspaceId, agentId, {
        expectedRevision: null,
        pushApproval: true,
      });
      expect(saved).toMatchObject({ outcome: "saved", revision: 1 });
      expect(await columnOf(agentId)).toBe("allow");
    });

    test("a save that leaves the field out keeps a stored deny", async () => {
      const { workspaceId, agentId } = await fixture({ source: "agent" });
      await save(workspaceId, agentId, {
        expectedRevision: null,
        pushApproval: true,
        pushAttached: "deny",
      });
      expect(await columnOf(agentId)).toBe("deny");
      const saved = await save(workspaceId, agentId, {
        expectedRevision: 1,
        pushApproval: false,
      });
      expect(saved).toMatchObject({ outcome: "saved", revision: 2 });
      expect(await columnOf(agentId)).toBe("deny");
    });

    test("a session with no snapshot is capped at ask even when the row now says allow", async () => {
      const { workspaceId, agentId, sessionId } = await fixture({
        source: "agent",
      });
      await settingsRow(workspaceId, agentId, {
        pushApproval: true,
        pushAttached: "allow",
        updatedBy: randomUUID(),
      });
      expect(await pushes.findSession(workspaceId, sessionId)).toMatchObject({
        push: "ask",
      });
    });

    test("while the row still says allow, the approved attached push is claimed", async () => {
      const { workspaceId, agentId, sessionId } = await fixture({
        source: "agent",
        start: START_ATTACHED_ALLOW,
      });
      await settingsRow(workspaceId, agentId, {
        pushApproval: false,
        pushAttached: "allow",
        updatedBy: randomUUID(),
      });
      const found = await pushes.findSession(workspaceId, sessionId);
      await request({
        workspaceId,
        sessionId,
        repositoryId: "docs",
        policyApproval: found?.policyApproval ?? null,
      });
      expect(await claimed()).toContain(sessionId);
    });
  });

  test("the row still off, the push is claimed; a person's approval outlives the row", async () => {
    const off = await fixture({
      source: "agent",
      start: START_ATTACHED_ALLOW,
    });
    await settingsRow(off.workspaceId, off.agentId, {
      pushApproval: false,
      pushAttached: "allow",
    });
    const found = await pushes.findSession(off.workspaceId, off.sessionId);
    await request({
      workspaceId: off.workspaceId,
      sessionId: off.sessionId,
      policyApproval: found?.policyApproval ?? null,
    });

    const person = await fixture({ source: "agent" });
    await settingsRow(person.workspaceId, person.agentId, {
      pushApproval: true,
    });
    const asked = await request({
      workspaceId: person.workspaceId,
      sessionId: person.sessionId,
      policyApproval: null,
    });
    if (asked.outcome !== "written") throw new Error("not written");
    await pushes.decide({
      ownerId: person.workspaceId,
      sessionId: person.sessionId,
      pushRequestId: asked.request.id,
      actor: ACTOR,
      decision: "approve",
      gitCommit: COMMIT,
      reason: null,
      idempotencyKey: "k-decide",
      payloadHash: "h-decide",
    });
    expect(await stateOf(asked.request.id)).toMatchObject({
      state: "approved",
      approval_basis: "human",
    });
    await settingsRow(person.workspaceId, person.agentId, {
      pushApproval: false,
      revision: 2,
    });

    const sessionIds = await claimed();
    expect(sessionIds).toContain(off.sessionId);
    expect(sessionIds).toContain(person.sessionId);
  });

  test("a `release` session asks under the one rule, so a policy approval it was handed goes back to a person at the claim", async () => {
    const { workspaceId, sessionId } = await fixture();
    const found = await pushes.findSession(workspaceId, sessionId);
    expect(found?.push).toBe("ask");
    expect(found?.policyApproval).toMatchObject({
      source: "release",
      settingsRevision: null,
    });
    const created = await request({
      workspaceId,
      sessionId,
      policyApproval: found?.policyApproval ?? null,
    });
    if (created.outcome !== "written") throw new Error("not written");
    expect(await claimed()).not.toContain(sessionId);
    expect(await stateOf(created.request.id)).toMatchObject({
      state: "requested",
      approval_basis: null,
    });
  });

  test("a pin that cannot be read keeps a person deciding", async () => {
    const { workspaceId, sessionId } = await fixture({
      pins: { github: { push_approval: false, from: "later" } },
    });
    expect((await pushes.findSession(workspaceId, sessionId))?.push).toBe(
      "ask",
    );
  });

  describe("a session started under a snapshot of the agent's settings", () => {
    const PERSON = randomUUID();
    const REVIEW_ON = { ...GITHUB_FEATURES_NONE, review: true };
    const snapshot = (
      repositories: string[],
      overrides: { enabled?: boolean } = {},
    ) => ({
      enabled: overrides.enabled ?? true,
      revision: 1,
      settings: {
        repositories,
        push_approval: false,
        features: REVIEW_ON,
        actions_allow: [{ workflow: "ci.yml" }],
      },
    });
    const paths = (sessionId: string, workspaceId: string) => ({
      gate: async () =>
        (await createPostgresGitHubGateStore(db).context(sessionId))?.policy,
      mcp: async () =>
        (await createPostgresGitHubMcpStore(db).sessionState(sessionId))
          ?.github,
      push: async () =>
        (await pushes.findSession(workspaceId, sessionId))?.github,
    });

    test("the gate, the built-in server and push all read the meet", async () => {
      const { workspaceId, agentId, sessionId } = await fixture({
        source: "agent",
        start: snapshot(["sample-app", "docs"]),
      });
      await settingsRow(workspaceId, agentId, {
        repositories: ["docs", "later"],
        pushApproval: false,
        features: REVIEW_ON,
        actionsAllow: [{ workflow: "release.yml" }],
        revision: 3,
        updatedBy: PERSON,
      });
      const read = paths(sessionId, workspaceId);
      const expected = {
        repositories: ["docs"],
        push_approval: false,
        features: REVIEW_ON,
        actions_allow: [{ workflow: "release.yml" }],
      };
      expect(await read.gate()).toMatchObject({
        source: "agent",
        settings: expected,
        startActionsAllow: [{ workflow: "ci.yml" }],
        agentSettingsRevision: 3,
      });
      expect(await read.mcp()).toEqual(expected);
      expect(await read.push()).toEqual(expected);

      await settingsRow(workspaceId, agentId, {
        repositories: ["docs", "later"],
        pushApproval: true,
        features: REVIEW_ON,
        revision: 4,
        updatedBy: PERSON,
      });
      expect(await read.push()).toMatchObject({ push_approval: true });
      expect((await pushes.findSession(workspaceId, sessionId))?.push).toBe(
        "ask",
      );
    });

    test("a repository added after the start does not open", async () => {
      const { workspaceId, agentId, sessionId } = await fixture({
        source: "agent",
        start: snapshot(["sample-app"]),
      });
      await settingsRow(workspaceId, agentId, {
        repositories: ["sample-app", "added-later"],
        features: REVIEW_ON,
        updatedBy: PERSON,
      });
      expect(await paths(sessionId, workspaceId).mcp()).toMatchObject({
        repositories: ["sample-app"],
      });
    });

    test("GitHub off now, or off at the start, closes the session on every path", async () => {
      const off = await fixture({
        source: "agent",
        start: snapshot(["sample-app"], { enabled: false }),
      });
      await settingsRow(off.workspaceId, off.agentId, {
        features: REVIEW_ON,
        updatedBy: PERSON,
      });
      const enabledOf = async (sessionId: string, workspaceId: string) => ({
        gate: (await createPostgresGitHubGateStore(db).context(sessionId))
          ?.agent?.githubEnabled,
        mcp: (await createPostgresGitHubMcpStore(db).sessionState(sessionId))
          ?.enabled,
        push: (await pushes.findSession(workspaceId, sessionId))?.githubEnabled,
      });
      // The agent's switch is on again; the session started with it off.
      expect(await enabledOf(off.sessionId, off.workspaceId)).toEqual({
        gate: false,
        mcp: false,
        push: false,
      });

      const on = await fixture({
        source: "agent",
        start: snapshot(["sample-app"]),
      });
      await settingsRow(on.workspaceId, on.agentId, {
        features: REVIEW_ON,
        updatedBy: PERSON,
      });
      expect(await enabledOf(on.sessionId, on.workspaceId)).toEqual({
        gate: true,
        mcp: true,
        push: true,
      });
      await pool.query(
        "UPDATE agents SET github_enabled = false WHERE id = $1",
        [on.agentId],
      );
      expect(await enabledOf(on.sessionId, on.workspaceId)).toEqual({
        gate: false,
        mcp: false,
        push: false,
      });
    });

    test("a snapshot this image cannot read closes the session", async () => {
      const { workspaceId, agentId, sessionId } = await fixture({
        source: "agent",
        start: { enabled: true },
      });
      await settingsRow(workspaceId, agentId, { updatedBy: PERSON });
      const read = paths(sessionId, workspaceId);
      expect((await read.gate())?.settings).toBe("invalid");
      expect(await read.mcp()).toBeNull();
      expect(await read.push()).toBe("invalid");
    });

    test("a session with no snapshot reads the row alone", async () => {
      const { workspaceId, agentId, sessionId } = await fixture({
        source: "agent",
      });
      await settingsRow(workspaceId, agentId, {
        repositories: ["docs"],
        updatedBy: PERSON,
      });
      expect(await paths(sessionId, workspaceId).mcp()).toMatchObject({
        repositories: ["docs"],
      });
    });

    test("capturing reads the row and the switch in the creating transaction and holds the row", async () => {
      const { workspaceId, agentId, releaseId } = await fixture({
        source: "agent",
      });
      await settingsRow(workspaceId, agentId, {
        repositories: ["sample-app", "docs"],
        features: REVIEW_ON,
        revision: 3,
        updatedBy: PERSON,
      });
      let competing: Promise<unknown> = Promise.resolve();
      let settled = false;
      const captured = await db.transaction(async (tx) => {
        const taken = await captureGitHubPolicyStart(tx, releaseId);
        competing = pool
          .query(
            "UPDATE agent_github_settings SET repositories = '[]', revision = revision + 1 WHERE agent_id = $1",
            [agentId],
          )
          .then(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 300));
        // A save waits for the session to exist.
        expect(settled).toBe(false);
        return taken;
      });
      await competing;
      expect(settled).toBe(true);
      expect(captured).toEqual({
        enabled: true,
        revision: 3,
        settings: {
          repositories: ["sample-app", "docs"],
          push_approval: true,
          features: REVIEW_ON,
          actions_allow: [],
        },
        push_attached: "ask",
      });
    });

    test("a new session's snapshot starts at the row's own push_attached, allow included", async () => {
      const { workspaceId, agentId, releaseId } = await fixture({
        source: "agent",
      });
      for (const [stored, expected] of [
        ["allow", "allow"],
        ["deny", "deny"],
        [undefined, "ask"],
      ] as const) {
        await settingsRow(workspaceId, agentId, {
          updatedBy: PERSON,
          ...(stored === undefined ? {} : { pushAttached: stored }),
        });
        const taken = await db.transaction((tx) =>
          captureGitHubPolicyStart(tx, releaseId),
        );
        expect(taken.push_attached).toBe(expected);
      }
    });

    test("capturing also holds the agent's switch until the session exists", async () => {
      const { workspaceId, agentId, releaseId } = await fixture({
        source: "agent",
      });
      await settingsRow(workspaceId, agentId, {
        features: REVIEW_ON,
        updatedBy: PERSON,
      });
      let settled = false;
      let competing: Promise<unknown> = Promise.resolve();
      const captured = await db.transaction(async (tx) => {
        const taken = await captureGitHubPolicyStart(tx, releaseId);
        competing = pool
          .query("UPDATE agents SET github_enabled = false WHERE id = $1", [
            agentId,
          ])
          .then(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
        return taken;
      });
      await competing;
      // The snapshot saw the switch as it was, on.
      expect(captured.enabled).toBe(true);
    });

    test("capturing with no row, or one that cannot be read, is closed", async () => {
      const closed = {
        enabled: false,
        revision: 0,
        settings: GITHUB_POLICY_CLOSED,
      };
      const none = await fixture({ source: "agent" });
      expect(
        await db.transaction((tx) =>
          captureGitHubPolicyStart(tx, none.releaseId),
        ),
      ).toEqual(closed);
      const bad = await fixture({ source: "agent" });
      await settingsRow(bad.workspaceId, bad.agentId, { repositories: [1] });
      expect(
        await db.transaction((tx) =>
          captureGitHubPolicyStart(tx, bad.releaseId),
        ),
      ).toEqual(closed);
    });

    test("a list past the old cap of 32 is stored and read", async () => {
      const many = Array.from({ length: 40 }, (_, i) => `repo-${i}`);
      const { workspaceId, agentId, sessionId } = await fixture({
        source: "agent",
      });
      await settingsRow(workspaceId, agentId, {
        repositories: many,
        updatedBy: PERSON,
      });
      expect(await paths(sessionId, workspaceId).mcp()).toMatchObject({
        repositories: many,
      });
      await expect(
        pool.query(
          "UPDATE agent_github_settings SET repositories = '{}'::jsonb WHERE agent_id = $1",
          [agentId],
        ),
      ).rejects.toThrow(/repositories_check/);
    });
  });

  describe("a release session and a row a person saved", () => {
    const PERSON = randomUUID();
    const row = {
      repositories: ["sample-app", "docs"],
      pushApproval: true,
      features: GITHUB_FEATURES_NONE,
    };

    test("the gate, the built-in server and push all narrow the pin; a migration's row does not", async () => {
      const { workspaceId, agentId, sessionId } = await fixture();
      const gate = createPostgresGitHubGateStore(db);
      const mcp = createPostgresGitHubMcpStore(db);
      const read = async () => ({
        gate: (await gate.context(sessionId))?.policy.settings,
        mcp: (await mcp.sessionState(sessionId))?.github,
        push: (await pushes.findSession(workspaceId, sessionId))?.github,
      });

      await settingsRow(workspaceId, agentId, { ...row, repositories: [] });
      expect(await read()).toEqual({
        gate: PIN_OFF,
        mcp: PIN_OFF,
        push: PIN_OFF,
      });

      await settingsRow(workspaceId, agentId, { ...row, updatedBy: PERSON });
      const narrowed = { ...PIN_OFF, push_approval: true };
      expect(await read()).toEqual({
        gate: narrowed,
        mcp: narrowed,
        push: narrowed,
      });
      expect((await gate.context(sessionId))?.policy).toMatchObject({
        source: "release",
        startActionsAllow: [],
        agentSettingsRevision: 1,
      });

      await settingsRow(workspaceId, agentId, {
        ...row,
        repositories: [],
        updatedBy: PERSON,
      });
      expect(await read()).toEqual({
        gate: { ...narrowed, repositories: [] },
        mcp: { ...narrowed, repositories: [] },
        push: { ...narrowed, repositories: [] },
      });
    });

    test("no row at all changes nothing", async () => {
      const { workspaceId, sessionId } = await fixture();
      expect(
        (await pushes.findSession(workspaceId, sessionId))?.github,
      ).toEqual(PIN_OFF);
    });

    test("a pin-less release keeps no list of its own and takes only the person's list as a limit", async () => {
      const { workspaceId, agentId, sessionId } = await fixture({
        pins: { github: undefined },
      });
      await settingsRow(workspaceId, agentId, { ...row, updatedBy: PERSON });
      expect(
        (await createPostgresGitHubGateStore(db).context(sessionId))?.policy,
      ).toEqual({
        source: "release",
        settings: null,
        startRepositoryId: null,
        agentSettingsRevision: 1,
        currentRepositories: ["sample-app", "docs"],
        startActionsAllow: null,
        enabledAtStart: true,
        pushAttached: "ask",
      });
      expect(
        await createPostgresGitHubMcpStore(db).sessionState(sessionId),
      ).toMatchObject({ github: null });
    });

    test("a row that cannot be read closes the session, whoever wrote it", async () => {
      for (const updatedBy of [PERSON, undefined]) {
        const { workspaceId, agentId, sessionId } = await fixture();
        await settingsRow(workspaceId, agentId, {
          ...row,
          repositories: [1],
          ...(updatedBy === undefined ? {} : { updatedBy }),
        });
        expect(
          (await createPostgresGitHubGateStore(db).context(sessionId))?.policy
            .settings,
        ).toBe("invalid");
        expect((await pushes.findSession(workspaceId, sessionId))?.github).toBe(
          "invalid",
        );
        expect(
          (await createPostgresGitHubMcpStore(db).sessionState(sessionId))
            ?.github,
        ).toBeNull();
      }
    });

    test("a push the pin approved goes back to a person once a person's row asks for approval", async () => {
      const { workspaceId, agentId, sessionId } = await fixture();
      const found = await pushes.findSession(workspaceId, sessionId);
      const created = await request({
        workspaceId,
        sessionId,
        policyApproval: found?.policyApproval ?? null,
        policyFields: found?.policyFields ?? {},
      });
      if (created.outcome !== "written") throw new Error("not written");
      await settingsRow(workspaceId, agentId, {
        ...row,
        pushApproval: true,
        updatedBy: PERSON,
        revision: 2,
      });
      expect(await claimed()).not.toContain(sessionId);
      expect(await stateOf(created.request.id)).toMatchObject({
        state: "requested",
        approval_basis: null,
      });
      const { rows } = await pool.query<{ result: Record<string, unknown> }>(
        `SELECT result FROM receipts
          WHERE owner_id = $1 AND operation = 'resolve_push'
          ORDER BY created_at DESC LIMIT 1`,
        [workspaceId],
      );
      expect(rows[0]?.result).toMatchObject({
        refusal: "approval_required",
        policy_source: "release",
      });
    });
  });

  describe("the workspace repository ceiling, written as installed", () => {
    async function workspaceOnly() {
      const workspaceId = randomUUID();
      await pool.query(
        "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
        [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
      );
      return workspaceId;
    }
    const revisionOf = async (workspaceId: string) =>
      (
        await pool.query<{ revision: number }>(
          "SELECT revision FROM github_workspace_settings WHERE workspace_id = $1",
          [workspaceId],
        )
      ).rows[0]?.revision;

    test("no row: writes the ceiling and leaves everything else closed; a repeat is a no-op", async () => {
      const workspaceId = await workspaceOnly();
      expect(await ensureInstalledRepositoryCeiling(db, workspaceId)).toEqual({
        changed: true,
      });
      expect(await workspaceRepositoryCeiling(db, workspaceId)).toEqual({
        repository_ids: [],
        github_app_repositories: "installed",
      });
      const { rows } = await pool.query(
        "SELECT ceiling FROM github_workspace_settings WHERE workspace_id = $1",
        [workspaceId],
      );
      expect(rows[0]?.ceiling).toEqual(GITHUB_CEILING_NONE);
      const revision = await revisionOf(workspaceId);
      expect(await ensureInstalledRepositoryCeiling(db, workspaceId)).toEqual({
        changed: false,
      });
      expect(await revisionOf(workspaceId)).toBe(revision);
    });

    test("a ceiling that lists ids keeps them, and the ids asked for join them", async () => {
      const workspaceId = await workspaceOnly();
      await pool.query(
        `INSERT INTO github_workspace_settings (workspace_id, ceiling, repository_ceiling)
         VALUES ($1, $2, $3)`,
        [
          workspaceId,
          JSON.stringify(GITHUB_CEILING_NONE),
          JSON.stringify({
            repository_ids: ["kept"],
            github_app_repositories: "listed",
          }),
        ],
      );
      expect(
        await ensureInstalledRepositoryCeiling(db, workspaceId, ["added"]),
      ).toEqual({ changed: true });
      expect(await workspaceRepositoryCeiling(db, workspaceId)).toEqual({
        repository_ids: ["kept", "added"],
        github_app_repositories: "installed",
      });
      expect(
        await ensureInstalledRepositoryCeiling(db, workspaceId, ["added"]),
      ).toEqual({ changed: false });
    });

    test("a stored list with a repeated id still takes a new id", async () => {
      const workspaceId = await workspaceOnly();
      await pool.query(
        `INSERT INTO github_workspace_settings (workspace_id, ceiling, repository_ceiling)
         VALUES ($1, $2, $3)`,
        [
          workspaceId,
          JSON.stringify(GITHUB_CEILING_NONE),
          JSON.stringify({
            repository_ids: ["kept", "kept"],
            github_app_repositories: "installed",
          }),
        ],
      );
      expect(
        await ensureInstalledRepositoryCeiling(db, workspaceId, ["added"]),
      ).toEqual({ changed: true });
      expect(
        (await workspaceRepositoryCeiling(db, workspaceId))?.repository_ids,
      ).toContain("added");
      expect(
        await ensureInstalledRepositoryCeiling(db, workspaceId, ["added"]),
      ).toEqual({ changed: false });
    });

    test("a ceiling that cannot be read, or null, becomes the installed one", async () => {
      for (const stored of [null, JSON.stringify({ from: "later" })]) {
        const workspaceId = await workspaceOnly();
        await pool.query(
          `INSERT INTO github_workspace_settings (workspace_id, ceiling, repository_ceiling)
           VALUES ($1, $2, $3)`,
          [workspaceId, JSON.stringify(GITHUB_CEILING_NONE), stored],
        );
        await ensureInstalledRepositoryCeiling(db, workspaceId);
        expect(await workspaceRepositoryCeiling(db, workspaceId)).toEqual({
          repository_ids: [],
          github_app_repositories: "installed",
        });
      }
    });

    test("two first calls at once write once", async () => {
      const workspaceId = await workspaceOnly();
      const results = await Promise.all([
        ensureInstalledRepositoryCeiling(db, workspaceId),
        ensureInstalledRepositoryCeiling(db, workspaceId),
      ]);
      expect(results.filter(({ changed }) => changed)).toHaveLength(1);
    });
  });
});
