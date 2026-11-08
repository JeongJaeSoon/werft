import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  acquireMigrationLock,
  createDatabaseIdentityReader,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  type Database,
  liveOwnerOf,
  openToolUnlockRollout,
  readToolUnlockFacts,
  recordToolUnlockItem,
} from "@werft-ai/db";
import {
  createAgentService,
  createAuthorizationPolicy,
  planToolUnlock,
  type SessionCatalog,
  type ToolUnlockEntry,
  type ToolUnlockPlan,
} from "@werft-ai/platform";
import type { Pool } from "pg";
import { openJobCatalog } from "./profile-migration.ts";

const USAGE = [
  "usage:",
  "  tool-unlock --dry-run --out <report.json>",
  "  tool-unlock --apply --out <report.json>",
].join("\n");

type Mode = { kind: "dry-run" | "apply"; out: string };

function parseArgs(argv: string[]): Mode {
  const [mode, flag, out, ...rest] = argv;
  if (
    (mode !== "--dry-run" && mode !== "--apply") ||
    flag !== "--out" ||
    out === undefined ||
    out.startsWith("--") ||
    rest.length > 0
  ) {
    throw new Error(USAGE);
  }
  return { kind: mode === "--apply" ? "apply" : "dry-run", out };
}

export const reportBytes = (plan: ToolUnlockPlan) =>
  `${JSON.stringify(plan, null, 2)}\n`;

export const sha256Of = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export type ToolUnlockDeps = {
  db: Database;
  pool: Pool;
  catalog: SessionCatalog;
  now?: () => string;
};

type Say = (summary: Record<string, unknown>) => void;

async function plan(deps: ToolUnlockDeps): Promise<ToolUnlockPlan> {
  await deps.catalog.workspace_profiles?.refresh(0);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  return planToolUnlock({
    facts: await readToolUnlockFacts(deps.db),
    catalog: deps.catalog,
    now,
  });
}

async function writeReport(out: string, report: ToolUnlockPlan) {
  const text = reportBytes(report);
  await writeFile(out, text, { flag: "wx" });
  return sha256Of(text);
}

const summaryOf = (report: ToolUnlockPlan) => ({
  ...report.totals,
  agents_unlocked: report.agents
    .filter((entry) => entry.decision === "unlock")
    .map((entry) => ({
      agent_id: entry.agent_id,
      unlocked: entry.unlocked,
    })),
});

async function apply(deps: ToolUnlockDeps, out: string, say: Say) {
  const { db, pool, catalog } = deps;
  const lock = await acquireMigrationLock(pool);
  if (lock === null) {
    say({ refused: "another profile migration or tool unlock is running" });
    return 1;
  }
  try {
    // The report goes out right before the run and does not hold it back: the
    // run judges every agent again under its own lock.
    // A file that cannot be written (an earlier dry-run at the same path, a
    // read-only dir) is named in the output and the run goes on; an existing
    // report is never overwritten.
    const report = await plan(deps);
    let sha: string | null = null;
    let reportError: string | null = null;
    try {
      sha = await writeReport(out, report);
    } catch (error) {
      reportError = error instanceof Error ? error.message : String(error);
    }
    const service = createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentStore(db),
      catalog,
      credentials: createPostgresCredentialBindingStore(db),
    });
    const actors = new Map<string, string | null>();
    const actorOf = async (workspaceId: string) => {
      if (!actors.has(workspaceId)) {
        actors.set(workspaceId, await liveOwnerOf(db, workspaceId));
      }
      return actors.get(workspaceId) ?? null;
    };
    const rollouts = new Map<string, string | null>();
    const rolloutOf = async (entry: ToolUnlockEntry, actor: string) => {
      if (!rollouts.has(entry.profile_id)) {
        rollouts.set(
          entry.profile_id,
          await openToolUnlockRollout(db, {
            profileId: entry.profile_id,
            createdBy: actor,
          }),
        );
      }
      return rollouts.get(entry.profile_id) ?? null;
    };
    const unlocked: Record<string, unknown>[] = [];
    const left: Record<string, unknown>[] = [];
    for (const entry of report.agents) {
      if (entry.decision === "same") continue;
      const note = (reason: string) =>
        left.push({ agent_id: entry.agent_id, reason });
      const actor = await actorOf(entry.workspace_id);
      if (actor === null) {
        note("no_live_owner");
        continue;
      }
      const rolloutId = await rolloutOf(entry, actor);
      const expected = {
        activeReleaseId: entry.active_release_id,
        activationRevision: entry.activation_revision,
        behaviorRevision: entry.behavior_revision,
      };
      // A refusal the plan already sees is an item too, so it is not lost.
      if (entry.decision === "would_fail") {
        const reason = entry.reason ?? "would_fail";
        note(reason);
        if (rolloutId !== null) {
          await recordToolUnlockItem(db, {
            rolloutId,
            agentId: entry.agent_id,
            generation: expected.activationRevision,
            result: { status: "failed", reason },
          });
        }
        continue;
      }
      const step = await service.unlockTools({
        workspaceId: entry.workspace_id,
        agentId: entry.agent_id,
        actorUserId: actor,
        rolloutId,
        expected,
      });
      if (step.status === "applied") {
        unlocked.push({ agent_id: entry.agent_id, release_id: step.releaseId });
        continue;
      }
      if (step.status === "same") continue;
      note(step.status === "failed" ? step.reason : "superseded");
      if (rolloutId !== null) {
        await recordToolUnlockItem(db, {
          rolloutId,
          agentId: entry.agent_id,
          generation: expected.activationRevision,
          result:
            step.status === "failed"
              ? { status: "failed", reason: step.reason }
              : { status: "superseded" },
        });
      }
    }
    say({
      dry_run: false,
      report: reportError === null ? out : null,
      report_sha256: sha,
      report_error: reportError,
      ...summaryOf(report),
      unlocked,
      not_unlocked: left,
    });
    return left.length > 0 ? 1 : 0;
  } finally {
    await lock.release();
  }
}

/** Exit 0: done; 1: something was left (named in the output). */
export async function runToolUnlock(
  argv: string[],
  deps: ToolUnlockDeps,
  out: (line: string) => void = console.log,
): Promise<number> {
  const mode = parseArgs(argv);
  const say: Say = (summary) => out(JSON.stringify(summary));
  if (mode.kind === "apply") return apply(deps, mode.out, say);
  const report = await plan(deps);
  const sha = await writeReport(mode.out, report);
  say({
    dry_run: true,
    report: mode.out,
    report_sha256: sha,
    ...summaryOf(report),
  });
  return 0;
}

export async function toolUnlock(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = console.log,
): Promise<number> {
  parseArgs(argv);
  const opened = await openJobCatalog("tool-unlock", environment);
  try {
    return await runToolUnlock(argv, opened, out);
  } finally {
    await opened.pool.end();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await toolUnlock(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
