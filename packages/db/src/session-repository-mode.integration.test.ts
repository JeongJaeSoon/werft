import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AcceptSessionInput } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { sessions } from "./schema.ts";
import {
  BEFORE_PROFILE_REMOVAL,
  migrationsThrough,
} from "./testing/migrations-through.ts";
import { fixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

// Each test applies the migration chain itself, on a fresh database the way
// its hooks prepare one. That is about a second on a quiet runner and went past
// bun's 5s default on a busy one (runs 43076026816 and 43076744519), so the
// tests get the same headroom as their hooks.
const MIGRATION_CHAIN_TIMEOUT = 60_000;

const integration = testDatabaseUrl() ? describe : describe.skip;

// Up to the profile removal: 0270 empties the session tables these rows sit in.
async function migrateBeforeRemoval(db: Parameters<typeof migrate>[0]) {
  const folder = migrationsThrough(BEFORE_PROFILE_REMOVAL);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };

integration("sessions.repository_mode", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let before: string;

  beforeEach(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "repository_mode_it",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    before = await migrationsThrough("0149_checkpoint_transcript_bytes");
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(before, { recursive: true, force: true });
  }, 60_000);

  test(
    "existing rows read back as repository sessions with their URL and branch",
    async () => {
      await migrate(db, { migrationsFolder: before });
      const catalogued = randomUUID();
      const legacy = randomUUID();
      await pool.query(
        `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id)
       VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a'),
              ($2, 'owner', 'https://example.invalid/old.git', 'release', NULL)`,
        [catalogued, legacy],
      );

      await migrateBeforeRemoval(db);

      const rows = await db
        .select({
          id: sessions.id,
          repositoryMode: sessions.repositoryMode,
          repositoryId: sessions.repositoryId,
          repoUrl: sessions.repoUrl,
          branch: sessions.branch,
        })
        .from(sessions)
        .orderBy(sessions.branch);
      expect(rows).toEqual([
        {
          id: catalogued,
          repositoryMode: "repository",
          repositoryId: "repo-a",
          repoUrl: "https://example.invalid/a.git",
          branch: "main",
        },
        {
          id: legacy,
          repositoryMode: "repository",
          repositoryId: null,
          repoUrl: "https://example.invalid/old.git",
          branch: "release",
        },
      ]);
    },
    MIGRATION_CHAIN_TIMEOUT,
  );

  test(
    "the CHECK refuses a row whose columns disagree with its mode",
    async () => {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const insert = (row: {
        mode: string;
        repositoryId: string | null;
        repoUrl: string | null;
        branch: string | null;
      }) =>
        pool.query(
          `INSERT INTO sessions (id, owner_id, repository_mode, repository_id, repo_url, branch)
         VALUES ($1, 'owner', $2, $3, $4, $5)`,
          [randomUUID(), row.mode, row.repositoryId, row.repoUrl, row.branch],
        );
      const url = "https://example.invalid/a.git";

      await insert({
        mode: "none",
        repositoryId: null,
        repoUrl: null,
        branch: null,
      });
      await insert({
        mode: "repository",
        repositoryId: null,
        repoUrl: url,
        branch: "main",
      });

      for (const refused of [
        {
          mode: "repository",
          repositoryId: "repo-a",
          repoUrl: null,
          branch: "main",
        },
        {
          mode: "repository",
          repositoryId: "repo-a",
          repoUrl: url,
          branch: null,
        },
        { mode: "none", repositoryId: "repo-a", repoUrl: null, branch: null },
        { mode: "none", repositoryId: null, repoUrl: url, branch: null },
        { mode: "none", repositoryId: null, repoUrl: null, branch: "main" },
        { mode: "other", repositoryId: null, repoUrl: null, branch: null },
      ]) {
        await expect(insert(refused)).rejects.toThrow(
          "sessions_repository_mode_check",
        );
      }
      expect(await db.select({ id: sessions.id }).from(sessions)).toHaveLength(
        2,
      );
    },
    MIGRATION_CHAIN_TIMEOUT,
  );

  test(
    '"none" is accepted as a session without a repository, a refused pair is not',
    async () => {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const inputs = createPostgresSessionUnitOfWork(db);
      const accept = async (repository: AcceptSessionInput["repository"]) =>
        inputs.acceptInputAtomic({
          principal: { ownerId: randomUUID() },
          idempotencyKey: randomUUID(),
          payloadHash: randomUUID(),
          agentReleaseId: await fixtureRelease(db),
          model: TEST_MODEL,
          repository,
          message: "hello",
          limits: LIMITS,
        });

      expect(await accept(null)).toEqual({ outcome: "unsupported" });
      expect(await db.select().from(sessions)).toEqual([]);

      const without = await accept("none");
      if (without.outcome !== "accepted") throw new Error(without.outcome);
      const [none] = await db
        .select({
          repositoryMode: sessions.repositoryMode,
          repositoryId: sessions.repositoryId,
          repoUrl: sessions.repoUrl,
          branch: sessions.branch,
        })
        .from(sessions)
        .where(eq(sessions.id, without.response.session_id));
      expect(none).toEqual({
        repositoryMode: "none",
        repositoryId: null,
        repoUrl: null,
        branch: null,
      });

      const accepted = await accept({
        id: "repo-a",
        url: "https://example.invalid/a.git",
        branch: "main",
      });
      if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
      const [row] = await db
        .select({ repositoryMode: sessions.repositoryMode })
        .from(sessions)
        .where(eq(sessions.id, accepted.response.session_id));
      expect(row).toEqual({ repositoryMode: "repository" });
    },
    MIGRATION_CHAIN_TIMEOUT,
  );

  test(
    "the attached list is written as given and read back, null when not given",
    async () => {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const inputs = createPostgresSessionUnitOfWork(db);
      const reader = createPostgresSessionReader(db);
      const ownerId = randomUUID();
      const accept = async (attachedRepositoryIds?: string[]) =>
        inputs.acceptInputAtomic({
          principal: { ownerId },
          idempotencyKey: randomUUID(),
          payloadHash: randomUUID(),
          agentReleaseId: await fixtureRelease(db),
          model: TEST_MODEL,
          repository: {
            id: "repo-a",
            url: "https://example.invalid/a.git",
            branch: "main",
          },
          ...(attachedRepositoryIds === undefined
            ? {}
            : { attachedRepositoryIds }),
          message: "hello",
          limits: LIMITS,
        });
      const read = async (attached?: string[]) => {
        const accepted = await accept(attached);
        if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
        return (await reader.getSession(ownerId, accepted.response.session_id))
          ?.attached_repository_ids;
      };

      expect(await read(["repo-b", "repo-c"])).toEqual(["repo-b", "repo-c"]);
      expect(await read([])).toEqual([]);
      expect(await read()).toBeNull();
    },
    MIGRATION_CHAIN_TIMEOUT,
  );

  test(
    "a session without a repository keeps an attached list",
    async () => {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const inputs = createPostgresSessionUnitOfWork(db);
      const reader = createPostgresSessionReader(db);
      const ownerId = randomUUID();
      const read = async (attachedRepositoryIds?: string[]) => {
        const accepted = await inputs.acceptInputAtomic({
          principal: { ownerId },
          idempotencyKey: randomUUID(),
          payloadHash: randomUUID(),
          agentReleaseId: await fixtureRelease(db),
          model: TEST_MODEL,
          repository: "none",
          ...(attachedRepositoryIds === undefined
            ? {}
            : { attachedRepositoryIds }),
          message: "hello",
          limits: LIMITS,
        });
        if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
        const session = await reader.getSession(
          ownerId,
          accepted.response.session_id,
        );
        return {
          repository: session?.repository_id,
          attached: session?.attached_repository_ids,
        };
      };

      expect(await read(["repo-b"])).toEqual({
        repository: null,
        attached: ["repo-b"],
      });
      expect(await read()).toEqual({ repository: null, attached: null });
    },
    MIGRATION_CHAIN_TIMEOUT,
  );
});
