import {
  type SessionScope,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  Principal,
  WorkspaceKey,
  WorkspaceKeyStore,
} from "@werft-ai/platform";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { lockActorAccount, receiptActorOf } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { agents, apiKeys, memberships, receipts, users } from "../schema.ts";
import {
  decodeCreatedAtCursor,
  encodeCreatedAtCursor,
  rethrowCursorCastError,
} from "../sessions/cursors.ts";
import { administers } from "./administers.ts";
import { lockedAdministers } from "./agent-admins.ts";

// Keys issued from the web or the API (94S-574). Lock order: the actor's
// membership, then the agent, then the key, as the agent store takes them.

const liveMembership = (workspaceId: string, userId: string) =>
  and(
    eq(memberships.workspaceId, workspaceId),
    eq(memberships.userId, userId),
    isNull(memberships.disabledAt),
    isNull(users.disabledAt),
  );

// The issuer's role as it stands under the share lock, so a demotion that
// commits after the policy's decision either waits for this key or is seen.
export async function lockedRole(
  tx: Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  await lockActorAccount(tx, userId);
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(liveMembership(workspaceId, userId))
    .limit(1)
    .for("share", { of: memberships });
  return (row?.role as WorkspaceRole | undefined) ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const keyColumns = {
  id: apiKeys.id,
  workspaceId: apiKeys.workspaceId,
  kind: apiKeys.kind,
  name: apiKeys.name,
  agentId: apiKeys.agentId,
  createdByUserId: apiKeys.createdByUserId,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
  lastUsedAt: apiKeys.lastUsedAt,
};

// Aliased: the list's visibility subqueries join users themselves. Users are
// never deleted, so a disabled or departed issuer still has their name; only
// a key with no recorded issuer goes without.
const issuer = alias(users, "issuer");
const keyWithIssuerColumns = {
  ...keyColumns,
  createdByDisplayName: issuer.displayName,
};

function keyOf(
  row: {
    id: string;
    workspaceId: string | null;
    kind: string;
    name: string | null;
    agentId: string | null;
    createdByUserId: string | null;
    scopes: string[] | null;
    createdAt: Date;
    expiresAt: Date | null;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
  },
  createdByDisplayName: string | null,
): WorkspaceKey {
  if (row.workspaceId === null || row.kind === "operator") {
    throw new Error(`api key ${row.id} read outside a workspace`);
  }
  return {
    ...row,
    workspaceId: row.workspaceId,
    kind: row.kind as WorkspaceKey["kind"],
    scopes: (row.scopes ?? []) as SessionScope[],
    createdByDisplayName,
  };
}

// One of the roles that take the right, or, for a key bound to an agent, an
// admin of that agent; the admin row is share-locked like the membership.
export async function holdsRight(
  tx: Database,
  workspaceId: string,
  userId: string,
  need: {
    role: WorkspaceRole;
    roles: readonly WorkspaceRole[];
    agentId: string | null;
  },
): Promise<boolean> {
  if (need.roles.includes(need.role)) return true;
  if (need.agentId === null) return false;
  return lockedAdministers(tx, workspaceId, need.agentId, userId);
}

async function writeReceipt(
  tx: Database,
  principal: Principal,
  input: {
    id: string;
    operation: "create_api_key" | "revoke_api_key";
    key: WorkspaceKey;
  },
) {
  await tx.insert(receipts).values({
    id: input.id,
    ownerId: principal.ownerId,
    actor: receiptActorOf(principal),
    requestId: principal.requestId ?? null,
    operation: input.operation,
    targetRef: {
      resource: { kind: "api_key", id: input.key.id },
      workspace_id: input.key.workspaceId,
    },
    status: "succeeded",
    // What the key may do, never the key itself.
    result: {
      kind: input.key.kind,
      name: input.key.name,
      agent_id: input.key.agentId,
      scopes: input.key.scopes,
    },
  });
}

export function createPostgresWorkspaceKeyStore(
  db: Database,
): WorkspaceKeyStore {
  async function find(
    tx: Database,
    workspaceId: string,
    keyId: string,
    lock: boolean,
  ): Promise<WorkspaceKey | null> {
    if (!UUID.test(keyId)) return null;
    const query = tx
      .select(keyWithIssuerColumns)
      .from(apiKeys)
      .leftJoin(issuer, eq(issuer.id, apiKeys.createdByUserId))
      .where(
        and(
          eq(apiKeys.id, keyId.toLowerCase()),
          eq(apiKeys.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    const [row] = await (lock ? query.for("update", { of: apiKeys }) : query);
    return row ? keyOf(row, row.createdByDisplayName) : null;
  }

  return {
    issue(input) {
      return db.transaction(async (tx) => {
        const role = await lockedRole(
          tx,
          input.workspaceId,
          input.createdByUserId,
        );
        if (role === null) return { outcome: "actor_inactive" };
        const [creator] = await tx
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, input.createdByUserId));
        if (!creator) throw new Error("a locked issuer has no users row");
        if (input.agentId !== null) {
          const [agent] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.id, input.agentId),
                eq(agents.workspaceId, input.workspaceId),
              ),
            )
            .limit(1)
            .for("key share");
          if (!agent) return { outcome: "agent_not_found" };
        }
        if (
          !(await holdsRight(tx, input.workspaceId, input.createdByUserId, {
            role,
            roles: input.issuerRoles,
            agentId: input.agentId,
          }))
        ) {
          return { outcome: "outranked" };
        }
        const ceiling = new Set(scopesForRole(role));
        if (input.scopes.some((scope) => !ceiling.has(scope))) {
          return { outcome: "scope_not_grantable" };
        }
        const [row] = await tx
          .insert(apiKeys)
          .values({
            id: input.id,
            keyHash: input.keyHash,
            ownerId: input.workspaceId,
            workspaceId: input.workspaceId,
            scopes: [...input.scopes],
            kind: input.kind,
            name: input.name,
            agentId: input.agentId,
            createdByUserId: input.createdByUserId,
            expiresAt: input.expiresAt,
          })
          .returning(keyColumns);
        if (!row) throw new Error("api key insert returned no row");
        const key = keyOf(row, creator.displayName);
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "create_api_key",
          key,
        });
        return { outcome: "issued", key };
      });
    },

    find: (workspaceId, keyId) => find(db, workspaceId, keyId, false),

    async list(workspaceId, filter, query) {
      const cursor = query.cursor ? decodeCreatedAtCursor(query.cursor) : null;
      const own = and(
        eq(apiKeys.kind, "personal"),
        eq(apiKeys.createdByUserId, filter.personalOf),
      );
      // Read in the same statement as the keys: the caller's role may have
      // changed since they signed in.
      const seesEveryAgentKey = exists(
        db
          .select({ userId: memberships.userId })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              liveMembership(workspaceId, filter.personalOf),
              inArray(memberships.role, [...filter.allAgentKeysFor]),
            ),
          ),
      );
      const administered = and(
        isNotNull(apiKeys.agentId),
        administers(db, workspaceId, filter.personalOf, apiKeys.agentId),
      );
      const agentKey = and(
        eq(apiKeys.kind, "agent"),
        or(seesEveryAgentKey, administered),
      );
      const rows = await db
        .select({
          ...keyWithIssuerColumns,
          cursorAt: sql<string>`${apiKeys.createdAt}::text`,
        })
        .from(apiKeys)
        .leftJoin(issuer, eq(issuer.id, apiKeys.createdByUserId))
        .where(
          and(
            eq(apiKeys.workspaceId, workspaceId),
            or(own, agentKey),
            cursor
              ? sql`(${apiKeys.createdAt}, ${apiKeys.id}) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
        .limit(query.limit + 1)
        .catch(rethrowCursorCastError);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(({ cursorAt: _, ...row }) =>
          keyOf(row, row.createdByDisplayName),
        ),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCreatedAtCursor({ created_at: last.cursorAt, id: last.id })
            : null,
      };
    },

    revoke(input) {
      return db.transaction(async (tx) => {
        const userId = input.principal.actor?.userId;
        const role =
          userId === undefined || userId === null
            ? null
            : await lockedRole(tx, input.workspaceId, userId);
        if (role === null || !userId) return { outcome: "actor_inactive" };
        const key = await find(tx, input.workspaceId, input.keyId, true);
        if (!key) return { outcome: "not_found" };
        if (
          !(await holdsRight(tx, input.workspaceId, userId, {
            role,
            roles: input.revokerRoles,
            agentId: key.kind === "agent" ? key.agentId : null,
          }))
        ) {
          return { outcome: "outranked" };
        }
        if (key.revokedAt !== null) {
          return { outcome: "already_revoked", key };
        }
        const [row] = await tx
          .update(apiKeys)
          .set({ revokedAt: DB_NOW })
          .where(eq(apiKeys.id, key.id))
          .returning(keyColumns);
        if (!row) throw new Error(`api key ${key.id} vanished in its tx`);
        const revoked = keyOf(row, key.createdByDisplayName);
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "revoke_api_key",
          key: revoked,
        });
        return { outcome: "revoked", key: revoked };
      });
    },
  };
}
