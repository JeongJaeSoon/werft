import type { SessionViewer } from "../sessions/ports/session-share-store.ts";

/** Installation-wide figures, summed across every owner. */
export type InstallationUsage = {
  /** When the database read them; each figure comes from the same statement. */
  readAt: Date;
  executionSlotsUsed: number;
  queuedInputCount: number;
  storageUsedBytes: number;
  /** null until the storage counter row exists. */
  storageUpdatedAt: Date | null;
  /** Distinct output objects named by an uncollected checkpoint. */
  outputsUsedBytes: number;
  /** null while no checkpoint has recorded an output. */
  outputsUpdatedAt: Date | null;
  /** false while an uncollected checkpoint predates output recording. */
  outputsComplete: boolean;
  /** Archived event chunks as stored in the object store. */
  archivedEventsBytes: number;
  /** null while no chunk was archived. */
  archivedEventsUpdatedAt: Date | null;
};

/**
 * One session's spend and the turns behind it, read in one statement so the
 * amount and the counts describe the same moment: a finalize landing between
 * two reads would otherwise pair an old amount with complete counts.
 */
export type SessionUsageRecord = {
  readAt: Date;
  sessionId: string;
  unmetered: boolean;
  /** `sessions.cost_usd` as the database prints the numeric. */
  costUsd: string;
  providerTokens: number;
  reportedTurnCount: number;
  unreportedTurnCount: number;
  openTurnCount: number;
  queuedInputCount: number;
};

/**
 * Whose sessions a summary adds up: every owner's, or the ones one person
 * (a personal key counts as its creator) or one keyless caller started in
 * one owner partition.
 */
export type UsageSummaryFilter =
  | { kind: "installation" }
  | { kind: "user"; ownerId: string; userId: string }
  | { kind: "api_key"; ownerId: string; apiKeyId: string };

export type UsageTotalsFilter =
  | UsageSummaryFilter
  // Started from any release of the agent, whoever started them.
  | { kind: "agent"; ownerId: string; agentId: string };

/** Sessions created in [since, until), read in one statement. */
export type UsageSummaryRecord = {
  readAt: Date;
  /** `until` as asked, or `readAt` when it was not. */
  until: Date;
  sessionCount: number;
  /** The sum of `sessions.cost_usd` as the database prints the numeric. */
  costUsd: string;
  providerTokens: number;
  /** Ended turns without a cost report plus open turns. */
  incompleteTurnCount: number;
  runSeconds: number;
};

/** One agent's or user's share of a summary; a null id is the sessions without one. */
export type UsageSummaryGroupRecord = {
  id: string | null;
  /** The agent's name or the user's display name. */
  name: string | null;
  sessionCount: number;
  costUsd: string;
  incompleteTurnCount: number;
  /** The floor of the running total minus the floor of the one before. */
  runSeconds: number;
};

/** A summary and its groups from one statement, so they always add up. */
export type UsageSummaryGroupsRecord = UsageSummaryRecord & {
  groups: UsageSummaryGroupRecord[];
};

/** One UTC day of a series: `UsageSummaryRecord`'s figures for that day. */
export type UsageSeriesBucketRecord = {
  /** YYYY-MM-DD. */
  date: string;
  sessionCount: number;
  costUsd: string;
  providerTokens: number;
  incompleteTurnCount: number;
  /** The floor of the running total minus the floor of the one before. */
  runSeconds: number;
};

/** Every UTC day [since, until) touches, read in one statement. */
export type UsageSeriesRecord = {
  readAt: Date;
  until: Date;
  buckets: UsageSeriesBucketRecord[];
};

/** The summary's sessions with the pull requests they opened. */
export type UsageOutcomeFiguresRecord = {
  sessionCount: number;
  costUsd: string;
  providerTokens: number;
  incompleteTurnCount: number;
  sessionsWithPr: number;
  sessionsWithMergedPr: number;
  prCount: number;
  mergedPrCount: number;
  closedPrCount: number;
  costOfMergedSessionsUsd: string;
  /** Every session's cost over the merged count, to six places; null with none. */
  costPerMergedPrUsd: string | null;
};

/** Totals and per-agent groups from one statement, so they add up. */
export type UsageOutcomesRecord = UsageOutcomeFiguresRecord & {
  readAt: Date;
  until: Date;
  /** Largest cost first; a null id is the sessions without an agent. */
  groups: (UsageOutcomeFiguresRecord & {
    id: string | null;
    name: string | null;
  })[];
};

export type UsageAchievementsFilter = {
  period: { since: Date; until?: Date };
  /** Only sessions pinned to a release of this agent. */
  agentId?: string;
  /** Narrow the achievements, not the sessions. */
  typeId?: string;
  categoryId?: string;
  recentLimit: number;
  /** A recent achievement shows its session only in this owner, to this viewer. */
  ownerId: string;
  viewer: SessionViewer;
};

/** `achievementCount` is `auto` plus `confirmed`. */
export type UsageAchievementCountsRecord = {
  achievementCount: number;
  needsReviewCount: number;
};

/** The figures of GET /v1/usage/achievements from one snapshot. */
export type UsageAchievementsRecord = UsageAchievementCountsRecord & {
  readAt: Date;
  until: Date;
  sessionCount: number;
  sessionsWithAchievementCount: number;
  costUsd: string;
  incompleteTurnCount: number;
  rejectedCount: number;
  judgmentCount: number;
  judgeCalls: number;
  judgeCostUsd: string;
  /** Every session's cost over `achievementCount`, to six places; null with none. */
  costPerAchievementUsd: string | null;
  byCategory: (UsageAchievementCountsRecord & { id: string; name: string })[];
  byType: (UsageAchievementCountsRecord & {
    id: string;
    key: string;
    name: string;
  })[];
  byRule: (UsageAchievementCountsRecord & {
    id: string;
    familyId: string;
    version: number;
    title: string;
    categoryId: string;
    categoryName: string;
    typeId: string;
    typeKey: string;
  })[];
  byAgent: {
    id: string | null;
    name: string | null;
    sessionCount: number;
    costUsd: string;
    achievementCount: number;
    costPerAchievementUsd: string | null;
  }[];
  recent: {
    id: string;
    createdAt: Date;
    /**
     * null, with the session's title and the achievement's title and link,
     * for a session the viewer may not read: those can name the session.
     */
    sessionId: string | null;
    sessionTitle: string | null;
    ruleId: string;
    ruleTitle: string;
    title: string | null;
    link: string | null;
    evidenceKind:
      | "github_pull_request"
      | "github_review"
      | "out_file"
      | "conversation";
    judge: "always" | "luna";
    reviewState: "auto" | "needs_review" | "confirmed" | "rejected";
  }[];
};

export type UsageBreakdownFiguresRecord = {
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** As the database prints the numeric. */
  costUsd: string;
};

/**
 * The sessions created in [since, until) grouped by model or agent, read in
 * one statement. A null key is the sessions without an agent, or the cost no
 * metered call explains.
 */
export type UsageBreakdownRecord = {
  rows: (UsageBreakdownFiguresRecord & {
    key: string | null;
    label: string | null;
  })[];
  /** `sessionCount` and `costUsd` are the summary's. */
  totals: UsageBreakdownFiguresRecord;
};

/**
 * One tool name's calls among tool_use events created in the period. A call
 * is timed only when its result is paired and both events carry a time.
 */
export type UsageToolRecord = {
  name: string;
  calls: number;
  failed: number;
  totalMs: number;
  /** 0 when no call of the tool was timed. */
  medianMs: number;
  maxMs: number;
  /** As an engine in the filter's sessions declared it; MCP tools only. */
  description?: string;
};

export type UsageToolsFilter = {
  period: { since: Date; until?: Date };
  /** Only sessions pinned to a release of this agent. */
  agentId?: string;
};

/** One call of a tool. Session id and title are null when hidden. */
export type UsageToolCallRecord = {
  sessionId: string | null;
  title: string | null;
  agent: string | null;
  occurredAt: Date;
  durationMs: number | null;
  outcome: "ok" | "failed" | "unknown";
};

export type UsageToolCallsFilter = UsageToolsFilter & {
  name: string;
  sort: "recent" | "slowest";
  limit: number;
  /** Opaque; a malformed one is InvalidCursorError. */
  cursor?: string;
  /** A session shows its id and title only in this owner, to this viewer. */
  ownerId: string;
  viewer: SessionViewer;
};

export interface UsageReader {
  installationUsage(): Promise<InstallationUsage>;
  /** Whether the workspace has this agent, archived or not. */
  agentExists(ownerId: string, agentId: string): Promise<boolean>;
  /** null when the session is not visible to the owner. */
  sessionUsage(
    ownerId: string,
    sessionId: string,
  ): Promise<SessionUsageRecord | null>;
  usageSummary(
    filter: UsageTotalsFilter,
    period: { since: Date; until?: Date },
  ): Promise<UsageSummaryRecord>;
  usageOutcomes(
    filter: UsageTotalsFilter,
    period: { since: Date; until?: Date },
  ): Promise<UsageOutcomesRecord>;
  usageAchievements(
    filter: UsageTotalsFilter,
    achievements: UsageAchievementsFilter,
  ): Promise<UsageAchievementsRecord>;
  /** Largest cost first. */
  usageSummaryGroups(
    filter: UsageSummaryFilter,
    period: { since: Date; until?: Date },
    by: "agent" | "user",
  ): Promise<UsageSummaryGroupsRecord>;
  usageSeries(
    filter: UsageSummaryFilter,
    period: { since: Date; until?: Date },
  ): Promise<UsageSeriesRecord>;
  usageBreakdown(
    filter: UsageSummaryFilter,
    period: { since: Date; until?: Date },
    by: "model" | "agent",
  ): Promise<UsageBreakdownRecord>;
  /** The most-called tools first, at most `limit` of them. */
  usageTools(
    filter: UsageSummaryFilter,
    tools: UsageToolsFilter,
    limit: number,
  ): Promise<UsageToolRecord[]>;
  usageToolCalls(
    filter: UsageSummaryFilter,
    calls: UsageToolCallsFilter,
  ): Promise<{ calls: UsageToolCallRecord[]; nextCursor: string | null }>;
  /** Every UTC date the period touches, oldest first, zeros included. */
  usageToolDays(
    filter: UsageSummaryFilter,
    tools: UsageToolsFilter & { name: string },
  ): Promise<{ date: string; calls: number }[]>;
}
