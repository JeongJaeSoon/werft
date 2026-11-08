import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";
import { createPostgresSessionAttributionStore } from "./session-attribution.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// The starter rule (design github-agent.md decision 5): turn 1's actor, else
// the session's creator. Web, personal-key and Slack-linked starts name a
// person; an agent key or the operator names no one.
integration("session attribution on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_attribution_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function workspace() {
    const workspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    return workspaceId;
  }

  async function person(workspaceId: string) {
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'p')",
      [userId, `${userId}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [workspaceId, userId],
    );
    return userId;
  }

  async function key(
    workspaceId: string,
    kind: "personal" | "agent",
    by: string | null,
  ) {
    const keyId = randomUUID();
    let agentId: string | null = null;
    if (kind === "agent") {
      agentId = randomUUID();
      await pool.query(
        "WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, $3, 'a', (SELECT id FROM t))",
        [agentId, workspaceId, `a-${agentId.slice(0, 8)}`],
      );
    }
    await pool.query(
      `INSERT INTO api_keys (id, key_hash, owner_id, workspace_id, kind, created_by_user_id, agent_id, scopes)
       VALUES ($1::uuid, decode(md5($6::text), 'hex'), $2::text, $2::uuid, $3, $4, $5, ARRAY['sessions:write'])`,
      [keyId, workspaceId, kind, by, agentId, keyId],
    );
    return keyId;
  }

  async function session(
    workspaceId: string,
    start: {
      channel: "web" | "slack" | "api" | null;
      createdBy?: string | null;
      apiKey?: string | null;
      firstActor?: string | null;
    },
  ) {
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id,
         channel, created_by_user_id, created_by_api_key_id)
       VALUES ($1, $2::text, 'https://github.com/acme/app.git', 'main', $2::uuid, $3, $4, $5)`,
      [
        sessionId,
        workspaceId,
        start.channel,
        start.createdBy ?? null,
        start.apiKey ?? null,
      ],
    );
    if (start.firstActor !== undefined) {
      await pool.query(
        "INSERT INTO turns (session_id, sequence, message, status, actor_id) VALUES ($1, 1, 'hi', 'completed', $2)",
        [sessionId, start.firstActor],
      );
    }
    return sessionId;
  }

  async function linkGitHub(workspaceId: string, userId: string, id: string) {
    await pool.query(
      `INSERT INTO linked_accounts (id, workspace_id, user_id, provider,
         external_tenant, external_user_id, external_user_name, verified_via, verified_at)
       VALUES ($1, $2, $3, 'github', 'github.com', $4, 'octocat', 'github_oauth', now())`,
      [randomUUID(), workspaceId, userId, id],
    );
  }

  test("web, personal key and Slack starts name the person; an agent key or the operator no one", async () => {
    const ws = await workspace();
    const alice = await person(ws);
    const bob = await person(ws);
    await linkGitHub(ws, alice, "583231");
    const store = createPostgresSessionAttributionStore(db);
    const personal = await key(ws, "personal", bob);
    const agent = await key(ws, "agent", null);

    const cases = [
      [
        await session(ws, { channel: "web", createdBy: alice }),
        "web",
        { userId: alice, github: { id: "583231", login: "octocat" } },
      ],
      [
        await session(ws, {
          channel: "api",
          createdBy: bob,
          apiKey: personal,
        }),
        "personal_key",
        { userId: bob, github: null },
      ],
      [
        await session(ws, { channel: "slack", firstActor: alice }),
        "slack",
        { userId: alice, github: { id: "583231", login: "octocat" } },
      ],
      [await session(ws, { channel: "api", apiKey: agent }), "agent_key", null],
      [await session(ws, { channel: "api" }), "operator_key", null],
    ] as const;
    for (const [sessionId, trigger, starter] of cases) {
      expect(await store.attribution(sessionId.toUpperCase())).toMatchObject({
        ownerId: ws,
        trigger,
        starter,
      });
    }
    expect(await store.attribution(randomUUID())).toBeNull();
  });

  test("turn 1's actor wins over the creator; a link in another workspace or revoked is none", async () => {
    const ws = await workspace();
    const creator = await person(ws);
    const first = await person(ws);
    const store = createPostgresSessionAttributionStore(db);
    const sessionId = await session(ws, {
      channel: "web",
      createdBy: creator,
      firstActor: first,
    });
    expect((await store.attribution(sessionId))?.starter?.userId).toBe(first);

    await linkGitHub(ws, first, "778");
    expect((await store.attribution(sessionId))?.starter?.github?.id).toBe(
      "778",
    );
    await pool.query(
      "UPDATE linked_accounts SET status = 'revoked', revoked_reason = 'unlinked', revoked_at = now() WHERE workspace_id = $1 AND user_id = $2",
      [ws, first],
    );
    expect((await store.attribution(sessionId))?.starter?.github).toBeNull();

    const elsewhere = await workspace();
    await linkGitHub(elsewhere, first, "777");
    expect((await store.attribution(sessionId))?.starter?.github).toBeNull();
  });

  test("names the App the primary repository is pinned to for author, not just any author App", async () => {
    const ws = await workspace();
    const store = createPostgresSessionAttributionStore(db);
    const repositoryId = `app-${ws.slice(0, 8)}`;
    const sessionId = await session(ws, { channel: "web" });
    await pool.query("UPDATE sessions SET repository_id = $2 WHERE id = $1", [
      sessionId,
      repositoryId,
    ]);
    const app = async (workspaceId: string, role: string, appId: number) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO github_apps (id, workspace_id, app_id, slug, name, html_url, api_base, role)
         VALUES ($1, $2, $3, $4, 'App', 'https://github.com/apps/x', 'https://api.github.com', $5)`,
        [id, workspaceId, appId, `app-${appId}`, role],
      );
      return id;
    };
    const pin = (role: string, connectionId: string | null, appId: number) =>
      pool.query(
        `INSERT INTO catalog_repository_github_apps (repository_id, role, connection_id, app_id, pinned_by)
         VALUES ($1, $2, $3, $4, 'claim')
         ON CONFLICT (repository_id, role) DO UPDATE SET connection_id = EXCLUDED.connection_id, app_id = EXCLUDED.app_id`,
        [repositoryId, role, connectionId, appId],
      );
    const read = async () => {
      const record = await store.attribution(sessionId);
      return { app: record?.authorApp, pinned: record?.authorPinned };
    };

    // Two author Apps and no pin: none is guessed.
    await app(ws, "author", 1);
    const second = await app(ws, "author", 2);
    const reviewer = await app(ws, "reviewer", 3);
    expect(await read()).toEqual({ app: null, pinned: false });
    await pin("reviewer", reviewer, 3);
    expect(await read()).toEqual({ app: null, pinned: false });

    await pin("author", second, 2);
    expect(await read()).toEqual({
      app: { slug: "app-2", apiBase: "https://api.github.com" },
      pinned: true,
    });
    // The pinned connection now holds another App, or is gone: pinned to
    // nothing usable, and no other App stands in.
    await pin("author", second, 9);
    expect(await read()).toEqual({ app: null, pinned: true });
    await pin("author", null, 2);
    expect(await read()).toEqual({ app: null, pinned: true });
    // Another workspace's connection under this repository's pin.
    const foreign = await app(await workspace(), "author", 4);
    await pin("author", foreign, 4);
    expect(await read()).toEqual({ app: null, pinned: true });
  });
});
