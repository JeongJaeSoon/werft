import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  type PullRequestSettings,
  type ReceiptActor,
} from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresGitHubSettingsStore } from "../github-settings.ts";
import * as schema from "../schema.ts";
import { createPostgresPullRequestSettingsStore } from "./pull-request-settings.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const TEMPLATE = "## Summary\n<!-- ours -->\n\n## Testing\n";
const LAYOUT: PullRequestSettings = {
  formatting: "off",
  default_template: TEMPLATE,
  template_mode: "override",
  session_link: "id",
};

integration("pull request settings on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pr_settings_it" });
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

  const ownerActor = (userId: string): ReceiptActor => ({
    principal: { kind: "user", id: userId },
    actor_user_id: userId,
    agent_id: null,
  });

  test("none saved reads as the defaults; the first save makes the row without saving a ceiling", async () => {
    const { workspaceId, userId } = await workspace();
    const store = createPostgresPullRequestSettingsStore(db);
    const ceilings = createPostgresGitHubSettingsStore(db);
    expect(await store.get(workspaceId)).toEqual({
      settings: DEFAULT_PULL_REQUEST_SETTINGS,
      revision: 0,
    });
    const first = await store.put({
      workspaceId,
      settings: LAYOUT,
      revision: 0,
      updatedBy: userId,
      actor: ownerActor(userId),
    });
    expect(first).toEqual({
      outcome: "stored",
      settings: LAYOUT,
      revision: 1,
      receiptId: expect.any(String),
    });
    expect(await store.get(workspaceId)).toEqual({
      settings: LAYOUT,
      revision: 1,
    });
    // A client that never saved a ceiling still holds revision 0 and may save.
    expect(await ceilings.get(workspaceId)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
    });
    const ceiling: GitHubCeiling = { ...GITHUB_CEILING_NONE, actions: true };
    expect(
      await ceilings.putCeiling({
        workspaceId,
        ceiling,
        revision: 0,
        updatedBy: userId,
        actor: ownerActor(userId),
      }),
    ).toMatchObject({ outcome: "stored", settings: { ceiling, revision: 1 } });
    // The ceiling's save leaves the layout and its revision alone.
    expect(await store.get(workspaceId)).toEqual({
      settings: LAYOUT,
      revision: 1,
    });
  });

  test("a save after the ceiling's own first save keeps the ceiling and its revision", async () => {
    const { workspaceId, userId } = await workspace();
    const store = createPostgresPullRequestSettingsStore(db);
    const ceilings = createPostgresGitHubSettingsStore(db);
    const ceiling: GitHubCeiling = { ...GITHUB_CEILING_NONE, review: true };
    await ceilings.putCeiling({
      workspaceId,
      ceiling,
      revision: 0,
      updatedBy: userId,
      actor: ownerActor(userId),
    });
    expect(
      await store.put({
        workspaceId,
        settings: LAYOUT,
        revision: 0,
        updatedBy: userId,
        actor: ownerActor(userId),
      }),
    ).toMatchObject({ outcome: "stored", revision: 1 });
    expect(await ceilings.get(workspaceId)).toEqual({ ceiling, revision: 1 });
  });

  test("the defaults saved at revision 0 beside a saved ceiling are a first save, revision 1", async () => {
    const { workspaceId, userId } = await workspace();
    const store = createPostgresPullRequestSettingsStore(db);
    await createPostgresGitHubSettingsStore(db).putCeiling({
      workspaceId,
      ceiling: { ...GITHUB_CEILING_NONE, review: true },
      revision: 0,
      updatedBy: userId,
      actor: ownerActor(userId),
    });
    expect(
      await store.put({
        workspaceId,
        settings: DEFAULT_PULL_REQUEST_SETTINGS,
        revision: 0,
        updatedBy: userId,
        actor: ownerActor(userId),
      }),
    ).toMatchObject({ outcome: "stored", revision: 1 });
  });

  test("a stale revision conflicts; the same values at the revision held write nothing", async () => {
    const { workspaceId, userId } = await workspace();
    const store = createPostgresPullRequestSettingsStore(db);
    const put = (revision: number, settings: PullRequestSettings) =>
      store.put({
        workspaceId,
        settings,
        revision,
        updatedBy: userId,
        actor: ownerActor(userId),
      });
    await put(0, LAYOUT);
    expect(await put(0, DEFAULT_PULL_REQUEST_SETTINGS)).toEqual({
      outcome: "revision_conflict",
    });
    expect(await put(1, LAYOUT)).toEqual({
      outcome: "stored",
      settings: LAYOUT,
      revision: 1,
      receiptId: null,
    });
    expect(await put(1, DEFAULT_PULL_REQUEST_SETTINGS)).toMatchObject({
      outcome: "stored",
      revision: 2,
    });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM receipts WHERE operation = 'set_github_pull_request_settings' AND owner_id = $1",
      [workspaceId],
    );
    expect(rows[0].n).toBe(2);
  });

  test("two first saves racing: one stores, the other conflicts", async () => {
    const { workspaceId, userId } = await workspace();
    const store = createPostgresPullRequestSettingsStore(db);
    const put = (settings: PullRequestSettings) =>
      store.put({
        workspaceId,
        settings,
        revision: 0,
        updatedBy: userId,
        actor: ownerActor(userId),
      });
    const outcomes = (
      await Promise.all([put(LAYOUT), put({ ...LAYOUT, session_link: "url" })])
    ).map((result) => result.outcome);
    expect(outcomes.sort()).toEqual(["revision_conflict", "stored"]);
  });

  test("the receipt keeps a template's size and hash, never its text", async () => {
    const { workspaceId, userId } = await workspace();
    const store = createPostgresPullRequestSettingsStore(db);
    await store.put({
      workspaceId,
      settings: LAYOUT,
      revision: 0,
      updatedBy: userId,
      actor: ownerActor(userId),
    });
    const { rows } = await pool.query(
      "SELECT result FROM receipts WHERE operation = 'set_github_pull_request_settings' AND owner_id = $1",
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toEqual({
      before: null,
      after: {
        formatting: "off",
        template_mode: "override",
        session_link: "id",
        default_template: {
          bytes: new TextEncoder().encode(TEMPLATE).length,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
      revision: 1,
    });
    expect(JSON.stringify(rows[0].result)).not.toContain("ours");
  });

  test("a demoted or disabled issuer stores nothing", async () => {
    const { workspaceId, userId } = await workspace();
    const store = createPostgresPullRequestSettingsStore(db);
    const put = () =>
      store.put({
        workspaceId,
        settings: LAYOUT,
        revision: 0,
        updatedBy: userId,
        actor: ownerActor(userId),
      });
    await pool.query(
      "UPDATE memberships SET role = 'member' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    expect(await put()).toEqual({ outcome: "actor_inactive" });
    expect(await store.get(workspaceId)).toEqual({
      settings: DEFAULT_PULL_REQUEST_SETTINGS,
      revision: 0,
    });
  });

  test("a stored value this image cannot read is the defaults, not an error", async () => {
    const { workspaceId } = await workspace();
    await pool.query(
      `INSERT INTO github_workspace_settings (workspace_id, ceiling, revision, pull_request, pull_request_revision)
       VALUES ($1, $2, 0, '{"formatting":"sideways"}', 3)`,
      [workspaceId, JSON.stringify(GITHUB_CEILING_NONE)],
    );
    expect(
      await createPostgresPullRequestSettingsStore(db).get(workspaceId),
    ).toEqual({ settings: DEFAULT_PULL_REQUEST_SETTINGS, revision: 3 });
  });
});
