import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@werft-ai/db";
import {
  agentEngineSettings,
  agentReleases,
  agents,
  agentVersions,
  setEngineSettingsGate,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import type { SessionCatalog } from "@werft-ai/platform";
import { installedToolCatalogs } from "@werft-ai/runtime-codecs";
import { createTempDatabase } from "@werft-ai/testkit";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { runEngineSettingsGate } from "./engine-settings-gate.ts";
import {
  parseArgs,
  runProfileRestrictionMigration,
  sha256Of,
} from "./profile-restriction-migration.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

type Db = NodePgDatabase<typeof schema>;

const CATALOG = installedToolCatalogs.find(
  (entry) => entry.runtimeKind === "claude_agent_sdk",
);
const ALL_TOOLS = (CATALOG?.tools ?? []).map((tool) => tool.name);

/** A profile that allows every catalog tool but the last, plus one blocked mcp__ name. */
const catalogWith = (over: Record<string, unknown> = {}) =>
  ({
    profiles: {
      coding: {
        runtime_kind: CATALOG?.runtimeKind,
        runtime_version: CATALOG?.sdkVersion,
        tools: ALL_TOOLS.slice(0, -1),
        mcp_deny: ["mcp__docs__drop"],
        ...over,
      },
    },
  }) as unknown as SessionCatalog;

// The CLI's one-line JSON summary; the tests read the fields they name.
// biome-ignore lint/suspicious/noExplicitAny: a parsed summary, not a typed value
type Summary = Record<string, any>;
type Run = (
  argv: string[],
  catalog?: SessionCatalog,
) => Promise<{ code: number; out: Summary }>;

async function withDatabase(
  body: (context: {
    db: Db;
    pool: Pool;
    dir: string;
    run: Run;
  }) => Promise<void>,
) {
  const database = await createTempDatabase({ prefix: "restriction_it" });
  const pool = new Pool({ connectionString: database.url, max: 6 });
  const db = drizzle(pool, { schema });
  const dir = await mkdtemp(join(tmpdir(), "restriction-"));
  try {
    await body({
      db,
      pool,
      dir,
      run: async (argv, catalog = catalogWith()) => {
        const lines: string[] = [];
        const code = await runProfileRestrictionMigration(
          argv,
          { db, pool, catalog },
          (line) => lines.push(line),
        );
        return { code, out: JSON.parse(lines.at(-1) ?? "null") };
      },
    });
  } finally {
    await pool.end();
    await database.drop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function workspaceOf(db: Db) {
  const id = randomUUID();
  await db
    .insert(workspaces)
    .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "w" });
  return id;
}

async function agentWithRelease(
  db: Db,
  workspaceId: string,
  tools: string[],
  more = 0,
) {
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    managingTeamId: await fixtureTeam(db, workspaceId),
    slug: `a-${agentId.slice(0, 8)}`,
    name: `agent-${agentId.slice(0, 4)}`,
  });
  const releaseIds: string[] = [];
  for (let n = 0; n <= more; n += 1) {
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: n + 1,
      card: {},
      contentSha256: randomUUID().replaceAll("-", "").repeat(2),
    });
    const id = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id,
      agentId,
      versionId,
      cardSha256: "0".repeat(64),
      runtimeProfileId: "coding",
      profileDigest: "digest",
      runtimeConfigSnapshot: { tools },
      effectiveTools: { tools, mcp: [] },
      policyPins: {},
    });
    releaseIds.push(id);
  }
  const active = releaseIds.at(-1) as string;
  await db
    .update(agents)
    .set({ activeReleaseId: active, activationRevision: 0 })
    .where(eq(agents.id, agentId));
  return { agentId, releaseIds };
}

const rowOf = async (db: Db, agentId: string) =>
  (
    await db
      .select()
      .from(agentEngineSettings)
      .where(eq(agentEngineSettings.agentId, agentId))
  )[0];

const plan = async (context: { dir: string; run: Run }) => {
  const out = join(context.dir, `report-${randomUUID()}.json`);
  const dry = await context.run(["--dry-run", "--out", out]);
  return { out, dry };
};

integration("the profile restriction migration on PostgreSQL", () => {
  test("the arguments follow the other migrations' shape", () => {
    expect(parseArgs(["--out", "r.json"])).toEqual({
      kind: "dry-run",
      out: "r.json",
    });
    expect(
      parseArgs(["--apply", "--report", "r.json", "--report-sha256", "AB"]),
    ).toEqual({ kind: "apply", report: "r.json", sha256: "ab" });
    for (const bad of [
      [],
      ["--apply", "--report", "r.json"],
      ["--dry-run", "--apply", "--out", "r"],
      ["--nope"],
    ]) {
      expect(() => parseArgs(bad)).toThrow();
    }
  });

  test("a dry run writes nothing; an apply writes one entry that exempts every release the agent has", async () => {
    await withDatabase(async (context) => {
      const { db, run } = context;
      const workspaceId = await workspaceOf(db);
      const { agentId, releaseIds } = await agentWithRelease(
        db,
        workspaceId,
        ALL_TOOLS.slice(0, 2),
        1,
      );
      const { out, dry } = await plan(context);
      expect(dry.out.write).toBe(1);
      expect(await rowOf(db, agentId)).toBeUndefined();

      // The gate is shut until the operator opens it: nothing is written.
      const text = await readFile(out, "utf8");
      const shut = await run([
        "--apply",
        "--report",
        out,
        "--report-sha256",
        sha256Of(text),
      ]);
      expect(shut.code).toBe(1);
      expect(shut.out.gate_closed).toBe(true);
      expect(await rowOf(db, agentId)).toBeUndefined();

      await setEngineSettingsGate(db, true);
      const applied = await run([
        "--apply",
        "--report",
        out,
        "--report-sha256",
        sha256Of(text),
      ]);
      expect(applied.code).toBe(0);
      expect(applied.out.written).toEqual([agentId]);
      const row = await rowOf(db, agentId);
      expect(row?.revision).toBe(1);
      const entries = row?.adminDeny as Array<{
        exempt_release_ids: string[];
        permissions_deny: string[];
        mcp_deny: string[];
      }>;
      expect(entries).toHaveLength(1);
      expect([...(entries[0]?.exempt_release_ids ?? [])].sort()).toEqual(
        [...releaseIds].sort(),
      );
      // The release allows two tools of a catalog the profile allows all but one of.
      expect(entries[0]?.permissions_deny).toEqual(ALL_TOOLS.slice(2));
      expect(entries[0]?.mcp_deny).toEqual(["mcp__docs__drop"]);
    });
  });

  test("a second run plans nothing and a replayed report writes nothing more (idempotent)", async () => {
    await withDatabase(async (context) => {
      const { db, run } = context;
      const workspaceId = await workspaceOf(db);
      const { agentId } = await agentWithRelease(
        db,
        workspaceId,
        ALL_TOOLS.slice(0, 2),
      );
      await setEngineSettingsGate(db, true);
      const first = await plan(context);
      const text = await readFile(first.out, "utf8");
      const argv = [
        "--apply",
        "--report",
        first.out,
        "--report-sha256",
        sha256Of(text),
      ];
      expect((await run(argv)).out.written_count).toBe(1);
      const again = await run(argv);
      expect(again.out.written_count).toBe(0);
      expect(again.out.skipped_existing).toEqual([agentId]);
      const second = await plan(context);
      expect(second.dry.out.write).toBe(0);
      expect((await rowOf(db, agentId))?.adminDeny).toHaveLength(1);
    });
  });

  test("an apply refuses a report that was edited, and an agent that changed after the report is left alone", async () => {
    await withDatabase(async (context) => {
      const { db, run, dir } = context;
      const workspaceId = await workspaceOf(db);
      const { agentId } = await agentWithRelease(
        db,
        workspaceId,
        ALL_TOOLS.slice(0, 2),
      );
      await setEngineSettingsGate(db, true);
      const { out } = await plan(context);
      const text = await readFile(out, "utf8");

      const wrong = await run([
        "--apply",
        "--report",
        out,
        "--report-sha256",
        "0".repeat(64),
      ]);
      expect(wrong.code).toBe(1);
      expect(wrong.out.refused).toContain("--report-sha256");

      // The profile blocks a different set by the time the apply runs.
      const changed = await run(
        ["--apply", "--report", out, "--report-sha256", sha256Of(text)],
        catalogWith({ tools: ALL_TOOLS.slice(0, 1) }),
      );
      expect(changed.code).toBe(1);
      expect(changed.out.changed_since_report_count).toBe(1);
      expect(await rowOf(db, agentId)).toBeUndefined();
      void dir;
    });
  });

  test("an agent with no release, or a gone profile, writes nothing and is reported", async () => {
    await withDatabase(async (context) => {
      const { db } = context;
      const workspaceId = await workspaceOf(db);
      const { agentId } = await agentWithRelease(db, workspaceId, ["Read"]);
      const lone = randomUUID();
      await db.insert(agents).values({
        id: lone,
        workspaceId,
        managingTeamId: await fixtureTeam(db, workspaceId),
        slug: `a-${lone.slice(0, 8)}`,
        name: "lone",
      });
      const out = join(context.dir, "r.json");
      const dry = await context.run(["--dry-run", "--out", out], {
        profiles: {},
      } as unknown as SessionCatalog);
      expect(dry.out.write).toBe(0);
      expect(dry.out.blocked).toBe(1);
      expect(dry.out.blocked_agents).toEqual([
        { agent_id: agentId, reason: "profile_gone" },
      ]);
      const report = JSON.parse(await readFile(out, "utf8"));
      expect(
        report.agents.find((a: { agent_id: string }) => a.agent_id === lone)
          .reason,
      ).toBe("no_release");
    });
  });

  test("an agent that needs an entry but is not in the report stops the apply with nothing written", async () => {
    await withDatabase(async (context) => {
      const { db, run } = context;
      const workspaceId = await workspaceOf(db);
      const first = await agentWithRelease(
        db,
        workspaceId,
        ALL_TOOLS.slice(0, 2),
      );
      await setEngineSettingsGate(db, true);
      const { out } = await plan(context);
      const text = await readFile(out, "utf8");
      // Made after the report was read.
      const later = await agentWithRelease(
        db,
        workspaceId,
        ALL_TOOLS.slice(0, 2),
      );
      const applied = await run([
        "--apply",
        "--report",
        out,
        "--report-sha256",
        sha256Of(text),
      ]);
      expect(applied.code).toBe(1);
      expect(applied.out.refused).toContain("make a new one");
      expect(applied.out.out_of_report).toEqual([
        {
          agent_id: later.agentId,
          now: "write",
          reason: null,
          in_report: null,
        },
      ]);
      expect(await rowOf(db, first.agentId)).toBeUndefined();
      expect(await rowOf(db, later.agentId)).toBeUndefined();
    });
  });

  test("an apply of a report with a blocked agent names it and does not succeed", async () => {
    await withDatabase(async (context) => {
      const { db, run } = context;
      const workspaceId = await workspaceOf(db);
      const { agentId } = await agentWithRelease(db, workspaceId, ["Read"]);
      await setEngineSettingsGate(db, true);
      const gone = { profiles: {} } as unknown as SessionCatalog;
      const out = join(context.dir, "blocked.json");
      await run(["--dry-run", "--out", out], gone);
      const text = await readFile(out, "utf8");
      const applied = await run(
        ["--apply", "--report", out, "--report-sha256", sha256Of(text)],
        gone,
      );
      expect(applied.code).toBe(1);
      expect(applied.out.written_count).toBe(0);
      expect(applied.out.blocked_count).toBe(1);
      expect(applied.out.blocked).toEqual([
        { agent_id: agentId, reason: "profile_gone" },
      ]);
      expect(await rowOf(db, agentId)).toBeUndefined();
    });
  });

  test("an activation and the entry take the agent's lock in turn, so the entry exempts the release made first", async () => {
    await withDatabase(async (context) => {
      const { db, pool, run } = context;
      const workspaceId = await workspaceOf(db);
      const { agentId } = await agentWithRelease(
        db,
        workspaceId,
        ALL_TOOLS.slice(0, 2),
      );
      await setEngineSettingsGate(db, true);
      const { out } = await plan(context);
      const text = await readFile(out, "utf8");

      // A release made while the agent row is locked lands before the entry reads the list.
      const holder = await pool.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [
        agentId,
      ]);
      const pending = run([
        "--apply",
        "--report",
        out,
        "--report-sha256",
        sha256Of(text),
      ]);
      // Wait until the apply is queued on the agent's lock; only then is a
      // release made "first" in any sense the test can lean on.
      let waiting = false;
      for (let tries = 0; tries < 300 && !waiting; tries += 1) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM agents WHERE id%FOR UPDATE%'`,
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((done) => setTimeout(done, 50));
      }
      expect(waiting).toBe(true);
      const versionId = randomUUID();
      await holder.query(
        `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
         VALUES ($1, $2, 9, '{}'::jsonb, $3)`,
        [versionId, agentId, "a".repeat(64)],
      );
      const lateId = `rel-${randomUUID()}`;
      await holder.query(
        `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256, runtime_profile_id, profile_digest, runtime_config_snapshot, effective_tools, policy_pins)
         VALUES ($1, $2, $3, $4, 'coding', 'd', $5::jsonb, '{"tools":[],"mcp":[]}'::jsonb, '{}'::jsonb)`,
        [
          lateId,
          agentId,
          versionId,
          "0".repeat(64),
          JSON.stringify({ tools: ALL_TOOLS.slice(0, 2) }),
        ],
      );
      await holder.query("COMMIT");
      holder.release();
      const result = await pending;
      expect(result.out.written).toEqual([agentId]);
      const entries = (await rowOf(db, agentId))?.adminDeny as Array<{
        exempt_release_ids: string[];
      }>;
      expect(entries[0]?.exempt_release_ids).toContain(lateId);
    });
  });

  test("the gate command opens, closes and reports without touching stored rules", async () => {
    await withDatabase(async ({ db }) => {
      const say = async (command: string) => {
        const lines: string[] = [];
        const code = await runEngineSettingsGate([command], { db }, (l) =>
          lines.push(l),
        );
        return { code, out: JSON.parse(lines.at(-1) ?? "null") };
      };
      expect((await say("status")).out.writes_open).toBe(false);
      expect((await say("open")).out).toEqual({
        writes_open_before: false,
        writes_open: true,
      });
      expect((await say("open")).out.writes_open_before).toBe(true);
      expect((await say("status")).out.writes_open).toBe(true);
      expect((await say("close")).out.writes_open).toBe(false);
      await expect(runEngineSettingsGate(["nope"], { db })).rejects.toThrow();
    });
  });
});
