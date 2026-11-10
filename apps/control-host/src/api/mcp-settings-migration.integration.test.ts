import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@werft-ai/db";
import {
  agentMcpSettings,
  agentReleases,
  agents,
  agentVersions,
  sessions,
  users,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import { createTempDatabase } from "@werft-ai/testkit";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  parseArgs,
  runMcpSettingsMigration,
  sha256Of,
} from "./mcp-settings-migration.ts";
import { releaseSpecColumns, TEST_CONNECTION_ID } from "@werft-ai/db/testing/spec-pins";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const READ = "mcp__docs__read";
const SEARCH = "mcp__docs__search";

type Db = NodePgDatabase<typeof schema>;

/** A fresh database per test: the plan reads every agent in it. */
async function withDatabase(
  body: (context: {
    db: Db;
    pool: Pool;
    dir: string;
    // biome-ignore lint/suspicious/noExplicitAny: the CLI's one-line JSON summary
    run: (argv: string[]) => Promise<{ code: number; out: any }>;
  }) => Promise<void>,
) {
  const database = await createTempDatabase({ prefix: "mcp_migration_it" });
  const pool = new Pool({ connectionString: database.url, max: 6 });
  const db = drizzle(pool, { schema });
  const dir = await mkdtemp(join(tmpdir(), "mcp-migration-"));
  try {
    await body({
      db,
      pool,
      dir,
      run: async (argv) => {
        const lines: string[] = [];
        const code = await runMcpSettingsMigration(argv, { db, pool }, (line) =>
          lines.push(line),
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

const cardOf = (server: string | null, refs: string[], extra = {}) => ({
  role: "r",
  instructions: "i",
  model: "m",
  capabilities: {
    tools: null,
    mcp: server === null ? null : [{ server }],
    forbidden: [],
    credential_refs: refs,
    ...extra,
  },
});

async function workspaceOf(db: Db) {
  const id = randomUUID();
  await db
    .insert(workspaces)
    .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "w" });
  return id;
}

async function personOf(db: Db) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `${id}@example.invalid`,
    passwordHash: "argon2id$placeholder",
    displayName: "u",
  });
  return id;
}

async function agentOf(db: Db, workspaceId: string) {
  const id = randomUUID();
  await db.insert(agents).values({
    id,
    workspaceId,
    managingTeamId: await fixtureTeam(db, workspaceId),
    slug: `a-${id.slice(0, 8)}`,
    name: `agent-${id.slice(0, 4)}`,
  });
  return id;
}

async function versionOf(
  db: Db,
  agentId: string,
  versionNo: number,
  card: unknown,
) {
  const id = randomUUID();
  await db.insert(agentVersions).values({
    id,
    agentId,
    versionNo,
    card,
    contentSha256: randomUUID().replaceAll("-", "").repeat(2),
  });
  return id;
}

async function releaseOf(
  db: Db,
  agentId: string,
  versionNo: number,
  card: unknown,
  perTool: Record<string, string>,
) {
  const versionId = await versionOf(db, agentId, versionNo, card);
  const id = `rel-${randomUUID()}`;
  await db.insert(agentReleases).values({
    id,
    agentId,
    versionId,
    cardSha256: "0".repeat(64),
    connectionId: TEST_CONNECTION_ID,
    ...releaseSpecColumns(),
    runtimeConfigSnapshot: {},
    effectiveTools: { tools: [], mcp: [] },
    policyPins: {
      tools: { default: { builtin: "allow", mcp: "ask" }, per_tool: perTool },
    },
  });
  return id;
}

async function activate(db: Db, agentId: string, releaseId: string) {
  await db
    .update(agents)
    .set({ activeReleaseId: releaseId, activationRevision: 0 })
    .where(eq(agents.id, agentId));
}

/** A running agent whose release carries docs, two allowed tools, an ask and a deny. */
async function runningAgent(db: Db, workspaceId: string) {
  const agentId = await agentOf(db, workspaceId);
  const card = cardOf("docs", ["docs-key"]);
  const releaseId = await releaseOf(db, agentId, 1, card, {
    [READ]: "allow",
    [SEARCH]: "allow",
    mcp__docs__write: "ask",
    mcp__docs__drop: "deny",
  });
  await activate(db, agentId, releaseId);
  return { agentId, releaseId, card };
}

const rowOf = async (db: Db, agentId: string) =>
  (
    await db
      .select()
      .from(agentMcpSettings)
      .where(eq(agentMcpSettings.agentId, agentId))
  )[0];

const reportPath = (dir: string) => join(dir, `report-${randomUUID()}.json`);

integration("the MCP settings migration CLI on PostgreSQL", () => {
  test("the arguments are the other migrations' shape, and refuse the rest", () => {
    expect(parseArgs(["--dry-run", "--out", "r.json"])).toEqual({
      kind: "dry-run",
      out: "r.json",
      includeDrafts: false,
    });
    expect(
      parseArgs(["--dry-run", "--include-drafts", "--out", "r.json"]),
    ).toMatchObject({ includeDrafts: true });
    expect(
      parseArgs(["--apply", "--report", "r.json", "--report-sha256", "AB"]),
    ).toEqual({ kind: "apply", report: "r.json", sha256: "ab" });
    expect(parseArgs(["--revert"])).toEqual({ kind: "revert" });
    // No mode is the dry run, the mode that writes nothing.
    expect(parseArgs(["--out", "r.json"])).toEqual({
      kind: "dry-run",
      out: "r.json",
      includeDrafts: false,
    });
    for (const bad of [
      [],
      ["--dry-run"],
      ["--apply", "--report", "r.json"],
      ["--revert", "--out", "r.json"],
      ["--dry-run", "--revert"],
      ["--apply", "--include-drafts", "--report", "r", "--report-sha256", "a"],
      ["--nope"],
    ]) {
      expect(() => parseArgs(bad)).toThrow();
    }
  });

  test("a dry run writes nothing and names, per agent, the values and the ask and deny counts", async () => {
    await withDatabase(async ({ db, dir, run }) => {
      const { agentId } = await runningAgent(db, await workspaceOf(db));
      const out = reportPath(dir);
      const { code, out: summary } = await run(["--dry-run", "--out", out]);
      expect(code).toBe(0);
      expect(summary).toMatchObject({
        dry_run: true,
        copy: 1,
        ask_total: 1,
        deny_total: 1,
      });
      expect(summary.agents).toEqual([
        {
          agent_id: agentId,
          source: "active_release",
          server: "docs",
          tool_count: 2,
          credential_ref_count: 1,
          ask_count: 1,
          deny_count: 1,
          forbidden_count: 0,
        },
      ]);
      expect(summary.report_sha256).toBe(sha256Of(await readFile(out, "utf8")));
      expect(await db.select().from(agentMcpSettings)).toHaveLength(0);
      // An existing report is never overwritten.
      await expect(run(["--dry-run", "--out", out])).rejects.toThrow();
    });
  });

  test("apply copies as nobody at revision 1; a second run changes nothing and says so", async () => {
    await withDatabase(async ({ db, dir, run }) => {
      const workspaceId = await workspaceOf(db);
      const { agentId } = await runningAgent(db, workspaceId);
      // An agent a person has already saved: left exactly as it is.
      const saved = await runningAgent(db, workspaceId);
      const person = await personOf(db);
      await db.insert(agentMcpSettings).values({
        agentId: saved.agentId,
        workspaceId,
        server: "docs",
        allowedTools: [READ],
        credentialRefs: ["docs-key"],
        revision: 3,
        updatedBy: person,
      });
      const out = reportPath(dir);
      const { out: dry } = await run(["--dry-run", "--out", out]);
      expect(dry).toMatchObject({ copy: 1, has_row: 1 });
      const apply = ["--apply", "--report", out, "--report-sha256"];

      const first = await run([...apply, dry.report_sha256]);
      expect(first.code).toBe(0);
      expect(first.out).toMatchObject({
        copied: [agentId],
        copied_count: 1,
        skipped_existing_count: 0,
        changed_since_report_count: 0,
        refused_count: 0,
      });
      expect(await rowOf(db, agentId)).toMatchObject({
        server: "docs",
        allowedTools: [READ, SEARCH],
        credentialRefs: ["docs-key"],
        revision: 1,
        updatedBy: null,
      });
      expect(await rowOf(db, saved.agentId)).toMatchObject({
        allowedTools: [READ],
        revision: 3,
        updatedBy: person,
      });

      const second = await run([...apply, dry.report_sha256]);
      expect(second.code).toBe(0);
      expect(second.out).toMatchObject({
        copied_count: 0,
        skipped_existing_count: 1,
        changed_since_report_count: 0,
      });
      expect(await rowOf(db, agentId)).toMatchObject({ revision: 1 });
    });
  });

  test("apply refuses a report whose bytes are not the ones named, or not ones this command wrote", async () => {
    await withDatabase(async ({ db, dir, run }) => {
      await runningAgent(db, await workspaceOf(db));
      const out = reportPath(dir);
      const { out: dry } = await run(["--dry-run", "--out", out]);

      const wrong = await run([
        "--apply",
        "--report",
        out,
        "--report-sha256",
        "0".repeat(64),
      ]);
      expect(wrong.code).toBe(1);
      expect(wrong.out).toMatchObject({
        refused_count: 1,
        copied_count: 0,
      });

      // A hand-edited file with its own sha: the shape check still refuses it.
      const text = await readFile(out, "utf8");
      const edited = reportPath(dir);
      await writeFile(edited, text.replace('"version": 1', '"version":  1'));
      const hand = await run([
        "--apply",
        "--report",
        edited,
        "--report-sha256",
        sha256Of(await readFile(edited, "utf8")),
      ]);
      expect(hand.code).toBe(1);
      expect(hand.out.refused).toContain("not a report this command wrote");
      expect(await db.select().from(agentMcpSettings)).toHaveLength(0);
      expect(dry.copy).toBe(1);
    });
  });

  test("an agent that changed after the report is not copied, and the exit says so", async () => {
    await withDatabase(async ({ db, dir, run }) => {
      const workspaceId = await workspaceOf(db);
      const { agentId } = await runningAgent(db, workspaceId);
      const out = reportPath(dir);
      const { out: dry } = await run(["--dry-run", "--out", out]);
      // A new release with another server is activated after the report.
      const next = await releaseOf(
        db,
        agentId,
        2,
        cardOf("wiki", ["wiki-key"]),
        { mcp__wiki__read: "allow" },
      );
      await activate(db, agentId, next);

      const { code, out: summary } = await run([
        "--apply",
        "--report",
        out,
        "--report-sha256",
        dry.report_sha256,
      ]);
      expect(code).toBe(1);
      expect(summary).toMatchObject({
        copied_count: 0,
        changed_since_report_count: 1,
      });
      expect(summary.changed_since_report[0]).toMatchObject({
        agent_id: agentId,
        reason: "values_changed",
      });
      expect(await rowOf(db, agentId)).toBeUndefined();
    });
  });

  test("a draft moves only when the report was made with --include-drafts", async () => {
    await withDatabase(async ({ db, dir, run }) => {
      const workspaceId = await workspaceOf(db);
      const agentId = await agentOf(db, workspaceId);
      await versionOf(
        db,
        agentId,
        1,
        cardOf("docs", ["docs-key"], {
          tool_policy: { per_tool: { [READ]: "allow" } },
        }),
      );
      const plain = reportPath(dir);
      const { out: without } = await run(["--dry-run", "--out", plain]);
      expect(without).toMatchObject({ copy: 0, draft_not_included: 1 });
      await run([
        "--apply",
        "--report",
        plain,
        "--report-sha256",
        without.report_sha256,
      ]);
      expect(await rowOf(db, agentId)).toBeUndefined();

      const withDrafts = reportPath(dir);
      const { out: included } = await run([
        "--dry-run",
        "--include-drafts",
        "--out",
        withDrafts,
      ]);
      expect(included).toMatchObject({ copy: 1, include_drafts: true });
      await run([
        "--apply",
        "--report",
        withDrafts,
        "--report-sha256",
        included.report_sha256,
      ]);
      expect(await rowOf(db, agentId)).toMatchObject({
        allowedTools: [READ],
        credentialRefs: ["docs-key"],
        updatedBy: null,
      });
    });
  });

  test("revert removes only copied rows nobody has touched, and says what it left", async () => {
    await withDatabase(async ({ db, run }) => {
      const workspaceId = await workspaceOf(db);
      const person = await personOf(db);
      const copy = (agentId: string, over = {}) =>
        db.insert(agentMcpSettings).values({
          agentId,
          workspaceId,
          server: "docs",
          allowedTools: [READ, SEARCH],
          credentialRefs: ["docs-key"],
          updatedBy: null,
          ...over,
        });

      const plain = await runningAgent(db, workspaceId);
      await copy(plain.agentId);

      // A person saved this one, so it is theirs.
      const edited = await runningAgent(db, workspaceId);
      await copy(edited.agentId, { updatedBy: person, revision: 2 });

      // A session started with the row's snapshot would lose its MCP.
      const busy = await runningAgent(db, workspaceId);
      await copy(busy.agentId);
      await db.insert(sessions).values({
        id: randomUUID(),
        ownerId: workspaceId,
        workspaceId,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
        agentReleaseId: busy.releaseId,
        mcpStart: {
          server: "docs",
          allowed_tools: [READ],
          credential_refs: ["docs-key"],
          revision: 1,
        },
      });

      // The release now says something else than the copy did.
      const moved = await runningAgent(db, workspaceId);
      await copy(moved.agentId, { allowedTools: [READ] });

      // An older release of the agent does not carry what the row says.
      const older = await runningAgent(db, workspaceId);
      await copy(older.agentId);
      await releaseOf(db, older.agentId, 2, cardOf(null, []), {});

      const { code, out } = await run(["--revert"]);
      expect(out.reverted).toEqual([plain.agentId]);
      expect(out.kept_edited).toEqual([
        { agent_id: edited.agentId, revision: 2 },
      ]);
      expect(
        Object.fromEntries(
          out.left.map((l: { agent_id: string; reason: string }) => [
            l.agent_id,
            l.reason,
          ]),
        ),
      ).toEqual({
        [busy.agentId]: "open_session_with_snapshot",
        [moved.agentId]: "changed",
        [older.agentId]: "release_does_not_carry",
      });
      expect(out).toMatchObject({
        reverted_count: 1,
        kept_edited_count: 1,
        left_count: 3,
      });
      // Something was left, so the exit is not 0.
      expect(code).toBe(1);
      expect(await rowOf(db, plain.agentId)).toBeUndefined();
      expect(await rowOf(db, edited.agentId)).toBeDefined();
      expect(await rowOf(db, busy.agentId)).toBeDefined();
    });
  });

  test("revert takes back a draft's copy only while the newest card still gives its values", async () => {
    await withDatabase(async ({ db, run }) => {
      const workspaceId = await workspaceOf(db);
      const draftCard = (tools: string[]) =>
        cardOf("docs", ["docs-key"], {
          tool_policy: {
            per_tool: Object.fromEntries(tools.map((tool) => [tool, "allow"])),
          },
        });
      const copy = (agentId: string) =>
        db.insert(agentMcpSettings).values({
          agentId,
          workspaceId,
          server: "docs",
          allowedTools: [READ],
          credentialRefs: ["docs-key"],
          updatedBy: null,
        });

      // No active release, and the newest card still gives the copy's values.
      const same = await agentOf(db, workspaceId);
      await versionOf(db, same, 1, draftCard([READ]));
      await copy(same);

      // The draft was edited after the copy.
      const edited = await agentOf(db, workspaceId);
      await versionOf(db, edited, 1, draftCard([READ]));
      await versionOf(db, edited, 2, draftCard([READ, SEARCH]));
      await copy(edited);

      // A release was activated since, and it does not carry the copy.
      const activated = await agentOf(db, workspaceId);
      await versionOf(db, activated, 1, draftCard([READ]));
      await copy(activated);
      await activate(
        db,
        activated,
        await releaseOf(db, activated, 2, cardOf(null, []), {}),
      );

      const { code, out } = await run(["--revert"]);
      expect(out.reverted_draft).toEqual([same]);
      expect(
        Object.fromEntries(
          out.left.map((l: { agent_id: string; reason: string }) => [
            l.agent_id,
            l.reason,
          ]),
        ),
      ).toEqual({ [edited]: "changed", [activated]: "changed" });
      // A release's copy and a draft's copy are counted apart.
      expect(out).toMatchObject({
        reverted_count: 0,
        reverted_draft_count: 1,
        left_count: 2,
      });
      expect(code).toBe(1);
      expect(await rowOf(db, same)).toBeUndefined();
      expect(await rowOf(db, edited)).toBeDefined();
      expect(await rowOf(db, activated)).toBeDefined();
    });
  });
});
