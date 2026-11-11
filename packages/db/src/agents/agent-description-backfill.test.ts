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
import { migrate } from "../migrate.ts";
import { MIGRATIONS_FOLDER } from "../migration-journal.ts";

let client: PGlite;
let before: string;

// Every migration before the backfill, through the migrator.
async function migrateBefore(): Promise<void> {
  before = mkdtempSync(join(tmpdir(), "agent-description-"));
  cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
  const journalPath = join(before, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const at = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_agent_description"),
  );
  if (at < 0) throw new Error("agent_description is not in the journal");
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  await migrate(drizzle(client), { migrationsFolder: before });
}

const applyBackfill = () =>
  migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";

// After the migrations an agent needs a managing team; before 0243 it has none.
async function seedAgent(slug: string, withTeam = false): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    withTeam
      ? `WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, $3, $3, (SELECT id FROM t))`
      : `INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, $3, $3)`,
    [id, WORKSPACE, slug],
  );
  return id;
}

async function seedVersion(
  agentId: string,
  versionNo: number,
  card: Record<string, unknown>,
): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      id,
      agentId,
      versionNo,
      JSON.stringify(card),
      String(versionNo).repeat(64),
    ],
  );
  return id;
}

async function activate(agentId: string, versionId: string): Promise<void> {
  const releaseId = `rel-${versionId}`;
  await client.query(
    `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256, runtime_profile_id, profile_digest, runtime_config_snapshot, effective_tools)
     VALUES ($1, $2, $3, 'sha', 'default', 'digest', '{}'::jsonb, '{}'::jsonb)`,
    [releaseId, agentId, versionId],
  );
  await client.query(
    `UPDATE agents SET active_release_id = $1, activation_revision = 0 WHERE id = $2`,
    [releaseId, agentId],
  );
}

async function descriptions(): Promise<Record<string, string | null>> {
  const rows = await client.query<{ slug: string; description: string | null }>(
    `SELECT slug, description FROM agents ORDER BY slug`,
  );
  return Object.fromEntries(rows.rows.map((r) => [r.slug, r.description]));
}

const card = (role?: string) => ({
  ...(role === undefined ? {} : { role }),
  instructions: "never read",
  model: "m",
  capabilities: { tools: null, mcp: null, forbidden: [] },
});

beforeEach(async () => {
  client = new PGlite();
  await migrateBefore();
  await client.query(
    `INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'Acme')`,
    [WORKSPACE],
  );
});

afterEach(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("agent description backfill", () => {
  test("takes the role of the version people talk to, else the newest", async () => {
    const released = await seedAgent("released");
    const first = await seedVersion(released, 1, card("Answers billing"));
    await seedVersion(released, 2, card("Draft not yet released"));
    await activate(released, first);
    const draft = await seedAgent("draft");
    await seedVersion(draft, 1, card("Old role"));
    await seedVersion(draft, 2, card("Newest role"));
    const roleless = await seedAgent("roleless");
    await seedVersion(roleless, 1, card());
    await seedAgent("versionless");

    await applyBackfill();

    expect(await descriptions()).toEqual({
      draft: "Newest role",
      released: "Answers billing",
      roleless: null,
      versionless: null,
    });
    const cards = await client.query<{ role: string }>(
      `SELECT card->>'role' AS role FROM agent_versions WHERE agent_id = $1 ORDER BY version_no`,
      [released],
    );
    expect(cards.rows.map((r) => r.role)).toEqual([
      "Answers billing",
      "Draft not yet released",
    ]);
  });

  test("the column holds at most 2000 characters", async () => {
    await applyBackfill();
    const id = await seedAgent("long", true);
    await client.query(`UPDATE agents SET description = $1 WHERE id = $2`, [
      "x".repeat(2000),
      id,
    ]);
    await expect(
      client.query(`UPDATE agents SET description = $1 WHERE id = $2`, [
        "x".repeat(2001),
        id,
      ]),
    ).rejects.toThrow(/agents_description_check/);
  });
});
