import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "@werft-ai/db";
import {
  acquireMigrationLock,
  copyMcpSettingsRow,
  type Database,
  listMcpCopyCandidates,
  listMcpEditedRows,
  readMcpMigrationFacts,
  revertMcpCopyRow,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import {
  type McpMigrationPlan,
  messageOf,
  planMcpSettingsMigration,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { queueDatabaseUrl } from "../database-url.ts";

const USAGE = [
  "usage:",
  "  mcp-settings-migration [--dry-run] [--include-drafts] --out <report.json>",
  "  mcp-settings-migration --apply --report <report.json> --report-sha256 <hex>",
  "  mcp-settings-migration --revert",
].join("\n");

type Mode =
  | { kind: "dry-run"; out: string; includeDrafts: boolean }
  | { kind: "apply"; report: string; sha256: string }
  | { kind: "revert" };

export function parseArgs(argv: string[]): Mode {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) throw new Error(`unexpected ${arg}\n${USAGE}`);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg, next);
      index += 1;
    } else flags.set(arg, true);
  }
  const value = (name: string) => {
    const found = flags.get(name);
    if (typeof found !== "string") {
      throw new Error(`${name} needs a value\n${USAGE}`);
    }
    return found;
  };
  const known = new Set([
    "--dry-run",
    "--apply",
    "--revert",
    "--include-drafts",
    "--out",
    "--report",
    "--report-sha256",
  ]);
  for (const name of flags.keys()) {
    if (!known.has(name)) throw new Error(`unknown option ${name}\n${USAGE}`);
  }
  const modes = ["--dry-run", "--apply", "--revert"].filter((m) =>
    flags.has(m),
  );
  if (modes.length > 1) throw new Error(`pick one mode\n${USAGE}`);
  // No mode is a dry run: the one that writes nothing.
  const dryRun = modes.length === 0 || flags.has("--dry-run");
  // The draft choice is made once, in the report; --apply follows it.
  if (flags.has("--include-drafts") && !dryRun) {
    throw new Error(`--include-drafts belongs to --dry-run\n${USAGE}`);
  }
  if (flags.has("--dry-run") && flags.get("--dry-run") !== true) {
    throw new Error(`--dry-run takes no value\n${USAGE}`);
  }
  if (dryRun) {
    return {
      kind: "dry-run",
      out: value("--out"),
      includeDrafts: flags.has("--include-drafts"),
    };
  }
  if (flags.has("--apply")) {
    return {
      kind: "apply",
      report: value("--report"),
      sha256: value("--report-sha256").toLowerCase(),
    };
  }
  if (flags.size !== 1) throw new Error(`--revert takes no option\n${USAGE}`);
  return { kind: "revert" };
}

const reportBytes = (plan: McpMigrationPlan) =>
  `${JSON.stringify(plan, null, 2)}\n`;

export const sha256Of = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export type McpSettingsMigrationDeps = { db: Database; pool: Pool };

type Say = (summary: Record<string, unknown>) => void;

const LOCKED = "another MCP settings migration is running";

async function planNow(db: Database, includeDrafts: boolean) {
  return planMcpSettingsMigration({
    facts: await readMcpMigrationFacts(db),
    includeDrafts,
  });
}

async function dryRun(
  deps: McpSettingsMigrationDeps,
  mode: Mode & { kind: "dry-run" },
  say: Say,
) {
  const plan = await planNow(deps.db, mode.includeDrafts);
  const text = reportBytes(plan);
  await writeFile(mode.out, text, { flag: "wx" });
  say({
    dry_run: true,
    report: mode.out,
    report_sha256: sha256Of(text),
    include_drafts: plan.include_drafts,
    ...plan.totals,
    // Names of agents and counts only; the report file lists the tool and
    // credential names.
    agents: plan.agents
      .filter((entry) => entry.decision === "copy")
      .map((entry) => ({
        agent_id: entry.agent_id,
        source: entry.source,
        server: entry.server,
        tool_count: entry.allowed_tools.length,
        credential_ref_count: entry.credential_refs.length,
        ask_count: entry.ask_count,
        deny_count: entry.deny_count,
        forbidden_count: entry.forbidden_count,
      })),
  });
  return 0;
}

const refusedSummary = (refused: string) => ({
  dry_run: false,
  refused,
  refused_count: 1,
  copied_count: 0,
  skipped_existing_count: 0,
  changed_since_report_count: 0,
});

async function apply(
  deps: McpSettingsMigrationDeps,
  mode: Mode & { kind: "apply" },
  say: Say,
) {
  const text = await readFile(mode.report, "utf8");
  if (sha256Of(text) !== mode.sha256) {
    say(refusedSummary("the report file does not match --report-sha256"));
    return 1;
  }
  let plan: McpMigrationPlan;
  try {
    plan = JSON.parse(text) as McpMigrationPlan;
  } catch {
    say(refusedSummary("the report file is not a report this command wrote"));
    return 1;
  }
  if (plan.version !== 1 || reportBytes(plan) !== text) {
    say(refusedSummary("the report file is not a report this command wrote"));
    return 1;
  }
  const lock = await acquireMigrationLock(deps.pool);
  if (lock === null) {
    say(refusedSummary(LOCKED));
    return 1;
  }
  try {
    const copied: string[] = [];
    const skippedExisting: string[] = [];
    const changed: { agent_id: string; reason: string }[] = [];
    for (const entry of plan.agents) {
      if (entry.decision !== "copy") continue;
      const result = await copyMcpSettingsRow(deps.db, {
        entry,
        includeDrafts: plan.include_drafts,
      });
      if (result.status === "copied") copied.push(entry.agent_id);
      else if (result.status === "skipped_existing") {
        skippedExisting.push(entry.agent_id);
      } else {
        changed.push({ agent_id: entry.agent_id, reason: result.reason });
      }
    }
    say({
      dry_run: false,
      report_sha256: mode.sha256,
      include_drafts: plan.include_drafts,
      copied,
      skipped_existing: skippedExisting,
      changed_since_report: changed,
      refused_count: 0,
      copied_count: copied.length,
      skipped_existing_count: skippedExisting.length,
      changed_since_report_count: changed.length,
    });
    return changed.length > 0 ? 1 : 0;
  } finally {
    await lock.release();
  }
}

async function revert(deps: McpSettingsMigrationDeps, say: Say) {
  const lock = await acquireMigrationLock(deps.pool);
  if (lock === null) {
    say({ refused: LOCKED, refused_count: 1 });
    return 1;
  }
  try {
    const reverted: string[] = [];
    const revertedDraft: string[] = [];
    const left: { agent_id: string; reason: string }[] = [];
    for (const row of await listMcpCopyCandidates(deps.db)) {
      const result = await revertMcpCopyRow(deps.db, {
        agentId: row.agent_id,
        workspaceId: row.workspace_id,
      });
      if (result.status === "reverted") {
        (result.draft ? revertedDraft : reverted).push(row.agent_id);
      } else left.push({ agent_id: row.agent_id, reason: result.reason });
    }
    // A row a person saved is theirs: kept, and named so it is not missed.
    const keptEdited = await listMcpEditedRows(deps.db);
    say({
      reverted,
      reverted_draft: revertedDraft,
      kept_edited: keptEdited,
      left,
      refused_count: 0,
      // Two counts that never overlap: copies of a release, copies of a draft.
      reverted_count: reverted.length,
      reverted_draft_count: revertedDraft.length,
      kept_edited_count: keptEdited.length,
      left_count: left.length,
    });
    return left.length > 0 ? 1 : 0;
  } finally {
    await lock.release();
  }
}

/**
 * Exit 0: done; 1: refused, or something was left (named in the output and
 * counted: read the `*_count` fields, not the exit code alone).
 */
export async function runMcpSettingsMigration(
  argv: string[],
  deps: McpSettingsMigrationDeps,
  out: (line: string) => void = console.log,
): Promise<number> {
  const mode = parseArgs(argv);
  const say: Say = (summary) => out(JSON.stringify(summary));
  if (mode.kind === "dry-run") return dryRun(deps, mode, say);
  if (mode.kind === "apply") return apply(deps, mode, say);
  return revert(deps, say);
}

/** The database this one-time job reads and writes; nothing else is opened. */
async function openJobDatabase(
  name: string,
  environment: NodeJS.ProcessEnv,
): Promise<McpSettingsMigrationDeps> {
  const databaseUrl = queueDatabaseUrl(environment);
  const pool = createEnforcedPool(
    databaseUrl,
    createLogger({ level: "warn" }),
    name,
    JOB_POOL_TIMEOUTS,
    { max: 4 },
  );
  return { db: drizzle(pool, { schema }), pool };
}

async function mcpSettingsMigration(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = console.log,
): Promise<number> {
  parseArgs(argv);
  const opened = await openJobDatabase("mcp-settings-migration", environment);
  try {
    return await runMcpSettingsMigration(argv, opened, out);
  } finally {
    await opened.pool.end();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await mcpSettingsMigration(process.argv.slice(2));
  } catch (error) {
    console.error(messageOf(error));
    process.exitCode = 2;
  }
}
