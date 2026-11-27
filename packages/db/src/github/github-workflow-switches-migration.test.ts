import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  GITHUB_CEILING_DEFAULT,
  githubCeilingSchema,
  githubFeaturesSchema,
} from "@werft-ai/contracts";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "../migrate.ts";
import { MIGRATIONS_FOLDER } from "../migration-journal.ts";
import type { Database } from "../queries.ts";
import { migrationsThrough } from "../testing/migrations-through.ts";
import { ensureRepositoryCeilingWhenUnset } from "./github-settings.ts";

// Found by name: a restack renumbers it.
const TAG = (
  JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] }
).entries.find((entry) => entry.tag.endsWith("_github_workflow_switches"))?.tag;

const OLD_FEATURES = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: true,
};

/**
 * The two workflow switches (94S-2406): every stored ceiling and agent row
 * takes workflow edits on and direct runs off, in the stored shape images
 * before the switches read.
 */
describe("the workflow switches migration", () => {
  let client: PGlite;
  let before: string;
  const saved = randomUUID();
  const unsaved = randomUUID();
  const fresh = randomUUID();
  const plain = randomUUID();
  const runner = randomUUID();
  const person = randomUUID();

  const ceilingOf = async (workspaceId: string) =>
    (
      await client.query<{ ceiling: unknown; revision: number }>(
        "SELECT ceiling, revision FROM github_workspace_settings WHERE workspace_id = $1",
        [workspaceId],
      )
    ).rows[0];
  const agentRow = async (agentId: string) =>
    (
      await client.query<{
        features: unknown;
        actions_allow: unknown;
        revision: number;
        updated_by: string | null;
      }>(
        "SELECT features, actions_allow, revision, updated_by FROM agent_github_settings WHERE agent_id = $1",
        [agentId],
      )
    ).rows[0];

  beforeAll(async () => {
    if (TAG === undefined) throw new Error("no workflow switches migration");
    client = new PGlite();
    before = migrationsThrough(TAG, { exclusive: true });
    await migrate(drizzle(client), { migrationsFolder: before });
    for (const [id, slug] of [
      [saved, "saved"],
      [unsaved, "unsaved"],
      [fresh, "fresh"],
    ] as const) {
      await client.query(
        "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $2)",
        [id, slug],
      );
    }
    // A ceiling a person saved with the old Actions switch on (as on the
    // demo's b69a2558), and one never saved.
    await client.query(
      `INSERT INTO github_workspace_settings (workspace_id, ceiling, revision)
       VALUES ($1, '{"workflows": false, "actions": true, "checks": false, "issues": false, "review": true, "merge": true}', 14),
              ($2, '{"workflows": false, "actions": false, "checks": false, "issues": false, "review": false}', 0)`,
      [saved, unsaved],
    );
    for (const [id, slug] of [
      [plain, "plain"],
      [runner, "runner"],
    ] as const) {
      await client.query(
        `WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, $3) RETURNING id)
         INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, $3, $3, (SELECT id FROM t))`,
        [id, saved, slug],
      );
    }
    await client.query(
      `INSERT INTO agent_github_settings (agent_id, workspace_id, repositories, push_approval, features, actions_allow, revision, updated_by)
       VALUES ($1, $3, '[]', false, $4, '[]', 3, $5),
              ($2, $3, '[]', true, $6, '[{"workflow": "ci.yml"}]', 8, $5)`,
      [
        plain,
        runner,
        saved,
        JSON.stringify(OLD_FEATURES),
        person,
        JSON.stringify({ ...OLD_FEATURES, actions: true }),
      ],
    );
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await client.close();
    rmSync(before, { recursive: true, force: true });
  });

  test("a saved ceiling takes workflow edits on and direct runs off, the old Actions on included, and its revision moves", async () => {
    const row = await ceilingOf(saved);
    expect(row?.ceiling).toEqual({
      workflows: true,
      actions: false,
      checks: true,
      issues: false,
      review: true,
      merge: true,
    });
    expect(row?.revision).toBe(15);
  });

  test("a ceiling never saved takes the defaults and stays at revision 0", async () => {
    const row = await ceilingOf(unsaved);
    expect(githubCeilingSchema.parse(row?.ceiling)).toEqual(
      GITHUB_CEILING_DEFAULT,
    );
    expect(row?.revision).toBe(0);
  });

  test("agent rows take the defaults; one with direct runs on loses them and its allow list", async () => {
    expect(await agentRow(plain)).toEqual({
      features: { ...OLD_FEATURES, workflows: true, checks: true },
      actions_allow: [],
      revision: 4,
      updated_by: person,
    });
    expect(await agentRow(runner)).toEqual({
      features: { ...OLD_FEATURES, workflows: true, checks: true },
      actions_allow: [],
      revision: 9,
      updated_by: person,
    });
  });

  test("the rows keep the five keys an image before the switches reads (strict)", async () => {
    for (const agentId of [plain, runner]) {
      expect(
        githubFeaturesSchema.safeParse((await agentRow(agentId))?.features)
          .success,
      ).toBe(true);
    }
    expect(
      githubCeilingSchema.safeParse((await ceilingOf(saved))?.ceiling).success,
    ).toBe(true);
  });

  test("a workspace's first ceiling row is the default one", async () => {
    await ensureRepositoryCeilingWhenUnset(
      drizzle(client) as unknown as Database,
      fresh,
    );
    expect((await ceilingOf(fresh))?.ceiling).toEqual(GITHUB_CEILING_DEFAULT);
  });
});
