import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentCardSchema } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentReleases,
  createPostgresSessionUnitOfWork,
  sessions,
} from "@werft-ai/db";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  type Connections,
  cardContentSha256,
  catalogImports,
  catalogProfileConfigSchema,
  catalogProviderSchema,
  createProfileRegistry,
  deriveReleaseId,
  type InstallationProfileRecord,
  profileCatalog,
  resolveReleaseContent,
  resolveSessionCatalog,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { reconcileSpecs } from "./spec-reconciliation.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const AT = new Date("2026-11-09T00:00:00.000Z");
const PROVIDER = catalogProviderSchema.parse({
  kind: "litellm",
  endpoint: "https://a.test",
  auth: { kind: "api_key", value_env: "KEY_A" },
});
const DEFINITION: CatalogProfileConfig = catalogProfileConfigSchema.parse({
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: PROVIDER,
});
const card = agentCardSchema.parse({
  role: "분석가",
  instructions: "읽고 요약한다.",
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
});

function row(id: string): InstallationProfileRecord {
  const [entry] = catalogImports({ [id]: DEFINITION });
  if (!entry) throw new Error("no entry");
  return {
    id,
    name: null,
    version: 1,
    origin: "catalog",
    definition: JSON.parse(JSON.stringify(DEFINITION)),
    permission_mode: DEFINITION.permission_mode,
    fingerprint: entry.fingerprint,
    repository_ids: [],
    github_app_repositories: "listed",
    previous_id: null,
    created_by: null,
    created_at: AT,
    retired_at: null,
    retired_by: null,
    blocked_at: null,
    blocked_by: null,
  };
}

/** The registry's catalog the way the api reads it: profiles carry the resolved credential. */
async function catalogOf(
  connections: Connections,
  options: { blocked?: boolean; absent?: boolean } = {},
) {
  const registry = createProfileRegistry({
    workspaces: { listAll: async () => [] },
    installations: {
      listAll: async () =>
        options.absent
          ? []
          : [
              options.blocked
                ? {
                    ...row("p"),
                    blocked_at: AT,
                    blocked_by: crypto.randomUUID(),
                  }
                : row("p"),
            ],
    },
    sources: {
      connections,
      connection_aliases: {},
      allowUnattended: false,
      runtimeSupported: () => true,
      materialize: (id, definition) => {
        const profile = resolveSessionCatalog(
          { profiles: { [id]: definition }, repositories: {} },
          () => "provider-key-value",
        ).profiles[id];
        if (!profile) throw new Error(`no ${id}`);
        return profile;
      },
    },
  });
  await registry.refresh();
  return profileCatalog({ repositories: {} }, registry);
}

integration(
  "release specs and session pins, reconciled against the catalog",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "spec_reconcile_it" });
      pool = new Pool({ connectionString: database.url, max: 4 });
      db = drizzle(pool, { schema });
    }, 60_000);

    afterAll(async () => {
      await pool.end();
      await database.drop();
    }, 60_000);

    async function releaseOn(profile: CatalogProfile) {
      const resolved = resolveReleaseContent(card, "coding", profile);
      if (!resolved.ok) throw new Error(resolved.error.message);
      const identity = {
        agent_id: crypto.randomUUID(),
        card_sha256: cardContentSha256(card),
        repository_id: null,
        ...resolved.content,
        runtime_profile_id: "p",
      };
      const id = deriveReleaseId(identity);
      const client = await pool.connect();
      try {
        await client.query("SET session_replication_role = replica");
        await drizzle(client, { schema }).insert(agentReleases).values({
          id,
          agentId: identity.agent_id,
          versionId: crypto.randomUUID(),
          cardSha256: identity.card_sha256,
          runtimeProfileId: "p",
          profileDigest: identity.profile_digest,
          runtimeConfigSnapshot: identity.runtime_config_snapshot,
          effectiveTools: identity.effective_tools,
          policyPins: identity.policy_pins,
        });
      } finally {
        await client.query("SET session_replication_role = DEFAULT");
        client.release();
      }
      return id;
    }

    async function startOn(releaseId: string) {
      const accepted = await createPostgresSessionUnitOfWork(
        db,
      ).acceptInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: { ownerId: crypto.randomUUID() },
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        profileId: "p",
        repository: "none",
        model: "claude-sonnet-5",
        agentReleaseId: releaseId,
        message: "go",
      });
      if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
      return accepted.response.session_id;
    }

    test("a release is matched to its connection by the stored definition, not the loaded profile, and its sessions are then pinned and the gate opens", async () => {
      const catalog = await catalogOf({ one: PROVIDER });
      const profile = catalog.profiles.p;
      if (!profile) throw new Error("no profile");
      const releaseId = await releaseOn(profile as CatalogProfile);
      // A session created before the release had a spec starts unpinned.
      const sessionId = await startOn(releaseId);
      expect(
        (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0]
          ?.specSource,
      ).toBeNull();

      const report = await reconcileSpecs({
        db,
        catalog,
        settings: () => ({
          connections: { one: PROVIDER },
          connection_aliases: {},
        }),
      });

      expect(report.releases.stored).toBe(1);
      expect(report.releases.skipped).toEqual([]);
      const [release] = await db
        .select()
        .from(agentReleases)
        .where(eq(agentReleases.id, releaseId));
      expect(release?.runtimeSpec?.connection).toMatchObject({
        id: "one",
        kind: "litellm",
        endpoint: "https://a.test",
      });
      expect(report.pins.repaired).toBe(1);
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      expect(session?.runtimeSpec?.model).toBe("claude-sonnet-5");
      expect(report.gate).toEqual({
        missing: 0,
        mismatched: 0,
        unverifiable: 0,
        modelUnknown: 0,
        releaseLess: 0,
        open: true,
      });
    }, 30_000);

    test("a release on a profile the operator blocked is told apart from one whose profile is gone, and its live sessions are listed with the reason", async () => {
      const full = await catalogOf({ one: PROVIDER });
      const profile = full.profiles.p;
      if (!profile) throw new Error("no profile");
      const blockedRelease = await releaseOn(profile as CatalogProfile);
      const blockedSession = await startOn(blockedRelease);
      const settings = () => ({
        connections: { one: PROVIDER },
        connection_aliases: {},
      });

      const blocked = await reconcileSpecs({
        db,
        catalog: await catalogOf({ one: PROVIDER }, { blocked: true }),
        settings,
      });
      expect(blocked.releases.skipped).toEqual([
        { release_id: blockedRelease, reason: "profile_blocked" },
      ]);
      expect(blocked.held).toEqual([
        {
          id: blockedSession,
          status: "queued",
          releaseId: blockedRelease,
          profileId: "p",
          reason: "profile_blocked",
        },
      ]);
      expect(blocked.gate.open).toBe(false);

      const gone = await reconcileSpecs({
        db,
        catalog: await catalogOf({ one: PROVIDER }, { absent: true }),
        settings,
      });
      expect(gone.releases.skipped).toEqual([
        { release_id: blockedRelease, reason: "profile_gone" },
      ]);
      expect(gone.held[0]?.reason).toBe("profile_gone");

      // Unblocked, the same release is specced and its session pinned.
      const back = await reconcileSpecs({ db, catalog: full, settings });
      expect(back.releases.stored).toBe(1);
      expect(back.held).toEqual([]);
    }, 30_000);

    test("a release whose provider the settings no longer hold is listed, not guessed, and keeps the gate shut", async () => {
      const catalog = await catalogOf({ one: PROVIDER });
      const profile = catalog.profiles.p;
      if (!profile) throw new Error("no profile");
      const releaseId = await releaseOn(profile as CatalogProfile);
      await startOn(releaseId);

      const report = await reconcileSpecs({
        db,
        catalog,
        settings: () => ({ connections: {}, connection_aliases: {} }),
      });

      expect(report.releases.skipped).toEqual([
        { release_id: releaseId, reason: "connection_missing" },
      ]);
      expect(report.pins.unresolved).toBe(1);
      expect(report.gate.open).toBe(false);
      expect(report.gate.missing).toBe(1);
    }, 30_000);
  },
);
