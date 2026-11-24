import { randomUUID } from "node:crypto";
import {
  SLACK_NOTICE_VERSIONS,
  type SlackNoticeApprovalId,
  type SlackNoticeVersion,
  type SlackNoticeVersionEntry,
  slackNoticeWindow,
  WORKSPACE_MANAGER_ROLES,
} from "@werft-ai/contracts";
import { and, asc, between, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import { lockedRole } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import {
  agentIdentities,
  agents,
  receipts,
  slackInstallations,
  slackNoticeApprovals,
} from "../schema.ts";
import { notDeleted } from "../soft-delete.ts";

/** One live approval that counts, for one Slack team of the agent's installs. */
export type SlackNoticeTeamApproval = {
  approvalId: SlackNoticeApprovalId;
  version: SlackNoticeVersion;
  slackTeamId: string;
};

export type SlackNoticeJudgment =
  | {
      approved: true;
      /** One per Slack team the agent's app is live in, by team id. */
      approvals: SlackNoticeTeamApproval[];
    }
  | {
      approved: false;
      /**
       * `no_notice`: no version is published; `not_installed`: the agent has
       * no live Slack install; `not_approved`: a team of its live installs
       * has no live approval within the counted versions.
       */
      reason: "no_notice" | "not_installed" | "not_approved";
    };

export type SlackNoticeApprovalRecord = {
  id: SlackNoticeApprovalId;
  workspaceId: string;
  agentId: string;
  slackTeamId: string;
  version: SlackNoticeVersion;
  approvedBy: string;
  approvedAt: Date;
  revokedBy: string | null;
  revokedAt: Date | null;
};

export type SlackNoticeApproval =
  | {
      /**
       * `unchanged`: every live team already had a live approval of this
       * version, and nothing was written.
       */
      outcome: "approved" | "unchanged";
      version: SlackNoticeVersion;
      /** The rows this call wrote, one per team that lacked one. */
      added: SlackNoticeTeamApproval[];
    }
  | { outcome: "not_found" | "not_admin" | "no_notice" | "not_installed" };

export type SlackNoticeRevoke =
  | {
      /** `unchanged`: nothing was live; no receipt is written. */
      outcome: "revoked" | "unchanged";
      approvalIds: SlackNoticeApprovalId[];
    }
  | { outcome: "not_found" | "not_admin" };

type Place = { workspaceId: string; agentId: string };

const recordColumns = {
  id: slackNoticeApprovals.id,
  workspaceId: slackNoticeApprovals.workspaceId,
  agentId: slackNoticeApprovals.agentId,
  slackTeamId: slackNoticeApprovals.slackTeamId,
  version: slackNoticeApprovals.noticeVersion,
  approvedBy: slackNoticeApprovals.approvedBy,
  approvedAt: slackNoticeApprovals.approvedAt,
  revokedBy: slackNoticeApprovals.revokedBy,
  revokedAt: slackNoticeApprovals.revokedAt,
};

/**
 * The Slack teams of the agent's live installs, sorted; empty without one.
 * One app may be installed in several teams, each its own organization.
 */
async function liveTeamsOf(tx: Database, place: Place): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ teamId: slackInstallations.teamId })
    .from(agentIdentities)
    .innerJoin(
      slackInstallations,
      and(
        eq(slackInstallations.id, agentIdentities.installationId),
        eq(slackInstallations.workspaceId, agentIdentities.workspaceId),
      ),
    )
    .innerJoin(
      agents,
      and(
        eq(agents.id, agentIdentities.agentId),
        eq(agents.workspaceId, agentIdentities.workspaceId),
      ),
    )
    .where(
      and(
        eq(agentIdentities.workspaceId, place.workspaceId),
        eq(agentIdentities.agentId, place.agentId),
        eq(agentIdentities.status, "active"),
        ne(slackInstallations.status, "revoked"),
        notDeleted(agents),
      ),
    )
    .orderBy(asc(slackInstallations.teamId));
  return rows.map((row) => row.teamId);
}

/**
 * Whether the agent is approved under the published notice: every Slack team
 * of its live installs has a live approval of a version from the latest one
 * that asked for a new approval up to the current one.
 */
export async function judgeSlackNotice(
  db: Database,
  place: Place,
  versions: readonly SlackNoticeVersionEntry[] = SLACK_NOTICE_VERSIONS,
): Promise<SlackNoticeJudgment> {
  const window = slackNoticeWindow(versions);
  if (window === null) return { approved: false, reason: "no_notice" };
  const teams = await liveTeamsOf(db, place);
  if (teams.length === 0) return { approved: false, reason: "not_installed" };
  const rows = await db
    .select({
      id: slackNoticeApprovals.id,
      version: slackNoticeApprovals.noticeVersion,
      slackTeamId: slackNoticeApprovals.slackTeamId,
    })
    .from(slackNoticeApprovals)
    .where(
      and(
        eq(slackNoticeApprovals.workspaceId, place.workspaceId),
        eq(slackNoticeApprovals.agentId, place.agentId),
        inArray(slackNoticeApprovals.slackTeamId, teams),
        isNull(slackNoticeApprovals.revokedAt),
        between(
          slackNoticeApprovals.noticeVersion,
          window.oldestCounted,
          window.current,
        ),
      ),
    )
    .orderBy(desc(slackNoticeApprovals.noticeVersion));
  const approvals: SlackNoticeTeamApproval[] = [];
  for (const slackTeamId of teams) {
    const row = rows.find((candidate) => candidate.slackTeamId === slackTeamId);
    if (row === undefined) return { approved: false, reason: "not_approved" };
    approvals.push({
      approvalId: row.id as SlackNoticeApprovalId,
      version: row.version as SlackNoticeVersion,
      slackTeamId,
    });
  }
  return { approved: true, approvals };
}

// Lock order: the actor's membership, then the agent, as the identity and
// binding stores take theirs.
async function lockAdminAndAgent(
  tx: Database,
  place: Place,
  userId: string,
): Promise<"not_admin" | "not_found" | null> {
  // Locks the account first, as lockedRole does for every role check, so a
  // disable committed while this waited is seen.
  const role = await lockedRole(tx, place.workspaceId, userId);
  if (role === null || !WORKSPACE_MANAGER_ROLES.some((r) => r === role)) {
    return "not_admin";
  }
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, place.workspaceId),
        eq(agents.id, place.agentId),
        notDeleted(agents),
      ),
    )
    .for("update");
  return agent === undefined ? "not_found" : null;
}

const actorOf = (userId: string) => ({
  principal: { kind: "user", id: userId },
  actor_user_id: userId,
  agent_id: null,
});

/**
 * A workspace owner's or admin's approval of the current notice version for
 * the agent's app, in each Slack team of its live installs that has no live
 * approval of that version yet: one row and one receipt per team, in one
 * transaction.
 */
export async function approveSlackNotice(
  db: Database,
  input: Place & { by: string; requestId?: string },
  versions: readonly SlackNoticeVersionEntry[] = SLACK_NOTICE_VERSIONS,
): Promise<SlackNoticeApproval> {
  const window = slackNoticeWindow(versions);
  if (window === null) return { outcome: "no_notice" };
  const version = window.current;
  return db.transaction(async (tx) => {
    const refused = await lockAdminAndAgent(tx, input, input.by);
    if (refused !== null) return { outcome: refused };
    const teams = await liveTeamsOf(tx, input);
    if (teams.length === 0) return { outcome: "not_installed" };
    const live = await tx
      .select({ slackTeamId: slackNoticeApprovals.slackTeamId })
      .from(slackNoticeApprovals)
      .where(
        and(
          eq(slackNoticeApprovals.agentId, input.agentId),
          inArray(slackNoticeApprovals.slackTeamId, teams),
          eq(slackNoticeApprovals.noticeVersion, version),
          isNull(slackNoticeApprovals.revokedAt),
        ),
      );
    const added: SlackNoticeTeamApproval[] = [];
    for (const slackTeamId of teams) {
      if (live.some((row) => row.slackTeamId === slackTeamId)) continue;
      const approvalId = randomUUID() as SlackNoticeApprovalId;
      await tx.insert(slackNoticeApprovals).values({
        id: approvalId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        slackTeamId,
        noticeVersion: version,
        approvedBy: input.by,
        approvedAt: DB_NOW,
      });
      await tx.insert(receipts).values({
        id: randomUUID(),
        ownerId: input.workspaceId,
        operation: "approve_slack_notice",
        targetRef: {
          resource: { kind: "agent", id: input.agentId },
          workspace_id: input.workspaceId,
        },
        status: "succeeded",
        result: {
          agent_id: input.agentId,
          approval_id: approvalId,
          slack_team_id: slackTeamId,
          notice_version: version,
        },
        actor: actorOf(input.by),
        requestId: input.requestId ?? null,
      });
      added.push({ approvalId, version, slackTeamId });
    }
    return {
      outcome: added.length === 0 ? "unchanged" : "approved",
      version,
      added,
    };
  });
}

/**
 * Revokes every live approval of the agent, in any Slack team, with one
 * receipt naming them. Nothing live is `unchanged` and writes nothing.
 */
export async function revokeSlackNotice(
  db: Database,
  input: Place & { by: string; requestId?: string },
): Promise<SlackNoticeRevoke> {
  return db.transaction(async (tx) => {
    const refused = await lockAdminAndAgent(tx, input, input.by);
    if (refused !== null) return { outcome: refused };
    const revoked = await tx
      .update(slackNoticeApprovals)
      .set({ revokedAt: DB_NOW, revokedBy: input.by })
      .where(
        and(
          eq(slackNoticeApprovals.workspaceId, input.workspaceId),
          eq(slackNoticeApprovals.agentId, input.agentId),
          isNull(slackNoticeApprovals.revokedAt),
        ),
      )
      .returning({
        id: slackNoticeApprovals.id,
        slackTeamId: slackNoticeApprovals.slackTeamId,
        version: slackNoticeApprovals.noticeVersion,
      });
    const approvalIds = revoked
      .map((row) => row.id as SlackNoticeApprovalId)
      .sort();
    if (approvalIds.length === 0) return { outcome: "unchanged", approvalIds };
    await tx.insert(receipts).values({
      id: randomUUID(),
      ownerId: input.workspaceId,
      operation: "revoke_slack_notice",
      targetRef: {
        resource: { kind: "agent", id: input.agentId },
        workspace_id: input.workspaceId,
      },
      status: "succeeded",
      result: {
        agent_id: input.agentId,
        approval_ids: approvalIds,
        slack_team_ids: [
          ...new Set(revoked.map((row) => row.slackTeamId)),
        ].sort(),
        notice_versions: [...new Set(revoked.map((row) => row.version))].sort(
          (a, b) => a - b,
        ),
      },
      actor: actorOf(input.by),
      requestId: input.requestId ?? null,
    });
    return { outcome: "revoked", approvalIds };
  });
}

/** Every approval row of one agent, or of a workspace's agents, oldest first. */
export async function listSlackNoticeApprovals(
  db: Database,
  filter: { agentId: string } | { workspaceId: string },
): Promise<SlackNoticeApprovalRecord[]> {
  const rows = await db
    .select(recordColumns)
    .from(slackNoticeApprovals)
    .where(
      "agentId" in filter
        ? eq(slackNoticeApprovals.agentId, filter.agentId)
        : eq(slackNoticeApprovals.workspaceId, filter.workspaceId),
    )
    .orderBy(
      asc(slackNoticeApprovals.approvedAt),
      asc(slackNoticeApprovals.id),
    );
  return rows.map((row) => ({
    ...row,
    id: row.id as SlackNoticeApprovalId,
    version: row.version as SlackNoticeVersion,
  }));
}
