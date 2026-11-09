import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentCardSchema } from "@werft-ai/contracts";
import {
  backfillReleaseSpecs,
  type CatalogProfile,
  cardContentSha256,
  deriveReleaseId,
  resolveReleaseContent,
  verifyReleaseSpec,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { releaseSpecStore } from "./release-specs.ts";
import * as schema from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Edit"],
  permission_mode: "bypassPermissions",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};

const card = agentCardSchema.parse({
  role: "분석가",
  instructions: "읽고 요약한다.",
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
});

integration("release spec backfill on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "release_spec_backfill" });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  // The foreign keys to the agent and its version are not what this tests.
  async function insertRelease(against: CatalogProfile) {
    const resolved = resolveReleaseContent(card, "coding", against);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const identity = {
      agent_id: crypto.randomUUID(),
      card_sha256: cardContentSha256(card),
      repository_id: null,
      ...resolved.content,
    };
    const id = deriveReleaseId(identity);
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await client.query(
        `INSERT INTO agent_releases
           (id, agent_id, version_id, card_sha256, runtime_profile_id, profile_digest,
            runtime_config_snapshot, effective_tools, policy_pins)
         VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
        [
          id,
          identity.agent_id,
          identity.card_sha256,
          identity.runtime_profile_id,
          identity.profile_digest,
          JSON.stringify(identity.runtime_config_snapshot),
          JSON.stringify(identity.effective_tools),
          JSON.stringify(identity.policy_pins),
        ],
      );
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
    return id;
  }

  const row = async (id: string) =>
    (
      await pool.query(
        "SELECT runtime_spec, spec_source, spec_source_digest, spec_digest FROM agent_releases WHERE id = $1",
        [id],
      )
    ).rows[0];

  test("stores a spec that verifies when read back, and a second run changes nothing", async () => {
    const good = await insertRelease(profile);
    const edited = await insertRelease({ ...profile, tools: ["Read"] });
    const store = releaseSpecStore(db);
    // `edited` was cut from a profile that has since become this one.
    const resolve = () => ({ profile, connectionId: "conn-1" });

    const first = await backfillReleaseSpecs(store, resolve, 1);
    expect(first.stored).toBe(1);
    expect(first.skipped).toEqual([
      { release_id: edited, reason: "profile_changed" },
    ]);

    const stored = await row(good);
    expect(verifyReleaseSpec(good, stored).ok).toBe(true);
    expect(stored.runtime_spec.execution_mode).toBe("bypass");
    expect(await row(edited)).toEqual({
      runtime_spec: null,
      spec_source: null,
      spec_source_digest: null,
      spec_digest: null,
    });

    const second = await backfillReleaseSpecs(store, resolve, 1);
    expect(second.stored).toBe(0);
    expect(await row(good)).toEqual(stored);
  });

  test("a spec already stored is never overwritten", async () => {
    const id = await insertRelease({
      ...profile,
      tools: ["Read", "Edit", "Bash"],
    });
    const store = releaseSpecStore(db);
    const withTools = { ...profile, tools: ["Read", "Edit", "Bash"] };
    await backfillReleaseSpecs(store, () => ({
      profile: withTools,
      connectionId: "conn-1",
    }));
    const stored = await row(id);
    expect(stored.runtime_spec).not.toBeNull();
    // Two writers on the same release: exactly one wins, the row is the
    // first one's, and the loser is told so.
    const record = verifyOk(id, stored);
    expect(await store.save(id, record)).toBe(false);
    expect((await store.pending(null, 100)).map((r) => r.id)).not.toContain(id);
    expect(await row(id)).toEqual(stored);
  });
  test("two backfills at once store each release exactly once", async () => {
    const ids = await Promise.all(
      ["Glob", "WebFetch", "Task"].map((tool) =>
        insertRelease({ ...profile, tools: [tool] }),
      ),
    );
    const store = releaseSpecStore(db);
    const resolve = (release: { id: string }) => {
      const tool = ["Glob", "WebFetch", "Task"][ids.indexOf(release.id)];
      return tool === undefined
        ? null
        : { profile: { ...profile, tools: [tool] }, connectionId: "conn-1" };
    };
    // Both read the pending set before either writes, so each really races.
    let reads = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = {
      ...store,
      pending: async (after: string | null, limit: number) => {
        const rows = await store.pending(after, limit);
        if (after === null) {
          reads += 1;
          if (reads === 2) release();
          await bothRead;
        }
        return rows;
      },
    };
    const [a, b] = await Promise.all([
      backfillReleaseSpecs(gated, resolve),
      backfillReleaseSpecs(gated, resolve),
    ]);
    expect(a.stored + b.stored).toBe(3);
    // Each writer saw all three; every one it did not store, the other had.
    expect(a.stored + a.raced).toBe(3);
    expect(b.stored + b.raced).toBe(3);
    for (const id of ids) {
      expect(verifyReleaseSpec(id, await row(id)).ok).toBe(true);
    }
  });

  test("the table still refuses every other write to a release", async () => {
    const id = await insertRelease({ ...profile, tools: ["Read", "Grep"] });
    const store = releaseSpecStore(db);
    await backfillReleaseSpecs(store, () => ({
      profile: { ...profile, tools: ["Read", "Grep"] },
      connectionId: "conn-1",
    }));
    const stored = await row(id);
    // A stored spec is not replaced by another one.
    await expect(
      pool.query(
        "UPDATE agent_releases SET runtime_spec = $2::jsonb, spec_source = $3::jsonb, spec_source_digest = $4, spec_digest = $5 WHERE id = $1",
        [
          id,
          JSON.stringify(stored.runtime_spec),
          JSON.stringify(stored.spec_source),
          stored.spec_source_digest,
          `${stored.spec_digest}-changed`,
        ],
      ),
    ).rejects.toThrow(/insert-only/);
    // The spec columns do not carry another column's change with them.
    const bare = await insertRelease({ ...profile, tools: ["Read", "Bash"] });
    await expect(
      pool.query(
        "UPDATE agent_releases SET note = 'x', runtime_spec = '{}'::jsonb, spec_source = '{}'::jsonb, spec_source_digest = 'd', spec_digest = 'd' WHERE id = $1",
        [bare],
      ),
    ).rejects.toThrow(/insert-only/);
  });
});

function verifyOk(id: string, stored: Parameters<typeof verifyReleaseSpec>[1]) {
  const verdict = verifyReleaseSpec(id, stored);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict.record;
}
