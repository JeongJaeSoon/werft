import {
  agentGitHubSchema,
  effectiveGitHubPolicy,
  GITHUB_MCP_FIXED_TOOLS,
  type GitHubCeiling,
  githubMcpToolNames,
  githubMcpTools,
  githubPolicySourceOf,
  type ReceiptActor,
  retiredCatalogServerOf,
} from "@werft-ai/contracts";
import {
  deniedMcpTools,
  type EffectiveMcp,
  effectiveMcp,
  type GitHubMcpStore,
  type McpEgressStore,
  type McpRefusalRecord,
  type McpSessionState,
  mcpDenyOf,
  pinnedMcpTools,
  type RefusalRecord,
  type RetiredSessionMcp,
  type SessionGitHubMcp,
  visibleMcpTools,
} from "@werft-ai/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import { retiredMcpSettingsOf } from "../agents/index.ts";
import type { Database } from "../queries.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  agentVersions,
  credentialBindings,
  receipts,
  retiredCatalogMcp,
  sessions,
  turns,
  workspaces,
} from "../schema.ts";
import {
  githubPolicyColumns,
  githubPolicyOfRow,
  workspaceFeatureCeiling,
} from "./github-settings.ts";

type ReleaseMcp = {
  agentId: string;
  /** The retired catalog server the card names (`retiredCatalogServerOf`). */
  retired: string | null;
  perTool: Record<string, string>;
  deny: string[];
};

// Read off the stored card and pins without the full schemas: a release is
// immutable and was parsed whole when it was made.
export async function releaseMcpOf(
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
  const pins = release.policyPins as {
    tools?: { per_tool?: Record<string, string> };
  };
  return {
    agentId: release.agentId,
    retired: retiredCatalogServerOf(release.card),
    perTool: pins.tools?.per_tool ?? {},
    deny: mcpDenyOf(release.snapshot),
  };
}

/**
 * The catalog server and tools a claim gave the session before migration
 * 0304 retired them, from the inputs it read then: the session's snapshot
 * of the agent's selection, the selection's retired row, and the release.
 */
async function retiredEffectiveMcp(
  executor: Database,
  session: { mcpStart: unknown },
  release: ReleaseMcp,
): Promise<EffectiveMcp> {
  return effectiveMcp({
    start: session.mcpStart,
    row: await retiredMcpSettingsOf(executor, release.agentId),
    release: {
      server: release.retired,
      tools:
        release.retired === null
          ? []
          : pinnedMcpTools(release.retired, release.perTool),
      deny: [...release.deny, ...deniedMcpTools(release.perTool)],
    },
  });
}

/**
 * The retired catalog server of a claimed session, for its restore configs
 * only; null when the claim gave it none, or the server was not a catalog
 * row migration 0304 recorded.
 */
export async function retiredSessionMcpOf(
  executor: Database,
  session: {
    agentReleaseId: string | null;
    mcpStart: unknown;
    createdAt: Date;
  },
): Promise<RetiredSessionMcp | null> {
  if (session.agentReleaseId === null) return null;
  const release = await releaseMcpOf(executor, session.agentReleaseId);
  if (release === null) return null;
  const effective = await retiredEffectiveMcp(executor, session, release);
  if (effective.server === null) return null;
  const [retired] = await executor
    .select({
      url: retiredCatalogMcp.url,
      credentialRef: retiredCatalogMcp.credentialRef,
      retiredAt: retiredCatalogMcp.retiredAt,
    })
    .from(retiredCatalogMcp)
    .where(eq(retiredCatalogMcp.name, effective.server))
    .limit(1);
  if (retired === undefined) return null;
  return {
    releaseId: session.agentReleaseId,
    server: effective.server,
    url: retired.url,
    credentialRef: retired.credentialRef,
    tools: effective.tools,
    restorable: session.createdAt < retired.retiredAt,
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
  const tools = githubMcpToolNames(githubMcpTools(settings));
  const pinned = agentGitHubSchema.safeParse(release.pin);
  const pinTools = pinned.success
    ? githubMcpToolNames(githubMcpTools(pinned.data))
    : tools;
  return {
    releaseId: session.agentReleaseId,
    tools,
    ...(pinTools.join() === tools.join() ? {} : { pinTools }),
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

/**
 * The ceiling of the workspace the gate judges (the agent's, else the
 * session's), for a refusal to name where a switch is off. A read that fails
 * leaves it unread: the gate still holds the line.
 */
async function ceilingFor(
  db: Database,
  workspaceId: string | null,
): Promise<{ ceiling?: GitHubCeiling }> {
  if (workspaceId === null) return {};
  try {
    return { ceiling: await workspaceFeatureCeiling(db, workspaceId) };
  } catch {
    return {};
  }
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
          agentWorkspaceId: agents.workspaceId,
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
        ...(await ceilingFor(
          db,
          session.agentWorkspaceId ?? session.workspaceId,
        )),
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

/**
 * A refusal's receipt, in a transaction of its own: one that cannot be
 * written must not turn the refusal into an outage. The same id twice is one
 * receipt.
 */
export async function recordMcpRefusal(
  db: Database,
  record: RefusalRecord<unknown>,
): Promise<void> {
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
}

/** The public id of the turn the attempt is running; null between turns. */
export async function runningTurnId(
  db: Database,
  input: { sessionId: string; attemptId: string },
): Promise<string | null> {
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
  return turn === undefined ? null : String(turn.sequence);
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
        })
        .from(sessions)
        .leftJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
        .where(eq(sessions.id, input.sessionId))
        .limit(1);
      if (!session || session.agentReleaseId === null) return null;
      const release = await releaseMcpOf(db, session.agentReleaseId);
      if (release === null) return null;
      // A call still naming the retired server finds it in no catalog and is
      // refused as `catalog_moved`.
      const effective = await retiredEffectiveMcp(db, session, release);
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
      const turnId = await runningTurnId(db, input);
      return {
        ownerId: session.ownerId,
        workspaceSlug: session.workspaceSlug,
        agentId: release.agentId,
        releaseId: session.agentReleaseId,
        server: effective.server,
        tools:
          effective.server === null
            ? []
            : visibleMcpTools(effective.server, effective.tools),
        boundRefs: bound.map((row) => row.ref),
        turnId,
        actor: creatorOf(session, release.agentId),
      };
    },

    recordRefusal: (record: McpRefusalRecord) => recordMcpRefusal(db, record),
  };
}
