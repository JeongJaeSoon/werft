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
 * Fills the parent conversation of every linked session that has none: a
 * channel thread's session gets its channel's main conversation, a DM's
 * session its person's, a revoked or closed link's session too. The person
 * is the link's creator, else the session's; one who is not a member of the
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
  const conversations = createPostgresConversationStore(db);
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
        const person = row.linkCreatorMember
          ? row.linkCreator
          : row.sessionCreatorMember
            ? row.sessionCreator
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
        const conversation = await conversations.findOrCreateConversation(key);
        const filled = await db
          .update(sessions)
          .set({ parentConversationId: conversation.id })
          .where(
            and(
              eq(sessions.id, row.sessionId),
              isNull(sessions.parentConversationId),
            ),
          )
          .returning({ id: sessions.id });
        result.filled += filled.length;
      } catch (error) {
        result.failed.push({ sessionId: row.sessionId, error });
      }
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < batchSize) return result;
    after = last.sessionId;
  }
}
