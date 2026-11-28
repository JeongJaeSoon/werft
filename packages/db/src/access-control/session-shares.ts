import type { SessionRelation, SessionShareScope } from "@werft-ai/contracts";
import type {
  SessionShare,
  SessionShareStore,
  SessionViewer,
  SetSessionShareInput,
  SetSessionShareResult,
} from "@werft-ai/platform";
import { receiptActorOf } from "@werft-ai/platform";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { lockPeople, UUID } from "../control-shared.ts";
import type { Database } from "../queries.ts";
import {
  agentReleases,
  agents,
  conversations,
  memberTeams,
  pendingRequests,
  pushIntents,
  pushRequests,
  receipts,
  sessionShares,
  sessionShareTargets,
  sessions,
  slackInstallations,
  surfaceBindings,
  turns,
} from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import { administers, insideAgent } from "./administers.ts";

// Session share scopes. Lock order: the people involved (users, then
// memberships), the session, the named teams, then the share row; the whole
// order is in requester-locks.ts.

const uuidOrNull = (value: string | null) =>
  value !== null && UUID.test(value) ? value.toLowerCase() : null;

// The creator branches of sessionVisibleTo: the caller holds the session
// now, which a takeover hands to someone else.
function ownedBy(viewer: SessionViewer): SQL[] {
  const userId = uuidOrNull(viewer.userId);
  const apiKeyId = uuidOrNull(viewer.apiKeyId);
  return [
    ...(userId === null ? [] : [sql`${sessions.createdByUserId} = ${userId}`]),
    // A key's session is its key's: the key stands where a creator would.
    ...(apiKeyId === null
      ? []
      : [
          sql`(${sessions.createdByUserId} IS NULL AND ${sessions.createdByApiKeyId} = ${apiKeyId})`,
        ]),
  ];
}

// The share branches of sessionVisibleTo: a people or team share names the
// caller.
function sharedWith(viewer: SessionViewer): SQL[] {
  const userId = uuidOrNull(viewer.userId);
  if (userId === null) return [];
  return [
    sql`EXISTS (SELECT 1 FROM session_shares sh JOIN session_share_targets st ON st.session_id = sh.session_id WHERE sh.session_id = ${sessions.id} AND sh.scope = 'people' AND st.user_id = ${userId})`,
    sql`EXISTS (SELECT 1 FROM session_shares sh JOIN session_share_targets st ON st.session_id = sh.session_id JOIN member_teams mt ON mt.id = st.team_id AND mt.archived_at IS NULL JOIN member_team_members mm ON mm.team_id = mt.id AND mm.removed_at IS NULL WHERE sh.session_id = ${sessions.id} AND sh.scope = 'team' AND mm.user_id = ${userId})`,
  ];
}

// Turn 1's actor, which a takeover leaves alone; created_by_user_id where turn
// 1 names no one (older rows). Qualified by hand: turns has an id of its own.
const starter = sql`coalesce((SELECT t.actor_id FROM ${turns} t WHERE t.session_id = ${sessions}.id AND t.sequence = 1), ${sessions}.created_by_user_id)`;

// relation=started: the caller started the session, whoever holds it now.
function startedBy(viewer: SessionViewer): SQL[] {
  const userId = uuidOrNull(viewer.userId);
  const apiKeyId = uuidOrNull(viewer.apiKeyId);
  return [
    ...(userId === null ? [] : [sql`${starter} = ${userId}`]),
    ...(apiKeyId === null
      ? []
      : [
          sql`(${starter} IS NULL AND ${sessions}.created_by_api_key_id = ${apiKeyId})`,
        ]),
  ];
}

const anyOf = (branches: SQL[]): SQL =>
  branches.length === 0 ? sql`false` : sql`(${sql.join(branches, sql` OR `)})`;

// The session has an agent whose managing team limits its audience: every team
// does, save the one migration 0243 made to hold agents that had none, whose
// agents stay as visible as before. Qualified by hand: agent_releases, agents
// and member_teams have ids of their own.
const managedAgentSession = sql`EXISTS (SELECT 1 FROM ${agentReleases} mar JOIN ${agents} ma ON ma.id = mar.agent_id JOIN ${memberTeams} mt ON mt.id = ma.managing_team_id WHERE mar.id = ${sessions}.agent_release_id AND NOT mt.holds_unassigned)`;

// The viewer is inside the session's agent (agent-rbac (b)): an agent key
// of that agent, or a person inside it, read at this decision.
function insideSessionAgent(db: Database, viewer: SessionViewer): SQL[] {
  const userId = uuidOrNull(viewer.userId);
  const keyAgentId = uuidOrNull(viewer.keyAgentId ?? null);
  return [
    ...(keyAgentId === null
      ? []
      : [
          sql`EXISTS (SELECT 1 FROM ${agentReleases} kar WHERE kar.id = ${sessions}.agent_release_id AND kar.agent_id = ${keyAgentId})`,
        ]),
    ...(userId === null
      ? []
      : [
          sql`EXISTS (SELECT 1 FROM ${agentReleases} iar WHERE iar.id = ${sessions}.agent_release_id AND ${insideAgent(db, sql`${sessions}.workspace_id`, userId, sql`iar.agent_id`)})`,
        ]),
  ];
}

// The kind the channel of conversation `conversation` (a conversations row
// or alias) has now, read from every binding of that channel in the
// workspace, whichever agent or install holds it: of those that know a kind
// (a partial or failed one may not), a live one before a revoked one, and a
// private one first, so one binding that says private holds the channel
// private; null with no binding that knows it.
// Qualified by hand: the outer query may read these tables.
/** The kind a channel conversation's bindings record: private first, unknown is null. */
export const channelKindOf = (conversation: SQL) =>
  sql`(SELECT pb.surface_kind FROM ${surfaceBindings} pb JOIN ${slackInstallations} pi ON pi.id = pb.installation_id WHERE pb.workspace_id = ${conversation}.workspace_id AND pi.team_id = ${conversation}.team_id AND pb.external_surface_id = ${conversation}.channel_id ORDER BY (pb.surface_kind IS NULL), (pb.revoked_at IS NULL) DESC, (pb.surface_kind = 'private_channel') DESC, pb.updated_at DESC, pb.id DESC LIMIT 1)`;

/**
 * The session the enclosing query reads from `sessions` sits behind a private
 * channel's door (decision 26): its share says so, or its parent conversation
 * is a channel no binding calls public. A kind not known counts as private,
 * so it hides rather than leaks. The one test of it, for every read and act.
 */
export const behindPrivateChannel = sql`(coalesce((SELECT ${sessionShares.scope} FROM ${sessionShares} WHERE ${sessionShares.sessionId} = ${sessions.id}), 'workspace') = 'private_channel' OR EXISTS (SELECT 1 FROM ${conversations} pc WHERE pc.id = ${sessions}.parent_conversation_id AND pc.kind = 'channel' AND ${channelKindOf(sql`pc`)} IS DISTINCT FROM 'public_channel'))`;

/**
 * Whether `viewer` sees the session row the enclosing query reads from
 * `sessions`. One predicate for a decision on one session and for a list,
 * so what a list shows and what a detail answers never disagree.
 *
 * `workspace` reaches every member, save that a session of an agent with a
 * managing team reaches only those inside the agent (agent-rbac (c)). Read
 * at this decision, so a new managing team or a member leaving the team
 * applies to sessions already made.
 */
export function sessionVisibleTo(db: Database, viewer: SessionViewer): SQL {
  const workspaceWide = anyOf([
    sql`${sessions}.workspace_id IS NULL`,
    sql`NOT ${managedAgentSession}`,
    ...insideSessionAgent(db, viewer),
  ]);
  const scope = sql`coalesce((SELECT ${sessionShares.scope} FROM ${sessionShares} WHERE ${sessionShares.sessionId} = ${sessions.id}), 'workspace')`;
  const byScope = anyOf([
    sql`(${scope} = 'workspace' AND ${workspaceWide})`,
    sql`(${scope} <> 'private_channel' AND ${anyOf([...ownedBy(viewer), ...sharedWith(viewer)])})`,
  ]);
  // The channel goes before whoever made or was named on the session, then
  // its scope's own rule; a key never passes it (no key is a channel member).
  const channels = (viewer.privateChannels ?? []).flatMap((id) => {
    const value = uuidOrNull(id);
    return value === null ? [] : [value];
  });
  return anyOf([
    sql`(NOT ${behindPrivateChannel} AND ${byScope})`,
    ...(viewer.apiKeyId !== null || channels.length === 0
      ? []
      : [
          sql`(${behindPrivateChannel} AND ${sessions}.parent_conversation_id IN (${sql.join(
            channels.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) AND (${scope} = 'private_channel' OR ${byScope}))`,
        ]),
  ]);
}

/**
 * How the session relates to `viewer`, to AND with sessionVisibleTo: on its
 * own it is no grant. `administered` follows the admin rows at this read,
 * as every decision does.
 */
export function sessionRelationIs(
  db: Database,
  viewer: SessionViewer,
  relation: Exclude<SessionRelation, "all">,
): SQL {
  switch (relation) {
    case "started":
      return anyOf(startedBy(viewer));
    case "shared":
      // IS NOT TRUE: a session no person started compares NULL, not false.
      return sql`(${anyOf(sharedWith(viewer))} AND ${anyOf(startedBy(viewer))} IS NOT TRUE)`;
    case "administered": {
      const userId = uuidOrNull(viewer.userId);
      if (userId === null) return sql`false`;
      // Qualified by hand: agent_releases has an id of its own.
      return sql`EXISTS (SELECT 1 FROM ${agentReleases} ar WHERE ar.id = ${sessions}.agent_release_id AND ${administers(db, sql`${sessions}.workspace_id`, userId, sql`ar.agent_id`)})`;
    }
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

async function readShare(
  db: Database,
  ownerId: string,
  sessionId: string,
): Promise<SessionShare | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      scope: sessionShares.scope,
      revision: sessionShares.revision,
      updatedBy: sessionShares.updatedBy,
      updatedAt: sessionShares.updatedAt,
      audienceLimited: sql<boolean>`(${sessions}.workspace_id IS NOT NULL AND ${managedAgentSession})`,
    })
    .from(sessions)
    .leftJoin(sessionShares, eq(sessionShares.sessionId, sessions.id))
    .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  const targets = await db
    .select({
      userId: sessionShareTargets.userId,
      teamId: sessionShareTargets.teamId,
    })
    .from(sessionShareTargets)
    .where(eq(sessionShareTargets.sessionId, sessionId))
    .orderBy(asc(sessionShareTargets.addedAt), asc(sessionShareTargets.id));
  // A row at revision 0 is the placeholder a first change locks on.
  const changed = row.revision !== null && row.revision > 0;
  return {
    sessionId: row.sessionId,
    scope: (changed ? row.scope : "workspace") as SessionShareScope,
    userIds: targets.flatMap((t) => (t.userId === null ? [] : [t.userId])),
    teamIds: targets.flatMap((t) => (t.teamId === null ? [] : [t.teamId])),
    revision: changed ? (row.revision ?? 0) : 0,
    updatedBy: changed ? row.updatedBy : null,
    updatedAt: changed ? row.updatedAt : null,
    audienceLimited: row.audienceLimited === true,
  };
}

async function setShare(
  db: Database,
  input: SetSessionShareInput,
): Promise<SetSessionShareResult> {
  if (!UUID.test(input.sessionId)) return { outcome: "not_found" };
  const sessionId = input.sessionId.toLowerCase();
  const userIds =
    input.scope === "people"
      ? [...new Set(input.userIds.map((id) => id.toLowerCase()))].sort()
      : [];
  const teamIds =
    input.scope === "team"
      ? [...new Set(input.teamIds.map((id) => id.toLowerCase()))].sort()
      : [];
  if (![...userIds, ...teamIds].every((id) => UUID.test(id))) {
    return { outcome: "invalid_target" };
  }
  return db.transaction(async (tx) => {
    const people = await lockPeople(tx, input.workspaceId, [
      input.updatedBy,
      ...userIds,
    ]);
    const live = new Set(people.filter((p) => p.live).map((p) => p.userId));
    if (!live.has(input.updatedBy.toLowerCase())) {
      return { outcome: "actor_inactive" };
    }
    if (!userIds.every((id) => live.has(id))) {
      return { outcome: "invalid_target" };
    }
    // The session row before the teams and the share row, as an input
    // takes it (requester-locks.ts), so an input is judged wholly before or
    // wholly after this change, a first one with no share row included.
    const [session] = await tx
      .select({ id: sessions.id, preview: sessions.preview })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.ownerId, input.ownerId),
          eq(sessions.workspaceId, input.workspaceId),
        ),
      )
      .limit(1)
      .for("update");
    if (!session) return { outcome: "not_found" };
    // A preview stays its creator's alone: what the agent does before it is
    // published is not shown to the team.
    if (session.preview && input.scope !== "private") {
      return { outcome: "preview_fixed" };
    }
    const [fixed] = await tx
      .select({ scope: sessionShares.scope })
      .from(sessionShares)
      .where(eq(sessionShares.sessionId, sessionId));
    if (fixed?.scope === "private_channel") return { outcome: "channel_fixed" };
    if (teamIds.length > 0) {
      const teams = await tx
        .select({ id: memberTeams.id })
        .from(memberTeams)
        .where(
          and(
            eq(memberTeams.workspaceId, input.workspaceId),
            inArray(memberTeams.id, teamIds),
            isNull(memberTeams.archivedAt),
          ),
        )
        .orderBy(asc(memberTeams.id))
        .for("share");
      if (teams.length !== teamIds.length) {
        return { outcome: "invalid_target" };
      }
    }
    // Two first changes would otherwise both find no row to lock.
    await tx
      .insert(sessionShares)
      .values({
        sessionId,
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        scope: "workspace",
        revision: 0,
      })
      .onConflictDoNothing();
    const [locked] = await tx
      .select({ revision: sessionShares.revision })
      .from(sessionShares)
      .where(eq(sessionShares.sessionId, sessionId))
      .for("update");
    const current = await readShare(tx, input.ownerId, sessionId);
    if (!locked || !current) return { outcome: "not_found" };
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== current.revision
    ) {
      return {
        outcome: "revision_conflict",
        currentRevision: current.revision,
      };
    }
    if (
      current.scope === input.scope &&
      sameSet(current.userIds, userIds) &&
      sameSet(current.teamIds, teamIds)
    ) {
      return { outcome: "unchanged", share: current };
    }
    const now = new Date();
    await tx
      .update(sessionShares)
      .set({
        scope: input.scope,
        revision: current.revision + 1,
        updatedBy: input.updatedBy,
        updatedAt: now,
      })
      .where(eq(sessionShares.sessionId, sessionId));
    await tx
      .delete(sessionShareTargets)
      .where(eq(sessionShareTargets.sessionId, sessionId));
    const targets = [
      ...userIds.map((userId) => ({ userId, teamId: null })),
      ...teamIds.map((teamId) => ({ userId: null, teamId })),
    ];
    if (targets.length > 0) {
      await tx.insert(sessionShareTargets).values(
        targets.map((target) => ({
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          sessionId,
          ...target,
          addedBy: input.updatedBy,
          addedAt: now,
        })),
      );
    }
    await tx.insert(receipts).values({
      id: input.receiptId,
      ownerId: input.ownerId,
      actor: receiptActorOf(input.principal),
      requestId: input.principal.requestId ?? null,
      operation: "share_session",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "succeeded",
      result: { scope: input.scope },
    });
    // Open streams re-read on this wakeup, and one that can no longer see
    // the session is refused there and ends.
    await tx.execute(sql`SELECT pg_notify('session_events', ${sessionId})`);
    const share = await readShare(tx, input.ownerId, sessionId);
    if (!share) throw new Error("session share vanished inside its write");
    return { outcome: "changed", share };
  });
}

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * SessionShareStore.pushRequesterOf: the person of the turn that asked for
 * the push (its root for a push follow-up, as pushFollowUpRequester has it),
 * else the person who asked over the API, else the session's starter.
 */
export async function pushRequesterOf(
  db: Database,
  ownerId: string,
  sessionId: string,
  pushRequestId: string,
): Promise<string | null> {
  if (!UUID.test(sessionId) || !UUID.test(pushRequestId)) return null;
  const [row] = await db
    .select({
      requestedBy: pushRequests.requestedBy,
      starter: sessions.createdByUserId,
      turnKind: turns.requesterKind,
      turnRequester: turns.requesterId,
      turnAuth: turns.requesterAuth,
    })
    .from(pushRequests)
    .innerJoin(sessions, eq(sessions.id, pushRequests.sessionId))
    .leftJoin(pushIntents, eq(pushIntents.pushRequestId, pushRequests.id))
    .leftJoin(turns, eq(turns.id, pushIntents.turnId))
    .where(
      and(
        eq(pushRequests.id, pushRequestId.toLowerCase()),
        eq(pushRequests.sessionId, sessionId.toLowerCase()),
        eq(sessions.ownerId, ownerId),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  const auth = objectOf(row.turnAuth);
  const root = auth?.method === "push_decision" ? objectOf(auth.root) : null;
  const [kind, id] =
    root !== null
      ? [root.requester_kind, root.requester_id]
      : [row.turnKind, row.turnRequester];
  if (kind === "user" && typeof id === "string") return id;
  const asked = objectOf(row.requestedBy)?.actor_user_id;
  if (row.turnKind === null && typeof asked === "string") return asked;
  return row.starter;
}

/** SessionShareStore.pendingRequesterOf, by the rule pushRequesterOf has. */
export async function pendingRequesterOf(
  db: Database,
  ownerId: string,
  sessionId: string,
  requestId: string,
): Promise<string | null> {
  if (!UUID.test(sessionId)) return null;
  const [row] = await db
    .select({
      starter: sessions.createdByUserId,
      turnKind: turns.requesterKind,
      turnRequester: turns.requesterId,
      turnAuth: turns.requesterAuth,
    })
    .from(pendingRequests)
    .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
    .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
    .where(
      and(
        eq(pendingRequests.requestId, requestId),
        eq(pendingRequests.sessionId, sessionId.toLowerCase()),
        eq(sessions.ownerId, ownerId),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  const auth = objectOf(row.turnAuth);
  const root = auth?.method === "push_decision" ? objectOf(auth.root) : null;
  const [kind, id] =
    root !== null
      ? [root.requester_kind, root.requester_id]
      : [row.turnKind, row.turnRequester];
  if (kind === "user" && typeof id === "string") return id;
  return row.starter;
}

/**
 * privateChannels(ownerId, null): the conversations of every channel the
 * owner's sessions sit behind the door of, as behindPrivateChannel reads it.
 * It walks the owner's distinct parent conversations on
 * sessions_owner_parent_idx, one probe each, rather than every session:
 * every session of a channel no binding calls public is behind its door, so
 * one session of it is enough; a public channel's count only through a
 * session shared `private_channel`.
 */
async function ownerPrivateChannels(
  db: Database,
  ownerId: string,
): ReturnType<SessionShareStore["privateChannels"]> {
  const rows = rowsOf<{
    conversation_id: string;
    agent_id: string;
    channel_id: string;
    kind_known: boolean;
  }>(
    await db.execute(sql`
      WITH RECURSIVE parents(id) AS (
        (SELECT parent_conversation_id FROM ${sessions}
         WHERE owner_id = ${ownerId} AND parent_conversation_id IS NOT NULL
         ORDER BY parent_conversation_id LIMIT 1)
        UNION ALL
        SELECT (SELECT ps.parent_conversation_id FROM ${sessions} ps
                WHERE ps.owner_id = ${ownerId} AND ps.parent_conversation_id > parents.id
                ORDER BY ps.parent_conversation_id LIMIT 1)
        FROM parents WHERE parents.id IS NOT NULL
      )
      SELECT c.id AS conversation_id, c.agent_id, c.channel_id,
             (k.kind IS NOT NULL) AS kind_known
      FROM parents
      JOIN ${conversations} c ON c.id = parents.id
      CROSS JOIN LATERAL (SELECT ${channelKindOf(sql`c`)} AS kind) k
      WHERE c.kind = 'channel' AND c.channel_id IS NOT NULL
        AND (k.kind IS DISTINCT FROM 'public_channel' OR EXISTS (
          SELECT 1 FROM ${sessions} cs
          JOIN ${sessionShares} csh ON csh.session_id = cs.id
          WHERE cs.owner_id = ${ownerId} AND cs.parent_conversation_id = c.id
            AND csh.scope = 'private_channel'))
      ORDER BY c.id`),
  );
  return rows.map((row) => {
    const place = {
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      channelId: row.channel_id,
    };
    return row.kind_known ? place : { ...place, kindUnknown: true as const };
  });
}

export function createPostgresSessionShareStore(
  db: Database,
): SessionShareStore {
  return {
    async visibleTo(ownerId, sessionId, viewer) {
      if (!UUID.test(sessionId)) return false;
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId.toLowerCase()),
            eq(sessions.ownerId, ownerId),
            sessionVisibleTo(db, viewer),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async privateChannels(ownerId, sessionId) {
      if (sessionId === null) return ownerPrivateChannels(db, ownerId);
      if (!UUID.test(sessionId)) return [];
      const rows = await db
        .selectDistinct({
          conversationId: conversations.id,
          agentId: conversations.agentId,
          channelId: sql<string>`${conversations.channelId}`,
          kindKnown: sql<boolean>`(${channelKindOf(sql`${conversations}`)} IS NOT NULL)`,
        })
        .from(sessions)
        .innerJoin(
          conversations,
          eq(conversations.id, sessions.parentConversationId),
        )
        .where(
          and(
            eq(sessions.ownerId, ownerId),
            behindPrivateChannel,
            eq(conversations.kind, "channel"),
            isNotNull(conversations.channelId),
            eq(sessions.id, sessionId.toLowerCase()),
          ),
        );
      return rows.map(({ kindKnown, ...place }) =>
        kindKnown ? place : { ...place, kindUnknown: true },
      );
    },

    pushRequesterOf: (ownerId, sessionId, pushRequestId) =>
      pushRequesterOf(db, ownerId, sessionId, pushRequestId),

    pendingRequesterOf: (ownerId, sessionId, requestId) =>
      pendingRequesterOf(db, ownerId, sessionId, requestId),

    async originOf(ownerId, sessionId) {
      if (!UUID.test(sessionId)) return null;
      const [row] = await db
        .select({
          creatorUserId: sessions.createdByUserId,
          creatorApiKeyId: sessions.createdByApiKeyId,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId.toLowerCase()),
            eq(sessions.ownerId, ownerId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    get(ownerId, sessionId) {
      if (!UUID.test(sessionId)) return Promise.resolve(null);
      // The row and its targets are two reads; one snapshot keeps a change
      // committed between them from mixing two shares.
      return db.transaction(
        (tx) => readShare(tx, ownerId, sessionId.toLowerCase()),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    set: (input) => setShare(db, input),

    async listForAdmin(ownerId, limit) {
      const rows = await db
        .select({
          sessionId: sessions.id,
          createdByUserId: sessions.createdByUserId,
          createdByApiKeyId: sessions.createdByApiKeyId,
          agentReleaseId: sessions.agentReleaseId,
          status: sessions.status,
          admissionState: sessions.admissionState,
          scope: sessionShares.scope,
          revision: sessionShares.revision,
          createdAt: sessions.createdAt,
          takeoverRequiredAt: sessions.takeoverRequiredAt,
        })
        .from(sessions)
        .leftJoin(sessionShares, eq(sessionShares.sessionId, sessions.id))
        .where(eq(sessions.ownerId, ownerId))
        .orderBy(desc(sessions.createdAt), desc(sessions.id))
        .limit(limit);
      return rows.map(({ scope, revision, ...row }) => ({
        ...row,
        shareScope: (revision !== null && revision > 0
          ? scope
          : "workspace") as SessionShareScope,
      }));
    },
  };
}
