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
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agents,
  extensionBundles,
  memberships,
  receipts,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { fixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

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

  test("two registrations of the same content at once leave one row and one receipt", async () => {
    const { service } = build();
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        service.register({
          principal: owner,
          slug: "acme",
          files: clean(),
          label: "Research",
          source: "upload",
        }),
      ),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "already_registered",
      "already_registered",
      "already_registered",
      "registered",
    ]);
    const rows = await db
      .select()
      .from(extensionBundles)
      .where(eq(extensionBundles.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(await receiptsOf(workspaceId, "register_extension")).toHaveLength(1);
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
        scope: "agent",
        ...(operation === "attach_extension" ? { mode: "optional" } : {}),
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

  async function agentIn(workspaceId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
    });
    return agentId;
  }

  test("attach offers a version to a scope, replaces it by name, and detach takes back only the version named", async () => {
    const { service } = build();
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const v1 = await register(service, owner);
    const v2 = await register(
      service,
      owner,
      [...clean(), file("skills/research/notes.md", "more")],
      "Research v2",
    );
    expect(v2.digest).not.toBe(v1.digest);
    expect(v2.name).toBe(v1.name);
    const agentId = await agentIn(workspaceId);
    const otherAgent = await agentIn(workspaceId);
    const listed = async (id?: string) =>
      (
        await service.listAttachments({
          workspaceId,
          ...(id === undefined ? {} : { agentId: id }),
        })
      ).map((a) => [a.scope, a.mode, a.bundle.id]);

    await service.recordAttachment({
      principal: owner,
      bundleId: v1.id,
      agentId,
      mode: "required",
      kind: "attach",
    });
    expect(await listed(agentId)).toEqual([["agent", "required", v1.id]]);
    await service.recordAttachment({
      principal: owner,
      bundleId: v2.id,
      agentId,
      kind: "attach",
    });
    expect(await listed(agentId)).toEqual([["agent", "optional", v2.id]]);
    await service.recordAttachment({
      principal: owner,
      bundleId: v1.id,
      agentId,
      kind: "detach",
    });
    expect(await listed(agentId)).toEqual([["agent", "optional", v2.id]]);
    await service.recordAttachment({
      principal: owner,
      bundleId: v1.id,
      scope: "workspace",
      mode: "forbidden",
      kind: "attach",
    });
    expect(await listed(agentId)).toEqual([
      ["agent", "optional", v2.id],
      ["workspace", "forbidden", v1.id],
    ]);
    expect(await listed(otherAgent)).toEqual([
      ["workspace", "forbidden", v1.id],
    ]);
    expect(await listed()).toEqual([["workspace", "forbidden", v1.id]]);
    await service.recordAttachment({
      principal: owner,
      bundleId: v2.id,
      agentId,
      kind: "detach",
    });
    expect(await listed(agentId)).toEqual([["workspace", "forbidden", v1.id]]);
    expect(
      (
        await service.recordAttachment({
          principal: owner,
          bundleId: v1.id,
          kind: "attach",
        })
      ).outcome,
    ).toBe("agent_not_found");
    expect(
      (
        await service.recordAttachment({
          principal: owner,
          bundleId: v1.id,
          agentId: await agentIn(await workspace()),
          kind: "attach",
        })
      ).outcome,
    ).toBe("agent_not_found");
  });

  test("an owner that is no uuid (before workspaces) has no attachments instead of failing the read", async () => {
    const { store } = build();
    expect(await store.listAttachments({ workspaceId: "local" })).toEqual([]);
    expect(await store.find("local", randomUUID())).toBeNull();
    expect(
      await store.listAttachments({
        workspaceId: randomUUID(),
        agentId: "not-a-uuid",
      }),
    ).toEqual([]);
  });

  test("attaches of one name at once all record and leave a single row", async () => {
    const { service } = build();
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const versions = [await register(service, owner)];
    for (let i = 0; i < 3; i++) {
      versions.push(
        await register(
          service,
          owner,
          [...clean(), file(`skills/research/n${i}.md`, `v${i}`)],
          `Research n${i}`,
        ),
      );
    }
    const agentId = await agentIn(workspaceId);
    for (const scope of ["agent", "workspace"] as const) {
      const outcomes = await Promise.all(
        versions.map((v) =>
          service.recordAttachment({
            principal: owner,
            bundleId: v.id,
            scope,
            ...(scope === "agent" ? { agentId } : {}),
            kind: "attach",
          }),
        ),
      );
      expect(outcomes.map((o) => o.outcome)).toEqual(
        versions.map(() => "recorded"),
      );
    }
    const rows = await service.listAttachments({ workspaceId, agentId });
    expect(rows.map((r) => r.scope).sort()).toEqual(["agent", "workspace"]);
  });

  test("a member cannot attach; nothing is written", async () => {
    const { service } = build();
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const member = await person(workspaceId, "member");
    const bundle = await register(service, owner);
    const result = await service.recordAttachment({
      principal: member,
      bundleId: bundle.id,
      scope: "workspace",
      kind: "attach",
    });
    expect(result.outcome).toBe("outranked");
    expect(await service.listAttachments({ workspaceId })).toEqual([]);
  });

  test("the table refuses a second version of one name in a scope, and a scope that names the wrong agent", async () => {
    const { service } = build();
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const userId = owner.actor?.userId ?? "";
    const v1 = await register(service, owner);
    const v2 = await register(service, owner, [
      ...clean(),
      file("skills/research/notes.md", "more"),
    ]);
    const agentId = await agentIn(workspaceId);
    const row = (
      over: Partial<typeof schema.extensionAttachments.$inferInsert>,
    ) => ({
      id: randomUUID(),
      workspaceId,
      scope: "workspace",
      agentId: null,
      bundleId: v1.id,
      name: v1.name,
      mode: "optional",
      createdBy: userId,
      ...over,
    });
    const insert = (values: ReturnType<typeof row>) =>
      db.insert(schema.extensionAttachments).values(values);
    expect(await refusal(insert(row({})))).toBe("accepted");
    expect(await refusal(insert(row({ bundleId: v2.id })))).toBe(
      "extension_attachments_workspace_name_idx",
    );
    expect(
      await refusal(insert(row({ scope: "agent", agentId, bundleId: v1.id }))),
    ).toBe("accepted");
    expect(
      await refusal(insert(row({ scope: "agent", agentId, bundleId: v2.id }))),
    ).toBe("extension_attachments_agent_name_idx");
    expect(await refusal(insert(row({ scope: "agent", agentId: null })))).toBe(
      "extension_attachments_scope_check",
    );
    expect(await refusal(insert(row({ scope: "workspace", agentId })))).toBe(
      "extension_attachments_scope_check",
    );
    expect(await refusal(insert(row({ mode: "always" })))).toBe(
      "extension_attachments_mode_check",
    );
    expect(
      await refusal(
        insert(
          row({
            workspaceId: await workspace(),
            scope: "agent",
            agentId: await agentIn(workspaceId),
          }),
        ),
      ),
    ).toBe("extension_attachments_agent_fk");
  });

  test("a session keeps the bundles resolved at create: a later attachment change does not move them, and a replay answers the same", async () => {
    const { service } = build();
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const bundle = await register(service, owner);
    const uow = createPostgresSessionUnitOfWork(db);
    const resolved = [
      {
        bundle_id: bundle.id,
        name: bundle.name,
        digest: bundle.digest,
        scope: "workspace" as const,
      },
    ];
    const agentReleaseId = await fixtureRelease(db);
    const request = (over: Record<string, unknown> = {}) => ({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
      idempotencyKey: "same-key",
      payloadHash: "same-hash",
      agentReleaseId,
      model: TEST_MODEL,
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
      ...over,
    });
    const first = await uow.acceptInputAtomic(
      request({ extensions: resolved }),
    );
    if (first.outcome !== "accepted") throw new Error(first.outcome);
    expect(first.response.extensions).toEqual(resolved);
    const stored = async () =>
      (
        await db
          .select({ extensions: sessions.extensions })
          .from(sessions)
          .where(eq(sessions.id, first.response.session_id))
      )[0]?.extensions;
    expect(await stored()).toEqual(resolved);

    await service.recordAttachment({
      principal: owner,
      bundleId: bundle.id,
      scope: "workspace",
      mode: "forbidden",
      kind: "attach",
    });
    expect(await stored()).toEqual(resolved);

    const replay = await uow.acceptInputAtomic(
      request({ extensions: [], extensionsRefused: true }),
    );
    expect(replay).toMatchObject({
      outcome: "replayed",
      response: { session_id: first.response.session_id, extensions: resolved },
    });
    const refused = await uow.acceptInputAtomic(
      request({
        idempotencyKey: "other-key",
        payloadHash: "other-hash",
        extensionsRefused: true,
      }),
    );
    expect(refused.outcome).toBe("unsupported");
    const count = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.ownerId, workspaceId));
    expect(count).toHaveLength(1);

    const bare = await uow.acceptInputAtomic(
      request({ idempotencyKey: "bare", payloadHash: "bare" }),
    );
    if (bare.outcome !== "accepted") throw new Error(bare.outcome);
    expect(bare.response.extensions).toBeUndefined();
    const [bareRow] = await db
      .select({ extensions: sessions.extensions })
      .from(sessions)
      .where(eq(sessions.id, bare.response.session_id));
    expect(bareRow?.extensions).toBeNull();
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
