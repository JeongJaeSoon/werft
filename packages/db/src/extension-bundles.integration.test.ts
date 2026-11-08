import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type BundleInputFile,
  type Caller,
  callerFor,
  createExtensionBundleService,
  EXTENSION_BUNDLE_REVIEWS,
  EXTENSION_BUNDLE_SOURCES,
} from "@werft-ai/platform";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresExtensionBundleStore } from "./extension-bundles.ts";
import * as schema from "./schema.ts";
import {
  agents,
  extensionBundles,
  memberships,
  receipts,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const text = (value: string) => new TextEncoder().encode(value);
const file = (path: string, content: string): BundleInputFile => ({
  path,
  kind: "file",
  mode: 0o644,
  bytes: text(content),
});
const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Use for ${name}\n---\nDo it.\n`;
const clean = (name = "research") => [
  file(`skills/${name}/SKILL.md`, skill(name)),
];

async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? String(error);
  }
  return "accepted";
}

test("the schema's review and source lists match the port's", () => {
  expect([...schema.EXTENSION_BUNDLE_REVIEWS]).toEqual([
    ...EXTENSION_BUNDLE_REVIEWS,
  ]);
  expect([...schema.EXTENSION_BUNDLE_SOURCES]).toEqual([
    ...EXTENSION_BUNDLE_SOURCES,
  ]);
});

integration("extension bundles on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "extension_bundles_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  function build() {
    const store = createPostgresExtensionBundleStore(db);
    const objects = createMemoryCheckpointObjectStore();
    return {
      store,
      objects,
      service: createExtensionBundleService({ store, objects }),
    };
  }

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${role}-${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  const receiptsOf = (workspaceId: string, operation: string) =>
    db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.ownerId, workspaceId),
          eq(receipts.operation, operation),
        ),
      );

  async function register(
    service: ReturnType<typeof build>["service"],
    by: Caller,
    files = clean(),
    label = "Research",
  ) {
    const result = await service.register({
      principal: by,
      slug: "acme",
      files,
      label,
      source: "upload",
    });
    if (result.outcome !== "registered") throw new Error(result.outcome);
    return result.bundle;
  }

  test("the table carries the columns the ticket names", async () => {
    const columns = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'extension_bundles'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const name of [
      "workspace_id",
      "name",
      "digest",
      "label",
      "source",
      "registered_by",
      "registered_at",
      "review",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("register stores a row and a register_extension receipt; the same content again adds neither", async () => {
    const { service } = build();
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const first = await register(service, owner);
    expect(first.review).toBe("pending");
    expect(first.registeredBy).toBe(owner.actor?.userId ?? "");
    const again = await service.register({
      principal: owner,
      slug: "acme",
      files: [...clean()].reverse(),
      label: "A different label",
      source: "github",
    });
    expect(again).toMatchObject({
      outcome: "already_registered",
      bundle: { id: first.id, label: "Research", source: "upload" },
    });
    const rows = await db
      .select()
      .from(extensionBundles)
      .where(eq(extensionBundles.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    const made = await receiptsOf(workspaceId, "register_extension");
    expect(made).toHaveLength(1);
    expect(made[0]?.targetRef).toEqual({
      resource: { kind: "extension_bundle", id: first.id },
      workspace_id: workspaceId,
    });
    expect(made[0]?.result).toMatchObject({ digest: first.digest });
  });

  test("a review changes the state and leaves the digest as it was", async () => {
    const { service, store } = build();
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const bundle = await register(service, owner);
    const approved = await service.review({
      principal: admin,
      bundleId: bundle.id,
      review: "approved",
    });
    expect(approved.outcome).toBe("reviewed");
    const stored = await store.find(workspaceId, bundle.id);
    expect(stored).toMatchObject({
      digest: bundle.digest,
      review: "approved",
      reviewedBy: admin.actor?.userId,
    });
    expect(
      (
        await service.review({
          principal: admin,
          bundleId: bundle.id,
          review: "approved",
        })
      ).outcome,
    ).toBe("unchanged");
    const writes = await receiptsOf(workspaceId, "approve_extension");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.result).toEqual({
      digest: bundle.digest,
      from: "pending",
      review: "approved",
    });
    expect((await service.read(workspaceId, bundle.digest))?.digest).toBe(
      bundle.digest,
    );
  });

  test("a member, a stranger and another workspace's owner cannot manage bundles", async () => {
    const { service, objects } = build();
    const workspaceId = await workspace();
    const otherId = await workspace();
    const owner = await person(workspaceId, "owner");
    const member = await person(workspaceId, "member");
    const other = await person(otherId, "owner");
    const bundle = await register(service, owner);
    expect(objects.keys()).toHaveLength(1);

    const attempt = (by: Caller, ownerId: string, files = clean("other")) =>
      service.register({
        principal: { ...by, ownerId },
        slug: "acme",
        files,
        label: "x",
        source: "upload",
      });
    expect((await attempt(member, workspaceId)).outcome).toBe("outranked");
    // The other workspace's owner is no member of this one.
    expect((await attempt(other, workspaceId)).outcome).toBe("actor_inactive");
    expect(objects.keys()).toHaveLength(1);
    expect(
      (
        await service.review({
          principal: member,
          bundleId: bundle.id,
          review: "approved",
        })
      ).outcome,
    ).toBe("outranked");
    expect(
      (
        await service.review({
          principal: { ...other, ownerId: otherId },
          bundleId: bundle.id,
          review: "approved",
        })
      ).outcome,
    ).toBe("not_found");
  });

  test("a bundle is read only in the workspace that stored it", async () => {
    const { service, store, objects } = build();
    const a = await workspace();
    const b = await workspace();
    const ownerA = await person(a, "owner");
    const ownerB = await person(b, "owner");
    const inA = await register(service, ownerA);
    expect(await service.read(b, inA.digest)).toBeNull();
    expect(await store.find(b, inA.id)).toBeNull();
    // The same content in B is its own object under its own prefix.
    const inB = await register(service, ownerB);
    expect(inB.digest).toBe(inA.digest);
    expect(inB.id).not.toBe(inA.id);
    expect(objects.keys().sort()).toEqual(
      [a, b].map((id) => `workspaces/${id}/bundles/${inA.digest}.tar`).sort(),
    );
  });

  test("attach and detach each leave a receipt on the agent", async () => {
    const { service } = build();
    const workspaceId = await workspace();
    const other = await workspace();
    const owner = await person(workspaceId, "owner");
    const bundle = await register(service, owner);
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
    });
    for (const kind of ["attach", "detach"] as const) {
      expect(
        (
          await service.recordAttachment({
            principal: owner,
            bundleId: bundle.id,
            agentId,
            kind,
          })
        ).outcome,
      ).toBe("recorded");
    }
    for (const operation of ["attach_extension", "detach_extension"]) {
      const rows = await receiptsOf(workspaceId, operation);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.targetRef).toEqual({
        resource: { kind: "agent", id: agentId },
        workspace_id: workspaceId,
      });
      expect(rows[0]?.result).toEqual({
        bundle_id: bundle.id,
        digest: bundle.digest,
      });
    }
    const stranger = randomUUID();
    expect(
      (
        await service.recordAttachment({
          principal: owner,
          bundleId: bundle.id,
          agentId: stranger,
          kind: "attach",
        })
      ).outcome,
    ).toBe("agent_not_found");
    expect(
      (
        await service.recordAttachment({
          principal: owner,
          bundleId: randomUUID(),
          agentId,
          kind: "attach",
        })
      ).outcome,
    ).toBe("bundle_not_found");
    expect(await receiptsOf(other, "attach_extension")).toEqual([]);
  });

  test("the table refuses what the service never writes", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const userId = owner.actor?.userId ?? "";
    const row = {
      id: randomUUID(),
      workspaceId,
      name: "acme",
      digest: "a".repeat(64),
      label: "x",
      source: "upload",
      sizeBytes: 1,
      manifest: {},
      registeredBy: userId,
    };
    const insert = (
      over: Partial<
        typeof row & { review: string; reviewedBy: string; reviewedAt: Date }
      >,
    ) =>
      db.insert(extensionBundles).values({ ...row, id: randomUUID(), ...over });
    expect(await refusal(insert({ digest: "A".repeat(64) }))).toBe(
      "extension_bundles_digest_check",
    );
    expect(await refusal(insert({ name: "Bad Name" }))).toBe(
      "extension_bundles_name_check",
    );
    expect(await refusal(insert({ source: "ftp" }))).toBe(
      "extension_bundles_source_check",
    );
    expect(
      await refusal(
        insert({ review: "maybe", reviewedBy: userId, reviewedAt: new Date() }),
      ),
    ).toBe("extension_bundles_review_check");
    // An approved bundle names who approved it.
    expect(await refusal(insert({ review: "approved" }))).toBe(
      "extension_bundles_review_actor_check",
    );
    expect(await refusal(insert({}))).toBe("accepted");
    expect(await refusal(insert({}))).toBe(
      "extension_bundles_workspace_digest_idx",
    );
  });
});
