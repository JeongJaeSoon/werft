import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  acquireMigrationLock,
  type Database,
  readRestrictionFacts,
  writeRestrictionEntry,
} from "@werft-ai/db";
import {
  catalogProfile,
  planProfileRestrictionMigration,
  type RestrictionPlan,
  type RestrictionResolver,
  type SessionCatalog,
} from "@werft-ai/platform";
import type { Pool } from "pg";
import { openJobCatalog } from "./profile-migration.ts";
import { installedToolCatalogView } from "./tool-catalogs.ts";

const USAGE = [
  "usage:",
  "  profile-restriction-migration [--dry-run] --out <report.json>",
  "  profile-restriction-migration --apply --report <report.json> --report-sha256 <hex>",
].join("\n");

type Mode =
  | { kind: "dry-run"; out: string }
  | { kind: "apply"; report: string; sha256: string };

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
    "--out",
    "--report",
    "--report-sha256",
  ]);
  for (const name of flags.keys()) {
    if (!known.has(name)) throw new Error(`unknown option ${name}\n${USAGE}`);
  }
  if (flags.has("--dry-run") && flags.has("--apply")) {
    throw new Error(`pick one mode\n${USAGE}`);
  }
  if (flags.has("--dry-run") && flags.get("--dry-run") !== true) {
    throw new Error(`--dry-run takes no value\n${USAGE}`);
  }
  // No mode is a dry run: the one that writes nothing.
  if (!flags.has("--apply")) {
    return { kind: "dry-run", out: value("--out") };
  }
  return {
    kind: "apply",
    report: value("--report"),
    sha256: value("--report-sha256").toLowerCase(),
  };
}

export const reportBytes = (plan: RestrictionPlan) =>
  `${JSON.stringify(plan, null, 2)}\n`;

export const sha256Of = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export type RestrictionMigrationDeps = {
  db: Database;
  pool: Pool;
  catalog: SessionCatalog;
};

type Say = (summary: Record<string, unknown>) => void;

const LOCKED =
  "another profile migration, tool unlock or settings migration is running";

/** The profile a release ran under today, with the tool catalog of its runtime. */
export function resolverOf(catalog: SessionCatalog): RestrictionResolver {
  return (_workspaceId, profileId) => {
    const profile = catalogProfile(catalog, profileId);
    if (profile === undefined) return undefined;
    return {
      tools: profile.tools,
      mcp_deny: profile.mcp_deny ?? [],
      catalog: installedToolCatalogView.for(
        profile.runtime_kind,
        profile.runtime_version,
      ),
    };
  };
}

async function planNow(deps: RestrictionMigrationDeps) {
  await deps.catalog.workspace_profiles?.refresh(0);
  return planProfileRestrictionMigration({
    facts: await readRestrictionFacts(deps.db),
    resolve: resolverOf(deps.catalog),
  });
}

async function dryRun(
  deps: RestrictionMigrationDeps,
  mode: Mode & { kind: "dry-run" },
  say: Say,
) {
  const plan = await planNow(deps);
  const text = reportBytes(plan);
  await writeFile(mode.out, text, { flag: "wx" });
  say({
    dry_run: true,
    report: mode.out,
    report_sha256: sha256Of(text),
    ...plan.totals,
    // Counts and reasons only; the report file names the rules.
    blocked_agents: plan.agents
      .filter((entry) => entry.decision === "blocked")
      .map((entry) => ({
        agent_id: entry.agent_id,
        reason: entry.reason,
      })),
  });
  return 0;
}

const refusedSummary = (refused: string) => ({
  dry_run: false,
  refused,
  refused_count: 1,
  written_count: 0,
  skipped_existing_count: 0,
  changed_since_report_count: 0,
});

async function apply(
  deps: RestrictionMigrationDeps,
  mode: Mode & { kind: "apply" },
  say: Say,
) {
  const text = await readFile(mode.report, "utf8");
  if (sha256Of(text) !== mode.sha256) {
    say(refusedSummary("the report file does not match --report-sha256"));
    return 1;
  }
  let plan: RestrictionPlan;
  try {
    plan = JSON.parse(text) as RestrictionPlan;
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
    // What the data reads as now, against what the report approved: an agent
    // that needs an entry the report did not list (it was skipped then, or it
    // is new) is named and nothing is written. A new report is the way on,
    // not a rule nobody reviewed.
    const approved = new Map(
      plan.agents.map((entry) => [entry.agent_id, entry.decision]),
    );
    const outOfReport = (await planNow(deps)).agents
      .filter(
        (entry) =>
          entry.decision !== "skip" &&
          approved.get(entry.agent_id) !== entry.decision,
      )
      .map((entry) => ({
        agent_id: entry.agent_id,
        now: entry.decision,
        reason: entry.reason,
        in_report: approved.get(entry.agent_id) ?? null,
      }));
    if (outOfReport.length > 0) {
      say({
        ...refusedSummary("the data changed since the report: make a new one"),
        out_of_report: outOfReport,
        out_of_report_count: outOfReport.length,
      });
      return 1;
    }
    const resolve = resolverOf(deps.catalog);
    const written: string[] = [];
    const skippedExisting: string[] = [];
    const changed: { agent_id: string; reason: string }[] = [];
    let gateClosed = false;
    // An agent the plan could not move is left, and named: success means the
    // report had nothing blocked, not only that the writes went through.
    const blocked = plan.agents
      .filter((entry) => entry.decision === "blocked")
      .map((entry) => ({ agent_id: entry.agent_id, reason: entry.reason }));
    const summary = () => ({
      dry_run: false,
      report_sha256: mode.sha256,
      written,
      skipped_existing: skippedExisting,
      changed_since_report: changed,
      blocked,
      gate_closed: gateClosed,
      refused_count: gateClosed ? 1 : 0,
      written_count: written.length,
      skipped_existing_count: skippedExisting.length,
      changed_since_report_count: changed.length,
      blocked_count: blocked.length,
      still_needed: stillNeeded,
      still_needed_count: stillNeeded.length,
    });
    // The agents the data needs an entry for after the writes. A release made
    // while this ran is not stopped (that needs the profile freeze), but it
    // is found here, named, and makes the exit code 1.
    let stillNeeded: { agent_id: string; reason: string | null }[] = [];
    try {
      for (const entry of plan.agents) {
        if (entry.decision !== "write") continue;
        const result = await writeRestrictionEntry(deps.db, {
          workspaceId: entry.workspace_id,
          agentId: entry.agent_id,
          expected: {
            permissions_deny: entry.permissions_deny,
            mcp_deny: entry.mcp_deny,
          },
          resolve,
        });
        if (result.status === "written") written.push(entry.agent_id);
        else if (result.status === "skipped_existing") {
          skippedExisting.push(entry.agent_id);
        } else if (result.status === "gate_closed") {
          gateClosed = true;
          break;
        } else {
          changed.push({ agent_id: entry.agent_id, reason: result.reason });
        }
      }
    } catch (error) {
      // Each agent commits on its own: say how far it got before the error.
      say({ ...summary(), error: String(error) });
      throw error;
    }
    if (!gateClosed) {
      stillNeeded = (await planNow(deps)).agents
        .filter((entry) => entry.decision === "write")
        .map((entry) => ({ agent_id: entry.agent_id, reason: entry.reason }));
    }
    say(summary());
    return gateClosed ||
      changed.length > 0 ||
      blocked.length > 0 ||
      stillNeeded.length > 0
      ? 1
      : 0;
  } finally {
    await lock.release();
  }
}

/**
 * Exit 0: done; 1: refused, or something was left (named in the output and
 * counted: read the `*_count` fields, not the exit code alone).
 */
export async function runProfileRestrictionMigration(
  argv: string[],
  deps: RestrictionMigrationDeps,
  out: (line: string) => void = console.log,
): Promise<number> {
  const mode = parseArgs(argv);
  const say: Say = (summary) => out(JSON.stringify(summary));
  return mode.kind === "dry-run"
    ? dryRun(deps, mode, say)
    : apply(deps, mode, say);
}

export async function profileRestrictionMigration(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = console.log,
): Promise<number> {
  parseArgs(argv);
  const opened = await openJobCatalog(
    "profile-restriction-migration",
    environment,
  );
  try {
    return await runProfileRestrictionMigration(argv, opened, out);
  } finally {
    await opened.pool.end();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await profileRestrictionMigration(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
