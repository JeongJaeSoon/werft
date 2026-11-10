import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  type ReceiptActor,
} from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresGitHubGateStore,
  createPostgresGitHubSettingsStore,
} from "./github-settings.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
  SESSION_PIN_SQL_COLUMNS,
  sessionPinSqlValues,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const RELEASE_RECEIPT_FIELDS = {
  policy_source: "release",
  agent_settings_revision: null,
  workspace_ceiling_revision: 0,
} as const;

const GITHUB = {
  repositories: ["sample-app"],
  features: {
    workflows: false,
    actions: true,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [{ workflow: "ci.yml" }],
  push_approval: false,
};

integration("GitHub gate and ceiling stores on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "github_gate_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function workspace() {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'owner')",
      [userId, `${userId}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, userId],
    );
    return { workspaceId, userId };
  }

  /** An agent whose active release carries `pins`. */
  async function agent(workspaceId: string, pins: object, enabled = true) {
    const agentId = randomUUID();
    const versionId = randomUUID();
    const releaseId = `sha256:${randomUUID()}`;
    await pool.query(
      "WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, github_enabled, managing_team_id) VALUES ($1, $2, $3, 'a', $4, (SELECT id FROM t))",
      [agentId, workspaceId, `a-${agentId.slice(0, 8)}`, enabled],
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
      [releaseId, agentId, versionId, "a".repeat(64), JSON.stringify(pins)],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    return { agentId, releaseId };
  }

  async function session(
    workspaceId: string,
    releaseId: string | null,
    createdBy: string | null,
  ) {
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, agent_release_id, created_by_user_id,
         ${SESSION_PIN_SQL_COLUMNS})
       VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', 'sample-app',
         $3, $4, $5, ${sessionPinSqlValues()})`,
      [sessionId, workspaceId, workspaceId, releaseId, createdBy],
    );
    return sessionId;
  }

  const ownerActor = (userId: string): ReceiptActor => ({
    principal: { kind: "user", id: userId },
    actor_user_id: userId,
    agent_id: null,
  });

  test("context reads the starter, the agent, the release's settings and the ceiling", async () => {
    const { workspaceId, userId } = await workspace();
    const { agentId, releaseId } = await agent(workspaceId, {
      github: GITHUB,
    });
    const sessionId = await session(workspaceId, releaseId, userId);
    const store = createPostgresGitHubGateStore(db);

    expect(await store.context(sessionId)).toEqual({
      ownerId: workspaceId,
      sessionId,
      repositoryId: "sample-app",
      attachedRepositoryIds: null,
      repository: { url: "https://github.com/acme/app.git", branch: "main" },
      startedBy: userId,
      agent: { id: agentId, workspaceId, githubEnabled: true },
      release: { id: releaseId },
      policy: {
        source: "release",
        settings: GITHUB,
        startRepositoryId: null,
        agentSettingsRevision: null,
        currentRepositories: null,
        startActionsAllow: null,
        enabledAtStart: true,
        pushAttached: "ask",
      },
      ceiling: GITHUB_CEILING_NONE,
      repositoryCeiling: null,
      ceilingRevision: 0,
    });
    expect(await store.context(randomUUID())).toBeNull();

    const later = await agent(workspaceId, { github: { from: "later" } });
    const laterSession = await session(workspaceId, later.releaseId, null);
    expect((await store.context(laterSession))?.policy.settings).toBe(
      "invalid",
    );
    expect((await store.context(laterSession))?.startedBy).toBeNull();
  });

  test("the gate and a push read the session's attached list", async () => {
    const { workspaceId, userId } = await workspace();
    const { releaseId } = await agent(workspaceId, { github: GITHUB });
    const sessionId = await session(workspaceId, releaseId, userId);
    await pool.query(
      "UPDATE sessions SET attached_repository_ids = $2 WHERE id = $1",
      [sessionId, ["docs"]],
    );
    expect(
      (await createPostgresGitHubGateStore(db).context(sessionId))
        ?.attachedRepositoryIds,
    ).toEqual(["docs"]);
    expect(
      (await createPostgresPushRequests(db).findSession(workspaceId, sessionId))
        ?.attached,
    ).toEqual(["docs"]);
  });

  test("a dispatch keeps its receipt and run in one write, and a rerun finds it by repository and run", async () => {
    const { workspaceId, userId } = await workspace();
    const { agentId, releaseId } = await agent(workspaceId, {
      github: GITHUB,
    });
    const sessionId = await session(workspaceId, releaseId, userId);
    const store = createPostgresGitHubGateStore(db);
    const context = {
      ownerId: workspaceId,
      sessionId,
      agentId,
      agentReleaseId: releaseId,
      repositoryId: "sample-app",
      policy: {},
    };
    const receiptId = await store.recordDispatch({
      context,
      actor: ownerActor(userId),
      result: { workflow: "ci.yml", ref: "main", input_keys: ["env"] },
      run: { id: 9_012_345_678, workflow: "ci.yml", ref: "main" },
    });

    expect(await store.findDispatch("sample-app", 9_012_345_678)).toEqual({
      runId: 9_012_345_678,
      repositoryId: "sample-app",
      workflow: "ci.yml",
      ref: "main",
    });
    expect(await store.findDispatch("other-app", 9_012_345_678)).toBeNull();
    const { rows } = await pool.query(
      "SELECT operation, status, result, target_ref FROM receipts WHERE id = $1",
      [receiptId],
    );
    expect(rows).toEqual([
      {
        operation: "dispatch_workflow",
        status: "succeeded",
        result: { workflow: "ci.yml", ref: "main", input_keys: ["env"] },
        target_ref: { session_id: sessionId, turn_id: null, request_id: null },
      },
    ]);

    // The same run twice is a programming error, not a second row.
    await expect(
      store.recordDispatch({
        context,
        actor: ownerActor(userId),
        result: {},
        run: { id: 9_012_345_678, workflow: "ci.yml", ref: "main" },
      }),
    ).rejects.toThrow();
    const counted = await pool.query(
      "SELECT count(*)::int AS n FROM receipts WHERE operation = 'dispatch_workflow' AND owner_id = $1",
      [workspaceId],
    );
    expect(counted.rows[0].n).toBe(1);
  });

  test("a review writes its receipt and github_review outcome together, never the body", async () => {
    const { workspaceId, userId } = await workspace();
    const { agentId, releaseId } = await agent(workspaceId, {
      github: GITHUB,
    });
    const sessionId = await session(workspaceId, releaseId, userId);
    const store = createPostgresGitHubGateStore(db);
    const url =
      "https://github.com/acme/sample-app/pull/398#pullrequestreview-77";
    const receiptId = await store.recordReview({
      context: {
        ownerId: workspaceId,
        sessionId,
        agentId,
        agentReleaseId: releaseId,
        repositoryId: "sample-app",
        policy: {},
      },
      actor: ownerActor(userId),
      result: { number: 398, event: "APPROVE", review_id: 77 },
      review: { id: 77, url },
      metadata: {
        number: 398,
        event: "APPROVE",
        commit_id: "c".repeat(40),
        opened_by_session_id: null,
      },
    });
    const { rows } = await pool.query(
      "SELECT type, url, repository_id, external_id, state, agent_id, agent_release_id, metadata, receipt_id FROM session_outcomes WHERE session_id = $1",
      [sessionId],
    );
    expect(rows).toEqual([
      {
        type: "github_review",
        url,
        repository_id: "sample-app",
        external_id: "77",
        state: "submitted",
        agent_id: agentId,
        agent_release_id: releaseId,
        metadata: {
          number: 398,
          event: "APPROVE",
          commit_id: "c".repeat(40),
          opened_by_session_id: null,
        },
        receipt_id: receiptId,
      },
    ]);
    const receipt = await pool.query(
      "SELECT operation, status FROM receipts WHERE id = $1",
      [receiptId],
    );
    expect(receipt.rows).toEqual([
      { operation: "review_pull_request", status: "succeeded" },
    ]);
  });

  test("a stored ceiling without the merge key reads as off, and saving it on is read back and seen by the gate's context", async () => {
    const { workspaceId, userId } = await workspace();
    await pool.query(
      "INSERT INTO github_workspace_settings (workspace_id, ceiling, revision) VALUES ($1, $2, 1)",
      [
        workspaceId,
        JSON.stringify({
          workflows: false,
          actions: true,
          checks: false,
          issues: false,
          review: false,
        }),
      ],
    );
    const store = createPostgresGitHubSettingsStore(db);
    expect(await store.get(workspaceId)).toEqual({
      ceiling: { ...GITHUB_CEILING_NONE, actions: true },
      revision: 1,
    });
    const on: GitHubCeiling = {
      ...GITHUB_CEILING_NONE,
      actions: true,
      merge: true,
    };
    expect(
      await store.putCeiling({
        workspaceId,
        ceiling: on,
        revision: 1,
        updatedBy: userId,
        actor: ownerActor(userId),
      }),
    ).toEqual({ outcome: "stored", settings: { ceiling: on, revision: 2 } });
    expect((await store.get(workspaceId)).ceiling.merge).toBe(true);
    await pool.query(
      "UPDATE github_workspace_settings SET ceiling = $2 WHERE workspace_id = $1",
      [workspaceId, JSON.stringify({ merge: "yes" })],
    );
    expect((await store.get(workspaceId)).ceiling).toEqual(GITHUB_CEILING_NONE);
  });

  test("the ceiling is written under its revision with a receipt, and counts agents using each feature", async () => {
    const { workspaceId, userId } = await workspace();
    await agent(workspaceId, { github: GITHUB });
    await agent(workspaceId, { github: GITHUB }, false);
    await agent(workspaceId, {});
    const store = createPostgresGitHubSettingsStore(db);
    const ceiling: GitHubCeiling = { ...GITHUB_CEILING_NONE, actions: true };

    expect(await store.get(workspaceId)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
    });
    const put = (revision: number, next: GitHubCeiling) =>
      store.putCeiling({
        workspaceId,
        ceiling: next,
        revision,
        updatedBy: userId,
        actor: ownerActor(userId),
      });
    expect(await put(0, ceiling)).toEqual({
      outcome: "stored",
      settings: { ceiling, revision: 1 },
    });
    expect(await put(0, GITHUB_CEILING_NONE)).toEqual({
      outcome: "revision_conflict",
    });
    expect(await put(1, GITHUB_CEILING_NONE)).toMatchObject({
      outcome: "stored",
      settings: { revision: 2 },
    });
    expect(await store.get(workspaceId)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 2,
    });
    const { rows } = await pool.query(
      "SELECT result FROM receipts WHERE operation = 'set_github_ceiling' AND owner_id = $1 ORDER BY created_at",
      [workspaceId],
    );
    expect(rows.map((row) => row.result)).toEqual([
      { before: null, after: ceiling, revision: 1 },
      { before: ceiling, after: GITHUB_CEILING_NONE, revision: 2 },
    ]);
    // The switched-off agent and the one without settings do not count.
    expect(await store.agentsUsing(workspaceId)).toEqual({
      workflows: 0,
      actions: 1,
      checks: 0,
      issues: 0,
      review: 0,
    });
    expect(await store.appPermissions(workspaceId)).toEqual({
      author: null,
      reviewer: null,
    });
  });

  test("a ceiling put by someone demoted or disabled after the policy's check stores nothing", async () => {
    const { workspaceId, userId } = await workspace();
    const store = createPostgresGitHubSettingsStore(db);
    const put = () =>
      store.putCeiling({
        workspaceId,
        ceiling: { ...GITHUB_CEILING_NONE, actions: true },
        revision: 0,
        updatedBy: userId,
        actor: ownerActor(userId),
      });
    await pool.query(
      "UPDATE memberships SET role = 'member' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    expect(await put()).toEqual({ outcome: "actor_inactive" });
    await pool.query(
      "UPDATE memberships SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [
      userId,
    ]);
    expect(await put()).toEqual({ outcome: "actor_inactive" });
    expect(await store.get(workspaceId)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
    });
    const { rows } = await pool.query(
      "SELECT 1 FROM receipts WHERE operation = 'set_github_ceiling' AND owner_id = $1",
      [workspaceId],
    );
    expect(rows).toEqual([]);
  });

  test("a release with push_approval false still asks under the one rule; a policy approval handed to create writes approved", async () => {
    const { workspaceId, userId } = await workspace();
    const { releaseId } = await agent(workspaceId, { github: GITHUB });
    const sessionId = await session(workspaceId, releaseId, userId);
    await pool.query(
      "UPDATE sessions SET checkpoint_revision = 1 WHERE id = $1",
      [sessionId],
    );
    const pushes = createPostgresPushRequests(db);

    const found = await pushes.findSession(workspaceId, sessionId);
    expect(found).toEqual({
      repositoryId: "sample-app",
      // The pointer set above: approvability reads it from here.
      checkpointRevision: 1,
      attached: null,
      policySource: "release",
      github: expect.objectContaining({ repositories: ["sample-app"] }),
      repositoryCeiling: null,
      githubEnabled: true,
      policyApproval: { releaseId, source: "release", settingsRevision: null },
      push: "ask",
      policyFields: RELEASE_RECEIPT_FIELDS,
    });
    const created = await pushes.create({
      ownerId: workspaceId,
      sessionId,
      actor: ownerActor(userId),
      idempotencyKey: `k-${randomUUID()}`,
      payloadHash: "h",
      repositoryId: "sample-app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: "a".repeat(40),
      policyApproval: found?.policyApproval ?? null,
      policyFields: found?.policyFields ?? {},
    });
    if (created.outcome !== "written") throw new Error("not written");
    expect(created.request).toMatchObject({ state: "approved" });
    const { rows } = await pool.query(
      "SELECT actor, status FROM receipts WHERE operation = 'resolve_push' AND owner_id = $1",
      [workspaceId],
    );
    expect(rows).toEqual([{ actor: null, status: "succeeded" }]);

    const plain = await agent(workspaceId, {});
    const other = await session(workspaceId, plain.releaseId, userId);
    expect(await pushes.findSession(workspaceId, other)).toEqual({
      repositoryId: "sample-app",
      checkpointRevision: null,
      attached: null,
      policySource: "release",
      github: null,
      repositoryCeiling: null,
      githubEnabled: true,
      push: "ask",
      policyApproval: {
        releaseId: plain.releaseId,
        source: "release",
        settingsRevision: null,
      },
      policyFields: RELEASE_RECEIPT_FIELDS,
    });
  });

  test("the opener of a pull request is the latest session that recorded it, within the owner", async () => {
    const { workspaceId, userId } = await workspace();
    const { agentId, releaseId } = await agent(workspaceId, {});
    const first = await session(workspaceId, null, userId);
    const latest = await session(workspaceId, releaseId, userId);
    const stranger = await workspace();
    const elsewhere = await session(stranger.workspaceId, null, null);
    for (const [sessionId, ownerId, at] of [
      [first, workspaceId, "2026-10-01T00:00:00Z"],
      [latest, workspaceId, "2026-10-02T00:00:00Z"],
      [elsewhere, stranger.workspaceId, "2026-10-03T00:00:00Z"],
    ] as const) {
      await pool.query(
        `INSERT INTO pull_requests (session_id, url, owner_id, repository_id, number, created_at)
         VALUES ($1, $2, $3, 'sample-app', 7, $4)`,
        [
          sessionId,
          `https://github.com/acme/app/pull/7#${sessionId}`,
          ownerId,
          at,
        ],
      );
    }
    const store = createPostgresGitHubGateStore(db);
    expect(await store.pullRequestOpener(workspaceId, "sample-app", 7)).toEqual(
      { sessionId: latest, agentId },
    );
    await pool.query(
      "UPDATE pull_requests SET created_at = now() WHERE session_id = $1",
      [first],
    );
    expect(await store.pullRequestOpener(workspaceId, "sample-app", 7)).toEqual(
      { sessionId: first, agentId: null },
    );
    expect(
      await store.pullRequestOpener(workspaceId, "sample-app", 8),
    ).toBeNull();
    expect(
      await store.pullRequestOpener(workspaceId, "other-app", 7),
    ).toBeNull();
  });
});
