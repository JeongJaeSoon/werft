import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  GITHUB_CEILING_NONE,
  GITHUB_FEATURES_NONE,
  type ReceiptActor,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createPushIntentRunner,
  createPushRequestService,
  createRepositoryAttachmentService,
  type SessionCatalog,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresGitHubGateStore } from "./github-settings.ts";
import { createPostgresGitHubMcpStore } from "./mcp-egress.ts";
import { createPostgresPushIntents } from "./push-intents.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import { createPostgresRepositoryAttachments } from "./repository-attachments.ts";
import * as schema from "./schema.ts";
import { pushIntents, pushRequests, sessions } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const ACTOR: ReceiptActor = {
  principal: { kind: "api_key", id: "key-writer" },
  actor_user_id: null,
  agent_id: null,
};
const PERSON = randomUUID();
const COMMIT = "b".repeat(40);
const quiet = { info: () => {}, warn: () => {} };

const repo = (name: string, branch = "main") => ({
  url: `https://example.invalid/${name}.git`,
  branch,
  profiles: ["p"],
  auth: { kind: "github_app" as const, registered: true as const },
});
// Only what the list and attach paths read: an agent session is judged by the
// workspace ceiling, so the profile needs no repository list of its own.
const CATALOG = {
  profiles: {
    p: {
      runtime_kind: "claude",
      runtime_version: "1",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "default",
      provider: { kind: "anthropic", endpoint: "https://api.invalid" },
    },
  },
  repositories: {
    "sample-app": repo("app"),
    docs: repo("docs", "trunk"),
    tools: repo("tools"),
  },
} as unknown as SessionCatalog;
const ALL = ["sample-app", "docs", "tools"];

// A session on the agent's settings keeps its own attached list, so what the
// agent turns on after the session started can be attached, and what it turns
// off stops on every path: the same rows, read by the real stores.
integration("an agent session's own attached list on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "attached_list_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const snapshot = (repositories: string[]) => ({
    enabled: true,
    revision: 1,
    settings: {
      repositories,
      push_approval: false,
      features: GITHUB_FEATURES_NONE,
      actions_allow: [],
    },
    push_attached: "allow",
  });

  /**
   * A workspace, an agent with a row listing `row`, and a session of it that
   * started on `started`, with `attached` as its own list (null: none), and
   * one open attempt.
   */
  async function session(options: {
    source?: "agent" | "release";
    started?: string[];
    row?: string[];
    attached?: string[] | null;
    pin?: string[];
  }) {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    const versionId = randomUUID();
    const releaseId = `sha256:${randomUUID()}`;
    const sessionId = randomUUID();
    const attemptId = `att_${randomUUID()}`;
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'owner')",
      [userId, `${userId}@example.invalid`],
    );
    await pool.query(
      "WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, github_enabled, managing_team_id) VALUES ($1, $2, $3, 'a', true, (SELECT id FROM t))",
      [agentId, workspaceId, `a-${agentId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    const pin = {
      repositories: options.pin ?? ["sample-app"],
      push_approval: false,
      features: GITHUB_FEATURES_NONE,
      actions_allow: [],
    };
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         runtime_profile_id, repository_id, profile_digest,
         runtime_config_snapshot, effective_tools, policy_pins)
       VALUES ($1, $2, $3, $4, 'p', 'sample-app', $5, '{}', '{}', $6)`,
      [
        releaseId,
        agentId,
        versionId,
        "a".repeat(64),
        `sha256:${"c".repeat(64)}`,
        JSON.stringify({ github: pin }),
      ],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    await pool.query(
      `INSERT INTO github_workspace_settings (workspace_id, ceiling, repository_ceiling, revision)
       VALUES ($1, $2, $3, 1)`,
      [
        workspaceId,
        JSON.stringify(GITHUB_CEILING_NONE),
        JSON.stringify({
          repository_ids: ALL,
          github_app_repositories: "listed",
        }),
      ],
    );
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, agent_release_id, created_by_user_id, github_policy_source,
         checkpoint_revision, github_policy_start, attached_repository_ids, profile_id)
       VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', 'sample-app',
         $3, $4, $5, $6, 1, $7, $8, 'p')`,
      [
        sessionId,
        workspaceId,
        workspaceId,
        releaseId,
        userId,
        options.source ?? "agent",
        JSON.stringify(snapshot(options.started ?? ["sample-app"])),
        options.attached === undefined ? [] : options.attached,
      ],
    );
    await pool.query(
      `INSERT INTO attempts (id, session_id, execution_id, lease_epoch,
         execution_generation, auth_revision, state, lease_expires_at)
       VALUES ($1, $2, 'exec-1', 1, 1, 1, 'running', now() + interval '1 minute')`,
      [attemptId, sessionId],
    );
    const setList = (repositories: string[]) =>
      pool.query(
        `INSERT INTO agent_github_settings (agent_id, workspace_id, repositories,
           push_approval, features, actions_allow, revision, updated_by, push_attached)
         VALUES ($1, $2, $3, false, $4, '[]', 2, $5, 'allow')
         ON CONFLICT (agent_id) DO UPDATE SET
           repositories = EXCLUDED.repositories, revision = agent_github_settings.revision + 1`,
        [
          agentId,
          workspaceId,
          JSON.stringify(repositories),
          JSON.stringify(GITHUB_FEATURES_NONE),
          PERSON,
        ],
      );
    await setList(options.row ?? options.started ?? ["sample-app"]);
    return { workspaceId, agentId, sessionId, attemptId, setList };
  }

  const attachments = () =>
    createRepositoryAttachmentService({
      store: createPostgresRepositoryAttachments(db),
      context: createPostgresGitHubGateStore(db),
      catalog: CATALOG,
    });
  const attach = (
    s: { sessionId: string; attemptId: string },
    repositoryId: string,
  ) =>
    attachments()
      .attach({
        sessionId: s.sessionId,
        attemptId: s.attemptId,
        actor: ACTOR,
        repositoryId,
      })
      .then(
        (answer) => ({ answer, refused: null }),
        (error: { details?: { reason_code?: string } }) => ({
          answer: null,
          refused: error.details?.reason_code ?? "other",
        }),
      );
  const statuses = async (sessionId: string) =>
    (await attachments().list(sessionId)).repositories.map((entry) => [
      entry.id,
      entry.status,
    ]);
  const attachedList = async (sessionId: string) =>
    (
      await pool.query(
        "SELECT attached_repository_ids AS ids FROM sessions WHERE id = $1",
        [sessionId],
      )
    ).rows[0]?.ids as string[] | null;

  function pushService() {
    return createPushRequestService({
      authorization: createAuthorizationPolicy(),
      store: createPostgresPushRequests(db),
      intents: createPostgresPushIntents(db),
      catalog: CATALOG,
      source: {
        readPushSource: async () => ({
          status: "ready",
          revision: 1,
          gitCommit: COMMIT,
        }),
        readPushSourceAt: async () => ({
          status: "ready",
          revision: 1,
          gitCommit: COMMIT,
        }),
      },
    });
  }
  const pushTo = (workspaceId: string, sessionId: string, repo: string) =>
    pushService()
      .create(
        {
          caller: testCaller(workspaceId),
          principal: {
            kind: "api_key",
            id: workspaceId,
            owner_id: workspaceId,
            workspace_id: null,
            scopes: ["sessions:write"],
          },
          ownerId: workspaceId,
          verified: true,
        },
        sessionId,
        {
          idempotencyKey: randomUUID(),
          body: { repository_id: repo },
        },
      )
      .then(
        () => null,
        (error: { details?: { refusal?: string } }) =>
          error.details?.refusal ?? "other",
      );

  test("a repository the agent turned on after the start can be attached; the session's own list is what grows", async () => {
    const s = await session({ started: ["sample-app"], attached: [] });
    expect(await attach(s, "docs")).toMatchObject({
      refused: "repository_not_allowed",
    });
    await s.setList(["sample-app", "docs"]);
    expect(await statuses(s.sessionId)).toEqual([
      ["docs", "not_attached"],
      ["sample-app", "attached"],
    ]);
    const done = await attach(s, "docs");
    expect(done.refused).toBeNull();
    expect(done.answer).toMatchObject({
      repository_id: "docs",
      status: "pending",
    });
    expect(await attachedList(s.sessionId)).toEqual(["docs"]);
  });

  test("every database reader sees the turned-on repository for a session with its own list, and none for one without", async () => {
    const own = await session({ started: ["sample-app"], attached: [] });
    const shared = await session({ started: ["sample-app"], attached: null });
    for (const s of [own, shared]) await s.setList(["sample-app", "docs"]);
    const read = async (s: typeof own) => ({
      gate: (await createPostgresGitHubGateStore(db).context(s.sessionId))
        ?.policy.settings,
      mcp: (await createPostgresGitHubMcpStore(db).sessionState(s.sessionId))
        ?.github,
      push: (
        await createPostgresPushRequests(db).findSession(
          s.workspaceId,
          s.sessionId,
        )
      )?.github,
    });
    for (const github of Object.values(await read(own))) {
      expect(github).toMatchObject({ repositories: ["sample-app", "docs"] });
    }
    for (const github of Object.values(await read(shared))) {
      expect(github).toMatchObject({ repositories: ["sample-app"] });
    }
    expect(await statuses(shared.sessionId)).toEqual([
      ["sample-app", "attached"],
    ]);
  });

  test("a release session never opens past its pin, whatever the agent's row says", async () => {
    const s = await session({
      source: "release",
      started: ["sample-app"],
      row: ["sample-app", "docs"],
      attached: [],
      pin: ["sample-app"],
    });
    expect(await attach(s, "docs")).toMatchObject({
      refused: "repository_not_allowed",
    });
  });

  test("features and the Actions list stay at what the session started with", async () => {
    const s = await session({ started: ["sample-app"], attached: [] });
    await pool.query(
      "UPDATE agent_github_settings SET features = $2, push_approval = true WHERE agent_id = $1",
      [
        s.agentId,
        JSON.stringify({
          ...GITHUB_FEATURES_NONE,
          review: true,
          actions: true,
        }),
      ],
    );
    const settings = (
      await createPostgresGitHubGateStore(db).context(s.sessionId)
    )?.policy.settings;
    expect(settings).toMatchObject({
      features: GITHUB_FEATURES_NONE,
      push_approval: true,
    });
  });

  describe("taking a repository off the agent's list", () => {
    test("stops attach, the push request and a pending push intent for it, lists it as revoked, and keeps what the session holds; turning it on again restores it", async () => {
      const s = await session({ started: ["sample-app"], attached: [] });
      await s.setList(["sample-app", "docs"]);
      expect((await attach(s, "docs")).refused).toBeNull();
      expect(await pushTo(s.workspaceId, s.sessionId, "docs")).toBeNull();

      const intentId = randomUUID();
      const [turn] = await db
        .insert(schema.turns)
        .values({
          sessionId: s.sessionId,
          sequence: 1,
          message: "work",
          status: "completed",
          attemptId: s.attemptId,
        })
        .returning({ id: schema.turns.id });
      if (!turn) throw new Error("no turn");
      await db.insert(pushIntents).values({
        id: intentId,
        ownerId: s.workspaceId,
        sessionId: s.sessionId,
        turnId: turn.id,
        attemptId: s.attemptId,
        repositoryId: "docs",
        targetBranch: `agent/${s.sessionId}`,
        status: "pinned",
        pinnedRevision: 1,
        actor: ACTOR,
        approvalBasis: "push",
        policySource: "agent",
      });

      // The worker finished the fetch; only a settled row turns revoked.
      await pool.query(
        `UPDATE session_repository_attachments
           SET status = 'attached', git_commit = $2, settled_at = now()
         WHERE session_id = $1 AND repository_id = 'docs'`,
        [s.sessionId, COMMIT],
      );
      await s.setList(["sample-app"]);

      expect((await attach(s, "docs")).refused).toBe("repository_not_allowed");
      expect(await pushTo(s.workspaceId, s.sessionId, "docs")).toBe(
        "repository_not_allowed",
      );
      const runner = createPushIntentRunner({
        store: createPostgresPushIntents(db),
        createFromIntent: (job) => pushService().createFromIntent(job),
        logger: quiet,
      });
      await runner.runOnce();
      const [intent] = await db
        .select()
        .from(pushIntents)
        .where(eq(pushIntents.id, intentId));
      expect(intent?.status).not.toBe("requested");
      expect(intent?.refusalCode).toBe("repository_not_allowed");
      const requests = await db
        .select()
        .from(pushRequests)
        .where(eq(pushRequests.sessionId, s.sessionId));
      // The one request made before the removal is all there is.
      expect(requests.map((row) => row.repositoryId)).toEqual(["docs"]);

      // Nothing is recalled: the session's list and row still hold it.
      expect(await attachedList(s.sessionId)).toEqual(["docs"]);
      expect(await statuses(s.sessionId)).toEqual([
        ["docs", "revoked"],
        ["sample-app", "attached"],
      ]);

      await s.setList(["sample-app", "docs"]);
      // Allowed again: what stops it now is the request already open.
      expect(await pushTo(s.workspaceId, s.sessionId, "docs")).toBe(
        "request_open",
      );
      expect(await statuses(s.sessionId)).toEqual([
        ["docs", "attached"],
        ["sample-app", "attached"],
      ]);
    });

    test("the session's own repository is revoked too, and nothing is deleted", async () => {
      const s = await session({ started: ["sample-app"], attached: [] });
      await s.setList(["docs"]);
      expect(await statuses(s.sessionId)).toEqual([
        ["docs", "not_attached"],
        ["sample-app", "revoked"],
      ]);
      // The MCP gate refuses the own repository by this same list; the push
      // request judges only additional repositories, as before.
      const gate = await createPostgresGitHubGateStore(db).context(s.sessionId);
      expect(gate?.policy.settings).toMatchObject({ repositories: ["docs"] });
      const [row] = await db
        .select({ repositoryId: sessions.repositoryId })
        .from(sessions)
        .where(eq(sessions.id, s.sessionId));
      expect(row?.repositoryId).toBe("sample-app");
    });
  });
});
