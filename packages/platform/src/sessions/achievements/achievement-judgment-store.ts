import type {
  AchievementEvidenceKind,
  AchievementJudgmentError,
  AchievementPayload,
  AchievementReviewState,
  AchievementRuleJudge,
  GitHubPullRequestOutcomeState,
  GitHubReviewEvent,
  ListSessionAchievementsResponse,
  ReviewAchievementRequest,
  SessionAchievement,
} from "@werft-ai/contracts";
import type { TeamActor } from "../../musterrolle/ports/team-store.ts";

/** Triggers within this of the last one merge into one judgment. */
export const ACHIEVEMENT_JUDGMENT_QUIET_MS = 120_000;

/** After a failed try, a judgment is tried again this long later, once each. */
export const ACHIEVEMENT_JUDGMENT_RETRY_MS = [60_000, 300_000, 1_800_000];

/** A judgment the judge holds the lease of. */
export type ClaimedJudgment = {
  id: string;
  sessionId: string;
  leaseToken: string;
  /** Tries so far, this one included. */
  attempts: number;
  /** Why the last finished try failed. */
  errorCode: AchievementJudgmentError | null;
};

/** A rule in use for the session, with its type. */
export type JudgedRule = {
  id: string;
  familyId: string;
  typeId: string;
  typeKey: string;
  builtin: boolean;
  evidenceKind: AchievementEvidenceKind;
  judge: AchievementRuleJudge;
  definition: string;
};

/** A session_outcomes row, as evidence. */
export type OutcomeEvidence =
  | {
      kind: "github_pull_request";
      id: string;
      url: string;
      number: number;
      state: GitHubPullRequestOutcomeState;
      mergedAt: Date | null;
      additions: number | null;
      deletions: number | null;
      /** Cut to 200 characters; null on rows from before titles were kept. */
      title: string | null;
    }
  | {
      kind: "github_review";
      id: string;
      url: string;
      number: number;
      event: GitHubReviewEvent;
      commitId: string;
    };

/** The workspace's judge, as it stands when a judgment runs. */
export type JudgeInForce = {
  /** The `openai_decisions` connection; null leaves `luna` rules unjudged. */
  connectionId: string | null;
  dailyBudgetUsd: number;
  maxPerSession: number;
  /** What the workspace's judgment calls cost since the UTC day began. */
  spentUsd: number;
  /** The next UTC midnight, by the database's clock. */
  budgetResetsAt: Date;
  /** The session's other judgments that called the judge. */
  sessionJudgments: number;
  /** A `luna` pair counts when its "yes" is at least this likely. */
  threshold: number;
  transcript: "none" | "recent";
  /** The input digest of the session's last judgment that succeeded. */
  lastInputDigest: string | null;
};

/** One ended turn: what the person said and the engine's final answer. */
export type TranscriptTurn = {
  sequence: number;
  message: string;
  result: string | null;
};

export type JudgmentContext = {
  session: {
    id: string;
    title: string | null;
    agentId: string | null;
    agentReleaseId: string | null;
  };
  rules: JudgedRule[];
  /** Those whose state last changed since the decision model was on. */
  outcomes: OutcomeEvidence[];
  judge: JudgeInForce;
  /**
   * What happened since the decision model was on without a break: older
   * evidence is never judged.
   */
  since: {
    /**
     * When that began, as the store reads it back; null with no model on.
     * Every read of the judgment uses this one, and `finish` writes nothing
     * once another is in force.
     */
    at: string | null;
    /** A turn ended since. */
    conversation: boolean;
    /**
     * The checkpoints committed since, by revision and publish directory
     * (ending in `/`). A stored out/ file is new when its key is under one
     * of the directories, the checkpoint that first uploaded its bytes; an
     * omitted one when the listed revision is among them.
     */
    checkpoints: { revision: number; directory: string }[];
  };
};

export type NewAchievement = {
  ruleId: string;
  ruleFamilyId: string;
  typeId: string;
  agentId: string | null;
  agentReleaseId: string | null;
  title: string;
  link: string;
  evidenceKind: AchievementEvidenceKind;
  evidenceId: string | null;
  payload: AchievementPayload | null;
  judge: AchievementRuleJudge;
  /** Luna's "yes" probability; null for an `always` rule. */
  probability: number | null;
  reviewState: AchievementReviewState;
};

export type JudgmentResult = {
  errorCode: AchievementJudgmentError | null;
  /** The rule versions and evidence ids paired. */
  rules: string[];
  evidenceIds: string[];
  achievements: NewAchievement[];
  /** Set when the `luna` pairs were judged, with or without a call. */
  luna?: {
    connectionId: string;
    /** Of every pair's request; the same digest again is not sent. */
    inputDigest: string;
    /**
     * Pairs answered "no": the family's achievement for that evidence is
     * superseded, unless a person confirmed or rejected it.
     */
    declined: { ruleFamilyId: string; evidenceId: string | null }[];
  };
  /** `JudgmentContext.since.at` of the evidence paired. */
  since?: string | null;
  /**
   * The threshold `luna` pairs were asked against, set once a call went out
   * whether or not the try then failed; apart from `luna`, whose digest a
   * failed try must not keep.
   */
  threshold?: number;
} & (
  | { status: "succeeded" | "skipped" | "failed" }
  /** Tried again after `retryInMs`. */
  | { status: "queued"; retryInMs: number }
  /** Over the day's budget: picked again at `until`, the next UTC day. */
  | { status: "deferred"; until: Date }
);

/** The judgments and achievements of sessions; the judge is the only writer. */
export interface AchievementJudgmentStore {
  /**
   * Leases at most `max` judgments due: queued ones whose last trigger is
   * older than the quiet time, and running ones whose lease ran out.
   */
  claim(input: { max: number; leaseMs: number }): Promise<ClaimedJudgment[]>;
  /**
   * What the judgment pairs: the session, its rules in use, its outcomes,
   * and the workspace's judge with its spend since UTC midnight.
   */
  context(judgment: ClaimedJudgment): Promise<JudgmentContext>;
  /**
   * Extends the lease by `leaseMs` from now while no one took it over, even
   * once it ran out; false once it was taken over or finished.
   */
  renew(judgment: ClaimedJudgment, leaseMs: number): Promise<boolean>;
  /**
   * The session's last `turns` turns that ended since `since`
   * (`JudgmentContext.since.at`), oldest first.
   */
  transcript(
    sessionId: string,
    turns: number,
    since: string | null,
  ): Promise<TranscriptTurn[]>;
  /**
   * Writes the result and the achievements in one transaction under the
   * lease; one a rule family already has for the evidence is kept. A "no"
   * takes down only what the window in force counted. When `result.since`
   * is no longer the window in force, the judgment ends as skipped with
   * `judge_unavailable` and writes no achievement. A retry
   * goes back to queued and a deferral to deferred, or, when the session
   * has another pending judgment already, moves that one's wait instead and
   * ends as `failed`. False when the lease was taken over or the
   * judgment was finished meanwhile.
   */
  finish(judgment: ClaimedJudgment, result: JudgmentResult): Promise<boolean>;
  /** Null when the owner has no such session. */
  list(
    ownerId: string,
    sessionId: string,
  ): Promise<ListSessionAchievementsResponse | null>;
  /**
   * Queues a `manual` judgment of the session, or merges into its pending
   * one, with a `rejudge_session` receipt in the same transaction.
   */
  /** The session and agent of an achievement in force; null when none. */
  find(
    ownerId: string,
    achievementId: string,
  ): Promise<{ sessionId: string; agentId: string | null } | null>;
  /**
   * Confirms a `needs_review` achievement, or rejects an `auto` or
   * `needs_review` one, with a `review_achievement` receipt in the same
   * transaction. `not_reviewable`: the action does not apply to its state.
   */
  review(
    input: AchievementReview,
  ): Promise<
    | { outcome: "reviewed"; achievement: SessionAchievement }
    | { outcome: "not_found" | "actor_inactive" | "not_reviewable" }
  >;
  rejudge(input: {
    actor: TeamActor;
    sessionId: string;
    receiptId: string;
  }): Promise<
    | { outcome: "queued"; judgmentId: string }
    | { outcome: "not_found" | "actor_inactive" }
  >;
}

/** What a person decided about an achievement, as the store writes it. */
export type AchievementReview = {
  actor: TeamActor;
  achievementId: string;
  action: ReviewAchievementRequest["action"];
  note: string | null;
  receiptId: string;
};

/** The judgment egress token's half of the store. */
export interface JudgmentEgressStore {
  /** Stores the token's hash on a judgment the lease still holds. */
  issueToken(
    judgment: ClaimedJudgment,
    tokenHash: Uint8Array,
  ): Promise<boolean>;
  /**
   * The running judgment the token belongs to while its lease holds, with
   * the workspace's judge and its spend since UTC midnight.
   */
  authorizeToken(input: { tokenHash: Uint8Array }): Promise<
    | {
        outcome: "ok";
        judgmentId: string;
        connectionId: string | null;
        dailyBudgetUsd: number;
        spentUsd: number;
      }
    | { outcome: "invalid_token" }
  >;
  /**
   * Adds one call's use to the judgment's ledger once per exchange; the
   * same report again is `replayed`, other use under its exchange a
   * `conflict`.
   */
  recordUsage(input: {
    exchangeId: string;
    judgmentId: string;
    inputTokens: number;
    costUsd: number;
  }): Promise<
    | { outcome: "recorded" | "replayed"; costUsd: number }
    | { outcome: "conflict" }
    | { outcome: "unknown_judgment" }
  >;
}
