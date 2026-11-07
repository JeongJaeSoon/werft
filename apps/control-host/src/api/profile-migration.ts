import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "@werft-ai/db";
import {
  acquireMigrationLock,
  createDatabaseIdentityReader,
  createPostgresAgentStore,
  createPostgresCatalogRepositoryStore,
  createPostgresCredentialBindingStore,
  createPostgresInstallationProfileStore,
  createPostgresInstallationSettingsStore,
  createPostgresWorkspaceProfileStore,
  type Database,
  liveOwnerOf,
  readMigrationFacts,
  readMigrationRecord,
  retireMigrationCopy,
  topUpCeiling,
  writeProfileCopy,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import {
  createAgentService,
  createAuthorizationPolicy,
  createProfileRegistry,
  type MigrationPlan,
  migrationRefusal,
  planMigration,
  profileCatalog,
  type SessionCatalog,
  withConsoleRepositories,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import {
  loadSecretKey,
  profileSources,
  runtimeVersionsFromEnv,
  secretsManagerReader,
} from "./catalog-config.ts";
import { leftOutReporter, settingsSource } from "./installation-settings.ts";
import { installedToolCatalogView } from "./tool-catalogs.ts";

const USAGE = [
  "usage:",
  "  profile-migration --dry-run --out <report.json>",
  "  profile-migration --apply --report <report.json> --report-sha256 <hex>",
  "  profile-migration --revert --migration-id <id>",
].join("\n");

type Mode =
  | { kind: "dry-run"; out: string }
  | { kind: "apply"; report: string; sha256: string }
  | { kind: "revert"; migrationId: string };

function parseArgs(argv: string[]): Mode {
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
    "--out",
    "--report",
    "--report-sha256",
    "--migration-id",
  ]);
  for (const name of flags.keys()) {
    if (!known.has(name)) throw new Error(`unknown option ${name}\n${USAGE}`);
  }
  const modes = ["--dry-run", "--apply", "--revert"].filter((m) =>
    flags.has(m),
  );
  if (modes.length !== 1) throw new Error(`pick exactly one mode\n${USAGE}`);
  if (flags.has("--dry-run")) return { kind: "dry-run", out: value("--out") };
  if (flags.has("--apply")) {
    return {
      kind: "apply",
      report: value("--report"),
      sha256: value("--report-sha256").toLowerCase(),
    };
  }
  return { kind: "revert", migrationId: value("--migration-id") };
}

export const reportBytes = (plan: MigrationPlan) =>
  `${JSON.stringify(plan, null, 2)}\n`;

export const sha256Of = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export type MigrationDeps = {
  db: Database;
  pool: Pool;
  catalog: SessionCatalog;
  now?: () => string;
  newId?: () => string;
};

type Summary = Record<string, unknown>;

async function refresh(catalog: SessionCatalog) {
  await catalog.workspace_profiles?.refresh(0);
}

async function dryRun(deps: MigrationDeps, out: string, say: Say) {
  const { db, catalog } = deps;
  await refresh(catalog);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const newId = deps.newId ?? randomUUID;
  const plan = planMigration({
    ...(await readMigrationFacts(db, now)),
    now,
    catalog,
    newId,
    migrationId: newId(),
  });
  const text = reportBytes(plan);
  await writeFile(out, text, { flag: "wx" });
  say({
    dry_run: true,
    report: out,
    report_sha256: sha256Of(text),
    migration_id: plan.migration_id,
    start_conditions: migrationRefusal(plan) ?? "met",
    workspaces: plan.workspaces.map((w) => ({
      workspace_id: w.workspace_id,
      copy: w.profiles.filter((p) => p.decision === "copy").length,
      exists: w.profiles.filter((p) => p.decision === "exists").length,
      skipped: w.profiles.filter((p) => p.decision === "skip").length,
      move: w.agents.filter((a) => a.decision === "move").length,
      stay: w.agents.filter((a) => a.decision === "stay").length,
      ceiling_additions: w.ceiling.additions.length,
    })),
  });
  return 0;
}

type Say = (summary: Summary) => void;

async function apply(
  deps: MigrationDeps,
  mode: Mode & { kind: "apply" },
  say: Say,
) {
  const { db, pool, catalog } = deps;
  const text = await readFile(mode.report, "utf8");
  if (sha256Of(text) !== mode.sha256) {
    say({ refused: "the report file does not match --report-sha256" });
    return 1;
  }
  const plan = JSON.parse(text) as MigrationPlan;
  if (plan.version !== 1 || reportBytes(plan) !== text) {
    say({ refused: "the report file is not a report this command wrote" });
    return 1;
  }
  const lock = await acquireMigrationLock(pool);
  if (lock === null) {
    say({ refused: "another profile migration is running" });
    return 1;
  }
  try {
    await refresh(catalog);
    const now = new Date().toISOString();
    const current = planMigration({
      ...(await readMigrationFacts(db, now)),
      now,
      catalog,
      newId: randomUUID,
      migrationId: plan.migration_id,
    });
    const refusal = migrationRefusal(plan) ?? migrationRefusal(current);
    if (refusal !== null) {
      say({ refused: refusal });
      return 1;
    }
    const service = createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentStore(db),
      catalog,
      credentials: createPostgresCredentialBindingStore(db),
    });
    const report: Summary[] = [];
    let failed = false;
    for (const workspace of plan.workspaces) {
      const entry: Summary = { workspace_id: workspace.workspace_id };
      report.push(entry);
      const hasWork =
        workspace.ceiling.additions.length > 0 ||
        workspace.profiles.some((p) => p.decision !== "skip") ||
        workspace.agents.some((a) => a.decision === "move");
      if (!hasWork) continue;
      const actor = workspace.actor_user_id;
      if (actor === null) {
        entry.refused = "no live owner";
        failed = true;
        continue;
      }
      // 1. The ceiling, before any copy is visible.
      const ceiling = await topUpCeiling(db, {
        migrationId: plan.migration_id,
        actorUserId: actor,
        workspaceId: workspace.workspace_id,
        additions: workspace.ceiling.additions,
      });
      entry.ceiling = ceiling;
      if (ceiling.outcome === "refused") {
        failed = true;
        continue;
      }
      const copies: Summary[] = [];
      entry.copies = copies;
      for (const profile of workspace.profiles) {
        if (profile.decision === "skip") {
          copies.push({ source: profile.source_id, skipped: profile.skip });
          continue;
        }
        const result = await writeProfileCopy(db, {
          migrationId: plan.migration_id,
          actorUserId: actor,
          plan: profile,
        });
        copies.push({ source: profile.source_id, ...result });
        if (result.outcome === "refused") failed = true;
      }
      await refresh(catalog);
      const moved: Summary[] = [];
      const left: Summary[] = [];
      entry.moved = moved;
      entry.not_moved = left;
      for (const agent of workspace.agents) {
        if (agent.decision === "stay" || agent.to_profile_id === null) {
          left.push({ agent_id: agent.agent_id, reason: agent.stay_reason });
          continue;
        }
        // A newer version of the name appeared after the report: the
        // approved tracking no longer holds, and a pinned agent must not follow.
        const latest = current.workspaces
          .find((w) => w.workspace_id === workspace.workspace_id)
          ?.agents.find((a) => a.agent_id === agent.agent_id);
        if (
          latest?.decision === "move" &&
          latest.tracking_after !== agent.tracking_after
        ) {
          failed = true;
          left.push({ agent_id: agent.agent_id, reason: "plan_changed" });
          continue;
        }
        const step = await service.migrateAgent({
          workspaceId: workspace.workspace_id,
          agentId: agent.agent_id,
          actorUserId: actor,
          targetProfileId: agent.to_profile_id,
          migrationId: plan.migration_id,
          expected: {
            activeReleaseId: agent.expected.active_release_id,
            activationRevision: agent.expected.activation_revision,
            behaviorRevision: agent.expected.behavior_revision,
            tracking: agent.expected.tracking,
            modelSource: agent.expected.model_source,
          },
          tracking: agent.tracking_after,
        });
        if (step.status === "applied" || step.status === "already") {
          moved.push({ agent_id: agent.agent_id, result: step.status });
        } else {
          failed = true;
          left.push({
            agent_id: agent.agent_id,
            reason:
              step.status === "failed" ? step.reason : "changed_since_report",
          });
        }
      }
    }
    say({
      dry_run: false,
      migration_id: plan.migration_id,
      complete: !failed,
      workspaces: report,
    });
    return failed ? 1 : 0;
  } finally {
    await lock.release();
  }
}

async function revert(
  deps: MigrationDeps,
  mode: Mode & { kind: "revert" },
  say: Say,
) {
  const { db, pool, catalog } = deps;
  const lock = await acquireMigrationLock(pool);
  if (lock === null) {
    say({ refused: "another profile migration is running" });
    return 1;
  }
  try {
    await refresh(catalog);
    const record = await readMigrationRecord(db, mode.migrationId);
    if (record.agents.length === 0 && record.copies.length === 0) {
      say({ refused: `nothing was written by migration ${mode.migrationId}` });
      return 1;
    }
    const service = createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentStore(db),
      catalog,
      credentials: createPostgresCredentialBindingStore(db),
    });
    const reverted: Summary[] = [];
    const skipped: Summary[] = [];
    let failed = false;
    const actors = new Map<string, string | null>();
    const actorOf = async (workspaceId: string) => {
      if (!actors.has(workspaceId)) {
        actors.set(workspaceId, await liveOwnerOf(db, workspaceId));
      }
      return actors.get(workspaceId) ?? null;
    };
    for (const agent of record.agents) {
      const actor = await actorOf(agent.workspace_id);
      if (actor === null || agent.previous_release_id === null) {
        skipped.push({
          agent_id: agent.agent_id,
          reason: "no_actor_or_previous",
        });
        failed = true;
        continue;
      }
      const step = await service.revertMigration({
        workspaceId: agent.workspace_id,
        agentId: agent.agent_id,
        actorUserId: actor,
        migrationId: mode.migrationId,
        previousReleaseId: agent.previous_release_id,
        expected: {
          activeReleaseId: agent.release_id,
          activationRevision: agent.activation_revision,
          behaviorRevision: agent.behavior_revision,
          tracking: agent.tracking_after,
          modelSource: agent.model_source,
        },
        tracking: agent.tracking_before,
      });
      if (step.status === "applied" || step.status === "already") {
        reverted.push({ agent_id: agent.agent_id, result: step.status });
      } else {
        skipped.push({
          agent_id: agent.agent_id,
          reason:
            step.status === "failed" ? step.reason : "changed_since_migration",
        });
      }
    }
    const retired: Summary[] = [];
    for (const copy of record.copies) {
      const actor = await actorOf(copy.workspace_id);
      if (actor === null) {
        failed = true;
        retired.push({ profile_id: copy.profile_id, result: "no_actor" });
        continue;
      }
      retired.push({
        profile_id: copy.profile_id,
        result: await retireMigrationCopy(db, {
          migrationId: mode.migrationId,
          actorUserId: actor,
          workspaceId: copy.workspace_id,
          profileId: copy.profile_id,
        }),
      });
    }
    say({
      reverted_migration: mode.migrationId,
      agents_reverted: reverted,
      agents_skipped: skipped,
      copies_retired: retired,
      ceilings_kept: true,
    });
    return failed ? 1 : 0;
  } finally {
    await lock.release();
  }
}

/** Exit 0: done; 1: refused or something was left (named in the output). */
export async function runProfileMigration(
  argv: string[],
  deps: MigrationDeps,
  out: (line: string) => void = console.log,
): Promise<number> {
  const mode = parseArgs(argv);
  const say: Say = (summary) => out(JSON.stringify(summary));
  if (mode.kind === "dry-run") return dryRun(deps, mode.out, say);
  if (mode.kind === "apply") return apply(deps, mode, say);
  return revert(deps, mode, say);
}

export async function profileMigration(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = console.log,
): Promise<number> {
  parseArgs(argv);
  const databaseUrl =
    environment.DATABASE_URL || environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  const logger = createLogger({ level: "warn" });
  const pool = createEnforcedPool(
    databaseUrl,
    logger,
    "profile-migration",
    JOB_POOL_TIMEOUTS,
    { max: 4 },
  );
  try {
    const db = drizzle(pool, { schema });
    const secretKey = loadSecretKey(environment);
    const installationSettings = settingsSource({
      store: createPostgresInstallationSettingsStore(db, secretKey),
      env: environment,
      readSecret: secretsManagerReader(environment),
    });
    const reportLeftOut = leftOutReporter((message, fields) =>
      logger.warn(message, fields),
    );
    const registry = createProfileRegistry({
      workspaces: createPostgresWorkspaceProfileStore(db),
      installations: createPostgresInstallationProfileStore(db),
      repositories: createPostgresCatalogRepositoryStore(db),
      settings: {
        async read() {
          const snapshot = await installationSettings.read();
          reportLeftOut(snapshot);
          return snapshot;
        },
      },
      sources: profileSources(environment),
    });
    await registry.refresh();
    const runtimeVersions = runtimeVersionsFromEnv(environment);
    const catalog = profileCatalog(
      {
        repositories: {},
        ...(runtimeVersions === undefined
          ? {}
          : { runtime_versions: runtimeVersions }),
        tool_catalogs: installedToolCatalogView,
      },
      registry,
      (rows, settings) => withConsoleRepositories(rows, settings?.repositories),
    ) as SessionCatalog;
    return await runProfileMigration(argv, { db, pool, catalog }, out);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await profileMigration(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
