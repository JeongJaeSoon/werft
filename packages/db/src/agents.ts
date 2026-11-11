import { randomUUID } from "node:crypto";
import {
  type Agent,
  type AgentRelease,
  type AgentStatus,
  type AgentVersion,
  agentReleaseSchema,
  behaviorKey,
  type ListAgentsResponse,
  type ModelSource,
  type ReceiptOperation,
  storedAgentCardSchema,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  ActivateResult,
  AgentRecord,
  AgentStore,
  Principal,
  SavedBehavior,
} from "@werft-ai/platform";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  max,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agentSummaries } from "./agent-summaries.ts";
import { earlierInSecond, releaseLabel } from "./agents/release-labels.ts";
import {
  actorStillMember,
  containsPattern,
  receiptActorOf,
} from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import {
  administers,
  agentReadable,
  agentUsable,
  credentialsAllowed,
  insideAgent,
  liveMember,
} from "./musterrolle/administers.ts";
import { managingTeamAllowed } from "./musterrolle/agent-admins.ts";
import { holdsRight, lockedRole } from "./musterrolle/api-keys.ts";
import { enqueueModelMoveNotices } from "./musterrolle/model-move-notices.ts";
import {
  isNewestProfile,
  openRolloutStep,
  resolveFailedItems,
  runsLineageOf,
} from "./profile-rollouts.ts";
import type { Database } from "./queries.ts";
import {
  agentActivationEvents,
  agentAdmins,
  agentGitHubSettings,
  agentReleases,
  agents,
  agentUsage,
  agentVersions,
  memberTeams,
  receipts,
} from "./schema.ts";
import {
  decodeCreatedAtCursor,
  encodeCreatedAtCursor,
  rethrowCursorCastError,
} from "./sessions/cursors.ts";
import { recordToolUnlockItem } from "./tool-unlock.ts";

type AgentRow = typeof agents.$inferSelect;

/** The managing team's name beside an agents row; a deleted team keeps its name. */
export const managingTeamName = sql<string>`(select ${memberTeams.name} from ${memberTeams} where ${memberTeams.id} = ${agents.managingTeamId} and ${memberTeams.workspaceId} = ${agents.workspaceId})`;
type VersionRow = typeof agentVersions.$inferSelect;
type ReleaseRow = typeof agentReleases.$inferSelect;

const newer = alias(agentReleases, "newer");

/** A release of the agent made after this one has been activated. */
export async function releaseSuperseded(
  db: Database,
  agentId: string,
  releaseId: string,
  workspaceId?: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: newer.id })
    .from(newer)
    .innerJoin(agents, eq(agents.id, newer.agentId))
    .innerJoin(
      agentReleases,
      and(
        eq(agentReleases.agentId, newer.agentId),
        eq(agentReleases.id, releaseId),
      ),
    )
    .where(
      and(
        eq(newer.agentId, agentId),
        workspaceId === undefined
          ? undefined
          : eq(agents.workspaceId, workspaceId),
        isNotNull(newer.approvedAt),
        gt(newer.createdAt, agentReleases.createdAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export function agentOf(row: AgentRow, managingTeamName: string): Agent {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    managing_team_id: row.managingTeamId,
    managing_team_name: managingTeamName,
    status: row.status as Agent["status"],
    active_release_id: row.activeReleaseId,
    activation_revision: row.activationRevision,
    auto_model_migration: row.autoModelMigration,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function versionOf(row: VersionRow): AgentVersion {
  return {
    id: row.id,
    agent_id: row.agentId,
    version_no: row.versionNo,
    card: storedAgentCardSchema.parse(row.card),
    content_sha256: row.contentSha256,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}

type ActivationSpan = Pick<AgentRelease, "activated_at" | "deactivated_at">;

// Each activation ends the one before it; a release's latest one counts.
async function activationSpans(
  db: Database,
  agentIds: readonly string[],
): Promise<Map<string, ActivationSpan>> {
  const spans = new Map<string, ActivationSpan>();
  if (agentIds.length === 0) return spans;
  const events = await db
    .select({
      agentId: agentActivationEvents.agentId,
      releaseId: agentActivationEvents.releaseId,
      at: agentActivationEvents.createdAt,
    })
    .from(agentActivationEvents)
    .where(
      and(
        inArray(agentActivationEvents.agentId, [...agentIds]),
        eq(agentActivationEvents.kind, "activated"),
      ),
    )
    .orderBy(
      asc(agentActivationEvents.agentId),
      asc(agentActivationEvents.activationRevision),
    );
  events.forEach((event, index) => {
    const next = events[index + 1];
    spans.set(event.releaseId, {
      activated_at: event.at.toISOString(),
      deactivated_at:
        next?.agentId === event.agentId ? next.at.toISOString() : null,
    });
  });
  return spans;
}

async function readReleases(
  db: Database,
  where: SQL | undefined,
): Promise<AgentRelease[]> {
  const rows = await db
    .select({
      release: agentReleases,
      earlier: earlierInSecond(agentReleases),
    })
    .from(agentReleases)
    .innerJoin(agents, eq(agents.id, agentReleases.agentId))
    .where(where)
    .orderBy(asc(agentReleases.createdAt), asc(agentReleases.id));
  const spans = await activationSpans(db, [
    ...new Set(rows.map(({ release }) => release.agentId)),
  ]);
  return rows.map(({ release, earlier }) =>
    releaseOf(release, earlier, spans.get(release.id)),
  );
}

function releaseOf(
  row: ReleaseRow,
  earlier: number,
  span: ActivationSpan | undefined,
): AgentRelease {
  return agentReleaseSchema.parse({
    id: row.id,
    agent_id: row.agentId,
    version_id: row.versionId,
    card_sha256: row.cardSha256,
    runtime_profile_id: row.runtimeProfileId,
    repository_id: row.repositoryId,
    profile_digest: row.profileDigest,
    runtime_config_snapshot: row.runtimeConfigSnapshot,
    effective_tools: row.effectiveTools,
    policy_pins: row.policyPins,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    approved_by: row.approvedBy,
    approved_at: row.approvedAt?.toISOString() ?? null,
    note: row.note,
    label: releaseLabel(row.createdAt, earlier),
    activated_at: span?.activated_at ?? null,
    deactivated_at: span?.deactivated_at ?? null,
  });
}

async function detailOf(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<AgentRecord | null> {
  const [row] = await db
    .select({ agent: agents, teamName: managingTeamName })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;
  const { agent } = row;
  const versions = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agent.id))
    .orderBy(asc(agentVersions.versionNo));
  const releases = await readReleases(db, eq(agentReleases.agentId, agent.id));
  return {
    agent: agentOf(agent, row.teamName),
    versions: versions.map(versionOf),
    releases,
    active_release:
      releases.find((release) => release.id === agent.activeReleaseId) ?? null,
    behavior_revision: agent.behaviorRevision,
    model_source: agent.modelSource as ModelSource,
    profile_tracking: agent.profileTracking === "pinned" ? "pinned" : "follow",
    profile_rollout: await openRolloutStep(db, agent.id, agent.activeReleaseId),
    draft:
      agent.draftVersionId === null ||
      agent.draftProfileId === null ||
      agent.draftModelSource === null
        ? null
        : {
            version_id: agent.draftVersionId,
            runtime_profile_id: agent.draftProfileId,
            model_source: agent.draftModelSource as ModelSource,
            failure: agent.draftFailure,
          },
  };
}

/**
 * What the active release runs, as `behaviorKey` reads it: the card of its
 * version with the model its snapshot pins, on its profile.
 */
async function activeBehaviorKey(
  tx: Database,
  releaseId: string | null,
): Promise<string | null> {
  if (releaseId === null) return null;
  const [row] = await tx
    .select({
      profileId: agentReleases.runtimeProfileId,
      snapshot: agentReleases.runtimeConfigSnapshot,
      card: agentVersions.card,
    })
    .from(agentReleases)
    .innerJoin(agentVersions, eq(agentVersions.id, agentReleases.versionId))
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  if (!row) return null;
  const model = (row.snapshot as { model?: unknown }).model;
  if (typeof model !== "string") return null;
  return behaviorKey(
    storedAgentCardSchema.parse(row.card),
    model,
    row.profileId,
  );
}

async function writeReceipt(
  tx: Database,
  principal: Principal,
  input: {
    operation: ReceiptOperation;
    workspaceId: string;
    agentId: string;
    result?: unknown;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: principal.ownerId,
    actor: receiptActorOf(principal),
    operation: input.operation,
    targetRef: {
      resource: { kind: "agent", id: input.agentId },
      workspace_id: input.workspaceId,
    },
    status: "succeeded",
    result: input.result ?? null,
  });
  return id;
}

/**
 * The release's GitHub settings for its receipt, and whether they differ
 * from `previousReleaseId`'s, so the agent's GitHub activity lists only the
 * releases and activations that moved them.
 */
async function githubChange(
  tx: Database,
  releaseId: string,
  previousReleaseId: string | null,
) {
  const [row] = await tx
    .select({
      github: sql<unknown>`${agentReleases.policyPins} -> 'github'`,
      changed: sql<boolean>`(${agentReleases.policyPins} -> 'github') IS DISTINCT FROM (SELECT p.policy_pins -> 'github' FROM agent_releases p WHERE p.id = ${previousReleaseId})`,
    })
    .from(agentReleases)
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  return { github: row?.github ?? null, github_changed: row?.changed ?? false };
}

async function lockAgent(tx: Database, workspaceId: string, agentId: string) {
  const [agent] = await tx
    .select({
      id: agents.id,
      activeReleaseId: agents.activeReleaseId,
      activationRevision: agents.activationRevision,
      behaviorRevision: agents.behaviorRevision,
      modelSource: agents.modelSource,
      profileTracking: agents.profileTracking,
      draftVersionId: agents.draftVersionId,
      autoModelMigration: agents.autoModelMigration,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1)
    .for("update");
  return agent;
}

/**
 * The agent row for a change to its settings, with the acting person's right
 * to make it read again under locks: their membership first, then the agent,
 * then what `holdsRight` rests on (agent-rbac R1). A managing-team change or
 * a lead's demotion committed after the policy's decision is seen here, or
 * waits for this write.
 */
export async function lockAgentToChange(
  tx: Database,
  input: {
    principal: Principal;
    workspaceId: string;
    managerRoles: readonly WorkspaceRole[];
    requireRoles?: readonly WorkspaceRole[];
  },
  agentId: string,
): Promise<
  | { agent: NonNullable<Awaited<ReturnType<typeof lockAgent>>> }
  | { outcome: "actor_inactive" | "outranked" | "not_found" }
> {
  const userId = input.principal.actor?.userId;
  // No person behind the principal: nothing to re-read, as actorStillMember.
  const role = userId ? await lockedRole(tx, input.workspaceId, userId) : null;
  if (userId && role === null) return { outcome: "actor_inactive" };
  if (
    input.requireRoles !== undefined &&
    (role === null || !input.requireRoles.includes(role))
  ) {
    return { outcome: userId ? "outranked" : "actor_inactive" };
  }
  const agent = await lockAgent(tx, input.workspaceId, agentId);
  if (!agent) return { outcome: "not_found" };
  if (
    userId &&
    role !== null &&
    !(await holdsRight(tx, input.workspaceId, userId, {
      role,
      roles: input.managerRoles,
      agentId: agent.id,
    }))
  ) {
    return { outcome: "outranked" };
  }
  return { agent };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A private agent the reader may not use is not in their list or counts, the
// same predicate the start decision and /v1/usable-agents read (94S-1512).
function visibleTo(
  db: Database,
  workspaceId: string,
  userId: string,
  outsideAccess: Parameters<typeof agentReadable>[4],
) {
  return and(
    agentReadable(db, workspaceId, userId, agents.id, outsideAccess),
    agentUsable(db, workspaceId, { userId, keyAgentId: null }, agents.id),
  );
}

export function createPostgresAgentStore(db: Database): AgentStore {
  return {
    async list(workspaceId, query, reader): Promise<ListAgentsResponse> {
      const cursor = query.cursor ? decodeCreatedAtCursor(query.cursor) : null;
      const rows = await db
        .select({
          agent: agents,
          teamName: managingTeamName,
          cursorAt: sql<string>`${agents.createdAt}::text`,
        })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            visibleTo(
              db,
              workspaceId,
              reader.userId.toLowerCase(),
              reader.outsideAccess,
            ),
            query.q === undefined
              ? undefined
              : or(
                  sql`${agents.name} ILIKE ${containsPattern(query.q)}`,
                  sql`${agents.slug} ILIKE ${containsPattern(query.q)}`,
                ),
            query.ids === undefined
              ? undefined
              : inArray(
                  agents.id,
                  query.ids.map((id) => id.toLowerCase()),
                ),
            // The release's profile is a setting: filtering on it keeps only
            // the agents whose settings the reader reads, so the rows never
            // tell anyone else which profile an agent runs.
            query.runtime_profile_id === undefined
              ? undefined
              : and(
                  insideAgent(
                    db,
                    workspaceId,
                    reader.userId.toLowerCase(),
                    agents.id,
                  ),
                  sql`exists (select 1 from ${agentReleases} where ${agentReleases.id} = ${agents.activeReleaseId} and ${agentReleases.agentId} = ${agents.id} and ${agentReleases.runtimeProfileId} = ${query.runtime_profile_id})`,
                ),
            cursor
              ? sql`(${agents.createdAt}, ${agents.id}) > (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(agents.createdAt), asc(agents.id))
        .limit(query.limit + 1)
        .catch(rethrowCursorCastError);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => agentOf(row.agent, row.teamName)),
        next_cursor:
          rows.length > query.limit && last
            ? encodeCreatedAtCursor({
                created_at: last.cursorAt,
                id: last.agent.id,
              })
            : null,
      };
    },

    async listUsable(workspaceId, who, limit) {
      const keyAgentId =
        who.keyAgentId !== null && UUID.test(who.keyAgentId)
          ? who.keyAgentId.toLowerCase()
          : null;
      // A key bound to an agent reaches that agent and nothing else.
      if (who.keyAgentId !== null && keyAgentId === null) return [];
      const rows = await db
        .select({ agent: agents, teamName: managingTeamName })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            eq(agents.status, "active"),
            isNotNull(agents.activeReleaseId),
            keyAgentId === null ? undefined : eq(agents.id, keyAgentId),
            agentUsable(db, workspaceId, who, agents.id),
            credentialsAllowed(workspaceId, who.userId, agents.id),
            // Axis A: outside an agent a start needs `use`, as the policy has it.
            // An agent key is inside its own agent, the only one it lists.
            who.outsideUse || keyAgentId !== null
              ? undefined
              : who.userId === null
                ? sql`false`
                : insideAgent(
                    db,
                    workspaceId,
                    who.userId.toLowerCase(),
                    agents.id,
                  ),
          ),
        )
        .orderBy(asc(agents.createdAt), asc(agents.id))
        .limit(limit);
      return rows.map((row) => agentOf(row.agent, row.teamName));
    },

    async count(workspaceId, reader) {
      const person = reader.userId.toLowerCase();
      const [row] = await db
        .select({
          all: sql<number>`count(*)::int`,
          administered: sql<number>`(count(*) filter (where ${and(
            administers(db, workspaceId, person, agents.id),
            liveMember(db, workspaceId, person),
          )}))::int`,
          active: sql<number>`(count(*) filter (where ${agents.status} = 'active' and ${agents.activeReleaseId} is not null))::int`,
          draft: sql<number>`(count(*) filter (where ${agents.status} <> 'archived' and ${agents.activeReleaseId} is null))::int`,
        })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            visibleTo(db, workspaceId, person, reader.outsideAccess),
          ),
        );
      return {
        all: row?.all ?? 0,
        administered: row?.administered ?? 0,
        active: row?.active ?? 0,
        draft: row?.draft ?? 0,
      };
    },

    summaries: (workspaceId, agentIds, viewer) =>
      agentSummaries(db, workspaceId, agentIds, viewer),

    get: (workspaceId, agentId) => detailOf(db, workspaceId, agentId),

    async findVersion(workspaceId, agentId, versionId) {
      const [row] = await db
        .select({ version: agentVersions })
        .from(agentVersions)
        .innerJoin(agents, eq(agents.id, agentVersions.agentId))
        .where(
          and(
            eq(agentVersions.id, versionId),
            eq(agents.id, agentId),
            eq(agents.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      return row ? versionOf(row.version) : null;
    },

    async findRelease(workspaceId, releaseId) {
      const [release] = await readReleases(
        db,
        and(
          eq(agentReleases.id, releaseId),
          eq(agents.workspaceId, workspaceId),
        ),
      );
      return release ?? null;
    },

    async agentStatus(workspaceId, agentId) {
      const [row] = await db
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
        .limit(1);
      return (row?.status as AgentStatus | undefined) ?? null;
    },

    releaseSuperseded: (workspaceId, agentId, releaseId) =>
      releaseSuperseded(db, agentId, releaseId, workspaceId),

    create(input) {
      return db.transaction(async (tx) => {
        if (!(await actorStillMember(tx, input.principal))) {
          return { outcome: "actor_inactive" };
        }
        const role = await lockedRole(tx, input.workspaceId, input.createdBy);
        if (role === null) return { outcome: "actor_inactive" };
        const allowed = await managingTeamAllowed(
          tx,
          input.workspaceId,
          input.managingTeam.id,
          {
            userId: input.createdBy,
            manager: input.managingTeam.managerRoles.includes(role),
          },
        );
        if (allowed !== "ok") return { outcome: allowed };
        const agentId = randomUUID();
        const inserted = await tx
          .insert(agents)
          .values({
            id: agentId,
            workspaceId: input.workspaceId,
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            managingTeamId: input.managingTeam.id.toLowerCase(),
            createdBy: input.createdBy,
          })
          .onConflictDoNothing({
            target: [agents.workspaceId, agents.slug],
          })
          .returning({ id: agents.id });
        if (inserted.length === 0) return { outcome: "slug_taken" };
        await tx.insert(agentVersions).values({
          id: randomUUID(),
          agentId,
          versionNo: 1,
          card: input.card,
          contentSha256: input.contentSha256,
          createdBy: input.createdBy,
        });
        // Every agent starts usable by the whole workspace (94S-900).
        await tx.insert(agentUsage).values({
          agentId,
          workspaceId: input.workspaceId,
          updatedBy: input.createdBy,
        });
        // D3: whoever creates an agent administers it.
        await tx.insert(agentAdmins).values({
          workspaceId: input.workspaceId,
          agentId,
          userId: input.createdBy,
          createdBy: input.createdBy,
        });
        await writeReceipt(tx, input.principal, {
          operation: "create_agent",
          workspaceId: input.workspaceId,
          agentId,
          result: {
            managing_team_id: input.managingTeam.id.toLowerCase(),
          },
        });
        const detail = await detailOf(tx, input.workspaceId, agentId);
        if (!detail) throw new Error(`agent ${agentId} vanished in its tx`);
        return { outcome: "created", detail };
      });
    },

    update(input) {
      return db.transaction(async (tx) => {
        const locked = await lockAgentToChange(tx, input, input.agentId);
        if ("outcome" in locked) return locked;
        const { agent } = locked;
        // Before any write: a request that left values out was built from an
        // agent that has since moved.
        const basedOn = input.behavior?.basedOn;
        if (
          basedOn !== undefined &&
          (agent.behaviorRevision !== basedOn.behaviorRevision ||
            agent.activationRevision !== basedOn.activationRevision)
        ) {
          return { outcome: "stale" };
        }
        let changed = false;
        let saved: SavedBehavior | null = null;
        if (input.name !== undefined) {
          const renamed = await tx
            .update(agents)
            .set({ name: input.name, updatedAt: DB_NOW })
            .where(
              and(
                eq(agents.id, agent.id),
                sql`${agents.name} IS DISTINCT FROM ${input.name}`,
              ),
            )
            .returning({ id: agents.id });
          changed ||= renamed.length > 0;
        }
        if (input.description !== undefined) {
          const described = await tx
            .update(agents)
            .set({ description: input.description, updatedAt: DB_NOW })
            .where(
              and(
                eq(agents.id, agent.id),
                sql`${agents.description} IS DISTINCT FROM ${input.description}`,
              ),
            )
            .returning({ id: agents.id });
          changed ||= described.length > 0;
        }
        let switched: boolean | null = null;
        if (input.autoModelMigration !== undefined) {
          const flipped = await tx
            .update(agents)
            .set({
              autoModelMigration: input.autoModelMigration,
              updatedAt: DB_NOW,
            })
            .where(
              and(
                eq(agents.id, agent.id),
                sql`${agents.autoModelMigration} IS DISTINCT FROM ${input.autoModelMigration}`,
              ),
            )
            .returning({ id: agents.id });
          if (flipped.length > 0) {
            changed = true;
            switched = input.autoModelMigration;
          }
        }
        if (input.card !== undefined) {
          const [latest] = await tx
            .select({ versionNo: max(agentVersions.versionNo) })
            .from(agentVersions)
            .where(eq(agentVersions.agentId, agent.id));
          const added = await tx
            .insert(agentVersions)
            .values({
              id: randomUUID(),
              agentId: agent.id,
              versionNo: (latest?.versionNo ?? 0) + 1,
              card: input.card.card,
              contentSha256: input.card.contentSha256,
              createdBy: input.updatedBy,
            })
            .onConflictDoNothing({
              target: [agentVersions.agentId, agentVersions.contentSha256],
            })
            .returning({ id: agentVersions.id });
          if (added.length > 0) {
            changed = true;
            await tx
              .update(agents)
              .set({ updatedAt: DB_NOW })
              .where(eq(agents.id, agent.id));
          }
          const { behavior } = input;
          if (behavior !== undefined) {
            const [stored] = await tx
              .select({ id: agentVersions.id })
              .from(agentVersions)
              .where(
                and(
                  eq(agentVersions.agentId, agent.id),
                  eq(agentVersions.contentSha256, input.card.contentSha256),
                ),
              )
              .limit(1);
            if (!stored)
              throw new Error(`version of agent ${agent.id} vanished`);
            const same =
              (await activeBehaviorKey(tx, agent.activeReleaseId)) ===
              behaviorKey(
                input.card.card,
                input.card.card.model,
                behavior.runtimeProfileId,
              );
            // Every intent to change behavior takes a revision, a repeat of
            // what runs included: it is what retires a save still in flight.
            const [taken] = await tx
              .update(agents)
              .set({
                behaviorRevision: sql`${agents.behaviorRevision} + 1`,
                updatedAt: DB_NOW,
                ...(same
                  ? {
                      modelSource: behavior.modelSource,
                      draftVersionId: null,
                      draftProfileId: null,
                      draftModelSource: null,
                      draftFailure: null,
                    }
                  : {
                      draftVersionId: stored.id,
                      draftProfileId: behavior.runtimeProfileId,
                      draftModelSource: behavior.modelSource,
                      draftFailure: null,
                    }),
              })
              .where(eq(agents.id, agent.id))
              .returning({ revision: agents.behaviorRevision });
            if (!taken) throw new Error(`agent ${agent.id} vanished in its tx`);
            changed ||= !same;
            saved = {
              status: same ? "unchanged" : "pending",
              versionId: stored.id,
              behaviorRevision: taken.revision,
            };
          }
        }
        if (changed) {
          await writeReceipt(tx, input.principal, {
            operation: "update_agent",
            workspaceId: input.workspaceId,
            agentId: agent.id,
            ...(switched === null
              ? {}
              : { result: { auto_model_migration: switched } }),
          });
        }
        const detail = await detailOf(tx, input.workspaceId, agent.id);
        if (!detail) throw new Error(`agent ${agent.id} vanished in its tx`);
        return { outcome: "updated", detail, saved };
      });
    },

    async recordDraftFailure(input) {
      const failed = await db
        .update(agents)
        .set({ draftFailure: input.failure, updatedAt: DB_NOW })
        .where(
          and(
            eq(agents.id, input.agentId),
            eq(agents.workspaceId, input.workspaceId),
            eq(agents.behaviorRevision, input.behaviorRevision),
            eq(agents.draftVersionId, input.draftVersionId),
          ),
        )
        .returning({ id: agents.id });
      return failed.length > 0;
    },

    followProfile(input) {
      return db.transaction(async (tx) => {
        const locked = await lockAgentToChange(tx, input, input.agentId);
        if ("outcome" in locked) return locked;
        // The judgment that the agent already runs the newest version was
        // made on this revision; a revert since then must not be undone.
        if (
          locked.agent.activationRevision !== input.expectedActivationRevision
        )
          return { outcome: "superseded" as const };
        await tx
          .update(agents)
          .set({ profileTracking: "follow", updatedAt: DB_NOW })
          .where(eq(agents.id, locked.agent.id));
        await resolveFailedItems(tx, locked.agent.id);
        return { outcome: "updated" as const };
      });
    },

    async hasGitHubSettings(agentId) {
      const [row] = await db
        .select({ agentId: agentGitHubSettings.agentId })
        .from(agentGitHubSettings)
        .where(eq(agentGitHubSettings.agentId, agentId.toLowerCase()))
        .limit(1);
      return row !== undefined;
    },

    async modelMigrationCandidates(input) {
      const rows = await db
        .select({
          workspaceId: agents.workspaceId,
          agentId: agents.id,
          profileId: agentReleases.runtimeProfileId,
          model: sql<string>`${agentReleases.runtimeConfigSnapshot} ->> 'model'`,
        })
        .from(agents)
        .innerJoin(agentReleases, eq(agentReleases.id, agents.activeReleaseId))
        .where(
          and(
            eq(agents.status, "active"),
            eq(agents.autoModelMigration, true),
            input.after === null ? undefined : gt(agents.id, input.after),
          ),
        )
        .orderBy(agents.id)
        .limit(input.limit);
      return rows;
    },

    async autoModelMigration(workspaceId, agentId) {
      const [row] = await db
        .select({ on: agents.autoModelMigration })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
        .limit(1);
      return row?.on ?? true;
    },

    async activationActor(workspaceId, agentId, releaseId) {
      const [row] = await db
        .select({ actor: agentActivationEvents.actorUserId })
        .from(agentActivationEvents)
        .where(
          and(
            eq(agentActivationEvents.workspaceId, workspaceId),
            eq(agentActivationEvents.agentId, agentId),
            eq(agentActivationEvents.releaseId, releaseId),
          ),
        )
        .orderBy(desc(agentActivationEvents.createdAt))
        .limit(1);
      return row?.actor ?? null;
    },

    async notifyModelMigrationFailed(input) {
      return await db.transaction(async (tx) => {
        const [agent] = await tx
          .select({
            revision: agents.activationRevision,
            releaseId: agents.activeReleaseId,
          })
          .from(agents)
          .where(
            and(
              eq(agents.id, input.agentId),
              eq(agents.workspaceId, input.workspaceId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          !agent ||
          agent.revision !== input.revision ||
          agent.releaseId !== input.releaseId
        ) {
          return 0;
        }
        return await enqueueModelMoveNotices(tx, {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          kind: "failed",
          from: input.from,
          to: input.to,
          revision: agent.revision,
        });
      });
    },

    insertRelease(input) {
      const { release } = input;
      return db.transaction(async (tx) => {
        // A release's label counts the agent's earlier releases in the same
        // second, so releases are made one at a time per agent and stamped
        // after the lock: the label they answer with is the one they keep.
        const held = await lockAgentToChange(tx, input, release.agent_id);
        if ("outcome" in held) return held;
        const locked = held.agent;
        // Agent row locked, settings row next: the session start's order.
        if (input.refuseGitHubWhenSettings === true) {
          const [row] = await tx
            .select({ agentId: agentGitHubSettings.agentId })
            .from(agentGitHubSettings)
            .where(eq(agentGitHubSettings.agentId, release.agent_id))
            .for("share");
          if (row !== undefined) {
            return { outcome: "github_settings_exist" as const };
          }
        }
        const [owned] = await tx
          .select({ id: agentVersions.id })
          .from(agentVersions)
          .innerJoin(agents, eq(agents.id, agentVersions.agentId))
          .where(
            and(
              eq(agentVersions.id, release.version_id),
              eq(agents.id, release.agent_id),
              eq(agents.workspaceId, input.workspaceId),
            ),
          )
          .limit(1);
        if (!owned) return { outcome: "not_found" };
        const [inserted] = await tx
          .insert(agentReleases)
          .values({
            id: release.id,
            agentId: release.agent_id,
            versionId: release.version_id,
            cardSha256: release.card_sha256,
            runtimeProfileId: release.runtime_profile_id,
            repositoryId: release.repository_id,
            profileDigest: release.profile_digest,
            runtimeConfigSnapshot: release.runtime_config_snapshot,
            effectiveTools: release.effective_tools,
            policyPins: release.policy_pins,
            createdBy: release.created_by,
            note: release.note,
            createdAt: sql`clock_timestamp()`,
          })
          .onConflictDoNothing({ target: agentReleases.id })
          .returning({ id: agentReleases.id });
        const [stored] = await readReleases(
          tx,
          eq(agentReleases.id, release.id),
        );
        if (!stored) throw new Error(`release ${release.id} vanished`);
        if (!inserted) return { outcome: "exists", release: stored };
        const receiptId = await writeReceipt(tx, input.principal, {
          operation: "create_agent_release",
          workspaceId: input.workspaceId,
          agentId: release.agent_id,
          result: {
            release_id: release.id,
            reason: input.reason ?? null,
            ...(await githubChange(
              tx,
              release.id,
              locked?.activeReleaseId ?? null,
            )),
          },
        });
        await tx.insert(agentActivationEvents).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          agentId: release.agent_id,
          kind: "release_created",
          releaseId: release.id,
          actorUserId: release.created_by,
          actor: receiptActorOf(input.principal),
          receiptId,
        });
        return { outcome: "created", release: stored };
      });
    },

    activate(input): Promise<ActivateResult> {
      return db.transaction(async (tx) => {
        // The lock queues concurrent activations; the UPDATE below is the
        // compare-and-swap each of them is then judged by.
        const locked = await lockAgentToChange(tx, input, input.agentId);
        if ("outcome" in locked) return locked;
        const { agent } = locked;
        const current = agent.activationRevision;
        const { intent } = input;
        // First, ahead of the early return below: a save a newer intent has
        // replaced must not finish, even when its release is already active.
        if (
          intent?.kind === "save" &&
          (agent.behaviorRevision !== intent.behaviorRevision ||
            agent.draftVersionId !== intent.draftVersionId)
        ) {
          return { outcome: "superseded" };
        }
        // A rollout is judged again on what the lock now shows, whatever the
        // process that asked had read.
        if (
          (intent?.kind === "rollout" || intent?.kind === "raise") &&
          ((intent.kind === "rollout" && agent.profileTracking !== "follow") ||
            agent.behaviorRevision !== intent.behaviorRevision ||
            !(await isNewestProfile(tx, intent.targetProfileId)) ||
            !(await runsLineageOf(tx, input.agentId, intent.targetProfileId)))
        ) {
          return { outcome: "superseded" };
        }
        if (
          intent?.kind === "migrate" &&
          agent.activeReleaseId !== input.releaseId &&
          (agent.activeReleaseId !== intent.expected.activeReleaseId ||
            agent.activationRevision !== intent.expected.activationRevision ||
            agent.behaviorRevision !== intent.expected.behaviorRevision ||
            agent.profileTracking !== intent.expected.tracking ||
            agent.modelSource !== intent.expected.modelSource)
        ) {
          return { outcome: "superseded" };
        }
        // The plan was read on these values; anything since is a person's.
        if (
          intent?.kind === "tool_unlock" &&
          agent.activeReleaseId !== input.releaseId &&
          (agent.activeReleaseId !== intent.expected.activeReleaseId ||
            agent.activationRevision !== intent.expected.activationRevision ||
            agent.behaviorRevision !== intent.expected.behaviorRevision)
        ) {
          return { outcome: "superseded" };
        }
        if (
          intent?.kind === "model_migration" &&
          agent.activeReleaseId !== input.releaseId &&
          (!agent.autoModelMigration ||
            agent.activeReleaseId !== intent.expected.activeReleaseId ||
            agent.activationRevision !== intent.expected.activationRevision ||
            agent.behaviorRevision !== intent.expected.behaviorRevision)
        ) {
          return { outcome: "superseded" };
        }
        const intentColumns =
          intent?.kind === "migrate"
            ? { profileTracking: intent.tracking }
            : intent?.kind === "save"
              ? {
                  modelSource: intent.modelSource,
                  draftVersionId: null,
                  draftProfileId: null,
                  draftModelSource: null,
                  draftFailure: null,
                }
              : intent?.kind === "raise"
                ? { profileTracking: "follow" }
                : intent?.kind === "direct"
                  ? {
                      behaviorRevision: sql`${agents.behaviorRevision} + 1`,
                      modelSource: intent.releaseRunsProfileDefault
                        ? sql`${agents.modelSource}`
                        : "fixed",
                      ...(intent.pinsProfile === true
                        ? { profileTracking: "pinned" }
                        : {}),
                    }
                  : {};
        // expected + 1: a retry of a request whose first attempt already swapped.
        if (
          agent.activeReleaseId === input.releaseId &&
          (current === input.expectedRevision ||
            current === input.expectedRevision + 1)
        ) {
          // A migrate retry writes nothing: a person may have changed the
          // agent since the first attempt, and that change is theirs.
          if (intent !== undefined && intent.kind !== "migrate") {
            await tx
              .update(agents)
              .set({ ...intentColumns, updatedAt: DB_NOW })
              .where(eq(agents.id, agent.id));
          }
          if (intent?.kind === "raise") await resolveFailedItems(tx, agent.id);
          if (intent?.kind === "tool_unlock" && intent.rolloutId !== null) {
            await recordToolUnlockItem(tx, {
              rolloutId: intent.rolloutId,
              agentId: agent.id,
              generation: intent.expected.activationRevision,
              result: { status: "applied" },
            });
          }
          return {
            outcome: "unchanged",
            revision: current,
            previousReleaseId: null,
          };
        }
        const [swapped] = await tx
          .update(agents)
          .set({
            activeReleaseId: input.releaseId,
            activationRevision: sql`${agents.activationRevision} + 1`,
            updatedAt: DB_NOW,
            ...intentColumns,
          })
          .where(
            and(
              eq(agents.id, agent.id),
              eq(agents.activationRevision, input.expectedRevision),
            ),
          )
          .returning({ revision: agents.activationRevision });
        if (!swapped) {
          return {
            outcome: "conflict",
            activeReleaseId: agent.activeReleaseId,
            revision: current,
          };
        }
        await tx
          .update(agentReleases)
          .set({ approvedBy: input.approvedBy, approvedAt: DB_NOW })
          .where(
            and(
              eq(agentReleases.id, input.releaseId),
              sql`${agentReleases.approvedBy} IS NULL`,
            ),
          );
        if (intent?.kind === "raise") await resolveFailedItems(tx, agent.id);
        // With the swap, so a crash between the two cannot leave a done
        // agent without its item.
        if (intent?.kind === "tool_unlock" && intent.rolloutId !== null) {
          await recordToolUnlockItem(tx, {
            rolloutId: intent.rolloutId,
            agentId: agent.id,
            generation: intent.expected.activationRevision,
            result: { status: "applied" },
          });
        }
        const receiptId = await writeReceipt(tx, input.principal, {
          operation: "activate_agent",
          workspaceId: input.workspaceId,
          agentId: agent.id,
          result: {
            release_id: input.releaseId,
            previous_release_id: agent.activeReleaseId,
            activation_revision: swapped.revision,
            reason: input.reason ?? null,
            ...(intent?.kind === "migrate"
              ? {
                  migration: {
                    id: intent.migrationId,
                    revert: intent.revert === true,
                    tracking_before: agent.profileTracking,
                    tracking_after: intent.tracking,
                    behavior_revision: agent.behaviorRevision,
                    model_source: agent.modelSource,
                  },
                }
              : {}),
            ...(intent?.kind === "model_migration"
              ? {
                  model_migration: {
                    from: intent.from,
                    to: intent.to,
                    automatic: true,
                  },
                }
              : {}),
            ...(intent?.kind === "tool_unlock"
              ? {
                  tool_unlock: {
                    rollout_id: intent.rolloutId,
                    tools_before: intent.tools.before,
                    tools_after: intent.tools.after,
                    unlocked: intent.tools.after.filter(
                      (tool) => !intent.tools.before.includes(tool),
                    ),
                  },
                }
              : {}),
            ...(await githubChange(tx, input.releaseId, agent.activeReleaseId)),
          },
        });
        await tx.insert(agentActivationEvents).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          agentId: agent.id,
          kind: "activated",
          releaseId: input.releaseId,
          previousReleaseId: agent.activeReleaseId,
          activationRevision: swapped.revision,
          actorUserId: input.approvedBy,
          actor: receiptActorOf(input.principal),
          receiptId,
        });
        if (intent?.kind === "model_migration") {
          await enqueueModelMoveNotices(tx, {
            workspaceId: input.workspaceId,
            agentId: agent.id,
            kind: "moved",
            from: intent.from,
            to: intent.to,
            revision: swapped.revision,
          });
        }
        return {
          outcome: "activated",
          revision: swapped.revision,
          previousReleaseId: agent.activeReleaseId,
          receiptId,
        };
      });
    },
  };
}
