import type { ConversationKey } from "@werft-ai/platform";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import {
  memberships,
  sessionLinks,
  sessions,
  slackInstallations,
  surfaceBindings,
} from "../schema.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";

/**
 * Why a linked DM session keeps no parent: no one to find (`no_person`), or
 * no one found is a member of the workspace any more (`no_membership`).
 */
export type SessionParentSkip = "no_person" | "no_membership";

export type SessionParentsFilled = {
  filled: number;
  skipped: Record<SessionParentSkip, number>;
  failed: { sessionId: string; error: unknown }[];
};

const isMember = (workspaceId: unknown, userId: unknown) =>
  sql<boolean>`exists (select 1 from ${memberships} where ${memberships.workspaceId} = ${workspaceId} and ${memberships.userId} = ${userId})`;

/**
 * Makes `key`'s conversation, found or made, the session's parent while it
 * has none: `set` then, `kept` when it already was, `other` when another
 * conversation is its parent, which is never overwritten. The one rule a
 * linked session's parent is written by, at host start and as a DM hands
 * its message to the person's standalone session (v1-b/DM3).
 */
export async function adoptSessionParent(
  db: Database,
  sessionId: string,
  key: ConversationKey,
): Promise<"set" | "kept" | "other"> {
  const conversation =
    await createPostgresConversationStore(db).findOrCreateConversation(key);
  const filled = await db
    .update(sessions)
    .set({ parentConversationId: conversation.id })
    .where(
      and(eq(sessions.id, sessionId), isNull(sessions.parentConversationId)),
    )
    .returning({ id: sessions.id });
  if (filled.length > 0) return "set";
  const [row] = await db
    .select({ parent: sessions.parentConversationId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row?.parent === conversation.id ? "kept" : "other";
}

/**
 * Fills the parent conversation of every linked session that has none: a
 * channel thread's session gets its channel's main conversation, a DM's
 * session its person's, a revoked or closed link's session too. The person
 * is the one who opened the session, as at creation, else the link's
 * creator; one who is not a member of the
 * workspace cannot own a conversation, so the next is tried, and with none
 * the session stays a standalone one. Each session is filled on its own and
 * only while still empty, so a run cut short goes on where it stopped and
 * hosts starting at once fill each session the same. Run at each host start:
 * a skipped session is found again, and filled if its person came back.
 */
export async function fillSessionParents(
  db: Database,
  options: { batchSize?: number } = {},
): Promise<SessionParentsFilled> {
  const batchSize = options.batchSize ?? 500;
  const result: SessionParentsFilled = {
    filled: 0,
    skipped: { no_person: 0, no_membership: 0 },
    failed: [],
  };
  let after: string | null = null;
  for (;;) {
    const rows = await db
      .select({
        sessionId: sessions.id,
        workspaceId: sessionLinks.workspaceId,
        agentId: sessionLinks.agentId,
        channelId: sessionLinks.channelId,
        teamId: slackInstallations.teamId,
        dm: sql<boolean>`${surfaceBindings.surfaceKind} = 'dm'`,
        linkCreator: sessionLinks.createdBy,
        linkCreatorMember: isMember(
          sessionLinks.workspaceId,
          sessionLinks.createdBy,
        ),
        sessionCreator: sessions.createdByUserId,
        sessionCreatorMember: isMember(
          sessionLinks.workspaceId,
          sessions.createdByUserId,
        ),
      })
      .from(sessionLinks)
      .innerJoin(sessions, eq(sessions.id, sessionLinks.sessionId))
      .innerJoin(
        surfaceBindings,
        eq(surfaceBindings.id, sessionLinks.surfaceBindingId),
      )
      .innerJoin(
        slackInstallations,
        eq(slackInstallations.id, sessionLinks.installationId),
      )
      .where(
        and(
          isNull(sessions.parentConversationId),
          after === null ? undefined : gt(sessionLinks.sessionId, after),
        ),
      )
      .orderBy(asc(sessionLinks.sessionId))
      .limit(batchSize);
    for (const row of rows) {
      let key: ConversationKey;
      if (row.dm) {
        const person = row.sessionCreatorMember
          ? row.sessionCreator
          : row.linkCreatorMember
            ? row.linkCreator
            : null;
        if (person === null) {
          const none = row.linkCreator === null && row.sessionCreator === null;
          result.skipped[none ? "no_person" : "no_membership"] += 1;
          continue;
        }
        key = {
          kind: "dm",
          workspaceId: row.workspaceId,
          agentId: row.agentId,
          personUserId: person,
        };
      } else {
        key = {
          kind: "channel",
          workspaceId: row.workspaceId,
          agentId: row.agentId,
          teamId: row.teamId,
          channelId: row.channelId,
        };
      }
      try {
        if ((await adoptSessionParent(db, row.sessionId, key)) === "set") {
          result.filled += 1;
        }
      } catch (error) {
        result.failed.push({ sessionId: row.sessionId, error });
      }
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < batchSize) return result;
    after = last.sessionId;
  }
}
