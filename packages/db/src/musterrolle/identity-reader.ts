import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import type { IdentityReader } from "@werft-ai/platform";
import { and, arrayContains, eq, isNull, ne } from "drizzle-orm";
import { UUID } from "../control-shared.ts";
import {
  apiKeyRecordOf,
  type Database,
  liveApiKey,
  selectLiveApiKey,
} from "../queries.ts";
import {
  agents,
  apiKeys,
  linkedAccounts,
  memberships,
  users,
} from "../schema.ts";

export async function findLiveRole(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(users)
    .innerJoin(
      memberships,
      and(
        eq(memberships.userId, users.id),
        eq(memberships.workspaceId, workspaceId),
        isNull(memberships.disabledAt),
      ),
    )
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  return (row?.role as WorkspaceRole | undefined) ?? null;
}

/** Whether the live agent answers `botUserId`'s mentions now. */
export async function agentAllowsSlackBot(
  db: Database,
  workspaceId: string,
  agentId: string,
  botUserId: string,
): Promise<boolean> {
  if (!UUID.test(agentId)) return false;
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.id, agentId.toLowerCase()),
        ne(agents.status, "archived"),
        arrayContains(agents.slackAllowedBotUserIds, [botUserId]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

type LinkReading =
  | { status: "ok"; userId: string; role: WorkspaceRole }
  | { status: "unlinked" | "disabled" | "stale_link" };

/**
 * The linked account a decision was resolved with, read again now. The
 * revision is part of the check: a link that went stale and was linked
 * again since is not the reading the caller resolved, so it re-resolves.
 */
async function rereadLink(
  db: Database,
  link: { id: string; revision: number },
  actorUserId: string | undefined,
  workspaceId: string,
): Promise<LinkReading> {
  if (!UUID.test(link.id)) return { status: "unlinked" };
  const [row] = await db
    .select({
      userId: linkedAccounts.userId,
      workspaceId: linkedAccounts.workspaceId,
      status: linkedAccounts.status,
      revokedReason: linkedAccounts.revokedReason,
      revision: linkedAccounts.revision,
    })
    .from(linkedAccounts)
    .where(eq(linkedAccounts.id, link.id))
    .limit(1);
  if (!row || row.workspaceId !== workspaceId) return { status: "unlinked" };
  if (row.userId !== actorUserId) return { status: "unlinked" };
  if (row.status === "revoked") {
    return {
      status: row.revokedReason === "offboarded" ? "disabled" : "unlinked",
    };
  }
  if (row.status === "stale" || row.revision !== link.revision) {
    return { status: "stale_link" };
  }
  const role = await findLiveRole(db, row.userId, row.workspaceId);
  return role === null
    ? { status: "disabled" }
    : { status: "ok", userId: row.userId, role };
}

export function createDatabaseIdentityReader(db: Database): IdentityReader {
  return {
    async reread(subject) {
      const { principal } = subject;
      if (subject.linked_account !== undefined) {
        const workspaceId = principal.workspace_id;
        const link =
          workspaceId === null
            ? ({ status: "unlinked" } as const)
            : await rereadLink(
                db,
                subject.linked_account,
                subject.actor_user_id,
                workspaceId,
              );
        if (link.status !== "ok") return { status: link.status };
        // A Slack event authenticates as the installation; the person it
        // resolved to is who is judged, with their role as it stands now.
        // Only on Slack: anywhere else an installation stands for no one.
        if (
          principal.kind === "installation" &&
          workspaceId !== null &&
          subject.surface.kind === "slack"
        ) {
          return {
            status: "ok",
            principal: {
              kind: "user",
              id: link.userId,
              workspace_id: workspaceId,
              role: link.role,
              scopes: [...scopesForRole(link.role)],
            },
          };
        }
      }
      // A bot's mention stands for no person: the agent that allows the bot
      // now, read again here, is who acts, as its key would.
      const { surface } = subject;
      if (
        principal.kind === "installation" &&
        principal.workspace_id !== null &&
        surface.kind === "slack" &&
        surface.slack_bot_user_id !== undefined &&
        surface.agent_id !== undefined
      ) {
        return (await agentAllowsSlackBot(
          db,
          principal.workspace_id,
          surface.agent_id,
          surface.slack_bot_user_id,
        ))
          ? {
              status: "ok",
              principal,
              keyAgentId: surface.agent_id.toLowerCase(),
            }
          : { status: "unlinked" };
      }
      if (principal.kind === "installation") return { status: "unlinked" };
      if (principal.kind === "user") {
        const role = await findLiveRole(
          db,
          principal.id,
          principal.workspace_id,
        );
        if (role === null) return { status: "disabled" };
        const ceiling = new Set(scopesForRole(role));
        return {
          status: "ok",
          principal: {
            ...principal,
            role,
            scopes: principal.scopes.filter((scope) => ceiling.has(scope)),
          },
        };
      }
      if (!UUID.test(principal.id)) return { status: "disabled" };
      const [row] = await selectLiveApiKey(db)
        .where(and(eq(apiKeys.id, principal.id), liveApiKey()))
        .limit(1);
      if (!row) return { status: "disabled" };
      const key = apiKeyRecordOf(row);
      const stored = {
        kind: "api_key" as const,
        id: key.id,
        owner_id: key.ownerId,
        workspace_id: key.workspaceId,
        scopes: key.scopes === null ? [] : [...key.scopes],
      };
      if (key.kind === "agent" && key.agentId != null) {
        return { status: "ok", principal: stored, keyAgentId: key.agentId };
      }
      if (key.kind === "operator") return { status: "ok", principal: stored };
      if (key.createdByUserId === null || key.creatorRole === null) {
        return { status: "disabled" };
      }
      return {
        status: "ok",
        principal: stored,
        keyCreator: { userId: key.createdByUserId, role: key.creatorRole },
      };
    },
  };
}
