import type { ReadinessCheck, ReadyDetail } from "@werft-ai/contracts";
import {
  APPLIED_MIGRATIONS_SQL,
  expectedMigrationHead,
  expectedMigrations,
  type MigrationEntry,
  type MigrationHead,
  OPEN_LOST_CHECKPOINT_SESSIONS_SQL,
} from "@werft-ai/db";
import { messageOf as describe } from "@werft-ai/platform";

export type ReadinessResult =
  // `detail` is what an operator should know about a ready instance.
  | { ready: true; detail?: ReadyDetail }
  // "shutdown" is the process withdrawing itself (shutdown.ts), not a
  // failed dependency, so it is not one of the checks a ready answer lists.
  | { ready: false; check: ReadinessCheck | "shutdown"; reason: string };

export type ReadinessProbe = () => Promise<ReadinessResult>;

export interface QueryRunner {
  // Rows of a raw SQL statement; pg.Pool satisfies this directly.
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

// A bare name must be set and non-empty; with `allowed`, its trimmed value
// must also be one of those.
type RequiredEnv =
  | string
  | { readonly name: string; readonly allowed: readonly string[] };

export interface CreateReadinessProbeOptions {
  readonly db: QueryRunner;
  readonly requiredEnv: readonly RequiredEnv[];
  // Typed validation beyond presence, e.g. the installation limits.
  readonly configProblems?: (
    environment: Record<string, string | undefined>,
  ) => string[];
  readonly environment?: Record<string, string | undefined>;
  readonly expected?: { head: MigrationHead; migrations: MigrationEntry[] };
  // Last-resort bound for each database step when the runner has no
  // timeouts of its own (see createProbePool in pool.ts); it abandons the
  // promise, so the runner itself must free the connection.
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

function configProblems(
  required: readonly RequiredEnv[],
  environment: Record<string, string | undefined>,
): string[] {
  return required.flatMap((entry) => {
    const name = typeof entry === "string" ? entry : entry.name;
    const value = environment[name];
    if (!value?.trim()) return [`missing ${name}`];
    // app.ts compares the raw string, so " none " would run in api-key mode;
    // judge exactly what the process will see.
    if (typeof entry !== "string" && !entry.allowed.includes(value)) {
      return [`${name} must be one of ${entry.allowed.join("|")}`];
    }
    return [];
  });
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The packaged migrations must be an exact prefix of the applied ones.
function migrationDrift(
  expected: MigrationEntry[],
  applied: { when: string; hash: string }[],
): string | null {
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index] as MigrationEntry;
    const have = applied[index];
    if (!have) {
      return `database is missing migration ${want.when}`;
    }
    if (have.when !== String(want.when) || have.hash !== want.hash) {
      return `migration ${index} differs (expected ${want.when}/${want.hash.slice(0, 12)}, database ${have.when}/${have.hash.slice(0, 12)})`;
    }
  }
  return null;
}

// database → schema → config, stopping at the first failure, then what a
// ready answer adds: the sessions a start gave up checkpoints for. Nothing here
// touches the execution backend: api.md keeps backend health out of readiness.
export function createReadinessProbe(
  options: CreateReadinessProbeOptions,
): ReadinessProbe {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expected = options.expected ?? {
    head: expectedMigrationHead(),
    migrations: expectedMigrations(),
  };
  return async () => {
    try {
      await withTimeout(options.db.query("SELECT 1"), timeoutMs);
    } catch (error) {
      return { ready: false, check: "database", reason: describe(error) };
    }
    let applied: { when: string; hash: string }[];
    try {
      const result = await withTimeout(
        options.db.query(APPLIED_MIGRATIONS_SQL),
        timeoutMs,
      );
      applied = result.rows.map((row) => ({
        when: String(row.when),
        hash: String(row.hash),
      }));
    } catch (error) {
      // 42P01 (relation missing) lands here too: no journal table means the
      // database was never migrated.
      return { ready: false, check: "schema", reason: describe(error) };
    }
    // The whole chain, not only its head: a missing or rewritten earlier
    // migration leaves the head intact while the schema differs from the one
    // this build's SQL produces. Rows after this build's last migration are
    // fine: migrations are applied in a Job before the rollout,
    // so the previous build must stay ready on a database that is one step
    // ahead, and only rollback-compatible changes ship.
    const drift = migrationDrift(expected.migrations, applied);
    if (drift) {
      return {
        ready: false,
        check: "schema",
        reason: `expected migrations up to ${expected.head.tag}: ${drift}`,
      };
    }
    const problems = [
      ...configProblems(options.requiredEnv, environment),
      ...(options.configProblems?.(environment) ?? []),
    ];
    if (problems.length > 0) {
      return {
        ready: false,
        check: "config",
        reason: `configuration: ${problems.join(", ")}`,
      };
    }
    let forgotten: number;
    try {
      const result = await withTimeout(
        options.db.query(OPEN_LOST_CHECKPOINT_SESSIONS_SQL),
        timeoutMs,
      );
      forgotten = Number(result.rows[0]?.n ?? 0);
    } catch (error) {
      return { ready: false, check: "database", reason: describe(error) };
    }
    return forgotten > 0
      ? { ready: true, detail: { checkpoints_forgotten_on_boot: forgotten } }
      : { ready: true };
  };
}
