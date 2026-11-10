import {
  effectiveGitHubPolicy,
  GITHUB_MCP_FIXED_TOOLS,
  githubMcpToolNames,
  githubMcpTools,
  githubPolicySourceOf,
  type ReceiptActor,
} from "@werft-ai/contracts";
import {
  deniedMcpTools,
  type EffectiveMcp,
  effectiveMcp,
  type GitHubMcpStore,
  type McpEgressStore,
  type McpRefusalRecord,
  type McpSessionState,
  mcpCallDenied,
  mcpDenyOf,
  pinnedMcpTools,
  SavedRulesUnavailable,
  type SessionGitHubMcp,
  type SessionMcp,
  visibleMcpTools,
} from "@werft-ai/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import { mcpDeniedBy } from "./claim-engine-settings.ts";
import { githubPolicyColumns, githubPolicyOfRow } from "./github-settings.ts";
import { mcpSettingsOfRelease } from "./mcp-settings.ts";
import type { Database } from "./queries.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  agentVersions,
  credentialBindings,
  receipts,
  sessions,
  turns,
  workspaces,
} from "./schema.ts";

type ReleaseMcp = {
  agentId: string;
  server: string | null;
  perTool: Record<string, string>;
  deny: string[];
};

// Read off the stored card and pins without the full schemas: a release is
// immutable and was parsed whole when it was made.
async function releaseMcpOf(
  executor: Database,
  releaseId: string,
): Promise<ReleaseMcp | null> {
  const [release] = await executor
    .select({
      agentId: agentReleases.agentId,
      card: agentVersions.card,
      policyPins: agentReleases.policyPins,
      snapshot: agentReleases.runtimeConfigSnapshot,
    })
    .from(agentReleases)
    .innerJoin(
      agentVersions,
      and(
        eq(agentVersions.id, agentReleases.versionId),
        eq(agentVersions.agentId, agentReleases.agentId),
      ),
    )
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  if (!release) return null;
  const card = release.card as {
    capabilities?: { mcp?: Array<{ server?: unknown }> | null };
  };
  const server = card.capabilities?.mcp?.[0]?.server;
  const pins = release.policyPins as {
    tools?: { per_tool?: Record<string, string> };
  };
  return {
    agentId: release.agentId,
    server: typeof server === "string" ? server : null,
    perTool: pins.tools?.per_tool ?? {},
    deny: mcpDenyOf(release.snapshot),
  };
}

/**
 * The server and tools a session's MCP route holds: its release's, or its
 * agent's settings when it started with a snapshot of them (`effectiveMcp`).
 */
async function sessionEffectiveMcp(
  executor: Database,
  session: { agentReleaseId: string; mcpStart: unknown },
  release: ReleaseMcp,
): Promise<EffectiveMcp> {
  return effectiveMcp({
    start: session.mcpStart,
    row: await mcpSettingsOfRelease(executor, session.agentReleaseId),
    release: {
      server: release.server,
      tools:
        release.server === null
          ? []
          : pinnedMcpTools(release.server, release.perTool),
      deny:
        release.server === null
          ? release.deny
          : [
              ...release.deny,
              ...deniedMcpTools(release.server, release.perTool),
            ],
    },
  });
}

/**
 * The MCP server a claimed session may reach, for its claim. A session whose
 * settings name no server gets no route.
 */
export async function sessionMcpOf(
  executor: Database,
  session: { agentReleaseId: string | null; mcpStart: unknown },
): Promise<SessionMcp | null> {
  if (session.agentReleaseId === null) return null;
  const release = await releaseMcpOf(executor, session.agentReleaseId);
  if (release === null) return null;
  const effective = await sessionEffectiveMcp(
    executor,
    { agentReleaseId: session.agentReleaseId, mcpStart: session.mcpStart },
    release,
  );
  if (effective.server === null) return null;
  return {
    releaseId: session.agentReleaseId,
    server: effective.server,
    tools: effective.tools,
  };
}

/**
 * The built-in `github` server of a claimed session. A `release` session gets
 * what its pin exposes. Any other is attached whole whatever its settings say
 * now: they may change under a running session, and each call judges them.
 */
export async function sessionGitHubMcpOf(
  executor: Database,
  session: { agentReleaseId: string | null; githubPolicySource: string },
): Promise<SessionGitHubMcp | null> {
  if (session.agentReleaseId === null) return null;
  if (githubPolicySourceOf(session.githubPolicySource) !== "release") {
    return {
      releaseId: session.agentReleaseId,
      tools: githubMcpToolNames(GITHUB_MCP_FIXED_TOOLS),
    };
  }
  const [release] = await executor
    .select({ pin: sql<unknown>`${agentReleases.policyPins} -> 'github'` })
    .from(agentReleases)
    .where(eq(agentReleases.id, session.agentReleaseId))
    .limit(1);
  if (!release) return null;
  const { settings } = effectiveGitHubPolicy({
    source: "release",
    releasePin: release.pin,
    agentRow: null,
  });
  // A pin this image cannot read exposes nothing rather than guessing.
  if (settings === null || settings === "invalid") return null;
  return {
    releaseId: session.agentReleaseId,
    tools: githubMcpToolNames(githubMcpTools(settings)),
  };
}

export function creatorOf(
  session: { createdByUserId: string | null; createdByApiKeyId: string | null },
  agentId: string | null,
): ReceiptActor | null {
  if (session.createdByApiKeyId !== null) {
    return {
      principal: { kind: "api_key", id: session.createdByApiKeyId },
      actor_user_id: session.createdByUserId,
      agent_id: agentId,
    };
  }
  if (session.createdByUserId !== null) {
    return {
      principal: { kind: "user", id: session.createdByUserId },
      actor_user_id: session.createdByUserId,
      agent_id: agentId,
    };
  }
  return null;
}

/** What the built-in `github` server is judged on, read fresh per exchange. */
async function withoutSavedMcpDenies(
  db: Database,
  session: {
    workspaceId: string | null;
    agentReleaseId: string | null;
    engineSettingsStart: unknown;
  },
  server: string | null,
  tools: readonly string[],
): Promise<readonly string[]> {
  const denied = await mcpDeniedBy(db, session);
  if (denied === null || server === null) return [];
  return visibleMcpTools(server, tools, denied);
}

async function blockedGitHubTools(
  db: Database,
  session: {
    workspaceId: string | null;
    agentReleaseId: string | null;
    engineSettingsStart: unknown;
  },
): Promise<string[]> {
  let denied: string[] | null;
  try {
    denied = await mcpDeniedBy(db, session);
  } catch (cause) {
    throw new SavedRulesUnavailable({ cause });
  }
  return GITHUB_MCP_FIXED_TOOLS.filter(
    (tool) =>
      denied === null ||
      mcpCallDenied(denied, githubMcpToolNames([tool])[0] as string),
  );
}

export function createPostgresGitHubMcpStore(db: Database): GitHubMcpStore {
  return {
    async sessionState(sessionId) {
      const [session] = await db
        .select({
          ownerId: sessions.ownerId,
          agentReleaseId: sessions.agentReleaseId,
          createdByUserId: sessions.createdByUserId,
          createdByApiKeyId: sessions.createdByApiKeyId,
          workspaceId: sessions.workspaceId,
          engineSettingsStart: sessions.engineSettingsStart,
          agentId: agentReleases.agentId,
          enabled: agents.githubEnabled,
          ...githubPolicyColumns,
        })
        .from(sessions)
        .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .leftJoin(agents, eq(agents.id, agentReleases.agentId))
        .leftJoin(
          agentGitHubSettings,
          eq(agentGitHubSettings.agentId, agents.id),
        )
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!session || session.agentReleaseId === null) return null;
      const policy = githubPolicyOfRow(session);
      return {
        ownerId: session.ownerId,
        agentId: session.agentId,
        releaseId: session.agentReleaseId,
        source: policy.source,
        github: policy.settings === "invalid" ? null : policy.settings,
        // Off now, or off as the session started: both close it.
        enabled: (session.enabled ?? false) && policy.enabledAtStart,
        blockedTools: await blockedGitHubTools(db, session),
        actor: creatorOf(session, session.agentId),
      };
    },

    async runningTurn(input) {
      const [turn] = await db
        .select({ id: turns.id })
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, input.sessionId),
            eq(turns.attemptId, input.attemptId),
            eq(turns.status, "running"),
          ),
        )
        .limit(1);
      return turn?.id ?? null;
    },
  };
}

export function createPostgresMcpEgressStore(db: Database): McpEgressStore {
  return {
    async sessionState(input): Promise<McpSessionState | null> {
      const [session] = await db
        .select({
          ownerId: sessions.ownerId,
          workspaceId: sessions.workspaceId,
          workspaceSlug: workspaces.slug,
          agentReleaseId: sessions.agentReleaseId,
          createdByUserId: sessions.createdByUserId,
          createdByApiKeyId: sessions.createdByApiKeyId,
          mcpStart: sessions.mcpStart,
          engineSettingsStart: sessions.engineSettingsStart,
        })
        .from(sessions)
        .leftJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
        .where(eq(sessions.id, input.sessionId))
        .limit(1);
      if (!session || session.agentReleaseId === null) return null;
      const release = await releaseMcpOf(db, session.agentReleaseId);
      if (release === null) return null;
      const effective = await sessionEffectiveMcp(
        db,
        { agentReleaseId: session.agentReleaseId, mcpStart: session.mcpStart },
        release,
      );
      const bound =
        session.workspaceId === null
          ? []
          : await db
              .select({ ref: credentialBindings.credentialRef })
              .from(credentialBindings)
              .where(
                and(
                  eq(credentialBindings.workspaceId, session.workspaceId),
                  eq(credentialBindings.target, "agent"),
                  eq(credentialBindings.targetId, release.agentId),
                  isNull(credentialBindings.revokedAt),
                ),
              );
      const [turn] = await db
        .select({ sequence: turns.sequence })
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, input.sessionId),
            eq(turns.attemptId, input.attemptId),
            eq(turns.status, "running"),
          ),
        )
        .limit(1);
      return {
        ownerId: session.ownerId,
        workspaceSlug: session.workspaceSlug,
        agentId: release.agentId,
        releaseId: session.agentReleaseId,
        server: effective.server,
        // Saved `mcp__` denies are enforced here, per call and from the rows
        // as they are now: the claim's `tools` is in the checkpoint
        // fingerprint and stays what the release allows. Unreadable rules
        // allow nothing. A failed read throws, so the caller answers
        // retryably and nothing has been forwarded yet.
        tools: await withoutSavedMcpDenies(
          db,
          session,
          effective.server,
          effective.tools,
        ),
        boundRefs: bound.map((row) => row.ref),
        turnId: turn === undefined ? null : String(turn.sequence),
        actor: creatorOf(session, release.agentId),
      };
    },

    async recordRefusal(record: McpRefusalRecord): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .insert(receipts)
          .values({
            id: record.id,
            ownerId: record.ownerId,
            operation: "call_mcp",
            targetRef: {
              session_id: record.sessionId,
              turn_id: record.turnId,
              request_id: null,
            },
            status: record.status,
            result: record.result,
            error: { code: "CREDENTIAL_UNBOUND", message: record.message },
            actor: record.actor,
          })
          .onConflictDoNothing({ target: receipts.id });
      });
    },
  };
}
