import {
  effectiveToolsSchema,
  sessionExtensionSchema,
  workspaceMcpStartSchema,
} from "@werft-ai/contracts";
import type { WerftStatusFacts, WerftStatusStore } from "@werft-ai/platform";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { githubPolicyColumns, githubPolicyOfRow } from "../github/index.ts";
import { channelKindOf } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import {
  agentGitHubSettings,
  agentIdentities,
  agentReleases,
  agents,
  catalogRepositories,
  conversations,
  githubApps,
  githubInstallationSnapshots,
  sessions,
  slackApps,
  slackInstallations,
  surfaceBindings,
  turns,
} from "../schema.ts";
import { notDeleted } from "../soft-delete.ts";

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * WerftStatusStore over the session's own rows. Only names, states and
 * switches are selected: no credential column, no Slack token and no
 * repository auth is read, so none can reach an answer.
 */
export function createPostgresWerftStatusStore(db: Database): WerftStatusStore {
  return {
    async factsOf(call): Promise<WerftStatusFacts | null> {
      const [session] = await db
        .select({
          workspaceId: sessions.ownerId,
          agentReleaseId: sessions.agentReleaseId,
          starter: sessions.createdByUserId,
          extensions: sessions.extensions,
          workspaceMcpStart: sessions.workspaceMcpStart,
          agentId: agentReleases.agentId,
          effectiveTools: agentReleases.effectiveTools,
          enabled: agents.githubEnabled,
          replyKind: conversations.kind,
          replyConversationId: conversations.id,
          replyPerson: conversations.personUserId,
          ...githubPolicyColumns,
        })
        .from(sessions)
        .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .leftJoin(agents, eq(agents.id, agentReleases.agentId))
        .leftJoin(
          agentGitHubSettings,
          eq(agentGitHubSettings.agentId, agents.id),
        )
        // The conversation the session's text belongs to, as the outbox
        // claim reads it (A3).
        .leftJoin(
          conversations,
          eq(conversations.id, sessions.parentConversationId),
        )
        .where(eq(sessions.id, call.sessionId))
        .limit(1);
      if (!session || session.agentReleaseId === null) return null;
      const { workspaceId, agentId } = session;

      const [requester, githubApp, slackApp, identity, channels] =
        await Promise.all([
          requesterOf(db, call, session.starter),
          githubAppInstalled(db, workspaceId),
          agentSlackApp(db, workspaceId, agentId),
          agentSlackIdentity(db, workspaceId, agentId),
          listeningChannels(db, workspaceId, agentId),
        ]);

      const policy = githubPolicyOfRow(session);
      const settings =
        policy.settings === "invalid" || policy.settings === null
          ? null
          : policy.settings;
      const repositoryIds = settings?.repositories ?? [];
      const repositories =
        repositoryIds.length === 0
          ? []
          : await db
              .select({
                owner: catalogRepositories.owner,
                name: catalogRepositories.name,
              })
              .from(catalogRepositories)
              .where(
                and(
                  inArray(catalogRepositories.id, [...repositoryIds]),
                  isNull(catalogRepositories.removedAt),
                ),
              )
              .orderBy(catalogRepositories.owner, catalogRepositories.name);

      const servers = workspaceMcpStartSchema.safeParse(
        session.workspaceMcpStart,
      );
      const extensions = Array.isArray(session.extensions)
        ? session.extensions.flatMap((stored) => {
            const parsed = sessionExtensionSchema.safeParse(stored);
            return parsed.success ? [parsed.data] : [];
          })
        : [];
      const tools = effectiveToolsSchema.safeParse(session.effectiveTools);
      return {
        workspaceId,
        agentId,
        requesterUserId: requester,
        replyTo: replyToOf(session),
        github: {
          app: githubApp,
          // Off now, or off as the session started: both close it.
          agentEnabled:
            settings !== null &&
            (session.enabled ?? false) &&
            policy.enabledAtStart,
          repositories,
        },
        slack: { app: slackApp || identity, identity, channels },
        workspaceMcpServers: servers.success
          ? servers.data.servers.map((server) => server.name)
          : [],
        skills: extensions.map(({ name, scope }) => ({ name, scope })),
        tools: tools.success ? tools.data.tools : [],
      };
    },
  };
}

function replyToOf(row: {
  replyKind: string | null;
  replyConversationId: string | null;
  replyPerson: string | null;
}): WerftStatusFacts["replyTo"] {
  if (row.replyKind === "channel" && row.replyConversationId !== null) {
    return { kind: "channel", conversationId: row.replyConversationId };
  }
  if (row.replyKind === "dm" && row.replyPerson !== null) {
    return { kind: "dm", personUserId: row.replyPerson };
  }
  return null;
}

/**
 * The person of the attempt's running turn (its root's for a push
 * follow-up, as pushRequesterOf has it), else the session's starter.
 */
async function requesterOf(
  db: Database,
  call: { sessionId: string; attemptId: string },
  starter: string | null,
): Promise<string | null> {
  const [turn] = await db
    .select({
      kind: turns.requesterKind,
      id: turns.requesterId,
      auth: turns.requesterAuth,
    })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, call.sessionId),
        eq(turns.attemptId, call.attemptId),
        eq(turns.status, "running"),
      ),
    )
    .limit(1);
  const auth = objectOf(turn?.auth);
  const root = auth?.method === "push_decision" ? objectOf(auth.root) : null;
  const [kind, id] =
    root !== null
      ? [root.requester_kind, root.requester_id]
      : [turn?.kind, turn?.id];
  if (kind === "user" && typeof id === "string") return id;
  return starter;
}

/** An author GitHub App of the workspace with an installation not suspended. */
async function githubAppInstalled(
  db: Database,
  workspaceId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(githubApps)
    .innerJoin(
      githubInstallationSnapshots,
      and(
        eq(githubInstallationSnapshots.connectionId, githubApps.id),
        eq(githubInstallationSnapshots.appId, githubApps.appId),
      ),
    )
    .where(
      and(
        eq(githubApps.workspaceId, workspaceId),
        eq(githubApps.role, "author"),
        notDeleted(githubApps),
        sql`exists (select 1 from jsonb_array_elements(${githubInstallationSnapshots.installations}) as installation where installation ->> 'suspendedAt' is null)`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The app Werft created for the agent, as its Slack tab reads it. */
async function agentSlackApp(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: slackApps.id })
    .from(slackApps)
    .where(
      and(
        eq(slackApps.workspaceId, workspaceId),
        eq(slackApps.kind, "agent"),
        eq(slackApps.state, "created"),
        eq(slackApps.agentId, agentId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** An active bot identity whose app was not deleted (agentSummaries' rule). */
async function agentSlackIdentity(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentIdentities.id })
    .from(agentIdentities)
    .innerJoin(
      slackInstallations,
      eq(slackInstallations.id, agentIdentities.installationId),
    )
    .where(
      and(
        eq(agentIdentities.workspaceId, workspaceId),
        eq(agentIdentities.agentId, agentId),
        eq(agentIdentities.provider, "slack_bot"),
        eq(agentIdentities.status, "active"),
        sql`not exists (${db
          .select({ one: sql`1` })
          .from(slackApps)
          .where(
            and(
              eq(slackApps.appId, slackInstallations.appId),
              eq(slackApps.state, "deleted"),
            ),
          )})`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The channels the agent listens in now. A channel is public only when its
 * bindings say so as the private channel's door reads them (channelKindOf:
 * any binding of the channel in that Slack team calling it private wins);
 * one no conversation has started in yet is held private.
 */
async function listeningChannels(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<WerftStatusFacts["slack"]["channels"]> {
  const rows = await db
    .select({
      channelId: surfaceBindings.externalSurfaceId,
      listen: surfaceBindings.listen,
      conversationId: conversations.id,
      name: conversations.channelName,
      kind: sql<string | null>`${channelKindOf(sql`${conversations}`)}`,
    })
    .from(surfaceBindings)
    .innerJoin(
      slackInstallations,
      eq(slackInstallations.id, surfaceBindings.installationId),
    )
    .leftJoin(
      conversations,
      and(
        eq(conversations.workspaceId, surfaceBindings.workspaceId),
        eq(conversations.agentId, surfaceBindings.agentId),
        eq(conversations.kind, "channel"),
        eq(conversations.teamId, slackInstallations.teamId),
        eq(conversations.channelId, surfaceBindings.externalSurfaceId),
      ),
    )
    .where(
      and(
        eq(surfaceBindings.workspaceId, workspaceId),
        eq(surfaceBindings.agentId, agentId),
        eq(surfaceBindings.surface, "slack"),
        eq(surfaceBindings.mode, "on"),
        eq(surfaceBindings.status, "ready"),
        ne(surfaceBindings.listen, "off"),
        isNull(surfaceBindings.revokedAt),
        sql`${surfaceBindings.surfaceKind} is distinct from 'dm'`,
      ),
    )
    .orderBy(surfaceBindings.externalSurfaceId);
  return rows.flatMap((row) =>
    row.channelId === null || row.listen === "off"
      ? []
      : [
          {
            conversationId: row.conversationId,
            channelId: row.channelId,
            name: row.name,
            private:
              row.conversationId === null || row.kind !== "public_channel",
            listen: row.listen,
          },
        ],
  );
}
