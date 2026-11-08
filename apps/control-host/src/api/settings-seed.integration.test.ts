import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import * as schema from "@werft-ai/db";
import {
  createPostgresInstallationProfileStore,
  type Database,
  installationProfiles,
} from "@werft-ai/db";
import {
  allowedRun,
  type CatalogProfile,
  type Connections,
  catalogImports,
  catalogProfile,
  catalogRepositoryIds,
  createProfileRegistry,
  installationProfileSnapshot,
  parseSeedDocument,
  profileCatalog,
  profileFingerprint,
  profileModels,
  profilePinned,
  profilePins,
  resolveSessionCatalog,
  runtimeConfigOf,
  type SnapshotSources,
  type WorkspaceProfileRecord,
  workspaceProfileState,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { slackProfileCatalog } from "../slack/main.ts";
import { seedSettings } from "../test-support/settings.ts";
import { ALLOW_UNATTENDED_SETTING } from "./catalog-config.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const FIXTURES = [
  "real-model",
  "fake-model",
  "fake-model-unattended",
  "local-model",
];
const PLACEHOLDER = "placeholder-credential-value";
const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

// Computed on main at 304c2713 (catalog-config.test.ts): sessions and
// releases pin these, so the database path must give the same.
const ON_MAIN: Record<string, Record<string, string>> = {
  "real-model": {
    "claude-coding-real":
      "sha256:1fc3c2a8042b16a150b6c2f7ab2d93c801daf2faacc7c86eefdf087f94d10fc1",
  },
  "fake-model": {
    "claude-coding-local":
      "sha256:72712d90972545ff5b7e0124e9647fab5d30e750b1422b626c217b116b160dd0",
    general:
      "sha256:6d29ef4da170790c0a7abefac65abf2d33079fab14162b461a811378b170d6a6",
  },
  "local-model": {
    "local-ollama":
      "sha256:719a7af6b2f1ec7710965e57e021d8d1d558cc3043866d518de09aca8894ec4b",
    "local-litellm":
      "sha256:d342569f22e036620a11708b4f0247d2784577bc62c0caf556a0ecb2073f682a",
  },
  "fake-model-unattended": {
    "claude-coding-auto":
      "sha256:a1e65a5716ac13d4ef2bad746f8aa8f611c0e8994d4195a14ce57f897bb28170",
    "claude-coding-bypass":
      "sha256:0c0a448dfd97b6236eea2fb5af8c8b781eb716e0549559649ff81cee5cbf6d8c",
  },
};

function sourcesFor(connections: Connections): SnapshotSources<CatalogProfile> {
  return {
    connections,
    allowUnattended: true,
    runtimeSupported: () => true,
    materialize: (id, definition) => {
      const profile = resolveSessionCatalog(
        { profiles: { [id]: definition }, repositories: {} },
        () => PLACEHOLDER,
      ).profiles[id];
      if (!profile) throw new Error(`no ${id}`);
      return profile;
    },
  };
}

// Seeding only acts on an empty table, so each test owns a database.
async function emptyDatabase<T>(run: (db: Database) => Promise<T>): Promise<T> {
  const database = await createTempDatabase({ prefix: "profile_seed_it" });
  const pool = new Pool({ connectionString: database.url, max: 4 });
  try {
    return await run(drizzle(pool, { schema }));
  } finally {
    await pool.end();
    await database.drop();
  }
}

const dump = (db: Database) =>
  db.select().from(installationProfiles).orderBy(asc(installationProfiles.id));

async function fixture(name: string) {
  const document = await Bun.file(
    join(import.meta.dir, `../../../../tests/fixtures/settings/${name}.json`),
  ).json();
  const { entries, profiles } = parseSeedDocument(document);
  if (profiles === null) throw new Error(`${name} seeds no ceiling`);
  return { document, entries, profiles };
}

integration("a settings document seeding an empty PostgreSQL", () => {
  for (const name of FIXTURES) {
    test(`${name}: the seeded database gives the document's profiles, pins and repositories`, async () => {
      await emptyDatabase(async (db) => {
        const { document, entries, profiles } = await fixture(name);
        // What the YAML-only image (main 9afaf942) resolves.
        const stageZero = resolveSessionCatalog(
          { repositories: entries.repositories, profiles },
          (ref) =>
            "secret_id" in ref &&
            ref.secret_id === "werft/local/fake-github-app"
              ? appKey
              : PLACEHOLDER,
        );
        await seedSettings(db, document);
        const store = createPostgresInstallationProfileStore(db);
        const fromDatabase = installationProfileSnapshot(
          sourcesFor(entries.connections),
          await store.listAll(),
        );
        expect(fromDatabase.profiles).toEqual(stageZero.profiles);
        for (const [id, profile] of Object.entries(stageZero.profiles)) {
          const stored = fromDatabase.profiles[id];
          if (!stored) throw new Error(`${name}: no ${id}`);
          expect(profilePins(stored, [])).toEqual(profilePins(profile, []));
          expect(profileModels(stored)).toEqual(profileModels(profile));
          expect(profileFingerprint(stored)).toBe(profileFingerprint(profile));
          expect(runtimeConfigOf(stored, "tok", true)).toEqual(
            runtimeConfigOf(profile, "tok", true),
          );
          const version: WorkspaceProfileRecord = {
            id: `ws_acme_${id}_v1`,
            workspace_id: "w",
            name: id,
            version: 1,
            base_profile_id: id,
            base_fingerprint: profileFingerprint(profile),
            model: profile.model,
            models: [profile.model],
            tools: profile.tools.slice(0, 1),
            permission_mode: profile.permission_mode,
            base_runtime_version: profile.runtime_version,
            base_billing: "metered",
            base_repository_mode: "required",
            created_by: "019a0000-0000-7000-8000-0000000000b1",
            created_at: new Date(),
            retired_by: null,
            retired_at: null,
          };
          expect(
            workspaceProfileState(
              {
                profiles: fromDatabase.profiles,
                installation: fromDatabase.installation,
              },
              version,
            ),
          ).toBe("usable");
        }
        for (const [id, digest] of Object.entries(ON_MAIN[name] ?? {})) {
          const stored = fromDatabase.profiles[id];
          if (!stored) throw new Error(`${name}: no ${id}`);
          // The digests were taken under runtime 0.3.270; the fixtures now say
          // 0.3.319, so an old pin matches while 0.3.270 is an accepted version.
          expect(profilePinned(stored, digest, ["0.3.270"])).toBe(true);
        }
        const catalog = {
          ...stageZero,
          profiles: fromDatabase.profiles,
          installation: fromDatabase.installation,
        };
        for (const [repositoryId, repository] of Object.entries(
          entries.repositories,
        )) {
          for (const profileId of repository.profiles ?? []) {
            if (!stageZero.profiles[profileId]) continue;
            expect(allowedRun(catalog, profileId, repositoryId)).not.toBeNull();
          }
        }
      });
    }, 60_000);
  }

  test("a populated table ignores a later seed: new ids, edited entries, moved repositories", async () => {
    await emptyDatabase(async (db) => {
      const { document, entries, profiles } = await fixture("fake-model");
      const store = createPostgresInstallationProfileStore(db);
      await seedSettings(db, document);
      const before = await dump(db);
      const edited = Object.fromEntries(
        Object.entries(profiles).map(([id, profile]) => [
          `${id}-edited`,
          { ...profile, model: "claude-opus-5-5" },
        ]),
      );
      const again = await store.seedCatalog({
        entries: async () => catalogImports({ ...profiles, ...edited }),
        repositoryIdsOf: catalogRepositoryIds(
          Object.fromEntries(
            Object.entries(entries.repositories).map(([id, repository]) => [
              id,
              { ...repository, profiles: [] },
            ]),
          ),
        ),
      });
      expect(again).toEqual({ seeded: [], migrated: [] });
      expect(await dump(db)).toEqual(before);
    });
  }, 60_000);

  test("a populated table is not read for a seed: a broken one writes nothing", async () => {
    await emptyDatabase(async (db) => {
      const { document } = await fixture("fake-model");
      await seedSettings(db, document);
      const before = await dump(db);
      const again = await createPostgresInstallationProfileStore(
        db,
      ).seedCatalog({
        entries: async () => {
          throw new Error("the seed was read");
        },
        repositoryIdsOf: () => [],
      });
      expect(again).toEqual({ seeded: [], migrated: [] });
      expect(await dump(db)).toEqual(before);
    });
  }, 60_000);

  test("a restarted replica reads the same rows and profiles", async () => {
    await emptyDatabase(async (db) => {
      const { document, entries } = await fixture("fake-model");
      const store = createPostgresInstallationProfileStore(db);
      await seedSettings(db, document);
      const boot = async () => {
        const registry = createProfileRegistry({
          workspaces: schema.createPostgresWorkspaceProfileStore(db),
          installations: store,
          sources: sourcesFor(entries.connections),
        });
        await registry.refresh();
        const catalog = profileCatalog({ repositories: {} }, registry);
        return { rows: await dump(db), profiles: catalog.profiles };
      };
      const first = await boot();
      const second = await boot();
      expect(second).toEqual(first);
      expect(first.rows.length).toBeGreaterThan(0);
    });
  }, 60_000);

  test("the slack role leaves a bypass ceiling out while the switch is off", async () => {
    await emptyDatabase(async (db) => {
      const { document } = await fixture("fake-model-unattended");
      await seedSettings(db, document);
      const off = slackProfileCatalog(db, {});
      const on = slackProfileCatalog(db, {
        [ALLOW_UNATTENDED_SETTING]: "true",
      });
      await Promise.all([
        off.workspace_profiles.refresh(),
        on.workspace_profiles.refresh(),
      ]);
      expect(off.installation.get("claude-coding-bypass")?.state).toBe(
        "unattended_off",
      );
      expect(catalogProfile(off, "claude-coding-bypass")).toBeUndefined();
      expect(allowedRun(off, "claude-coding-bypass", "sample-app")).toBeNull();
      expect(catalogProfile(on, "claude-coding-bypass")).toBeDefined();
      expect(
        allowedRun(on, "claude-coding-bypass", "sample-app"),
      ).not.toBeNull();
      expect(catalogProfile(off, "claude-coding-auto")).toBeDefined();
    });
  }, 60_000);
});
