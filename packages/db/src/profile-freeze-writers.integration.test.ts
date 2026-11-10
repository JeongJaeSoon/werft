import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresInstallationProfileStore } from "./installation-profiles.ts";
import {
  certifyProfiles,
  freezeProfiles,
  ProfilesFrozenError,
} from "./profile-freeze.ts";
import { retireMigrationCopy, writeProfileCopy } from "./profile-migration.ts";
import type { Database } from "./queries.ts";
import { releaseSpecStore } from "./release-specs.ts";
import * as schema from "./schema.ts";
import { createPostgresWorkspaceProfileStore } from "./workspace-profiles.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// Each writer takes the freeze barrier as the first statement of its
// transaction, before it reads its input, so a dummy input is enough to see
// whether the barrier stopped it. What a writer does once it is let through is
// the job of its own test file.
integration("the writers of profile and release tables meet the freeze", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;

  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "profile_freeze_writers" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema }) as unknown as Database;
  }, 60_000);

  afterEach(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  const dummy = {} as never;

  const outcome = (call: () => Promise<unknown>) =>
    call().then(
      () => null,
      (error: unknown) => error,
    );

  const refused = async (call: () => Promise<unknown>) =>
    expect(await outcome(call)).toBeInstanceOf(ProfilesFrozenError);

  const letThrough = async (call: () => Promise<unknown>) =>
    expect(await outcome(call)).not.toBeInstanceOf(ProfilesFrozenError);

  // Writers of profile-only tables. A dummy input is not valid, so the
  // writer may fail for its own reasons once past the barrier.
  const profileTableWriters = (): [string, () => Promise<unknown>][] => {
    const installation = createPostgresInstallationProfileStore(db);
    const workspace = createPostgresWorkspaceProfileStore(db);
    const agents = createPostgresAgentStore(db);
    return [
      ["installation seedCatalog", () => installation.seedCatalog(dummy)],
      [
        "installation create",
        // `scope` is read before the transaction opens.
        () => installation.create({ scope: { kind: "installation" } } as never),
      ],
      ["installation retire", () => installation.retire(dummy)],
      ["installation setBlocked", () => installation.setBlocked(dummy)],
      ["workspace create", () => workspace.create(dummy)],
      ["workspace retire", () => workspace.retire(dummy)],
      ["agent followProfile", () => agents.followProfile(dummy)],
      [
        "migration writeProfileCopy",
        () =>
          writeProfileCopy(db, {
            migrationId: "m",
            actorUserId: "u",
            plan: { target: {}, decision: "write", workspace_id: "w" } as never,
          }),
      ],
      [
        "migration retireMigrationCopy",
        () =>
          retireMigrationCopy(db, {
            migrationId: "m",
            actorUserId: "u",
            workspaceId: "w",
            profileId: "p",
          }),
      ],
      [
        "agent activate with a raise (writes rollout items)",
        () =>
          createPostgresAgentStore(db).activate({
            intent: { kind: "raise" },
          } as never),
      ],
    ];
  };

  // A tool unlock writes a rollout item only when it belongs to a rollout.
  const unlockWithRollout = (rolloutId: string | null) => () =>
    createPostgresAgentStore(db).activate({
      intent: { kind: "tool_unlock", rolloutId },
    } as never);

  // Writers of agent_releases (and the agent's move between them).
  const releaseWriters = (): [string, () => Promise<unknown>][] => {
    const agents = createPostgresAgentStore(db);
    return [
      [
        "agent insertRelease",
        () => agents.insertRelease({ release: { agent_id: "a" } } as never),
      ],
      ["agent activate", () => agents.activate({ intent: undefined } as never)],
      [
        "release spec backfill save",
        () =>
          releaseSpecStore(db).save("r", {
            runtime_spec: {},
            spec_source: {},
            spec_source_digest: "d",
            spec_digest: "d",
          } as never),
      ],
    ];
  };

  test("an open freeze lets every writer reach its own logic", async () => {
    for (const [, call] of [...profileTableWriters(), ...releaseWriters()]) {
      await letThrough(call);
    }
  });

  test("a freeze that is not yet certified stops every writer", async () => {
    await freezeProfiles(db);
    for (const [name, call] of [
      ...profileTableWriters(),
      ...releaseWriters(),
    ]) {
      await refused(call).catch((error) => {
        throw new Error(`${name}: ${String(error)}`);
      });
    }
  });

  test("once certified, releases may change again and profile tables never", async () => {
    await freezeProfiles(db);
    await certifyProfiles(db, 1);
    for (const [name, call] of profileTableWriters()) {
      await refused(call).catch((error) => {
        throw new Error(`${name}: ${String(error)}`);
      });
    }
    for (const [name, call] of releaseWriters()) {
      await letThrough(call).catch((error) => {
        throw new Error(`${name}: ${String(error)}`);
      });
    }
  });

  test("once certified, a tool unlock is refused only when it writes a rollout item", async () => {
    await freezeProfiles(db);
    await certifyProfiles(db, 1);
    await refused(unlockWithRollout("rollout-1"));
    await letThrough(unlockWithRollout(null));
  });
});
