import type { AgentAuthority } from "@werft-ai/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import { administers, insideAgent } from "./administers.ts";
import { usageOf as usageDecisionOf } from "./agent-usage.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agents,
  memberships,
  sessionLinks,
  sessions,
  surfaceBindings,
  users,
} from "./schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDatabaseAgentAuthority(db: Database): AgentAuthority {
  return {
    async agentOf(workspaceId, resource) {
      // A malformed id would reach a uuid column as a 22P02.
      if (!UUID.test(resource.id) || !UUID.test(workspaceId)) return null;
      const id = resource.id.toLowerCase();
      if (resource.kind === "agent") {
        const [row] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
          .limit(1);
        return row?.id ?? null;
      }
      if (resource.kind === "session") {
        // A session belongs to the agent of the release it was pinned to; one
        // made from a profile alone belongs to none.
        const [row] = await db
          .select({ agentId: agentReleases.agentId })
          .from(sessions)
          .innerJoin(
            agentReleases,
            eq(agentReleases.id, sessions.agentReleaseId),
          )
          .innerJoin(
            agents,
            and(
              eq(agents.id, agentReleases.agentId),
              eq(agents.workspaceId, workspaceId),
            ),
          )
          .where(and(eq(sessions.id, id), eq(sessions.ownerId, workspaceId)))
          .limit(1);
        return row?.agentId ?? null;
      }
      if (resource.kind === "surface_binding") {
        // A revoked binding speaks for no agent any more.
        const [row] = await db
          .select({ agentId: surfaceBindings.agentId })
          .from(surfaceBindings)
          .where(
            and(
              eq(surfaceBindings.id, id),
              eq(surfaceBindings.workspaceId, workspaceId),
              isNull(surfaceBindings.revokedAt),
            ),
          )
          .limit(1);
        return row?.agentId ?? null;
      }
      if (resource.kind === "session_link") {
        const [row] = await db
          .select({ agentId: sessionLinks.agentId })
          .from(sessionLinks)
          .where(
            and(
              eq(sessionLinks.id, id),
              eq(sessionLinks.workspaceId, workspaceId),
              isNull(sessionLinks.revokedAt),
            ),
          )
          .limit(1);
        return row?.agentId ?? null;
      }
      return null;
    },

    async agentOfRelease(workspaceId, releaseId) {
      if (!UUID.test(workspaceId)) return null;
      const [row] = await db
        .select({ agentId: agentReleases.agentId })
        .from(agentReleases)
        .innerJoin(
          agents,
          and(
            eq(agents.id, agentReleases.agentId),
            eq(agents.workspaceId, workspaceId),
          ),
        )
        .where(eq(agentReleases.id, releaseId))
        .limit(1);
      return row?.agentId ?? null;
    },

    async isAdmin(workspaceId, agentId, userId) {
      if (![workspaceId, agentId, userId].every((v) => UUID.test(v))) {
        return false;
      }
      const [row] = await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(
          users,
          and(eq(users.id, memberships.userId), isNull(users.disabledAt)),
        )
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, userId.toLowerCase()),
            isNull(memberships.disabledAt),
            administers(
              db,
              workspaceId,
              userId.toLowerCase(),
              agentId.toLowerCase(),
            ),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async usageOf(workspaceId, agentId, who) {
      if (![workspaceId, agentId].every((v) => UUID.test(v))) {
        return { allowed: false };
      }
      return usageDecisionOf(db, {
        workspaceId,
        agentId: agentId.toLowerCase(),
        who,
        lock: false,
      });
    },

    async isInside(workspaceId, agentId, userId) {
      if (![workspaceId, agentId, userId].every((v) => UUID.test(v))) {
        return false;
      }
      const [row] = await db
        .select({ one: sql`1` })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            eq(agents.id, agentId.toLowerCase()),
            insideAgent(db, workspaceId, userId.toLowerCase(), agents.id),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}
