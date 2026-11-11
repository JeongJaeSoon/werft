import { listUncollectedSessionPointers } from "@werft-ai/db";
import { createLogger, type StructuredLogger } from "@werft-ai/observability";
import {
  assessNothingReplaced,
  assessUpgrade,
  type UpgradeAssessment,
  type UpgradeSession,
  type WorkerImagesEnvironment,
  workerImageRuntimesFromEnv,
} from "@werft-ai/platform";
import { withJobDatabase } from "../job-database.ts";

export type UpgradeCheckEnvironment = Readonly<
  Record<string, string | undefined>
> &
  WorkerImagesEnvironment & {
    DATABASE_URL?: string | undefined;
    UPGRADE_APPROVED_SESSIONS?: string | undefined;
    UPGRADE_DEPLOYED_STATE?: string | undefined;
    UPGRADE_DEPLOYED_WORKER_IMAGE?: string | undefined;
    UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS?: string | undefined;
    WORKER_IMAGE?: string | undefined;
    WORKER_IMAGE_PREVIOUS?: string | undefined;
  };

const UPGRADE_CHECK_EXIT = {
  proceed: 0,
  check_failed: 1,
  refused: 2,
} as const;

/**
 * The pre-upgrade check (helm hook `upgrade-check`, or by hand before a
 * `helm rollback`): reads every session holding an uncollected checkpoint
 * and prints one JSON line saying whether the target release's worker
 * images leave any of them with nothing to resume on.
 *
 * Read: `DATABASE_URL`; the target's `WORKER_IMAGE`, `WORKER_IMAGE_RUNTIME`,
 * `WORKER_IMAGE_PREVIOUS`, `WORKER_IMAGE_PREVIOUS_RUNTIME`; the
 * `UPGRADE_DEPLOYED_WORKER_IMAGE` the cluster runs now and its
 * `UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS` (empty when it has none);
 * `UPGRADE_APPROVED_SESSIONS`, a JSON array of session ids; and
 * `UPGRADE_DEPLOYED_STATE`, what the chart read about the deployed release
 * when it has no worker image or runtime to compare:
 *
 * - `absent`: the cluster answered and has no scheduler Deployment. Retrying
 *   a failed first install looks like this, so an unused database passes.
 * - `unpinned`: the scheduler runs one image, with no runtime and no previous
 *   image. Upgrading that same image needs no runtime: nothing is compared.
 *
 * Anything else is no evidence. Returns the exit code: 0 proceed, 2 refused,
 * 1 when the check could not be made (a setting missing or unreadable, the
 * database unreachable), which stops the upgrade as surely as a refusal:
 * there is no override.
 */
export async function runUpgradeCheck(input: {
  environment: UpgradeCheckEnvironment;
  logger: StructuredLogger;
  /** Tests substitute the database; the product path connects to it. */
  listSessions?: (databaseUrl: string) => Promise<readonly UpgradeSession[]>;
  databaseUnused?: (databaseUrl: string) => Promise<boolean>;
  write?: (line: string) => void;
}): Promise<number> {
  const { environment } = input;
  const write = input.write ?? ((line: string) => console.log(line));
  const base = {
    deployedWorker: environment.UPGRADE_DEPLOYED_WORKER_IMAGE || null,
    targetWorker: environment.WORKER_IMAGE || null,
    targetPreviousWorker: environment.WORKER_IMAGE_PREVIOUS || null,
  };
  const failed = (reason: string) => {
    write(
      JSON.stringify({
        verdict: "check_failed",
        ...base,
        affected: [],
        approved: [],
        reason,
      }),
    );
    return UPGRADE_CHECK_EXIT.check_failed;
  };
  const report = (assessment: UpgradeAssessment) => {
    write(JSON.stringify({ ...base, ...assessment }));
    return UPGRADE_CHECK_EXIT[assessment.verdict];
  };

  let settings: ReturnType<typeof readSettings>;
  try {
    settings = readSettings(environment);
  } catch (error) {
    return failed((error as Error).message);
  }

  if (settings.deployedWorker === null) {
    let unused: boolean;
    try {
      unused = await (input.databaseUnused ?? databaseUnused(input.logger))(
        settings.databaseUrl,
      );
    } catch (error) {
      return failed(`could not read the database: ${causeOf(error)}`);
    }
    if (!unused) {
      return failed(
        "no scheduler Deployment, but the database has been used: a blank database or one with no session is all a failed first install leaves",
      );
    }
    return report(
      assessNothingReplaced(
        settings.approved,
        "nothing was deployed on this database",
      ),
    );
  }

  let sessions: readonly UpgradeSession[];
  try {
    sessions = await (input.listSessions ?? listSessions(input.logger))(
      settings.databaseUrl,
    );
  } catch (error) {
    return failed(`could not read sessions: ${causeOf(error)}`);
  }

  return report(
    settings.runtimes === null
      ? assessNothingReplaced(
          settings.approved,
          "the worker image does not change",
        )
      : assessUpgrade({
          ...settings,
          deployedWorker: settings.deployedWorker,
          runtimes: settings.runtimes,
          sessions,
        }),
  );
}

// drizzle wraps the driver's error, which says why, as the cause.
function causeOf(error: unknown): string {
  const cause = (error as Error).cause;
  return cause instanceof Error ? cause.message : (error as Error).message;
}

function readSettings(environment: UpgradeCheckEnvironment) {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const targetWorker = environment.WORKER_IMAGE;
  if (!targetWorker) throw new Error("WORKER_IMAGE is not set");
  const state = environment.UPGRADE_DEPLOYED_STATE;
  const deployedWorker = environment.UPGRADE_DEPLOYED_WORKER_IMAGE || null;
  if (deployedWorker === null && state !== "absent") {
    throw new Error(
      "UPGRADE_DEPLOYED_WORKER_IMAGE is empty: the deployed worker image could not be read (a dry run or `helm template` reads no cluster)",
    );
  }
  // Empty means the deployed release has no previous image; unset means the
  // caller never said, which must not read as "none".
  if (
    deployedWorker !== null &&
    environment.UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS === undefined
  ) {
    throw new Error(
      "UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS is not set (empty when the deployed release has no previous image)",
    );
  }
  const runtimes = workerImageRuntimesFromEnv(environment);
  const targetPreviousWorker = environment.WORKER_IMAGE_PREVIOUS || null;
  // Nothing compares runtimes when nothing is replaced, but dropping one a
  // deployed release had could strand what it sealed: `unpinned` rules it out.
  const nothingToCompare =
    deployedWorker === null ||
    (deployedWorker === targetWorker && state === "unpinned");
  if (
    runtimes === null &&
    (targetPreviousWorker !== null || !nothingToCompare)
  ) {
    throw new Error("WORKER_IMAGE_RUNTIME is not set");
  }
  if (
    runtimes !== null &&
    (targetPreviousWorker === null) !== (runtimes.previous === null)
  ) {
    throw new Error(
      "WORKER_IMAGE_PREVIOUS and WORKER_IMAGE_PREVIOUS_RUNTIME go together",
    );
  }
  return {
    databaseUrl,
    targetWorker,
    deployedWorker,
    deployedPreviousWorker:
      environment.UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS || null,
    targetPreviousWorker,
    runtimes,
    approved: approvedSessions(environment.UPGRADE_APPROVED_SESSIONS ?? "[]"),
  };
}

function approvedSessions(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("UPGRADE_APPROVED_SESSIONS is not JSON");
  }
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === "string" && id !== "")
  ) {
    throw new Error(
      "UPGRADE_APPROVED_SESSIONS must be a JSON array of session ids",
    );
  }
  return value;
}

function listSessions(logger: StructuredLogger) {
  return (databaseUrl: string) =>
    withJobDatabase("upgrade-check", databaseUrl, logger, ({ db }) =>
      listUncollectedSessionPointers(db),
    );
}

/**
 * Whether the database is what a failed first install leaves: never migrated,
 * or migrated with no session. Any session row counts, not only one holding a
 * checkpoint: a first turn still running has none yet. Part of a schema
 * without `sessions` is a restore or a repair, never a first install.
 */
export function databaseUnused(logger: StructuredLogger) {
  return (databaseUrl: string) =>
    withJobDatabase("upgrade-check", databaseUrl, logger, async ({ pool }) => {
      const { rows } = await pool.query<{
        journal: string | null;
        sessions: string | null;
        tables: number;
      }>(`
        SELECT
          to_regclass('drizzle.__drizzle_migrations')::text AS journal,
          to_regclass('public.sessions')::text AS sessions,
          (SELECT count(*)::int FROM information_schema.tables
            WHERE table_schema = 'public') AS tables
      `);
      const { journal, sessions, tables } = rows[0] as (typeof rows)[number];
      if (sessions !== null) {
        const used = await pool.query("SELECT 1 FROM public.sessions LIMIT 1");
        return used.rowCount === 0;
      }
      if (tables > 0) return false;
      if (journal === null) return true;
      const applied = await pool.query(
        'SELECT 1 FROM "drizzle"."__drizzle_migrations" LIMIT 1',
      );
      return applied.rowCount === 0;
    });
}

if (import.meta.main) {
  const logger = createLogger(
    process.env.LOG_LEVEL === undefined ? {} : { level: process.env.LOG_LEVEL },
  );
  process.exit(await runUpgradeCheck({ environment: process.env, logger }));
}
