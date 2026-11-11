import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateDatabase } from "@werft-ai/db/migrate";
import { Pool } from "pg";

export type TempDatabase = {
  /** Drops the database. Safe to call more than once. */
  drop(): Promise<void>;
  name: string;
  url: string;
};

export type TempDatabaseOptions = {
  /**
   * Connection URL of a server the test may create databases on. Defaults to
   * `QUEUE_DATABASE_URL`, the opt-in variable docs/contributing/development.md and CI already use.
   */
  adminUrl?: string;
  /**
   * Apply the Drizzle migrations right after creation. Defaults to true, or to
   * false with `template`, whose copy already carries its migrations.
   *
   * Left unset (and without `template`), the database is a copy of one this
   * server migrated once for the current migrations: the same schema, without
   * paying about a second for every database. `true` runs the migrations on
   * the new database itself, for a test about what migrating does.
   */
  migrate?: boolean;
  /** Prefix of the generated database name. */
  prefix?: string;
  /**
   * Name of a database on the same server to copy instead of starting empty.
   * Copying a migrated template takes a fraction of the time the migrations
   * do. PostgreSQL refuses the copy while anyone is connected to the template.
   */
  template?: string;
};

/** The opt-in URL for real PostgreSQL integration tests, if set. */
export function testDatabaseUrl(): string | undefined {
  return process.env.QUEUE_DATABASE_URL || undefined;
}

export async function createTempDatabase(
  options: TempDatabaseOptions = {},
): Promise<TempDatabase> {
  const adminUrl = options.adminUrl ?? testDatabaseUrl();
  if (adminUrl === undefined) {
    throw new Error(
      "createTempDatabase requires QUEUE_DATABASE_URL or options.adminUrl",
    );
  }
  const name = `${options.prefix ?? "testkit"}_${randomUUID().replaceAll("-", "_")}`;
  const quoted = `"${name}"`;
  const admin = new URL(adminUrl);
  admin.pathname = "/postgres";
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;

  const shared =
    options.template === undefined && options.migrate === undefined
      ? await migratedTemplate(admin.toString())
      : undefined;
  const template = options.template ?? shared;
  const from =
    template === undefined
      ? ""
      : ` TEMPLATE "${template.replaceAll('"', '""')}"`;
  await withAdminPool(admin.toString(), (pool) =>
    copyRetrying(() => pool.query(`CREATE DATABASE ${quoted}${from}`)),
  );
  let dropped = false;
  const drop = async () => {
    if (dropped) return;
    await withAdminPool(admin.toString(), (pool) =>
      pool.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`),
    );
    dropped = true;
  };
  if (options.migrate ?? template === undefined) {
    try {
      await migrateDatabase(target.toString());
    } catch (error) {
      await drop();
      throw error;
    }
  }
  return { drop, name, url: target.toString() };
}

export async function withTempDatabase<T>(
  fn: (database: TempDatabase) => Promise<T>,
  options: TempDatabaseOptions = {},
): Promise<T> {
  const database = await createTempDatabase(options);
  try {
    return await fn(database);
  } finally {
    await database.drop();
  }
}

const TEMPLATE_PREFIX = "testkit_template_";

/**
 * The migrations and the code that applies them: a template is reused only
 * while both are what they were when it was migrated.
 */
function migrationsDigest(): string {
  const db = join(import.meta.dir, "..", "..", "db");
  const folder = join(db, "migrations");
  const hash = createHash("sha256");
  for (const entry of readdirSync(folder, { recursive: true }).sort()) {
    const path = join(folder, String(entry));
    let content: Buffer;
    try {
      content = readFileSync(path);
    } catch {
      continue; // a directory
    }
    hash
      .update(`${String(entry)}\0`)
      .update(content)
      .update("\0");
  }
  hash.update(readFileSync(join(db, "src", "migrate.ts")));
  return hash.digest("hex").slice(0, 16);
}

const templates = new Map<string, Promise<string>>();

/**
 * The name of a database on this server that carries every current migration
 * and is never connected to, so it can be copied. Built once per server and
 * set of migrations: processes that start together each migrate a database
 * of their own and rename it into place, so whichever finishes first wins and
 * the others drop theirs. A half-migrated build never carries the final name.
 */
function migratedTemplate(adminUrl: string): Promise<string> {
  let template = templates.get(adminUrl);
  if (template === undefined) {
    template = buildTemplate(adminUrl);
    templates.set(adminUrl, template);
    // A failed build is not remembered: the next database tries again.
    template.catch(() => templates.delete(adminUrl));
  }
  return template;
}

async function buildTemplate(adminUrl: string): Promise<string> {
  const name = `${TEMPLATE_PREFIX}${migrationsDigest()}`;
  const exists = (pool: Pool) =>
    pool
      .query("SELECT 1 FROM pg_database WHERE datname = $1", [name])
      .then((result) => result.rowCount === 1);
  if (await withAdminPool(adminUrl, exists)) return name;

  const building = `${name}_build_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const target = new URL(adminUrl);
  target.pathname = `/${building}`;
  await withAdminPool(adminUrl, (pool) =>
    pool.query(`CREATE DATABASE "${building}"`),
  );
  try {
    await migrateDatabase(target.toString());
    await withAdminPool(adminUrl, (pool) =>
      pool.query(`ALTER DATABASE "${building}" RENAME TO "${name}"`),
    );
  } catch (error) {
    await withAdminPool(adminUrl, (pool) =>
      pool.query(`DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`),
    );
    // Another process renamed its build into place first: use that one.
    if ((error as { code?: string }).code === "42P04") return name;
    throw error;
  }
  // Templates of migrations this checkout no longer has. One still being
  // copied by an older checkout refuses the drop, and stays for next time.
  await withAdminPool(adminUrl, async (pool) => {
    const stale = await pool.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname <> $2 AND datname NOT LIKE '%\\_build\\_%'",
      [`${TEMPLATE_PREFIX}%`, name],
    );
    for (const { datname } of stale.rows) {
      await pool
        .query(`DROP DATABASE IF EXISTS "${datname}"`)
        .catch(() => undefined);
    }
  });
  return name;
}

/**
 * PostgreSQL refuses to copy a database while anyone is connected to it
 * (55006). Nothing connects to a template, but a stale-template drop or a
 * monitoring session can for a moment; a few short retries cover that.
 */
async function copyRetrying<T>(create: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await create();
    } catch (error) {
      if ((error as { code?: string }).code !== "55006" || attempt >= 5) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

async function withAdminPool<T>(
  url: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
