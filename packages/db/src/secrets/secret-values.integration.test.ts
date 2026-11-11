import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  callerFor,
  MANAGEMENT_ROLES,
  type SecretAudit,
  SecretDecryptError,
  SecretKey,
  type SecretSlot,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  memberships,
  receipts,
  secretValues,
  users,
  workspaces,
} from "../schema.ts";
import { createPostgresSecretStore } from "./secret-values.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];

// Made per run: a fixed token-shaped string has no place in a file.
const fakeToken = () => `xoxe-1-${randomBytes(24).toString("hex")}`;

integration("secret values on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "secret_values_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function workspace() {
    const id = randomUUID();
    await db
      .insert(workspaces)
      .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "Acme" });
    return id;
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: `${role} person`,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    const audit: SecretAudit = {
      principal: callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role,
          scopes: [...scopesForRole(role)],
        },
        { kind: "web" },
        randomUUID(),
      ),
      receiptId: randomUUID(),
      roles: MANAGERS,
    };
    return { userId, audit };
  }

  const configToken = (workspaceId: string): SecretSlot => ({
    workspaceId,
    owner: { kind: "workspace" },
    purpose: "slack_config_token",
  });
  const appSecret = (workspaceId: string, appId: string): SecretSlot => ({
    workspaceId,
    owner: { kind: "slack_app", id: appId },
    purpose: "slack_signing_secret",
  });

  async function rowOf(slot: SecretSlot) {
    const [row] = await db
      .select()
      .from(secretValues)
      .where(
        sql`${secretValues.workspaceId} = ${slot.workspaceId} AND ${secretValues.purpose} = ${slot.purpose} AND ${secretValues.ownerRef} = ${slot.owner.kind === "workspace" ? "workspace" : `slack_app:${slot.owner.id}`}`,
      );
    if (!row) throw new Error("no row");
    return row;
  }

  test("a value round-trips and only its ciphertext is stored", async () => {
    const store = createPostgresSecretStore(db, key);
    const slot = configToken(await workspace());
    const value = fakeToken();
    expect(await store.get(slot)).toBeNull();
    expect(await store.describe(slot)).toBeNull();
    const put = await store.put(slot, value);
    expect(put).toMatchObject({
      outcome: "stored",
      summary: { last4: value.slice(-4), secretVersion: 1, updatedBy: null },
    });
    expect(await store.get(slot)).toBe(value);
    const row = await rowOf(slot);
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(value))).toBe(
      false,
    );
    const dumped = await pool.query(
      "SELECT row_to_json(s)::text AS json FROM secret_values s WHERE id = $1",
      [row.id],
    );
    expect(dumped.rows[0].json).not.toContain(value);
  });

  test("a workspace id in any case names the same slot", async () => {
    const store = createPostgresSecretStore(db, key);
    const lower = configToken(await workspace());
    const upper = { ...lower, workspaceId: lower.workspaceId.toUpperCase() };
    const value = fakeToken();
    expect(await store.put(upper, value)).toMatchObject({ outcome: "stored" });
    expect(await store.get(lower)).toBe(value);
    expect(await store.get(upper)).toBe(value);
    expect(await store.put(lower, fakeToken())).toMatchObject({
      summary: { secretVersion: 2 },
    });
    expect(await store.delete(upper)).toMatchObject({ outcome: "deleted" });
  });

  test("a replace keeps the row and bumps its version", async () => {
    const store = createPostgresSecretStore(db, key);
    const slot = configToken(await workspace());
    await store.put(slot, fakeToken());
    const first = await rowOf(slot);
    const next = fakeToken();
    await store.put(slot, next);
    const second = await rowOf(slot);
    expect(second.id).toBe(first.id);
    expect(second.secretVersion).toBe(2);
    expect(await store.get(slot)).toBe(next);
  });

  const app = randomUUID();
  const tampered: [
    string,
    (row: typeof secretValues.$inferSelect) => string,
    (slot: SecretSlot) => SecretSlot,
  ][] = [
    ["id", () => `id = '${randomUUID()}'`, (slot) => slot],
    [
      "owner_ref",
      () => `owner_ref = 'slack_app:${app}'`,
      (slot) => ({ ...slot, owner: { kind: "slack_app", id: app } }),
    ],
    [
      "purpose",
      () => "purpose = 'slack_bot_token'",
      (slot) => ({ ...slot, purpose: "slack_bot_token" }),
    ],
    [
      "secret_version",
      (row) => `secret_version = ${row.secretVersion + 1}`,
      (slot) => slot,
    ],
    [
      "key_version",
      (row) => `key_version = ${row.keyVersion + 1}`,
      (slot) => slot,
    ],
  ];
  test.each(tampered)(
    "changing only %s on the row makes it undecryptable",
    async (_, change, readThrough) => {
      const store = createPostgresSecretStore(db, key);
      const slot = configToken(await workspace());
      await store.put(slot, fakeToken());
      const row = await rowOf(slot);
      await pool.query(
        `UPDATE secret_values SET ${change(row)} WHERE id = $1`,
        [row.id],
      );
      await expect(store.get(readThrough(slot))).rejects.toBeInstanceOf(
        SecretDecryptError,
      );
    },
  );

  test("changing only workspace_id makes it undecryptable", async () => {
    const store = createPostgresSecretStore(db, key);
    const slot = configToken(await workspace());
    const other = await workspace();
    await store.put(slot, fakeToken());
    await pool.query(
      "UPDATE secret_values SET workspace_id = $2 WHERE workspace_id = $1",
      [slot.workspaceId, other],
    );
    await expect(store.get(configToken(other))).rejects.toBeInstanceOf(
      SecretDecryptError,
    );
  });

  test("another workspace's ciphertext copied in is refused", async () => {
    const store = createPostgresSecretStore(db, key);
    const mine = configToken(await workspace());
    const theirs = configToken(await workspace());
    await store.put(mine, fakeToken());
    await store.put(theirs, fakeToken());
    const source = await rowOf(theirs);
    await db
      .update(secretValues)
      .set({ nonce: source.nonce, ciphertext: source.ciphertext })
      .where(eq(secretValues.id, (await rowOf(mine)).id));
    await expect(store.get(mine)).rejects.toBeInstanceOf(SecretDecryptError);
  });

  test("another app's ciphertext copied in is refused", async () => {
    const store = createPostgresSecretStore(db, key);
    const workspaceId = await workspace();
    const mine = appSecret(workspaceId, randomUUID());
    const theirs = appSecret(workspaceId, randomUUID());
    await store.put(mine, fakeToken());
    await store.put(theirs, fakeToken());
    const source = await rowOf(theirs);
    await db
      .update(secretValues)
      .set({ nonce: source.nonce, ciphertext: source.ciphertext })
      .where(eq(secretValues.id, (await rowOf(mine)).id));
    await expect(store.get(mine)).rejects.toBeInstanceOf(SecretDecryptError);
    expect(await store.get(theirs)).not.toBeNull();
  });

  test("another master key cannot read what this one wrote", async () => {
    const slot = configToken(await workspace());
    await createPostgresSecretStore(db, key).put(slot, fakeToken());
    const other = SecretKey.fromHex(randomBytes(32).toString("hex"), "OTHER");
    await expect(
      createPostgresSecretStore(db, other).get(slot),
    ).rejects.toBeInstanceOf(SecretDecryptError);
  });

  test("a person's set and delete each leave a receipt with purpose and last four only", async () => {
    const store = createPostgresSecretStore(db, key);
    const workspaceId = await workspace();
    const slot = configToken(workspaceId);
    const owner = await person(workspaceId, "owner");
    const value = fakeToken();
    const put = await store.put(slot, value, { audit: owner.audit });
    expect(put).toMatchObject({
      outcome: "stored",
      summary: {
        updatedBy: { userId: owner.userId, displayName: "owner person" },
      },
    });
    const admin = await person(workspaceId, "admin");
    expect(await store.delete(slot, { audit: admin.audit })).toEqual({
      outcome: "deleted",
      last4: value.slice(-4),
    });
    const written = await db
      .select()
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId));
    expect(
      written
        .map((receipt) => ({
          id: receipt.id,
          operation: receipt.operation,
          result: receipt.result,
          targetRef: receipt.targetRef,
        }))
        .sort((a, b) => a.operation.localeCompare(b.operation)),
    ).toEqual([
      {
        id: admin.audit.receiptId,
        operation: "delete_slack_secret",
        result: { purpose: "slack_config_token", last4: value.slice(-4) },
        targetRef: {
          resource: { kind: "workspace", id: workspaceId },
          workspace_id: workspaceId,
        },
      },
      {
        id: owner.audit.receiptId,
        operation: "set_slack_secret",
        result: { purpose: "slack_config_token", last4: value.slice(-4) },
        targetRef: {
          resource: { kind: "workspace", id: workspaceId },
          workspace_id: workspaceId,
        },
      },
    ]);
    expect(JSON.stringify(written)).not.toContain(value);
    expect(
      await store.delete(slot, {
        audit: { ...admin.audit, receiptId: randomUUID() },
      }),
    ).toEqual({ outcome: "not_found" });
  });

  test("a member, or a disabled manager, writes nothing", async () => {
    const store = createPostgresSecretStore(db, key);
    const workspaceId = await workspace();
    const slot = configToken(workspaceId);
    const member = await person(workspaceId, "member");
    expect(await store.put(slot, fakeToken(), { audit: member.audit })).toEqual(
      { outcome: "outranked" },
    );
    const owner = await person(workspaceId, "owner");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, owner.userId));
    expect(await store.put(slot, fakeToken(), { audit: owner.audit })).toEqual({
      outcome: "actor_inactive",
    });
    expect(await store.describe(slot)).toBeNull();
    expect(
      await db.select().from(receipts).where(eq(receipts.ownerId, workspaceId)),
    ).toEqual([]);
  });

  test("a workspace that does not exist is reported, not created", async () => {
    const store = createPostgresSecretStore(db, key);
    expect(await store.put(configToken(randomUUID()), fakeToken())).toEqual({
      outcome: "workspace_not_found",
    });
  });
});
