import { integerSetting } from "@werft-ai/contracts/settings";
import type {
  AnnouncedInputReturn,
  ChannelSummaryHistoryPrune,
  JudgmentBufferPurge,
  OwnershipReconciled,
  ReconciledInterrupt,
  ReconciledLease,
  ReconciledOrphan,
  ToolCallProjection,
} from "@werft-ai/db";

import { booleanFlag } from "../boolean-flag.ts";

export type ReconcileOptions = {
  dryRun: boolean;
  limit: number;
  // Unset: the store judges deadlines on the database clock.
  now?: Date;
};

export type LeaseReconcileOptions = ReconcileOptions & { now: Date };

export type ReconcilerRun = {
  orphans: ReconciledOrphan[];
  leases: ReconciledLease[];
  interrupts: ReconciledInterrupt[];
  interruptsOverdue: number;
  terminationsOverdue: number;
  // Sessions whose parked requests this pass expired.
  parkedExpired: string[];
  inputReturns: AnnouncedInputReturn[];
  decisionsExpired: number;
  toolAuditsExpired: number;
  webSessionsDeleted: number;
  // Sessions whose copied variable values this pass dropped.
  envStartsPurged: number;
  // Failed Slack inbox rows whose payload this pass cleared.
  slackInboundPayloadsPurged: number;
  // Buffered Slack messages past their time (and of those, the unjudged), or
  // of a channel no longer heard; and ended judgment batches past M1's window.
  judgmentBufferPurged: JudgmentBufferPurge;
  // Marks of deleted and edited Slack messages nothing points at.
  slackSourceMarksPurged: { deleted: number; edited: number };
  // Channel summary versions no longer current at any time in the last 7
  // days, and the lines only they held.
  channelSummaryHistoryPruned: ChannelSummaryHistoryPrune;
  slackMembersPurged: number;
  // Tasks whose close as abandoned this pass started (closed, or a drain
  // accepted); null on a dry run, which closes none.
  tasksClosedIdle: number | null;
  ownership: OwnershipReconciled;
  // null on a dry run, which projects nothing.
  toolCalls: ToolCallProjection | null;
};

export type ReconcilerLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

// The most tasks one pass starts closing on their time rules (v1-b/C2); the
// rest stay due for a later pass (each pass draws its own at random).
export const TASK_TIME_CLOSES_PER_PASS = 50;

// The fill (packages/db sessions/neutral-fields.ts) passes rows once 60 seconds old
// and runs every 15 seconds; held this long, it has stopped.
const FILL_HOLD_WARN_SECONDS = 300;

export type ReconcilerEnvironment = {
  // Present only to be refused: see runReconciler.
  HEARTBEAT_TTL_SEC?: string;
  RECONCILER_BATCH_SIZE?: string;
  RECONCILER_DRY_RUN?: string;
};

/** Refuses a bad setting before any row is touched; the service loop calls it once at startup. */
export function reconcilerSettings(
  environment: Readonly<Record<string, string | undefined>>,
): {
  limit: number;
  dryRun: boolean;
} {
  // Every lease this judges carries the deadline its writer stamped from the
  // API's HEARTBEAT_TTL_SEC. A value here could only disagree with that one,
  // and silently ignoring it would let an operator believe it applies.
  if (environment.HEARTBEAT_TTL_SEC !== undefined) {
    throw new Error(
      "HEARTBEAT_TTL_SEC is read by the API only; the reconciler judges the lease deadlines stored with each heartbeat. Unset it here.",
    );
  }
  return {
    limit: integerSetting(environment, "RECONCILER_BATCH_SIZE", {
      min: 1,
      default: 100,
    }),
    dryRun: booleanFlag(
      environment.RECONCILER_DRY_RUN ?? "false",
      "RECONCILER_DRY_RUN",
    ),
  };
}

export async function runReconciler(input: {
  environment?: ReconcilerEnvironment;
  logger: ReconcilerLogger;
  now?: Date;
  reconcile(options: ReconcileOptions): Promise<ReconciledOrphan[]>;
  // Gateway-bound sessions: fence the attempt and ask for its execution to
  // go. Their judgement waits for the scheduler to confirm the removal.
  reconcileLeases(options: LeaseReconcileOptions): Promise<ReconciledLease[]>;
  // Terminate receipts past their deadline become unknown. The scheduler
  // sweeps too, but it may not run at all while Docker is down.
  expireTerminations(options: LeaseReconcileOptions): Promise<number>;
  // Interrupts left unsettled past their deadline by a worker that keeps its
  // lease: its execution goes down the terminate path. Runs after the lease
  // pass so an attempt that pass already fenced is not fenced twice.
  reconcileInterrupts(
    options: LeaseReconcileOptions,
  ): Promise<ReconciledInterrupt[]>;
  // Interrupt receipts still open past their later deadline become unknown,
  // for when nothing confirms the kill above.
  expireInterrupts(options: LeaseReconcileOptions): Promise<number>;
  // Parked requests past their deadline: settled expired, and their group
  // closed, before the pass below reports what ended.
  expireParked(options: { dryRun: boolean; limit: number }): Promise<string[]>;
  // Waits for input the stream still reports after they ended with nothing
  // written (expiry, a lost attempt). Last, so the lease pass above has
  // already fenced what it fences and this reports the result in one go.
  announceInputReturns(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<AnnouncedInputReturn[]>;
  expireDecisions(options: { dryRun: boolean; limit: number }): Promise<number>;
  expireToolAudits(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<number>;
  // Web sessions 30 days past expiry.
  deleteExpiredWebSessions(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<number>;
  // Variable values an open session copied at accept and kept past retention.
  purgeExpiredEnvStart(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<number>;
  // Payloads of Slack inbox rows that failed and were received 7 days ago.
  purgeFailedSlackInboundPayloads(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<number>;
  // Unmentioned Slack messages held for the judgment, whole, once their 10
  // minutes are up or the agent stopped hearing their channel. Before the
  // marks below, which a buffered message keeps.
  purgeJudgmentBuffer(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<JudgmentBufferPurge>;
  // Delete and edit marks of Slack messages nothing points at, made more
  // than the judgment buffer's lifetime and an hour ago.
  purgeSlackSourceMarks(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<{ deleted: number; edited: number }>;
  // Old versions of channel summaries, past their 7 days of history.
  pruneChannelSummaryHistory(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<ChannelSummaryHistoryPrune>;
  // Slack channel member lists and voids past their TTL.
  purgeSlackChannelMembers(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<number>;
  // Sign-in attempt windows that ended long ago.
  purgeAuthAttemptWindows(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<number>;
  // Open tasks idle, or quiet past their limits, whose close as abandoned
  // (v1-b/C2) starts, at most `limit` of them.
  closeIdleTasks(limit: number): Promise<number>;
  // Agents no one live administers get their ownerless mark; agents that
  // have someone again lose it.
  reconcileOwnership(options: {
    dryRun: boolean;
    limit: number;
  }): Promise<OwnershipReconciled>;
  // Tool calls for the usage API, from the events since the last pass. Last,
  // because it spends what is left of its own time budget catching up.
  projectToolCalls(): Promise<ToolCallProjection>;
}): Promise<ReconcilerRun> {
  const { limit, dryRun } = reconcilerSettings(
    input.environment ?? process.env,
  );
  const reconciled = await input.reconcile({
    dryRun,
    limit,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const now = input.now ?? new Date();
  input.logger.info("Orphan session reconciliation completed", {
    blocked_count: reconciled.filter(({ action }) => action === "blocked")
      .length,
    dry_run: dryRun,
    reconciled_count: reconciled.length,
    released_count: reconciled.filter(({ action }) => action === "released")
      .length,
    requeued_count: reconciled.filter(({ action }) => action === "requeued")
      .length,
    session_ids: reconciled.map(({ sessionId }) => sessionId),
  });
  const leases = await input.reconcileLeases({ dryRun, limit, now });
  input.logger.info("Expired lease reconciliation completed", {
    dry_run: dryRun,
    ended_count: leases.filter(({ action }) => action === "ended").length,
    fenced_count: leases.filter(({ action }) => action === "fenced").length,
    // session_ids also names the ended ones; this says which were fenced.
    fenced_session_ids: leases
      .filter(({ action }) => action === "fenced")
      .map(({ sessionId }) => sessionId),
    reconciled_count: leases.length,
    session_ids: leases.map(({ sessionId }) => sessionId),
  });
  const interrupts = await input.reconcileInterrupts({ dryRun, limit, now });
  input.logger.info("Overdue interrupt executions sent to terminate", {
    dry_run: dryRun,
    fenced_count: interrupts.length,
    session_ids: interrupts.map(({ sessionId }) => sessionId),
  });
  const interruptsOverdue = await input.expireInterrupts({
    dryRun,
    limit,
    now,
  });
  input.logger.info("Overdue interrupt receipts marked unknown", {
    dry_run: dryRun,
    overdue_count: interruptsOverdue,
  });
  const terminationsOverdue = await input.expireTerminations({
    dryRun,
    limit,
    now,
  });
  input.logger.info("Overdue terminate receipts marked unknown", {
    dry_run: dryRun,
    overdue_count: terminationsOverdue,
  });
  const parkedExpired = await input.expireParked({ dryRun, limit });
  input.logger.info("Expired parked requests settled", {
    dry_run: dryRun,
    session_ids: parkedExpired,
  });
  const inputReturns = await input.announceInputReturns({ dryRun, limit });
  input.logger.info("Ended input waits announced", {
    dry_run: dryRun,
    announced_count: inputReturns.length,
    session_ids: inputReturns.map(({ sessionId }) => sessionId),
  });
  const decisionsExpired = await input.expireDecisions({ dryRun, limit });
  input.logger.info("Expired authorization decisions deleted", {
    dry_run: dryRun,
    deleted_count: decisionsExpired,
  });
  const toolAuditsExpired = await input.expireToolAudits({ dryRun, limit });
  input.logger.info("Expired tool call audits deleted", {
    dry_run: dryRun,
    deleted_count: toolAuditsExpired,
  });
  const webSessionsDeleted = await input.deleteExpiredWebSessions({
    dryRun,
    limit,
  });
  input.logger.info("Expired web sessions deleted", {
    dry_run: dryRun,
    deleted_count: webSessionsDeleted,
  });
  const envStartsPurged = await input.purgeExpiredEnvStart({ dryRun, limit });
  input.logger.info("Expired session variable values purged", {
    dry_run: dryRun,
    purged_count: envStartsPurged,
  });
  const slackInboundPayloadsPurged =
    await input.purgeFailedSlackInboundPayloads({ dryRun, limit });
  input.logger.info("Failed Slack inbound payloads purged", {
    dry_run: dryRun,
    purged_count: slackInboundPayloadsPurged,
  });
  const judgmentBufferPurged = await input.purgeJudgmentBuffer({
    dryRun,
    limit,
  });
  input.logger.info("Judgment buffer purged", {
    dry_run: dryRun,
    expired_count: judgmentBufferPurged.expired,
    unjudged_count: judgmentBufferPurged.unjudged,
    unlistened_count: judgmentBufferPurged.unlistened,
    batches_count: judgmentBufferPurged.batches,
  });
  const slackSourceMarksPurged = await input.purgeSlackSourceMarks({
    dryRun,
    limit,
  });
  input.logger.info("Unknown Slack source marks purged", {
    dry_run: dryRun,
    deleted_count: slackSourceMarksPurged.deleted,
    edited_count: slackSourceMarksPurged.edited,
  });
  const channelSummaryHistoryPruned = await input.pruneChannelSummaryHistory({
    dryRun,
    limit,
  });
  input.logger.info("Old channel summary versions pruned", {
    dry_run: dryRun,
    channel_count: channelSummaryHistoryPruned.channels,
    version_count: channelSummaryHistoryPruned.versions,
    line_count: channelSummaryHistoryPruned.lines,
  });
  const slackMembersPurged = await input.purgeSlackChannelMembers({
    dryRun,
    limit,
  });
  input.logger.info("Expired Slack channel member lists deleted", {
    dry_run: dryRun,
    deleted_count: slackMembersPurged,
  });
  const authAttemptsPurged = await input.purgeAuthAttemptWindows({
    dryRun,
    limit,
  });
  input.logger.info("Ended sign-in attempt windows deleted", {
    dry_run: dryRun,
    deleted_count: authAttemptsPurged,
  });
  const tasksClosedIdle = dryRun
    ? null
    : await input.closeIdleTasks(TASK_TIME_CLOSES_PER_PASS);
  input.logger.info("Idle tasks closed", {
    dry_run: dryRun,
    ...(tasksClosedIdle === null ? {} : { closed_count: tasksClosedIdle }),
  });
  const ownership = await input.reconcileOwnership({ dryRun, limit });
  input.logger.info("Agent ownership reconciled", {
    dry_run: dryRun,
    flagged_count: ownership.flagged.length,
    cleared_count: ownership.cleared.length,
    flagged_agent_ids: ownership.flagged,
  });
  const toolCalls = dryRun ? null : await input.projectToolCalls();
  input.logger.info("Tool calls projected", {
    dry_run: dryRun,
    ...(toolCalls === null
      ? {}
      : {
          events_read: toolCalls.eventsRead,
          batches: toolCalls.batches,
          applied_through: toolCalls.appliedThrough,
          caught_up: toolCalls.caughtUp,
          timed_out_batches: toolCalls.timedOut,
        }),
  });
  if ((toolCalls?.heldByFillSeconds ?? 0) >= FILL_HOLD_WARN_SECONDS) {
    // Calls are delayed, not lost: the projection reads them once filled.
    input.logger.warn(
      "Tool call projection is waiting on the event neutral field fill",
      {
        applied_through: toolCalls?.appliedThrough,
        fill_idle_seconds: Math.round(toolCalls?.heldByFillSeconds ?? 0),
      },
    );
  }
  return {
    orphans: reconciled,
    leases,
    interrupts,
    interruptsOverdue,
    terminationsOverdue,
    parkedExpired,
    inputReturns,
    decisionsExpired,
    toolAuditsExpired,
    webSessionsDeleted,
    envStartsPurged,
    slackInboundPayloadsPurged,
    judgmentBufferPurged,
    slackSourceMarksPurged,
    channelSummaryHistoryPruned,
    slackMembersPurged,
    tasksClosedIdle,
    ownership,
    toolCalls,
  };
}
