import { randomUUID } from "node:crypto";
import {
  type ConversationRollout,
  SETTABLE_CONVERSATION_ROLLOUT_VALUES,
  SLACK_NOTICE_VERSIONS,
  type SlackNoticeApprovalId,
  type SlackNoticeLocale,
  type SlackNoticeVersion,
  type SlackNoticeVersionEntry,
  slackNoticeWindow,
  WORKSPACE_MANAGER_ROLES,
} from "@werft-ai/contracts";
import { and, asc, between, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { dropUnlistenedBuffer } from "../conversations/index.ts";
import { DB_NOW } from "../db-clock.ts";
import { lockedRole } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import {
  agentIdentities,
  agents,
  memberships,
  receipts,
  slackInstallations,
  slackNoticeApprovals,
  users,
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
  input: Place & {
    by: string;
    /** The language the approver was shown the notice in. */
    locale: SlackNoticeLocale;
    requestId?: string;
  },
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
          notice_locale: input.locale,
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
    await lowerRollout(tx, {
      ...input,
      by: { userId: input.by },
      reason: "notice_revoked",
    });
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

/** An unrevoked approval in a team of the agent's live installs, with its approver. */
export type SlackNoticeLiveApproval = {
  id: SlackNoticeApprovalId;
  slackTeamId: string;
  version: SlackNoticeVersion;
  approvedBy: string;
  approvedByName: string;
  approvedByEmail: string;
  approvedAt: Date;
};

/**
 * The agent's unrevoked approvals of any version in the teams of its live
 * installs, by team, newest version first. An approval from a team the app
 * left is not shown: it no longer counts for anything.
 */
export async function liveSlackNoticeApprovals(
  db: Database,
  place: Place,
): Promise<SlackNoticeLiveApproval[]> {
  const teams = await liveTeamsOf(db, place);
  if (teams.length === 0) return [];
  const rows = await db
    .select({
      id: slackNoticeApprovals.id,
      slackTeamId: slackNoticeApprovals.slackTeamId,
      version: slackNoticeApprovals.noticeVersion,
      approvedBy: slackNoticeApprovals.approvedBy,
      approvedByName: users.displayName,
      approvedByEmail: users.email,
      approvedAt: slackNoticeApprovals.approvedAt,
    })
    .from(slackNoticeApprovals)
    .innerJoin(users, eq(users.id, slackNoticeApprovals.approvedBy))
    .where(
      and(
        eq(slackNoticeApprovals.workspaceId, place.workspaceId),
        eq(slackNoticeApprovals.agentId, place.agentId),
        inArray(slackNoticeApprovals.slackTeamId, teams),
        isNull(slackNoticeApprovals.revokedAt),
      ),
    )
    .orderBy(
      asc(slackNoticeApprovals.slackTeamId),
      desc(slackNoticeApprovals.noticeVersion),
      asc(slackNoticeApprovals.id),
    );
  return rows.map((row) => ({
    ...row,
    id: row.id as SlackNoticeApprovalId,
    version: row.version as SlackNoticeVersion,
  }));
}

/**
 * Whether the user is a live owner or admin of the workspace now, read
 * without a lock: for what a screen offers, not for a write.
 */
export async function managesWorkspace(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, userId),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  return WORKSPACE_MANAGER_ROLES.some((role) => role === row?.role);
}

type RolloutBy = "operator_cli" | "reconciler" | { userId: string };

/**
 * Why a switch went to `off` without being asked to: its approval was
 * revoked, or a pass found it no longer approved (the reasons of
 * `SlackNoticeJudgment`).
 */
type LoweredReason =
  | "notice_revoked"
  | Extract<SlackNoticeJudgment, { approved: false }>["reason"];

/**
 * Sets the agent's switch and writes its receipt; going to `off` removes
 * every message the agent holds in its judgment buffer, in this transaction.
 * The caller holds the agent's row lock.
 */
async function writeRollout(
  tx: Database,
  input: Place & {
    before: ConversationRollout;
    after: ConversationRollout;
    by: RolloutBy;
    reason: LoweredReason | null;
    requestId?: string;
  },
): Promise<number> {
  await tx
    .update(agents)
    .set({ conversationRollout: input.after })
    .where(eq(agents.id, input.agentId));
  const dropped =
    input.after === "off"
      ? await dropUnlistenedBuffer(tx, { agentId: input.agentId })
      : 0;
  const person = typeof input.by === "string" ? null : input.by.userId;
  await tx.insert(receipts).values({
    id: randomUUID(),
    ownerId: input.workspaceId,
    operation: "set_conversation_rollout",
    targetRef: {
      resource: { kind: "agent", id: input.agentId },
      workspace_id: input.workspaceId,
    },
    status: "succeeded",
    result: {
      agent_id: input.agentId,
      before: input.before,
      after: input.after,
      by: person === null ? input.by : "web",
      reason: input.reason,
      buffered_dropped: dropped,
    },
    ...(person === null ? {} : { actor: actorOf(person) }),
    requestId: input.requestId ?? null,
  });
  return dropped;
}

/** Lowers a raised switch to `off`; the caller holds the agent's row lock. */
async function lowerRollout(
  tx: Database,
  input: Place & { by: RolloutBy; reason: LoweredReason },
): Promise<boolean> {
  const before = await rolloutOf(tx, input);
  if (before === null || before === "off") return false;
  await writeRollout(tx, { ...input, before, after: "off" });
  return true;
}

export type ConversationRolloutChange =
  | {
      /** `unchanged`: the switch already held the value; nothing is written. */
      outcome: "changed" | "unchanged";
      before: ConversationRollout;
      after: ConversationRollout;
      /** Buffered messages a change to `off` removed. */
      bufferedDropped: number;
    }
  /** `on_unavailable`: `on` is not open yet. */
  | { outcome: "not_found" | "not_admin" | "on_unavailable" }
  | {
      /** The switch leaves `off` only for an agent approved now. */
      outcome: "not_approved";
      reason: Extract<SlackNoticeJudgment, { approved: false }>["reason"];
    };

/**
 * Changes the agent's conversation switch, by a workspace owner or admin
 * (`by.userId`, checked under its lock) or the operator CLI. Raising it
 * needs the agent approved under the published notice, judged under the
 * agent's lock that a revoke takes too. A change writes one
 * `set_conversation_rollout` receipt in its transaction; `off` also empties
 * the agent's judgment buffer.
 */
export async function setConversationRollout(
  db: Database,
  input: Place & {
    rollout: ConversationRollout;
    by: "operator_cli" | { userId: string };
    requestId?: string;
  },
  versions: readonly SlackNoticeVersionEntry[] = SLACK_NOTICE_VERSIONS,
): Promise<ConversationRolloutChange> {
  return db.transaction(async (tx) => {
    if (typeof input.by === "string") {
      if ((await rolloutOf(tx, input, "update")) === null) {
        return { outcome: "not_found" };
      }
    } else {
      const refused = await lockAdminAndAgent(tx, input, input.by.userId);
      if (refused !== null) return { outcome: refused };
    }
    if (
      !SETTABLE_CONVERSATION_ROLLOUT_VALUES.some((v) => v === input.rollout)
    ) {
      return { outcome: "on_unavailable" };
    }
    const before = await rolloutOf(tx, input);
    if (before === null) return { outcome: "not_found" };
    if (input.rollout !== "off") {
      const judgment = await judgeSlackNotice(tx, input, versions);
      if (!judgment.approved) {
        return { outcome: "not_approved", reason: judgment.reason };
      }
    }
    if (before === input.rollout) {
      return {
        outcome: "unchanged",
        before,
        after: before,
        bufferedDropped: 0,
      };
    }
    const bufferedDropped = await writeRollout(tx, {
      ...input,
      before,
      after: input.rollout,
      reason: null,
    });
    return {
      outcome: "changed",
      before,
      after: input.rollout,
      bufferedDropped,
    };
  });
}

/** The live agent's switch, or null for none; `lock` locks its row so. */
export async function rolloutOf(
  db: Database,
  place: Place,
  lock?: "update" | "share",
): Promise<ConversationRollout | null> {
  const query = db
    .select({ rollout: agents.conversationRollout })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, place.workspaceId),
        eq(agents.id, place.agentId),
        notDeleted(agents),
      ),
    );
  const [agent] = await (lock === undefined ? query : query.for(lock));
  return agent?.rollout ?? null;
}

export type ConversationGate =
  | {
      open: true;
      rollout: Exclude<ConversationRollout, "off">;
      approvals: SlackNoticeTeamApproval[];
    }
  | {
      open: false;
      reason:
        | "agent_not_found"
        | "rollout_off"
        | Extract<SlackNoticeJudgment, { approved: false }>["reason"];
    };

/**
 * Whether the agent may take a conversation step now: its switch is raised
 * and it is approved under the published notice. Asked right before a model
 * call and right before its result is written. With `lock`, called in the
 * transaction that writes, it holds the agent's row shared until commit, so
 * a revoke, a lowering or a change of the switch waits for that write or is
 * seen by it.
 */
export async function conversationGate(
  db: Database,
  place: Place,
  options: {
    lock?: boolean;
    versions?: readonly SlackNoticeVersionEntry[];
  } = {},
): Promise<ConversationGate> {
  const rollout = await rolloutOf(
    db,
    place,
    options.lock ? "share" : undefined,
  );
  if (rollout === null) return { open: false, reason: "agent_not_found" };
  if (rollout === "off") return { open: false, reason: "rollout_off" };
  const judgment = await judgeSlackNotice(
    db,
    place,
    options.versions ?? SLACK_NOTICE_VERSIONS,
  );
  if (!judgment.approved) return { open: false, reason: judgment.reason };
  return { open: true, rollout, approvals: judgment.approvals };
}

/**
 * Lowers to `off` the switch of every agent no longer approved under the
 * published notice (a version that asks for a new approval was published,
 * or its app left the Slack team), each in its own transaction with its
 * receipt and its buffer emptied; up to `limit`. A dry run counts them. The
 * reconciler runs it every pass; the gate already answers no before it does.
 */
export async function lowerUnapprovedRollouts(
  db: Database,
  options: {
    dryRun: boolean;
    limit: number;
    versions?: readonly SlackNoticeVersionEntry[];
  },
): Promise<string[]> {
  const versions = options.versions ?? SLACK_NOTICE_VERSIONS;
  const raised = await db
    .select({ agentId: agents.id, workspaceId: agents.workspaceId })
    .from(agents)
    .where(and(ne(agents.conversationRollout, "off"), notDeleted(agents)))
    .orderBy(asc(agents.id));
  const lowered: string[] = [];
  for (const place of raised) {
    if (lowered.length >= options.limit) break;
    if ((await judgeSlackNotice(db, place, versions)).approved) continue;
    if (options.dryRun) {
      lowered.push(place.agentId);
      continue;
    }
    const done = await db.transaction(async (tx) => {
      if ((await rolloutOf(tx, place, "update")) === null) return false;
      const judgment = await judgeSlackNotice(tx, place, versions);
      if (judgment.approved) return false;
      return lowerRollout(tx, {
        ...place,
        by: "reconciler",
        reason: judgment.reason,
      });
    });
    if (done) lowered.push(place.agentId);
  }
  return lowered;
}
