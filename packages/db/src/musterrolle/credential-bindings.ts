import { randomUUID } from "node:crypto";
import type { ReceiptActor } from "@werft-ai/contracts";
import type {
  AgentContact,
  CredentialBinding,
  CredentialBindingStore,
  Principal,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { receiptActorOf } from "../control-shared.ts";
import { rowsOf } from "../control-unit-of-work.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentAdmins,
  agentReleases,
  agents,
  credentialBindings,
  memberships,
  receipts,
  users,
} from "../schema.ts";
import { holdsRight, lockedRole } from "./api-keys.ts";

// Bindings made from the web or the API (94S-581). Lock order follows the
// key store: the actor's membership, the agent, then the credential name.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Written out with aliases: inside a select list drizzle renders a column
// without its table, which is ambiguous once the subquery joins.
const CARD_REFS_TEXT = `v.card -> 'capabilities' -> 'credential_refs'`;

// The names a session needs: the snapshot it started with when it has one,
// else its release's card. `s` is the session, `v` its release's version.
const SESSION_REFS = sql.raw(
  `CASE WHEN jsonb_typeof(s.mcp_start -> 'credential_refs') = 'array' THEN s.mcp_start -> 'credential_refs' ELSE ${CARD_REFS_TEXT} END`,
);

// The names an agent needs for a session it starts or an activation: its
// settings when it has a row, else the release's card. `m` is the row.
const CURRENT_REFS = sql.raw(
  `CASE WHEN m.agent_id IS NOT NULL THEN m.credential_refs ELSE ${CARD_REFS_TEXT} END`,
);

// Sessions on this agent's releases whose card names the credential and
// that can still take a turn: until they close they keep what they started
// with (D11).
function runningSessions(workspaceId: string, agentId: SQL, ref: SQL) {
  return sql<number>`(
    SELECT count(*)::int FROM sessions s
    JOIN agent_releases r ON r.id = s.agent_release_id
    JOIN agent_versions v ON v.id = r.version_id
    WHERE s.owner_id = ${workspaceId}
      AND r.agent_id = ${agentId}
      AND s.admission_state <> 'closed'
      AND jsonb_typeof(${SESSION_REFS}) = 'array'
      AND ${SESSION_REFS} ? ${ref}
  )`;
}

const bindingColumns = (workspaceId: string) => ({
  id: credentialBindings.id,
  agentId: credentialBindings.targetId,
  credentialRef: credentialBindings.credentialRef,
  boundBy: credentialBindings.boundBy,
  boundAt: credentialBindings.boundAt,
  revokedAt: credentialBindings.revokedAt,
  runningSessions: runningSessions(
    workspaceId,
    sql.raw(`"credential_bindings"."target_id"`),
    sql.raw(`"credential_bindings"."credential_ref"`),
  ),
});

const liveOnAgent = (workspaceId: string, agentId: string) =>
  and(
    eq(credentialBindings.workspaceId, workspaceId),
    eq(credentialBindings.target, "agent"),
    eq(credentialBindings.targetId, agentId),
    isNull(credentialBindings.revokedAt),
  );

// The key the 0143 trigger takes, so the store's checks and the trigger's
// see the same writers of one name in one workspace.
async function lockRef(tx: Database, workspaceId: string, ref: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`credential_bindings:${workspaceId}:${ref}`}, 0))`,
  );
}

export type CredentialBindingTarget = "agent" | "agent_identity";

/**
 * Binds a name to a target inside the caller's transaction, for any writer
 * of bindings (an agent identity's link too). A name an agent identity holds
 * is that identity's alone; the 0143 trigger refuses the same, this answers
 * it as an outcome instead of an error.
 */
export async function bindCredentialRef(
  tx: Database,
  input: {
    id: string;
    workspaceId: string;
    credentialRef: string;
    target: CredentialBindingTarget;
    targetId: string;
    boundBy: string;
  },
): Promise<
  { outcome: "bound" | "already_bound"; id: string } | { outcome: "ref_in_use" }
> {
  await lockRef(tx, input.workspaceId, input.credentialRef);
  const live = await tx
    .select({
      id: credentialBindings.id,
      target: credentialBindings.target,
      targetId: credentialBindings.targetId,
    })
    .from(credentialBindings)
    .where(
      and(
        eq(credentialBindings.workspaceId, input.workspaceId),
        eq(credentialBindings.credentialRef, input.credentialRef),
        isNull(credentialBindings.revokedAt),
      ),
    );
  const targetId = input.targetId.toLowerCase();
  const same = live.find(
    (row) => row.target === input.target && row.targetId === targetId,
  );
  if (same) return { outcome: "already_bound", id: same.id };
  if (
    live.some(
      (row) =>
        row.target === "agent_identity" || input.target === "agent_identity",
    )
  ) {
    return { outcome: "ref_in_use" };
  }
  await tx.insert(credentialBindings).values({
    id: input.id,
    workspaceId: input.workspaceId,
    credentialRef: input.credentialRef,
    target: input.target,
    targetId,
    boundBy: input.boundBy,
  });
  return { outcome: "bound", id: input.id };
}

/** Revokes every live binding of one target, e.g. a revoked agent identity's. */
export async function releaseCredentialRefs(
  tx: Database,
  input: {
    workspaceId: string;
    target: CredentialBindingTarget;
    targetId: string;
  },
): Promise<string[]> {
  const rows = await tx
    .update(credentialBindings)
    .set({ revokedAt: DB_NOW })
    .where(
      and(
        eq(credentialBindings.workspaceId, input.workspaceId),
        eq(credentialBindings.target, input.target),
        eq(credentialBindings.targetId, input.targetId.toLowerCase()),
        isNull(credentialBindings.revokedAt),
      ),
    )
    .returning({ credentialRef: credentialBindings.credentialRef });
  return rows.map((row) => row.credentialRef).sort();
}

async function writeReceipt(
  tx: Database,
  principal: Principal,
  input: {
    id: string;
    operation: "bind_credential" | "unbind_credential";
    binding: CredentialBinding;
  },
) {
  await tx.insert(receipts).values({
    id: input.id,
    ownerId: principal.ownerId,
    actor: receiptActorOf(principal),
    requestId: principal.requestId ?? null,
    operation: input.operation,
    targetRef: {
      resource: { kind: "agent", id: input.binding.agentId },
      workspace_id: principal.ownerId,
    },
    status: "succeeded",
    result: { credential_ref: input.binding.credentialRef },
  });
}

// With a session the names are that session's own (`SESSION_REFS`), so a name
// the settings gained since it started does not stop its next message; without
// one they are the agent's current need (`CURRENT_REFS`), for activating a
// release or starting a session.
async function unboundRefsOn(
  executor: Database,
  workspaceId: string,
  releaseId: string,
  sessionId: string | null = null,
  names: readonly string[] | null = null,
  fromRelease = false,
): Promise<string[]> {
  const needed = fromRelease
    ? sql.raw(CARD_REFS_TEXT)
    : sessionId === null
      ? CURRENT_REFS
      : SESSION_REFS;
  const list =
    names === null
      ? sql`CASE WHEN jsonb_typeof(${needed}) = 'array' THEN ${needed} ELSE '[]'::jsonb END`
      : sql`${JSON.stringify(names)}::jsonb`;
  const result = await executor.execute<{ ref: string }>(sql`
    SELECT DISTINCT ref FROM agent_releases r
    JOIN agents a ON a.id = r.agent_id AND a.workspace_id = ${workspaceId}
    JOIN agent_versions v ON v.id = r.version_id
    LEFT JOIN agent_mcp_settings m ON m.agent_id = r.agent_id AND m.workspace_id = a.workspace_id
    LEFT JOIN sessions s ON s.id = ${sessionId}
    CROSS JOIN LATERAL jsonb_array_elements_text(${list}) AS ref
    WHERE r.id = ${releaseId}
      AND NOT EXISTS (
        SELECT 1 FROM credential_bindings b
        WHERE b.workspace_id = ${workspaceId}
          AND b.target = 'agent'
          AND b.target_id = r.agent_id
          AND b.credential_ref = ref
          AND b.revoked_at IS NULL
      )
    ORDER BY ref`);
  return rowsOf<{ ref: string }>(result).map((row) => row.ref);
}

/**
 * The release's unbound names, read inside a session's acceptance: the
 * agent's live bindings stay share-locked until it commits, so an unbind
 * either waits and then counts the new session as running, or committed
 * first and is seen here.
 */
export async function lockUnboundRefs(
  tx: Database,
  input: {
    workspaceId: string;
    releaseId: string;
    sessionId?: string;
    /** The names of a snapshot the caller already holds locked: judged as given. */
    names?: readonly string[];
    /** The session will follow its release: judge the release card's names, whatever a row says now. */
    fromRelease?: true;
  },
): Promise<string[]> {
  await tx.execute(sql`
    SELECT 1 FROM credential_bindings b
    JOIN agent_releases r ON r.agent_id = b.target_id
    WHERE r.id = ${input.releaseId}
      AND b.workspace_id = ${input.workspaceId}
      AND b.target = 'agent'
      AND b.revoked_at IS NULL
    FOR SHARE OF b`);
  return unboundRefsOn(
    tx,
    input.workspaceId,
    input.releaseId,
    input.sessionId ?? null,
    input.names ?? null,
    input.fromRelease === true,
  );
}

/**
 * The failed receipt of an input refused because the release lost a
 * binding: on the agent for a session that never started, on the session
 * for a message it was refused. No credential name: the requester reading
 * it is told whom to ask, not what is missing.
 */
export async function recordUnboundRefusal(
  tx: Database,
  input: {
    ownerId: string;
    actor: ReceiptActor | null;
    requestId: string | null;
    operation: "create_session" | "append_message";
    releaseId: string;
    sessionId: string | null;
  },
): Promise<{ agentId: string; receiptId: string }> {
  const [release] = await tx
    .select({ agentId: agentReleases.agentId })
    .from(agentReleases)
    .where(eq(agentReleases.id, input.releaseId))
    .limit(1);
  if (!release) throw new Error("A refused input names no stored release");
  const receiptId = randomUUID();
  await tx.insert(receipts).values({
    id: receiptId,
    ownerId: input.ownerId,
    actor: input.actor,
    requestId: input.requestId,
    operation: input.operation,
    targetRef:
      input.sessionId === null
        ? {
            resource: { kind: "agent", id: release.agentId },
            workspace_id: input.ownerId,
          }
        : { session_id: input.sessionId, turn_id: null, request_id: null },
    status: "failed",
    result: { agent_id: release.agentId, release_id: input.releaseId },
    error: {
      code: "CREDENTIAL_UNBOUND",
      message:
        "A credential this agent's release uses is no longer bound to the agent",
    },
  });
  return { agentId: release.agentId, receiptId };
}

export function createPostgresCredentialBindingStore(
  db: Database,
): CredentialBindingStore {
  async function agentExists(
    tx: Database,
    workspaceId: string,
    agentId: string,
  ): Promise<boolean> {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
      .limit(1)
      .for("key share");
    return agent !== undefined;
  }

  return {
    bind(input) {
      if (!UUID.test(input.agentId)) {
        return Promise.resolve({ outcome: "agent_not_found" });
      }
      const agentId = input.agentId.toLowerCase();
      return db.transaction(async (tx) => {
        const role = await lockedRole(tx, input.workspaceId, input.boundBy);
        if (role === null) return { outcome: "actor_inactive" };
        if (!(await agentExists(tx, input.workspaceId, agentId))) {
          return { outcome: "agent_not_found" };
        }
        if (
          !(await holdsRight(tx, input.workspaceId, input.boundBy, {
            role,
            roles: input.binderRoles,
            agentId,
          }))
        ) {
          return { outcome: "outranked" };
        }
        const written = await bindCredentialRef(tx, {
          id: input.id,
          workspaceId: input.workspaceId,
          credentialRef: input.credentialRef,
          target: "agent",
          targetId: agentId,
          boundBy: input.boundBy,
        });
        if (written.outcome === "ref_in_use") return written;
        const [binding] = await tx
          .select(bindingColumns(input.workspaceId))
          .from(credentialBindings)
          .where(eq(credentialBindings.id, written.id));
        if (!binding) throw new Error("credential binding vanished in its tx");
        if (written.outcome === "already_bound") {
          return { outcome: "already_bound", binding };
        }
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "bind_credential",
          binding,
        });
        return { outcome: "bound", binding };
      });
    },

    revoke(input) {
      if (!UUID.test(input.agentId) || !UUID.test(input.bindingId)) {
        return Promise.resolve({ outcome: "not_found" });
      }
      const agentId = input.agentId.toLowerCase();
      return db.transaction(async (tx) => {
        const userId = input.principal.actor?.userId;
        const role = userId
          ? await lockedRole(tx, input.workspaceId, userId)
          : null;
        if (role === null || !userId) return { outcome: "actor_inactive" };
        if (!(await agentExists(tx, input.workspaceId, agentId))) {
          return { outcome: "not_found" };
        }
        if (
          !(await holdsRight(tx, input.workspaceId, userId, {
            role,
            roles: input.revokerRoles,
            agentId,
          }))
        ) {
          return { outcome: "outranked" };
        }
        const [revoked] = await tx
          .update(credentialBindings)
          .set({ revokedAt: DB_NOW })
          .where(
            and(
              liveOnAgent(input.workspaceId, agentId),
              eq(credentialBindings.id, input.bindingId.toLowerCase()),
            ),
          )
          .returning({ id: credentialBindings.id });
        if (!revoked) return { outcome: "not_found" };
        const [binding] = await tx
          .select(bindingColumns(input.workspaceId))
          .from(credentialBindings)
          .where(eq(credentialBindings.id, revoked.id));
        if (!binding) throw new Error("credential binding vanished in its tx");
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "unbind_credential",
          binding,
        });
        return { outcome: "revoked", binding };
      });
    },

    async list(workspaceId, agentId) {
      if (!UUID.test(agentId)) return null;
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, agentId.toLowerCase()),
            eq(agents.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!agent) return null;
      return db
        .select(bindingColumns(workspaceId))
        .from(credentialBindings)
        .where(liveOnAgent(workspaceId, agentId.toLowerCase()))
        .orderBy(asc(credentialBindings.credentialRef));
    },

    unboundRefs(workspaceId, releaseId) {
      return unboundRefsOn(db, workspaceId, releaseId);
    },

    async contacts(workspaceId, agentId) {
      if (!UUID.test(agentId)) return [];
      const live = and(
        eq(memberships.workspaceId, workspaceId),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      );
      const columns = {
        userId: users.id,
        displayName: users.displayName,
        email: users.email,
      };
      const admins: AgentContact[] = await db
        .select(columns)
        .from(agentAdmins)
        .innerJoin(users, eq(users.id, agentAdmins.userId))
        .innerJoin(
          memberships,
          and(
            eq(memberships.workspaceId, agentAdmins.workspaceId),
            eq(memberships.userId, agentAdmins.userId),
          ),
        )
        .where(
          and(
            live,
            eq(agentAdmins.workspaceId, workspaceId),
            eq(agentAdmins.agentId, agentId.toLowerCase()),
          ),
        )
        .orderBy(asc(users.email));
      if (admins.length > 0) return admins;
      return db
        .select(columns)
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(live, inArray(memberships.role, ["owner", "admin"])))
        .orderBy(asc(users.email));
    },
  };
}
