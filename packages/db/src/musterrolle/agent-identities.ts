import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@werft-ai/contracts";
import type {
  AgentIdentityRecord,
  AgentIdentityStore,
  LinkAgentIdentityResult,
  Principal,
  RevokeAgentIdentityResult,
  SlackEventAgent,
  SlackEventKey,
} from "@werft-ai/platform";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { receiptActorOf } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentIdentities,
  agents,
  receipts,
  slackInstallations,
  surfaceBindings,
} from "../schema.ts";
import { holdsRight, lockedRole } from "./api-keys.ts";
import {
  bindCredentialRef,
  releaseCredentialRefs,
} from "./credential-bindings.ts";

// Lock order: the actor's membership, the agent, the install, the identity
// rows, the agent's surface bindings, then the credential name, as the api
// key, surface binding and credential binding stores take theirs.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const columns = {
  id: agentIdentities.id,
  workspaceId: agentIdentities.workspaceId,
  agentId: agentIdentities.agentId,
  provider: agentIdentities.provider,
  installationId: agentIdentities.installationId,
  appId: slackInstallations.appId,
  teamId: slackInstallations.teamId,
  externalPrincipalId: agentIdentities.externalPrincipalId,
  credentialRef: agentIdentities.credentialRef,
  status: agentIdentities.status,
  revision: agentIdentities.revision,
  createdBy: agentIdentities.createdBy,
  createdAt: agentIdentities.createdAt,
  revokedAt: agentIdentities.revokedAt,
};

async function findIdentity(
  tx: Database,
  where: ReturnType<typeof and>,
  lock: boolean,
): Promise<AgentIdentityRecord | null> {
  const query = tx
    .select(columns)
    .from(agentIdentities)
    .innerJoin(
      slackInstallations,
      eq(slackInstallations.id, agentIdentities.installationId),
    )
    .where(where)
    .limit(1);
  const [row] = await (lock
    ? query.for("update", { of: agentIdentities })
    : query);
  return row ?? null;
}

async function writeReceipt(
  tx: Database,
  principal: Principal,
  operation: "link_agent_identity" | "revoke_agent_identity",
  identity: AgentIdentityRecord,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: identity.workspaceId,
    actor: receiptActorOf(principal),
    requestId: principal.requestId ?? null,
    operation,
    targetRef: {
      resource: { kind: "agent", id: identity.agentId },
      workspace_id: identity.workspaceId,
    },
    status: "succeeded",
    // The token's name, never a value: the row holds none.
    result: {
      agent_identity_id: identity.id,
      provider: identity.provider,
      app_id: identity.appId,
      team_id: identity.teamId,
      bot_user_id: identity.externalPrincipalId,
      credential_ref: identity.credentialRef,
      revision: identity.revision,
    },
  });
  return id;
}

// The caller's role and right as they stand under the share locks, so a
// demotion committed after the policy's decision is seen here.
export async function callerHoldsRight(
  tx: Database,
  principal: Principal,
  workspaceId: string,
  agentId: string,
  managerRoles: readonly WorkspaceRole[],
): Promise<{ userId: string } | { outcome: "actor_inactive" | "outranked" }> {
  const userId = principal.actor?.userId;
  if (!userId) return { outcome: "actor_inactive" };
  const role = await lockedRole(tx, workspaceId, userId);
  if (role === null) return { outcome: "actor_inactive" };
  return (await holdsRight(tx, workspaceId, userId, {
    role,
    roles: managerRoles,
    agentId,
  }))
    ? { userId }
    : { outcome: "outranked" };
}

async function link(
  db: Database,
  input: Parameters<AgentIdentityStore["link"]>[0],
): Promise<LinkAgentIdentityResult> {
  const { workspaceId } = input;
  if (!UUID.test(input.agentId)) return { outcome: "agent_not_found" };
  const agentId = input.agentId.toLowerCase();
  return db.transaction(async (tx) => {
    const right = await callerHoldsRight(
      tx,
      input.principal,
      workspaceId,
      agentId,
      input.managerRoles,
    );
    if ("outcome" in right) return right;
    const { userId } = right;
    const [agent] = await tx
      .select({ status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
      .limit(1)
      .for("key share");
    if (!agent || agent.status === "archived") {
      return { outcome: "agent_not_found" };
    }
    // Every link to one install queues here, and a revoke or re-verify of
    // the install waits for this one to commit.
    const [installation] = await tx
      .select({
        id: slackInstallations.id,
        status: slackInstallations.status,
        botUserId: slackInstallations.botUserId,
      })
      .from(slackInstallations)
      .where(
        and(
          eq(slackInstallations.appId, input.key.appId),
          eq(slackInstallations.teamId, input.key.teamId),
          eq(slackInstallations.workspaceId, workspaceId),
        ),
      )
      .for("update");
    if (
      !installation ||
      installation.status !== "verified" ||
      installation.botUserId === null
    ) {
      return { outcome: "not_installed" };
    }
    const holder = await findIdentity(
      tx,
      and(
        eq(agentIdentities.installationId, installation.id),
        eq(agentIdentities.status, "active"),
      ),
      true,
    );
    if (holder) {
      return holder.agentId === agentId
        ? { outcome: "exists", identity: holder }
        : { outcome: "taken" };
    }
    const id = randomUUID();
    // The bot token's name is this identity's alone: no agent may be bound
    // to it, nor another identity (94S-581).
    const bound = await bindCredentialRef(tx, {
      id: randomUUID(),
      workspaceId,
      credentialRef: input.credentialRef,
      target: "agent_identity",
      targetId: id,
      boundBy: userId,
    });
    if (bound.outcome === "ref_in_use") {
      return { outcome: "credential_ref_in_use" };
    }
    await tx.insert(agentIdentities).values({
      id,
      workspaceId,
      agentId,
      provider: "slack_bot",
      installationId: installation.id,
      externalPrincipalId: installation.botUserId,
      credentialRef: input.credentialRef,
      createdBy: userId,
      createdAt: DB_NOW,
    });
    const identity = await findIdentity(tx, eq(agentIdentities.id, id), false);
    if (!identity) throw new Error(`agent identity ${id} vanished in its tx`);
    const receiptId = await writeReceipt(
      tx,
      input.principal,
      "link_agent_identity",
      identity,
    );
    return { outcome: "linked", identity, receiptId };
  });
}

async function revokeIdentityRow(
  tx: Database,
  identity: Pick<
    AgentIdentityRecord,
    "id" | "workspaceId" | "agentId" | "installationId"
  >,
  revokedBy: string | null,
): Promise<void> {
  await tx
    .update(agentIdentities)
    .set({
      status: "revoked",
      revokedAt: DB_NOW,
      revokedBy,
      revision: sql`${agentIdentities.revision} + 1`,
    })
    .where(eq(agentIdentities.id, identity.id));
  // The agent's channels in that install go with it: the next agent the
  // install is linked to starts from none, and cannot write these.
  await tx
    .update(surfaceBindings)
    .set({
      status: "revoked",
      home: false,
      revokedAt: DB_NOW,
      updatedAt: DB_NOW,
      revision: sql`${surfaceBindings.revision} + 1`,
    })
    .where(
      and(
        eq(surfaceBindings.agentId, identity.agentId),
        eq(surfaceBindings.installationId, identity.installationId),
        isNull(surfaceBindings.revokedAt),
      ),
    );
  await releaseCredentialRefs(tx, {
    workspaceId: identity.workspaceId,
    target: "agent_identity",
    targetId: identity.id,
  });
}

/**
 * Revokes the install's active identity when Slack took the install away,
 * with no person acting. The caller holds the install row's lock. Nothing
 * is active on a repeat, so a repeat changes nothing.
 */
export async function revokeInstallationIdentities(
  tx: Database,
  installationId: string,
): Promise<void> {
  const active = await tx
    .select({
      id: agentIdentities.id,
      workspaceId: agentIdentities.workspaceId,
      agentId: agentIdentities.agentId,
      installationId: agentIdentities.installationId,
    })
    .from(agentIdentities)
    .where(
      and(
        eq(agentIdentities.installationId, installationId),
        eq(agentIdentities.status, "active"),
      ),
    )
    .for("update");
  for (const identity of active) await revokeIdentityRow(tx, identity, null);
}

async function revoke(
  db: Database,
  input: Parameters<AgentIdentityStore["revoke"]>[0],
): Promise<RevokeAgentIdentityResult> {
  const { workspaceId } = input;
  if (!UUID.test(input.agentId) || !UUID.test(input.identityId)) {
    return { outcome: "not_found" };
  }
  const agentId = input.agentId.toLowerCase();
  return db.transaction(async (tx) => {
    const right = await callerHoldsRight(
      tx,
      input.principal,
      workspaceId,
      agentId,
      input.managerRoles,
    );
    if ("outcome" in right) return right;
    const current = await findIdentity(
      tx,
      and(
        eq(agentIdentities.id, input.identityId.toLowerCase()),
        eq(agentIdentities.agentId, agentId),
        eq(agentIdentities.workspaceId, workspaceId),
      ),
      true,
    );
    if (!current) return { outcome: "not_found" };
    if (current.status === "revoked") {
      return { outcome: "already_revoked", identity: current };
    }
    await revokeIdentityRow(tx, current, right.userId);
    const identity = await findIdentity(
      tx,
      eq(agentIdentities.id, current.id),
      false,
    );
    if (!identity) throw new Error(`agent identity ${current.id} vanished`);
    const receiptId = await writeReceipt(
      tx,
      input.principal,
      "revoke_agent_identity",
      identity,
    );
    return { outcome: "revoked", identity, receiptId };
  });
}

/**
 * The agent a Slack event's app and team name now (design A.7): the
 * install, its active identity and the agent, read in one statement so a
 * revoke committing between reads cannot pair a revoked install with a live
 * identity. An event that waited in the inbox while its identity or install
 * was revoked resolves to a drop.
 */
export async function resolveSlackEventAgent(
  db: Database,
  key: SlackEventKey,
): Promise<SlackEventAgent> {
  // (app_id, team_id) is unique, so every joined row is that install's.
  const [row] = await db
    .select({
      installationId: slackInstallations.id,
      workspaceId: slackInstallations.workspaceId,
      installationStatus: slackInstallations.status,
      botUserId: slackInstallations.botUserId,
      identityId: agentIdentities.id,
      identityStatus: agentIdentities.status,
      agentId: agentIdentities.agentId,
      revision: agentIdentities.revision,
      externalPrincipalId: agentIdentities.externalPrincipalId,
      credentialRef: agentIdentities.credentialRef,
      agentStatus: agents.status,
    })
    .from(slackInstallations)
    .leftJoin(
      agentIdentities,
      eq(agentIdentities.installationId, slackInstallations.id),
    )
    .leftJoin(agents, eq(agents.id, agentIdentities.agentId))
    .where(
      and(
        eq(slackInstallations.appId, key.appId),
        eq(slackInstallations.teamId, key.teamId),
      ),
    )
    // The active row if there is one, else the latest revoked.
    .orderBy(
      sql`${agentIdentities.status} = 'active' DESC NULLS LAST`,
      desc(agentIdentities.createdAt),
    )
    .limit(1);
  if (!row) return { status: "dropped", reason: "not_installed" };
  if (row.installationStatus === "revoked") {
    return { status: "dropped", reason: "installation_revoked" };
  }
  if (row.installationStatus !== "verified") {
    return { status: "dropped", reason: "installation_unverified" };
  }
  if (
    row.identityId === null ||
    row.agentId === null ||
    row.revision === null ||
    row.externalPrincipalId === null ||
    row.credentialRef === null
  ) {
    return { status: "dropped", reason: "unidentified" };
  }
  if (row.identityStatus !== "active") {
    return { status: "dropped", reason: "identity_revoked" };
  }
  if (row.externalPrincipalId !== row.botUserId) {
    return { status: "dropped", reason: "bot_mismatch" };
  }
  if (row.agentStatus === "archived") {
    return { status: "dropped", reason: "agent_archived" };
  }
  return {
    status: "resolved",
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    identity: { id: row.identityId, revision: row.revision },
    installationId: row.installationId,
    botUserId: row.externalPrincipalId,
    credentialRef: row.credentialRef,
  };
}

export function createPostgresAgentIdentityStore(
  db: Database,
): AgentIdentityStore {
  return {
    link: (input) => link(db, input),
    revoke: (input) => revoke(db, input),
    async list(workspaceId, agentId, limit) {
      if (!UUID.test(agentId)) return [];
      return db
        .select(columns)
        .from(agentIdentities)
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, agentIdentities.installationId),
        )
        .where(
          and(
            eq(agentIdentities.workspaceId, workspaceId),
            eq(agentIdentities.agentId, agentId.toLowerCase()),
          ),
        )
        .orderBy(
          asc(agentIdentities.status),
          desc(agentIdentities.createdAt),
          desc(agentIdentities.id),
        )
        .limit(limit);
    },
    resolveSlackEvent: (key) => resolveSlackEventAgent(db, key),
  };
}
