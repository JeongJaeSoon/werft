import {
  listSlotHoldingWorkerSessions,
  listUnreleasedLaunchImages,
  listUpgradeSessions,
} from "@werft-ai/db";
import { createLogger, type StructuredLogger } from "@werft-ai/observability";
import {
  assessNothingReplaced,
  assessUpgrade,
  type ListedWorkerImage,
  newestLaunchable,
  readRuntime,
  type UpgradeAssessment,
  type UpgradeImage,
  type UpgradeSession,
  type UpgradeWorkers,
  type WorkerImagesEnvironment,
  workerImageListFromEnv,
  workerImageRuntimesFromEnv,
} from "@werft-ai/platform";
import { installedDescriptors } from "@werft-ai/runtime-codecs";
import { withJobDatabase } from "../job-database.ts";

export type UpgradeCheckEnvironment = Readonly<
  Record<string, string | undefined>
> &
  WorkerImagesEnvironment & {
    DATABASE_URL?: string | undefined;
    UPGRADE_APPROVED_SESSIONS?: string | undefined;
    UPGRADE_DEPLOYED_STATE?: string | undefined;
    UPGRADE_DEPLOYED_WORKER_IMAGES?: string | undefined;
    UPGRADE_DEPLOYED_WORKER_IMAGE?: string | undefined;
    UPGRADE_DEPLOYED_WORKER_IMAGE_RUNTIME?: string | undefined;
    UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS?: string | undefined;
    UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS_RUNTIME?: string | undefined;
    UPGRADE_DEPLOYED_WORKER_GATEWAY_URL?: string | undefined;
    WORKER_GATEWAY_URL?: string | undefined;
  };

type Images<I> = readonly [I, ...I[]];

const UPGRADE_CHECK_EXIT = {
  proceed: 0,
  check_failed: 1,
  refused: 2,
} as const;

/**
 * The pre-upgrade check (helm hook `upgrade-check`, or by hand before a
 * `helm rollback`): reads every session holding an uncollected checkpoint,
 * and every one not closed with the engine its runtime kind runs on, and
 * prints one JSON line saying whether the target release's worker images
 * leave any of them with nothing to resume on. It also reads the session of
 * every worker holding a slot, and lists them when the target gives workers
 * another gateway address than the deployed scheduler does: those workers
 * end with the upgrade.
 *
 * Read: `DATABASE_URL`; the target's `WORKER_IMAGES`, or its `WORKER_IMAGE`,
 * `WORKER_IMAGE_RUNTIME`, `WORKER_IMAGE_PREVIOUS`,
 * `WORKER_IMAGE_PREVIOUS_RUNTIME`; what the cluster's scheduler runs now, its
 * `WORKER_IMAGES` as `UPGRADE_DEPLOYED_WORKER_IMAGES`, or its single-image
 * settings as `UPGRADE_DEPLOYED_WORKER_IMAGE` and
 * `UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS` (empty when it has none), with the
 * `_RUNTIME` of each (empty when none was declared); the target's
 * `WORKER_GATEWAY_URL` and the running scheduler's as
 * `UPGRADE_DEPLOYED_WORKER_GATEWAY_URL`;
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
  listWriters?: (databaseUrl: string) => Promise<readonly UpgradeImage[]>;
  listWorkers?: (databaseUrl: string) => Promise<readonly string[]>;
  databaseUnused?: (databaseUrl: string) => Promise<boolean>;
  write?: (line: string) => void;
}): Promise<number> {
  const { environment } = input;
  const write = input.write ?? ((line: string) => console.log(line));
  let base = {
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
  // What new sessions start on, then the image after it that also launches.
  const launchable = settings.target.filter(({ retracted }) => !retracted);
  base = {
    deployedWorker:
      settings.deployed === null
        ? null
        : (newestLaunchable(settings.deployed)?.image ?? null),
    targetWorker: launchable[0]?.image ?? null,
    targetPreviousWorker: launchable[1]?.image ?? null,
  };

  if (settings.deployed === null) {
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

  let gateway: UpgradeWorkers["gateway"];
  try {
    gateway = {
      deployed: gatewayAddress(
        "UPGRADE_DEPLOYED_WORKER_GATEWAY_URL",
        environment.UPGRADE_DEPLOYED_WORKER_GATEWAY_URL,
      ),
      target: gatewayAddress(
        "WORKER_GATEWAY_URL",
        environment.WORKER_GATEWAY_URL,
      ),
    };
  } catch (error) {
    return failed((error as Error).message);
  }

  let sessions: readonly UpgradeSession[];
  let writers: readonly UpgradeImage[];
  let workers: UpgradeWorkers;
  try {
    sessions = await (input.listSessions ?? listSessions(input.logger))(
      settings.databaseUrl,
    );
    writers = await (input.listWriters ?? listWriters(input.logger))(
      settings.databaseUrl,
    );
    workers = {
      gateway,
      sessions: await (input.listWorkers ?? listWorkers(input.logger))(
        settings.databaseUrl,
      ),
    };
  } catch (error) {
    return failed(`could not read sessions: ${causeOf(error)}`);
  }

  const candidates = withRuntimes(settings.target);
  return report(
    candidates === null
      ? assessNothingReplaced(
          settings.approved,
          "the worker image does not change",
          workers,
        )
      : assessUpgrade({
          deployed: settings.deployed,
          target: candidates,
          writers,
          sessions,
          workers,
          approved: settings.approved,
        }),
  );
}

// The same address spelled two ways is one address. Not quoted: a value that
// is not a URL may still hold a credential.
function gatewayAddress(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set: the gateway address workers are given could not be compared`,
    );
  }
  try {
    return new URL(value).href;
  } catch {
    throw new Error(`${name} is not a URL`);
  }
}

// Only the newest image of a target can lack a runtime, and only alone.
function withRuntimes(
  images: Images<UpgradeImage>,
): Images<ListedWorkerImage> | null {
  const listed = images.flatMap(({ image, runtime, retracted }) =>
    runtime === null ? [] : [{ image, runtime, retracted: retracted === true }],
  );
  return listed.length === images.length
    ? (listed as unknown as Images<ListedWorkerImage>)
    : null;
}

// drizzle wraps the driver's error, which says why, as the cause.
function causeOf(error: unknown): string {
  const cause = (error as Error).cause;
  return cause instanceof Error ? cause.message : (error as Error).message;
}

function readSettings(environment: UpgradeCheckEnvironment) {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const target = targetImages(environment);
  const state = environment.UPGRADE_DEPLOYED_STATE;
  const deployed = deployedImages(environment);
  if (deployed === null && state !== "absent") {
    throw new Error(
      "UPGRADE_DEPLOYED_WORKER_IMAGES and UPGRADE_DEPLOYED_WORKER_IMAGE are empty: the deployed worker image could not be read (a dry run or `helm template` reads no cluster)",
    );
  }
  // Nothing compares runtimes when nothing is replaced, but dropping one a
  // deployed release had could strand what it sealed: `unpinned` rules it out.
  const nothingToCompare =
    deployed === null ||
    (deployed.length === 1 &&
      deployed[0].image === target[0].image &&
      state === "unpinned");
  if (target[0].runtime === null && !nothingToCompare) {
    throw new Error("WORKER_IMAGE_RUNTIME is not set");
  }
  return {
    databaseUrl,
    target,
    deployed,
    approved: approvedSessions(environment.UPGRADE_APPROVED_SESSIONS ?? "[]"),
  };
}

function targetImages(
  environment: UpgradeCheckEnvironment,
): Images<UpgradeImage> {
  const listed = workerImageListFromEnv(environment);
  if (listed !== null) return listed;
  const image = environment.WORKER_IMAGE;
  if (!image) throw new Error("WORKER_IMAGES or WORKER_IMAGE is not set");
  const runtimes = workerImageRuntimesFromEnv(environment);
  const previous = environment.WORKER_IMAGE_PREVIOUS || null;
  if (runtimes === null) {
    if (previous !== null) throw new Error("WORKER_IMAGE_RUNTIME is not set");
    return [{ image, runtime: null }];
  }
  if ((previous === null) !== (runtimes.previous === null)) {
    throw new Error(
      "WORKER_IMAGE_PREVIOUS and WORKER_IMAGE_PREVIOUS_RUNTIME go together",
    );
  }
  return previous === null || runtimes.previous === null
    ? [{ image, runtime: runtimes.current }]
    : [
        { image, runtime: runtimes.current },
        { image: previous, runtime: runtimes.previous },
      ];
}

/**
 * What the deployed scheduler runs, null when the chart read none. A runtime
 * it was not given reads as undeclared, so that image is compared by digest
 * alone, as before runtimes were passed.
 */
function deployedImages(
  environment: UpgradeCheckEnvironment,
): Images<UpgradeImage> | null {
  const list = environment.UPGRADE_DEPLOYED_WORKER_IMAGES;
  const image = environment.UPGRADE_DEPLOYED_WORKER_IMAGE || null;
  if (list) {
    if (image !== null) {
      throw new Error(
        "UPGRADE_DEPLOYED_WORKER_IMAGES and UPGRADE_DEPLOYED_WORKER_IMAGE are both set: a scheduler runs one or the other",
      );
    }
    try {
      return workerImageListFromEnv({ WORKER_IMAGES: list });
    } catch (error) {
      throw new Error(
        `UPGRADE_DEPLOYED_WORKER_IMAGES: ${(error as Error).message}`,
      );
    }
  }
  if (image === null) return null;
  // Empty means the deployed release has no previous image; unset means the
  // caller never said, which must not read as "none".
  const previous = environment.UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS;
  if (previous === undefined) {
    throw new Error(
      "UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS is not set (empty when the deployed release has no previous image)",
    );
  }
  const current = {
    image,
    runtime: deployedRuntime(
      "UPGRADE_DEPLOYED_WORKER_IMAGE_RUNTIME",
      environment.UPGRADE_DEPLOYED_WORKER_IMAGE_RUNTIME,
    ),
  };
  return previous === ""
    ? [current]
    : [
        current,
        {
          image: previous,
          runtime: deployedRuntime(
            "UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS_RUNTIME",
            environment.UPGRADE_DEPLOYED_WORKER_IMAGE_PREVIOUS_RUNTIME,
          ),
        },
      ];
}

function deployedRuntime(name: string, value: string | undefined) {
  return value ? readRuntime(name, value) : null;
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
    withJobDatabase("upgrade-check", databaseUrl, logger, async ({ db }) =>
      (await listUpgradeSessions(db)).map(
        ({ sessionId, pointer, open, runtimeKind }): UpgradeSession =>
          open
            ? {
                sessionId,
                pointer,
                engine:
                  runtimeKind === null
                    ? null
                    : (installedDescriptors.find(
                        (descriptor) => descriptor.kind === runtimeKind,
                      )?.checkpointEngine ?? null),
              }
            : { sessionId, pointer },
      ),
    );
}

function listWriters(logger: StructuredLogger) {
  return (databaseUrl: string) =>
    withJobDatabase("upgrade-check", databaseUrl, logger, ({ db }) =>
      listUnreleasedLaunchImages(db),
    );
}

function listWorkers(logger: StructuredLogger) {
  return (databaseUrl: string) =>
    withJobDatabase("upgrade-check", databaseUrl, logger, ({ db }) =>
      listSlotHoldingWorkerSessions(db),
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
