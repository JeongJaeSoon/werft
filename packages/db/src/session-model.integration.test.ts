import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CatalogProfile,
  createWorkerGateway,
  fingerprintModel,
  profileFingerprint,
  profilePins,
  type SessionCatalog,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrate } from "./migrate.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { attempts, sessions, unassignedSessions } from "./schema.ts";
import { backfillSessionModels } from "./session-model-backfill.ts";
import { launchSession } from "./testing/launches.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MIGRATIONS = join(import.meta.dir, "../migrations");

type Journal = { entries: Array<{ tag: string }> };

async function migrationsThrough(lastTag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "session-model-migrations-"));
  await mkdir(join(folder, "meta"));
  const journal: Journal = JSON.parse(
    await readFile(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
  );
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`no migration ${lastTag}`);
  const entries = journal.entries.slice(0, last + 1);
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const { tag } of entries) {
    await copyFile(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  return folder;
}

const PROFILE_ID = "claude-coding-v1";
const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-opus-5-5"],
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const catalog: SessionCatalog = testSessionCatalog({
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});
const pins = profilePins(profile, []);
const V1_SONNET = pins[2]?.fingerprint ?? "";
const V1_OPUS = pins[3]?.fingerprint ?? "";
const V2 = profileFingerprint(profile);

integration("sessions.model", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let before: string;

  beforeEach(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "session_model_it",
    });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    before = await migrationsThrough("0154_slack_apps");
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(before, { recursive: true, force: true });
  }, 60_000);

  const modelOf = ({
    profileId,
    fingerprint,
  }: {
    profileId: string;
    fingerprint: string;
  }) => fingerprintModel(catalog, profileId, fingerprint);

  test("the backfill writes the model a version 1 fingerprint names and leaves the rest null", async () => {
    await migrate(db, { migrationsFolder: before });
    const row = (fingerprint: string | null, profileId = PROFILE_ID) => ({
      id: randomUUID(),
      fingerprint,
      profileId,
    });
    const opus = row(V1_OPUS);
    const sonnet = row(V1_SONNET);
    const moved = row(`sha256:${"0".repeat(64)}`);
    const gone = row(V1_OPUS, "gone-profile");
    const unpinned = row(null);
    for (const r of [opus, sonnet, moved, gone, unpinned]) {
      await pool.query(
        `INSERT INTO sessions (id, owner_id, profile_id, profile_fingerprint, repo_url, branch, repository_id)
         VALUES ($1, 'owner', $2, $3, 'https://example.invalid/app.git', 'main', 'sample-app')`,
        [r.id, r.profileId, r.fingerprint],
      );
    }

    await migrate(db, { migrationsFolder: MIGRATIONS });
    const written = randomUUID();
    await db.insert(sessions).values({
      id: written,
      ownerId: "owner",
      profileId: PROFILE_ID,
      profileFingerprint: V2,
      model: "claude-opus-5-5",
      repositoryId: "sample-app",
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
    });

    expect(await backfillSessionModels(db, modelOf)).toBe(2);
    expect(await backfillSessionModels(db, modelOf)).toBe(0);
    const models = Object.fromEntries(
      (
        await db
          .select({ id: sessions.id, model: sessions.model })
          .from(sessions)
      ).map((r) => [r.id, r.model]),
    );
    expect(models).toEqual({
      [opus.id]: "claude-opus-5-5",
      [sonnet.id]: "claude-sonnet-5",
      [moved.id]: null,
      [gone.id]: null,
      [unpinned.id]: null,
      [written]: "claude-opus-5-5",
    });
    const [kept] = await db
      .select({ fingerprint: sessions.profileFingerprint })
      .from(sessions)
      .where(eq(sessions.id, opus.id));
    expect(kept?.fingerprint).toBe(V1_OPUS);
  });

  test("a session pinned under version 1 before the upgrade is still claimed after it, on its model", async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
        sleep: async () => {},
      },
    });

    async function queued(pin: { fingerprint: string; model?: string }) {
      const partition = `p-${randomUUID()}`;
      const result = await createPostgresSessionUnitOfWork(
        db,
      ).acceptInputAtomic({
        limits: {
          queuedInputLimitPerSession: 1_000,
          storageLimitBytes: 1e15,
        },
        principal: { ownerId: `owner-${randomUUID()}` },
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        profileId: PROFILE_ID,
        repository: {
          id: "sample-app",
          url: "https://example.invalid/app.git",
          branch: "main",
        },
        profileFingerprint: pin.fingerprint,
        ...(pin.model === undefined ? {} : { model: pin.model }),
        message: "first input",
      });
      if (result.outcome !== "accepted") throw new Error(result.outcome);
      const sessionId = result.response.session_id;
      await db
        .update(sessions)
        .set({ partition })
        .where(eq(sessions.id, sessionId));
      await db
        .update(unassignedSessions)
        .set({ partition })
        .where(eq(unassignedSessions.sessionId, sessionId));
      const { executionId, generation, nonce } = await launchSession(db, {
        sessionId,
      });
      const claimed = await gateway.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: executionId,
          execution_generation: generation,
          credential: { kind: "launch_nonce", nonce },
        },
      );
      const [row] = await db
        .select({
          fingerprint: sessions.profileFingerprint,
          model: sessions.model,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      const [attempt] = await db
        .select({
          fingerprint: attempts.profileFingerprint,
          model: attempts.model,
        })
        .from(attempts)
        .where(eq(attempts.id, claimed.attempt_id));
      return { claimed, row, attempt };
    }

    const legacy = await queued({ fingerprint: V1_OPUS });
    expect(legacy.claimed.runtime_config.model).toBe("claude-opus-5-5");
    expect(legacy.row).toEqual({ fingerprint: V1_OPUS, model: null });
    expect(legacy.attempt).toEqual({ fingerprint: V1_OPUS, model: null });

    const current = await queued({ fingerprint: V2, model: "claude-opus-5-5" });
    expect(current.claimed.runtime_config.model).toBe("claude-opus-5-5");
    expect(current.attempt).toEqual({
      fingerprint: V2,
      model: "claude-opus-5-5",
    });
  });
});
