import {
  AGENT_SUMMARY_INSTRUCTIONS_MAX,
  type AgentSlackAction,
  type AgentSummary,
  storedAgentCapabilitiesSchema,
} from "@werft-ai/contracts";
import type { SessionViewer } from "@werft-ai/platform";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { insideAgent } from "./administers.ts";
import { actionableOfSession, IN_FLIGHT_STATUSES } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { earlierInSecond, releaseLabel } from "./release-labels.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agentIdentities,
  agentMcpSettings,
  agentReleases,
  agents,
  agentVersions,
  credentialBindings,
  memberTeams,
  sessions,
  slackApps,
  surfaceBindings,
  users,
} from "./schema.ts";
import { sessionVisibleTo } from "./session-shares.ts";

// Postgres `left` counts code points; the contract counts UTF-16 units.
function clip(text: string) {
  if (text.length <= AGENT_SUMMARY_INSTRUCTIONS_MAX) return text;
  const end = AGENT_SUMMARY_INSTRUCTIONS_MAX;
  return text.slice(
    0,
    /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") ? end - 1 : end,
  );
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The summaries of a page of agents in eight statements whatever its size,
 * matching what the agent, admins, bindings, session list and Slack reads
 * would show one by one.
 */
export async function agentSummaries(
  db: Database,
  workspaceId: string,
  agentIds: readonly string[],
  viewer: SessionViewer,
): Promise<Map<string, AgentSummary>> {
  const ids = [...new Set(agentIds.map((id) => id.toLowerCase()))];
  const userId = viewer.userId?.toLowerCase();
  if (ids.length === 0 || userId === undefined) return new Map();
  const heads = await db
    .select({
      id: agents.id,
      connection: agentReleases.connectionId,
      model: sql<
        string | null
      >`${agentReleases.runtimeConfigSnapshot}->>'model'`,
      versionId: agentReleases.versionId,
      releasedAt: agentReleases.createdAt,
      earlier: earlierInSecond(agentReleases),
    })
    .from(agents)
    .leftJoin(
      agentReleases,
      and(
        eq(agentReleases.id, agents.activeReleaseId),
        eq(agentReleases.agentId, agents.id),
      ),
    )
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        inArray(agents.id, ids),
        insideAgent(db, workspaceId, userId, agents.id),
      ),
    );
  if (heads.length === 0) return new Map();
  const found = heads.map((head) => head.id);

  // Only the fields shown, so a long card is not read whole for each agent.
  const fields = {
    agentId: agentVersions.agentId,
    versionNo: agentVersions.versionNo,
    role: sql<string | null>`${agentVersions.card}->>'role'`,
    instructions: sql<
      string | null
    >`left(${agentVersions.card}->>'instructions', ${AGENT_SUMMARY_INSTRUCTIONS_MAX})`,
    capabilities: sql<unknown>`${agentVersions.card}->'capabilities'`,
  };
  const released = heads.flatMap((head) =>
    head.versionId ? [head.versionId] : [],
  );
  const drafts = heads.filter((head) => !head.versionId).map((head) => head.id);
  const versions = [
    ...(released.length > 0
      ? await db
          .select(fields)
          .from(agentVersions)
          .where(inArray(agentVersions.id, released))
      : []),
    ...(drafts.length > 0
      ? await db
          .selectDistinctOn([agentVersions.agentId], fields)
          .from(agentVersions)
          .where(inArray(agentVersions.agentId, drafts))
          .orderBy(agentVersions.agentId, desc(agentVersions.versionNo))
      : []),
  ];

  const admins = new Map<string, string[]>();
  for (const row of await db
    .select({
      agentId: agentAdmins.agentId,
      email: users.email,
      displayName: users.displayName,
    })
    .from(agentAdmins)
    .innerJoin(users, eq(users.id, agentAdmins.userId))
    .where(
      and(
        eq(agentAdmins.workspaceId, workspaceId),
        inArray(agentAdmins.agentId, found),
      ),
    )
    .orderBy(asc(agentAdmins.createdAt), asc(agentAdmins.userId)))
    push(admins, row.agentId, row.displayName ?? row.email);
  for (const row of await db
    .select({ agentId: agentAdminTeams.agentId, name: memberTeams.name })
    .from(agentAdminTeams)
    .innerJoin(memberTeams, eq(memberTeams.id, agentAdminTeams.teamId))
    .where(
      and(
        eq(agentAdminTeams.workspaceId, workspaceId),
        inArray(agentAdminTeams.agentId, found),
      ),
    )
    .orderBy(asc(agentAdminTeams.createdAt), asc(agentAdminTeams.teamId)))
    push(admins, row.agentId, row.name);

  // An agent with a settings row shows its server and names; the others show
  // their card's, as before.
  const mcpSettings = new Map(
    (
      await db
        .select({
          agentId: agentMcpSettings.agentId,
          server: agentMcpSettings.server,
          credentialRefs: agentMcpSettings.credentialRefs,
        })
        .from(agentMcpSettings)
        .where(
          and(
            eq(agentMcpSettings.workspaceId, workspaceId),
            inArray(agentMcpSettings.agentId, found),
          ),
        )
    ).map((row) => [row.agentId, row]),
  );

  const bound = new Map<string, string[]>();
  for (const row of await db
    .select({
      agentId: credentialBindings.targetId,
      ref: credentialBindings.credentialRef,
    })
    .from(credentialBindings)
    .where(
      and(
        eq(credentialBindings.workspaceId, workspaceId),
        eq(credentialBindings.target, "agent"),
        inArray(credentialBindings.targetId, found),
        isNull(credentialBindings.revokedAt),
      ),
    )
    .orderBy(asc(credentialBindings.credentialRef)))
    push(bound, row.agentId, row.ref);

  // GET /v1/sessions' filter and public status, so a card's counts are that
  // list's `?agent_id=&status=` read to the end.
  const awaiting = sql`exists (${actionableOfSession(db)})`;
  const live = new Map(
    (
      await db
        .select({
          agentId: agentReleases.agentId,
          needsInput: sql<number>`(count(*) filter (where ${awaiting}))::int`,
          running: sql<number>`(count(*) filter (where not ${awaiting}))::int`,
        })
        .from(sessions)
        .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .where(
          and(
            eq(sessions.ownerId, workspaceId),
            inArray(agentReleases.agentId, found),
            inArray(sessions.status, IN_FLIGHT_STATUSES),
            sessionVisibleTo(db, viewer),
          ),
        )
        .groupBy(agentReleases.agentId)
    ).map((row) => [row.agentId, row]),
  );

  // The agent's created app as its Slack tab reads it: an active bot
  // identity means installed, and a live home binding means a home.
  const slack = new Map(
    (
      await db
        .select({
          agentId: slackApps.agentId,
          eventsState: slackApps.eventsState,
          eventsSent: sql<boolean>`${slackApps.eventsUrl} is not null`,
          botToken: sql<boolean>`${slackApps.botTokenRef} is not null`,
          installed: sql<boolean>`exists (${db
            .select({ one: sql`1` })
            .from(agentIdentities)
            .where(
              and(
                eq(agentIdentities.workspaceId, slackApps.workspaceId),
                eq(agentIdentities.agentId, slackApps.agentId),
                eq(agentIdentities.provider, "slack_bot"),
                eq(agentIdentities.status, "active"),
              ),
            )})`,
          home: sql<boolean>`exists (${db
            .select({ one: sql`1` })
            .from(surfaceBindings)
            .where(
              and(
                eq(surfaceBindings.workspaceId, slackApps.workspaceId),
                eq(surfaceBindings.agentId, slackApps.agentId),
                eq(surfaceBindings.surface, "slack"),
                eq(surfaceBindings.home, true),
                isNull(surfaceBindings.revokedAt),
              ),
            )})`,
        })
        .from(slackApps)
        .where(
          and(
            eq(slackApps.workspaceId, workspaceId),
            eq(slackApps.kind, "agent"),
            eq(slackApps.state, "created"),
            inArray(slackApps.agentId, found),
          ),
        )
    ).map((row): [string | null, AgentSlackAction | null] => [
      row.agentId,
      // An uninstalled app keeps its events columns, which the tab no
      // longer shows; installed, the tab leads with an unverified URL's
      // notice, then the home step, then Advanced's failed events row.
      !row.installed
        ? row.botToken
          ? "reinstall"
          : "install"
        : row.eventsState === "pending" && row.eventsSent
          ? "events_unverified"
          : !row.home
            ? "home_unset"
            : row.eventsState === "failed"
              ? "events_failed"
              : null,
    ]),
  );

  const connections = new Map(heads.map((head) => [head.id, head.connection]));
  const models = new Map(heads.map((head) => [head.id, head.model]));
  const labels = new Map(
    heads.map((head) => [
      head.id,
      head.releasedAt ? releaseLabel(head.releasedAt, head.earlier) : null,
    ]),
  );
  const summaries = new Map<string, AgentSummary>();
  for (const version of versions) {
    const capabilities = storedAgentCapabilitiesSchema.parse(
      version.capabilities,
    );
    const settings = mcpSettings.get(version.agentId);
    summaries.set(version.agentId, {
      version: {
        version_no: version.versionNo,
        role: version.role,
        instructions:
          version.instructions === null ? null : clip(version.instructions),
        mcp_servers:
          settings === undefined
            ? (capabilities.mcp ?? []).map((mcp) => mcp.server)
            : settings.server === null
              ? []
              : [settings.server],
        credential_refs:
          settings === undefined
            ? (capabilities.credential_refs ?? [])
            : settings.credentialRefs,
      },
      connection_id: connections.get(version.agentId) ?? null,
      release_label: labels.get(version.agentId) ?? null,
      release_model: models.get(version.agentId) ?? null,
      bound_credential_refs: bound.get(version.agentId) ?? [],
      admins: admins.get(version.agentId) ?? [],
      needs_input_count: live.get(version.agentId)?.needsInput ?? 0,
      running_count: live.get(version.agentId)?.running ?? 0,
      slack_action: slack.get(version.agentId) ?? null,
    });
  }
  return summaries;
}
