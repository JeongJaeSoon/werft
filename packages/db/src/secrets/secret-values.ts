import { randomUUID } from "node:crypto";
import {
  isSettingsSecretOwner,
  lastFour,
  openSecret,
  type PutSecretResult,
  receiptActorOf,
  type SecretAadFields,
  type SecretAudit,
  type SecretKey,
  type SecretOwner,
  type SecretOwnerRef,
  type SecretSlot,
  type SecretStore,
  type SecretSummary,
  sealSecret,
  secretOwnerRef,
} from "@werft-ai/platform";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import { lockedRole } from "../musterrolle/api-keys.ts";
import type { Database } from "../queries.ts";
import { receipts, secretValues, users, workspaces } from "../schema.ts";

type Row = typeof secretValues.$inferSelect;

// Postgres returns uuids in lowercase and the AAD and lock key are built from
// the slot, so a slot named in another case would seal what it cannot open.
const canonical = (slot: SecretSlot): SecretSlot => ({
  ...slot,
  workspaceId: slot.workspaceId.toLowerCase(),
});

const bySlot = (slot: SecretSlot) =>
  and(
    eq(secretValues.workspaceId, slot.workspaceId),
    eq(secretValues.ownerRef, secretOwnerRef(slot.owner)),
    eq(secretValues.purpose, slot.purpose),
  );

function aadOf(row: {
  id: string;
  workspaceId: string;
  ownerRef: SecretOwnerRef;
  purpose: string;
  secretVersion: number;
  keyVersion: number;
}): SecretAadFields {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerRef: row.ownerRef,
    purpose: row.purpose,
    secretVersion: row.secretVersion,
    keyVersion: row.keyVersion,
  };
}

async function lockSlot(tx: Database, slot: SecretSlot): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`secret_values:${slot.workspaceId}:${secretOwnerRef(slot.owner)}:${slot.purpose}`}))`,
  );
}

async function lockedRow(
  tx: Database,
  slot: SecretSlot,
): Promise<Row | undefined> {
  await lockSlot(tx, slot);
  const [row] = await tx
    .select()
    .from(secretValues)
    .where(bySlot(slot))
    .for("update");
  return row;
}

export async function secretAuditRefusal(
  tx: Database,
  workspaceId: string,
  audit: SecretAudit,
): Promise<"actor_inactive" | "outranked" | null> {
  const userId = audit.principal.actor?.userId;
  if (!userId) return "actor_inactive";
  const role = await lockedRole(tx, workspaceId, userId);
  if (role === null) return "actor_inactive";
  return audit.roles.includes(role) ? null : "outranked";
}

export function secretReceiptRow(
  audit: SecretAudit,
  slot: SecretSlot,
  operation: "set_slack_secret" | "delete_slack_secret",
  last4: string,
) {
  return {
    id: audit.receiptId,
    ownerId: slot.workspaceId,
    actor: receiptActorOf(audit.principal),
    operation,
    targetRef: {
      resource: { kind: "workspace", id: slot.workspaceId },
      workspace_id: slot.workspaceId,
    },
    status: "succeeded" as const,
    result: { purpose: slot.purpose, last4 },
  };
}

const summaryColumns = {
  ownerRef: secretValues.ownerRef,
  purpose: secretValues.purpose,
  last4: secretValues.last4,
  secretVersion: secretValues.secretVersion,
  updatedAt: secretValues.updatedAt,
  updatedBy: secretValues.updatedBy,
  displayName: users.displayName,
};

async function summaryOf(
  db: Database,
  where: ReturnType<typeof bySlot>,
): Promise<SecretSummary | null> {
  const [row] = await db
    .select(summaryColumns)
    .from(secretValues)
    .leftJoin(users, eq(users.id, secretValues.updatedBy))
    .where(where);
  return row ? summaryFrom(row) : null;
}

function summaryFrom(row: {
  last4: string;
  secretVersion: number;
  updatedAt: Date;
  updatedBy: string | null;
  displayName: string | null;
}): SecretSummary {
  return {
    last4: row.last4,
    secretVersion: row.secretVersion,
    updatedAt: row.updatedAt,
    updatedBy:
      row.updatedBy === null || row.displayName === null
        ? null
        : { userId: row.updatedBy, displayName: row.displayName },
  };
}

function openRow(key: SecretKey, row: Row): string {
  return openSecret(key, aadOf(row), {
    nonce: Buffer.from(row.nonce),
    ciphertext: Buffer.from(row.ciphertext),
  });
}

export async function openSecretsOf(
  db: Database,
  key: SecretKey,
  workspaceId: string,
  purpose: SecretSlot["purpose"],
  ownerRefs: readonly SecretOwnerRef[],
): Promise<Map<string, string>> {
  if (ownerRefs.length === 0) return new Map();
  const rows = await db
    .select()
    .from(secretValues)
    .where(
      and(
        eq(secretValues.workspaceId, workspaceId.toLowerCase()),
        eq(secretValues.purpose, purpose),
        inArray(secretValues.ownerRef, [...ownerRefs]),
      ),
    );
  // A value that does not open (sealed under another key) is left out alone:
  // its owner reads as unset, and the rest still open.
  const opened = new Map<string, string>();
  for (const row of rows) {
    try {
      opened.set(row.ownerRef, openRow(key, row));
    } catch {}
  }
  return opened;
}

/**
 * Seals `value` into the slot inside the caller's transaction, so a store
 * that keeps more than the secret (a Slack app's row, the config token's
 * expiry) commits both together.
 */
export async function writeSecretInTx(
  tx: Database,
  key: SecretKey,
  named: SecretSlot,
  value: string,
  /** Left out: whoever set the value before stays its setter. */
  updatedBy?: string | null,
): Promise<void> {
  const slot = canonical(named);
  const current = await lockedRow(tx, slot);
  await write(
    tx,
    key,
    slot,
    current,
    value,
    updatedBy === undefined ? (current?.updatedBy ?? null) : updatedBy,
  );
}

/** The value in the slot, read under the slot's lock; null when unset. */
export async function readSecretInTx(
  tx: Database,
  key: SecretKey,
  named: SecretSlot,
): Promise<string | null> {
  const row = await lockedRow(tx, canonical(named));
  return row ? openRow(key, row) : null;
}

/** Drops the slot's value; the last four characters it had, or null. */
export async function deleteSecretInTx(
  tx: Database,
  named: SecretSlot,
): Promise<string | null> {
  const slot = canonical(named);
  await lockSlot(tx, slot);
  const [deleted] = await tx
    .delete(secretValues)
    .where(bySlot(slot))
    .returning({ last4: secretValues.last4 });
  return deleted?.last4 ?? null;
}

export function describeSecret(
  db: Database,
  slot: SecretSlot,
): Promise<SecretSummary | null> {
  return summaryOf(db, bySlot(canonical(slot)));
}

/**
 * describeSecret for every purpose of many owners in one statement, keyed
 * by secretSummaryKey. A slot with no secret has no entry.
 */
export async function describeSecrets(
  db: Database,
  workspaceId: string,
  owners: readonly SecretOwner[],
): Promise<Map<string, SecretSummary>> {
  if (owners.length === 0) return new Map();
  const rows = await db
    .select(summaryColumns)
    .from(secretValues)
    .leftJoin(users, eq(users.id, secretValues.updatedBy))
    .where(
      and(
        eq(secretValues.workspaceId, workspaceId.toLowerCase()),
        inArray(
          secretValues.ownerRef,
          owners.map((owner) => secretOwnerRef(workspaceOwner(owner))),
        ),
      ),
    );
  return new Map(
    rows.map((row) => [
      secretSummaryKey(row.ownerRef, row.purpose),
      summaryFrom(row),
    ]),
  );
}

export const secretSummaryKey = (ownerRef: string, purpose: string): string =>
  `${ownerRef}/${purpose}`;

async function write(
  tx: Database,
  key: SecretKey,
  slot: SecretSlot,
  current: Row | undefined,
  value: string,
  updatedBy: string | null,
): Promise<void> {
  const fields = aadOf({
    id: current?.id ?? randomUUID(),
    workspaceId: slot.workspaceId,
    ownerRef: secretOwnerRef(slot.owner),
    purpose: slot.purpose,
    secretVersion: (current?.secretVersion ?? 0) + 1,
    keyVersion: key.version,
  });
  const sealed = sealSecret(key, fields, value);
  const columns = {
    secretVersion: fields.secretVersion,
    keyVersion: fields.keyVersion,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    last4: lastFour(value),
    updatedBy,
    updatedAt: DB_NOW,
  };
  if (current) {
    await tx
      .update(secretValues)
      .set(columns)
      .where(eq(secretValues.id, current.id));
  } else {
    await tx.insert(secretValues).values({
      id: fields.id,
      workspaceId: fields.workspaceId,
      ownerRef: fields.ownerRef,
      purpose: fields.purpose,
      ...columns,
    });
  }
}

// Checked at runtime too: a slot built from request data must not reach an
// installation setting's credential through a workspace route.
function workspaceOwner(owner: SecretOwner): SecretOwner {
  if (isSettingsSecretOwner(owner)) {
    throw new Error(
      `secret owner ${owner.kind} belongs to the installation's settings, not a workspace`,
    );
  }
  return owner;
}

const workspaceSlot = (slot: SecretSlot): SecretSlot => {
  workspaceOwner(slot.owner);
  return canonical(slot);
};

/** A workspace's own slots only: an installation settings owner is refused. */
export function createPostgresSecretStore(
  db: Database,
  key: SecretKey,
): SecretStore {
  return {
    describe: async (slot) => describeSecret(db, workspaceSlot(slot)),

    async get(slot) {
      const [row] = await db
        .select()
        .from(secretValues)
        .where(bySlot(workspaceSlot(slot)));
      return row ? openRow(key, row) : null;
    },

    async put(named, value, options) {
      const slot = workspaceSlot(named);
      return db.transaction(async (tx): Promise<PutSecretResult> => {
        const audit = options?.audit;
        if (audit) {
          const refused = await secretAuditRefusal(tx, slot.workspaceId, audit);
          if (refused) return { outcome: refused };
        }
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, slot.workspaceId));
        if (!workspace) return { outcome: "workspace_not_found" };
        const current = await lockedRow(tx, slot);
        await write(
          tx,
          key,
          slot,
          current,
          value,
          audit?.principal.actor?.userId ?? null,
        );
        if (audit) {
          await tx
            .insert(receipts)
            .values(
              secretReceiptRow(
                audit,
                slot,
                "set_slack_secret",
                lastFour(value),
              ),
            );
        }
        const summary = await summaryOf(tx, bySlot(slot));
        if (!summary) throw new Error("secret write returned no row");
        return { outcome: "stored", summary };
      });
    },

    async delete(named, options) {
      const slot = workspaceSlot(named);
      return db.transaction(async (tx) => {
        const audit = options?.audit;
        if (audit) {
          const refused = await secretAuditRefusal(tx, slot.workspaceId, audit);
          if (refused) return { outcome: refused };
        }
        await lockSlot(tx, slot);
        const [deleted] = await tx
          .delete(secretValues)
          .where(bySlot(slot))
          .returning({ last4: secretValues.last4 });
        if (!deleted) return { outcome: "not_found" };
        if (audit) {
          await tx
            .insert(receipts)
            .values(
              secretReceiptRow(
                audit,
                slot,
                "delete_slack_secret",
                deleted.last4,
              ),
            );
        }
        return { outcome: "deleted", last4: deleted.last4 };
      });
    },
  };
}
