import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-folder.ts";

let client: PGlite;
let before: string;

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000a2";

// Every migration before this one, through the migrator.
async function migrateBefore(): Promise<void> {
  before = mkdtempSync(join(tmpdir(), "profile-one-kind-"));
  cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
  const journalPath = join(before, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const at = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_profile_one_kind_base"),
  );
  if (at < 0) throw new Error("profile_one_kind_base is not in the journal");
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  await migrate(drizzle(client), { migrationsFolder: before });
}

const applyMigration = () =>
  migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

const definition = JSON.stringify({ permission_mode: "default" });

async function seedProfile(
  id: string,
  row: { origin: "catalog" | "console"; ids: string[] | null },
) {
  await client.query(
    `INSERT INTO installation_profiles (id, name, version, origin, definition, permission_mode, fingerprint, repository_ids)
     VALUES ($1, $2, 1, $3, $4::jsonb, 'default', 'fp', $5::jsonb)`,
    [
      id,
      row.origin === "catalog" ? null : id,
      row.origin,
      definition,
      row.ids === null ? null : JSON.stringify(row.ids),
    ],
  );
}

const profileRows = () =>
  client.query(`SELECT * FROM installation_profiles ORDER BY id`);

beforeEach(async () => {
  client = new PGlite();
  await migrateBefore();
  await client.query(
    `INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'Acme'), ($2, 'other', 'Other')`,
    [WORKSPACE, OTHER_WORKSPACE],
  );
});

afterEach(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("profile one-kind base migration", () => {
  test("leaves rows already there as they were and adds only nulls and defaults", async () => {
    await seedProfile("coding-v1", { origin: "catalog", ids: ["repo-a"] });
    await seedProfile("op_ops_v1", { origin: "console", ids: [] });
    const agent = crypto.randomUUID();
    await client.query(
      `INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, 'a', 'A')`,
      [agent, WORKSPACE],
    );
    const profilesBefore = (await profileRows()).rows;

    await applyMigration();

    const profilesAfter = (await profileRows()).rows as Record<
      string,
      unknown
    >[];
    expect(profilesAfter).toHaveLength(2);
    for (const [index, row] of profilesAfter.entries()) {
      expect(row).toMatchObject(profilesBefore[index] as object);
      expect(row).toMatchObject({
        derived_from: null,
        workspace_id: null,
        display_name: null,
        migrated_from: null,
        repository_scope: "profile",
        github_app_repositories: "listed",
      });
    }
    const agents = await client.query(`SELECT * FROM agents`);
    expect(agents.rows[0]).toMatchObject({
      profile_tracking: "follow",
      behavior_revision: 0,
      model_source: "fixed",
      draft_version_id: null,
      draft_profile_id: null,
      draft_model_source: null,
      draft_failure: null,
    });
  });

  test("an image from before still inserts through the defaults", async () => {
    await applyMigration();
    await seedProfile("op_ops_v1", { origin: "console", ids: [] });
    const { rows } = await client.query(
      `SELECT repository_scope, github_app_repositories FROM installation_profiles`,
    );
    expect(rows).toEqual([
      { repository_scope: "profile", github_app_repositories: "listed" },
    ]);
  });

  test("a console row may name no repository, and only then may it leave repository_ids null", async () => {
    await applyMigration();
    await client.query(
      `INSERT INTO installation_profiles (id, name, version, origin, definition, permission_mode, fingerprint, repository_scope, github_app_repositories)
       VALUES ('op_none_v1', 'op_none_v1', 1, 'console', $1::jsonb, 'default', 'fp', NULL, NULL)`,
      [definition],
    );
    const { rows } = await client.query(
      `SELECT repository_ids, repository_scope, github_app_repositories FROM installation_profiles`,
    );
    expect(rows).toEqual([
      {
        repository_ids: null,
        repository_scope: null,
        github_app_repositories: null,
      },
    ]);
    await expect(
      client.query(
        `INSERT INTO installation_profiles (id, name, version, origin, definition, permission_mode, fingerprint)
         VALUES ('op_bad_v1', 'op_bad_v1', 1, 'console', $1::jsonb, 'default', 'fp')`,
        [definition],
      ),
    ).rejects.toThrow(/installation_profiles_repository_ids_check/);
    await expect(
      client.query(
        `INSERT INTO installation_profiles (id, name, version, origin, definition, permission_mode, fingerprint, repository_ids, repository_scope)
         VALUES ('op_bad_v2', 'op_bad_v2', 1, 'console', $1::jsonb, 'default', 'fp', '[]'::jsonb, 'elsewhere')`,
        [definition],
      ),
    ).rejects.toThrow(/installation_profiles_repository_scope_check/);
  });

  test("a workspace's lineage and a migrated_from are each unique", async () => {
    await applyMigration();
    await seedProfile("op_wl_x_v1", { origin: "console", ids: [] });
    const insert = (id: string, workspace: string, extra: string) =>
      client.query(
        `INSERT INTO installation_profiles (id, name, version, origin, definition, permission_mode, fingerprint, repository_scope, workspace_id, display_name, migrated_from, derived_from)
         VALUES ($1, $1, 1, 'console', $2::jsonb, 'default', 'fp', NULL, $3, 'Reviewer', ${extra})`,
        [id, definition, workspace],
      );
    await insert("op_a_v1", WORKSPACE, `'ws_old', 'op_wl_x_v1'`);
    await expect(insert("op_b_v1", WORKSPACE, `NULL, NULL`)).rejects.toThrow(
      /installation_profiles_workspace_lineage_key/,
    );
    await insert("op_c_v1", OTHER_WORKSPACE, `NULL, NULL`);
    await expect(
      insert("op_d_v1", OTHER_WORKSPACE, `'ws_old', NULL`),
    ).rejects.toThrow(/installation_profiles_migrated_from_key|lineage_key/);
    await expect(
      client.query(
        `UPDATE installation_profiles SET derived_from = 'missing' WHERE id = 'op_c_v1'`,
      ),
    ).rejects.toThrow(/installation_profiles_derived_from_fk/);
  });

  test("an agent's draft columns are filled and cleared together", async () => {
    await applyMigration();
    const agent = crypto.randomUUID();
    await client.query(
      `WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'a', 'A', (SELECT id FROM t))`,
      [agent, WORKSPACE],
    );
    await expect(
      client.query(`UPDATE agents SET draft_profile_id = 'p' WHERE id = $1`, [
        agent,
      ]),
    ).rejects.toThrow(/agents_draft_check/);
    await expect(
      client.query(`UPDATE agents SET draft_failure = 'x' WHERE id = $1`, [
        agent,
      ]),
    ).rejects.toThrow(/agents_draft_check/);
    await expect(
      client.query(
        `UPDATE agents SET profile_tracking = 'other' WHERE id = $1`,
        [agent],
      ),
    ).rejects.toThrow(/agents_profile_tracking_check/);
    const version = crypto.randomUUID();
    await client.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256) VALUES ($1, $2, 1, '{}'::jsonb, $3)`,
      [version, agent, "1".repeat(64)],
    );
    await client.query(
      `UPDATE agents SET draft_version_id = $2, draft_profile_id = 'p', draft_model_source = 'profile', draft_failure = 'credential_unbound' WHERE id = $1`,
      [agent, version],
    );
    await expect(
      client.query(`UPDATE agents SET draft_version_id = $2 WHERE id = $1`, [
        agent,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow(/agents_draft_version_fk|agents_draft_check/);
  });

  test("a rollout is one per target and kind, an item one per agent and generation", async () => {
    await applyMigration();
    await seedProfile("op_ops_v1", { origin: "console", ids: [] });
    const agent = crypto.randomUUID();
    await client.query(
      `WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'a', 'A', (SELECT id FROM t))`,
      [agent, WORKSPACE],
    );
    const rollout = crypto.randomUUID();
    const addRollout = (id: string, kind: string) =>
      client.query(
        `INSERT INTO profile_rollouts (id, kind, target_profile_id) VALUES ($1, $2, 'op_ops_v1')`,
        [id, kind],
      );
    await addRollout(rollout, "profile_update");
    await expect(
      addRollout(crypto.randomUUID(), "profile_update"),
    ).rejects.toThrow(/profile_rollouts_target_kind_key/);
    await expect(addRollout(crypto.randomUUID(), "other")).rejects.toThrow(
      /profile_rollouts_kind_check/,
    );
    const addItem = (generation: number, status = "pending", reason?: string) =>
      client.query(
        `INSERT INTO profile_rollout_items (rollout_id, agent_id, generation, status, reason_code) VALUES ($1, $2, $3, $4, $5)`,
        [rollout, agent, generation, status, reason ?? null],
      );
    await addItem(0);
    await expect(addItem(0)).rejects.toThrow(/profile_rollout_items_pkey/);
    await addItem(1, "applied");
    await expect(addItem(2, "failed")).rejects.toThrow(
      /profile_rollout_items_failed_check/,
    );
    await addItem(2, "failed", "credential_unbound");
    await expect(addItem(3, "done")).rejects.toThrow(
      /profile_rollout_items_status_check/,
    );
  });

  test("runs again over its own result", async () => {
    await applyMigration();
    const sql = readFileSync(
      join(MIGRATIONS_FOLDER, "0233_profile_one_kind_base.sql"),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      await client.exec(statement);
    }
  });
});
