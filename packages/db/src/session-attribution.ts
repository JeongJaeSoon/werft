import type { SessionTrigger } from "@werft-ai/contracts";
import type { SessionAttributionStore } from "@werft-ai/platform";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  apiKeys,
  catalogRepositoryGitHubApps,
  githubApps,
  linkedAccounts,
  pushIntents,
  sessions,
  turns,
} from "./schema.ts";

function triggerOf(row: {
  channel: string | null;
  keyKind: string | null;
  createdByApiKeyId: string | null;
  createdByUserId: string | null;
}): SessionTrigger {
  if (row.channel === "web" || row.channel === "slack") return row.channel;
  const byKey =
    row.keyKind === "personal"
      ? "personal_key"
      : row.keyKind === "agent"
        ? "agent_key"
        : "operator_key";
  if (row.channel === "api") return byKey;
  // Rows from before `channel`: their creator columns are all there is.
  if (row.createdByApiKeyId !== null) return byKey;
  return row.createdByUserId !== null ? "web" : "operator_key";
}

async function activeGitHubLink(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<{ id: string; login: string } | null> {
  const [link] = await db
    .select({
      id: linkedAccounts.externalUserId,
      login: linkedAccounts.externalUserName,
    })
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.workspaceId, workspaceId),
        eq(linkedAccounts.userId, userId),
        eq(linkedAccounts.provider, "github"),
        eq(linkedAccounts.status, "active"),
      ),
    )
    .limit(1);
  return link === undefined || link.login === null
    ? null
    : { id: link.id, login: link.login };
}

export function createPostgresSessionAttributionStore(
  db: Database,
): SessionAttributionStore {
  return {
    async githubLinkOf(rawSessionId, userId) {
      const [session] = await db
        .select({ workspaceId: sessions.workspaceId })
        .from(sessions)
        .where(eq(sessions.id, rawSessionId.toLowerCase()))
        .limit(1);
      return session?.workspaceId == null
        ? null
        : activeGitHubLink(db, session.workspaceId, userId);
    },
    async lastRequesterOf(rawSessionId) {
      const sessionId = rawSessionId.toLowerCase();
      const [latest] = await db
        .select({
          userId: turns.actorId,
          workspaceId: sessions.workspaceId,
        })
        .from(turns)
        .innerJoin(sessions, eq(sessions.id, turns.sessionId))
        .where(eq(turns.sessionId, sessionId))
        .orderBy(desc(turns.sequence))
        .limit(1);
      if (latest === undefined) return null;
      const github =
        latest.userId !== null && latest.workspaceId !== null
          ? await activeGitHubLink(db, latest.workspaceId, latest.userId)
          : null;
      return { userId: latest.userId, github };
    },
    async requesterOfPushRequest(rawSessionId, pushRequestId) {
      const [row] = await db
        .select({ userId: turns.actorId, channel: turns.channel })
        .from(pushIntents)
        .innerJoin(turns, eq(turns.id, pushIntents.turnId))
        .where(
          and(
            eq(pushIntents.sessionId, rawSessionId.toLowerCase()),
            eq(pushIntents.pushRequestId, pushRequestId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async attribution(rawSessionId) {
      const sessionId = rawSessionId.toLowerCase();
      const [row] = await db
        .select({
          ownerId: sessions.ownerId,
          workspaceId: sessions.workspaceId,
          repositoryId: sessions.repositoryId,
          channel: sessions.channel,
          createdByUserId: sessions.createdByUserId,
          createdByApiKeyId: sessions.createdByApiKeyId,
          keyKind: apiKeys.kind,
          // Turn 1's actor, else the creator: the session-shares rule.
          startedBy: sql<
            string | null
          >`coalesce((SELECT t.actor_id FROM ${turns} t WHERE t.session_id = ${sessions.id} AND t.sequence = 1), ${sessions.createdByUserId})`,
          agentId: agentReleases.agentId,
          agentReleaseId: sessions.agentReleaseId,
        })
        .from(sessions)
        .leftJoin(apiKeys, eq(apiKeys.id, sessions.createdByApiKeyId))
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (row === undefined) return null;
      const github =
        row.startedBy !== null && row.workspaceId !== null
          ? await activeGitHubLink(db, row.workspaceId, row.startedBy)
          : null;
      // The App the primary repository is pinned to, the one that opens its
      // pull requests (decision D11). A pin whose connection is gone or now
      // holds another App names none: no other App stands in for it.
      let authorApp: { slug: string; apiBase: string } | null = null;
      let authorPinned = false;
      if (row.workspaceId !== null && row.repositoryId !== null) {
        const [pin] = await db
          .select({
            slug: githubApps.slug,
            apiBase: githubApps.apiBase,
          })
          .from(catalogRepositoryGitHubApps)
          .leftJoin(
            githubApps,
            and(
              eq(githubApps.id, catalogRepositoryGitHubApps.connectionId),
              eq(githubApps.appId, catalogRepositoryGitHubApps.appId),
              eq(githubApps.role, "author"),
              eq(githubApps.workspaceId, row.workspaceId),
            ),
          )
          .where(
            and(
              eq(catalogRepositoryGitHubApps.repositoryId, row.repositoryId),
              eq(catalogRepositoryGitHubApps.role, "author"),
            ),
          )
          .limit(1);
        if (pin !== undefined) {
          authorPinned = true;
          authorApp =
            pin.slug === null || pin.apiBase === null
              ? null
              : { slug: pin.slug, apiBase: pin.apiBase };
        }
      }
      return {
        ownerId: row.ownerId,
        authorApp,
        authorPinned,
        trigger: triggerOf(row),
        agentId: row.agentId,
        agentReleaseId: row.agentReleaseId,
        starter:
          row.startedBy === null ? null : { userId: row.startedBy, github },
      };
    },
  };
}
