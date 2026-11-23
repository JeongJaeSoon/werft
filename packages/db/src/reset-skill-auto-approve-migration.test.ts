import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER, readJournal } from "./migration-journal.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

/**
 * Auto-approve turned on or requested before it meant "passes the fixed-rule
 * checks" is turned off, and the migration says how many sources it reset.
 */
describe("the migration that resets skill auto-approve", () => {
  const tag = readJournal(MIGRATIONS_FOLDER).find((entry) =>
    entry.tag.endsWith("_reset_skill_auto_approve"),
  )?.tag;
  if (tag === undefined) throw new Error("the migration is not in the journal");
  const sql = readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8");
  let client: PGlite;
  let before: string;
  const workspaceId = randomUUID();
  const requester = randomUUID();
  const consenter = randomUUID();
  const grant = randomUUID();

  const run = async () => {
    const notices: string[] = [];
    await client.exec(sql, {
      onNotice: (notice) => notices.push(notice.message ?? ""),
    });
    return notices;
  };
  const sources = async () =>
    (
      await client.query(
        `SELECT name, auto_approve, auto_approve_requested_by AS requested_by,
           auto_approve_consented_by AS consented_by,
           auto_approve_grant_id AS grant_id, sync_enabled
         FROM skill_git_sources ORDER BY name`,
      )
    ).rows;

  beforeAll(async () => {
    client = new PGlite();
    before = migrationsThrough(tag, { exclusive: true });
    await migrate(drizzle(client), { migrationsFolder: before });
    await client.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    for (const id of [requester, consenter]) {
      await client.query(
        "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'argon2id$placeholder', 'manager')",
        [id, `${id}@example.invalid`],
      );
    }
    const connectionId = randomUUID();
    await client.query(
      `INSERT INTO github_apps (id, workspace_id, role, app_id, slug, name, html_url, api_base)
       VALUES ($1, $2, 'author', 54, 's', 'n', 'https://github.com/apps/s', 'https://api.github.com')`,
      [connectionId, workspaceId],
    );
    for (const [name, state, requestedBy, consentedBy, grantId] of [
      ["was-on", "on", requester, consenter, grant],
      ["was-requested", "requested", requester, null, null],
      ["was-off", "off", null, null, null],
    ] as const) {
      await client.query(
        `INSERT INTO skill_git_sources (workspace_id, name, connection_id,
           installation_id, repository_id, repository, path, ref, created_by,
           auto_approve, auto_approve_requested_by, auto_approve_consented_by,
           auto_approve_grant_id)
         VALUES ($1, $2, $3, 77, 9001, 'acme/skills', 'skills/x', 'main', $4,
           $5, $6, $7, $8)`,
        [
          workspaceId,
          name,
          connectionId,
          requester,
          state,
          requestedBy,
          consentedBy,
          grantId,
        ],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await client.close();
    rmSync(before, { recursive: true, force: true });
  });

  test("on and requested sources are turned off, sync stays as it was, and the count is reported; a second run finds none", async () => {
    const notices = await run();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      "auto-approve turned off on 2 GitHub skill sources",
    );
    const off = {
      auto_approve: "off",
      requested_by: null,
      consented_by: null,
      grant_id: null,
      sync_enabled: true,
    };
    expect(await sources()).toEqual([
      { name: "was-off", ...off },
      { name: "was-on", ...off },
      { name: "was-requested", ...off },
    ]);
    expect(await run()).toEqual([]);
  });
});
