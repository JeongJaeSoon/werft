import type {
  AdmissionState,
  PendingQuestion,
  PushRequestOrigin,
  UserLocale,
} from "@werft-ai/contracts";
import type {
  PendingRequestDisplay,
  ToolSummaryContext,
} from "./pending-requests.ts";
import type { PushRequestDisplay } from "./push-requests.ts";

/**
 * `reply`: a turn's answer in its thread. `failure_notice`: a turn the model
 * could not finish, or a reply whose send nobody can vouch for. `input_notice`:
 * a request the session waits on, with the buttons that settle it. `notice`: a refusal,
 * ephemeral to the person who typed. `welcome`: a deployment's one message
 * in the agent's home channel, outside any thread (`threadTs` is "").
 * `instruction`: an input sent from the web or the API, shown in the thread
 * ahead of its answer. `model_notice`: a direct message to one person (their
 * Slack user id is the `channelId`, `threadTs` is "") that a session's model
 * left the agent's allowed list.
 */
export type SlackOutboxKind =
  | "instruction"
  | "reply"
  | "notice"
  | "failure_notice"
  | "input_notice"
  | "welcome"
  | "action_notice"
  | "model_notice";

/**
 * `uncertain`: the send was under way when its lease ran out or its answer
 * never came, so Slack may hold the message; it is never sent again.
 */
export type SlackOutboxStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain";

/**
 * What goes out, before Slack controls are escaped. `mention_user_ids`: the
 * only Slack users the text may notify (a reply's requester). `sender`: the
 * name an instruction is shown under, and the Slack account whose profile
 * image goes with it. `locale`: the language of the words the platform adds,
 * the link's label included; rows from before it have none and read Korean.
 */
export type SlackOutboxBody = {
  text: string;
  link_url?: string;
  locale?: UserLocale;
  mention_user_ids?: string[];
  /** Block Kit, shown in place of `text`, which stays the notification. */
  blocks?: unknown[];
  sender?: { username: string; slack_user_id?: string };
};

export type SlackOutboxEntry = {
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  installationId: string;
  kind: SlackOutboxKind;
  channelId: string;
  threadTs: string;
  /** The ephemeral's reader; set exactly for `notice`. */
  slackUserId: string | null;
  /** The session the console link opens; null for a refusal. */
  sessionId: string | null;
  body: SlackOutboxBody;
  /** The same key twice enqueues once. */
  dedupeKey: string;
};

export type SlackOutboxFence = { id: string; claimToken: string };

export type SlackOutboxClaim = SlackOutboxEntry &
  SlackOutboxFence & {
    /**
     * Attempts so far, this one included. A claim whose lease lapses before
     * beginSend or settle does not count.
     */
    attempts: number;
  };

/** A row the lease ran out on mid-send, now `uncertain`. */
export type SlackOutboxLost = SlackOutboxEntry & { id: string };

/**
 * Where a linked session's turns answer: the link's thread. `locale`: that
 * of whoever started the session, whom the thread is in their language for.
 */
export type SlackLinkedTurnTarget = {
  locale: UserLocale | null;
  sessionLinkId: string;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
};

/** An ended turn of a live linked session that has no outbox row yet. */
export type SlackUnansweredTurn = SlackLinkedTurnTarget & {
  /** The public turn id, 1-based within the session. */
  turnId: number;
  state: "completed" | "failed";
  /** The Slack account linked to whoever asked for the turn, if any. */
  requesterSlackUserId: string | null;
  /**
   * The final attempt's top-level assistant and tool_use event payloads,
   * in order; empty unless the turn completed.
   */
  events: { type: string; payload: unknown }[];
};

/**
 * A turn of a live linked session asked from the web or the API that the
 * thread has not been shown yet.
 */
export type SlackUnpostedInstruction = SlackLinkedTurnTarget & {
  turnId: number;
  channel: "web" | "api";
  message: string;
  /** Who sent it; null for an API key no person created. */
  senderName: string | null;
  /** The Slack account linked to the sender, if any. */
  senderSlackUserId: string | null;
};

/**
 * A request of a live linked session that a person can still settle, with
 * no outbox row yet: a permission or question a client can answer, or a
 * push request waiting for its decision.
 */
export type SlackPendingPrompt = SlackLinkedTurnTarget & {
  /** The Slack account linked to whoever asked for the turn, if any. */
  requesterSlackUserId: string | null;
  prompt:
    | {
        kind: "permission";
        requestId: string;
        tool: string;
        input: unknown;
        context: ToolSummaryContext;
        /**
         * The rules the run offered to keep for the session, redacted for
         * display. Present, the card offers "allow for the session"; the
         * worker that registered it announced it can take the answer.
         */
        rememberOffer?: { toolName: string; ruleContent?: string }[];
        expiresAt: string;
      }
    | {
        kind: "question";
        requestId: string;
        questions: PendingQuestion[];
        expiresAt: string;
      }
    | {
        kind: "push";
        requestId: string;
        repositoryId: string;
        repositoryName: string | null;
        targetBranch: string;
        gitCommit: string;
      };
};

/**
 * What a posted card is redrawn from: its row's language and link, the
 * request as the database holds it now, and the Slack account of whoever
 * decided it in the card's workspace.
 */
export type SlackPromptCard = {
  locale: UserLocale;
  /** Where a decided request was decided; null while none was. */
  decidedVia: "slack" | "web" | null;
  /** A push's checkpoint revisions, for `pushApprovability`. */
  pushRevisions?: {
    session: number | null;
    request: number;
    origin: PushRequestOrigin;
  };
  linkUrl: string | null;
  deciderSlackUserId: string | null;
  display: PendingRequestDisplay | ({ kind: "push" } & PushRequestDisplay);
};

export type SlackOutboxSettle =
  | { status: "sent"; slackTs: string }
  | { status: "failed"; errorCode: string }
  | { status: "uncertain"; errorCode: string }
  | { status: "pending"; retryInMs: number; errorCode: string };

/** One session's state as stored, read for its thread status. */
export type SlackThreadStatusFacts = {
  admissionState: AdmissionState;
  executionRevoked: boolean;
  /** A turn whose outcome is unknown: the session waits on recovery. */
  unknownTurn: boolean;
  checkpointRevision: number | null;
  /** Pending under the answer path's own rule, parked ones included. */
  answerableRequest: boolean;
  runningTurn: boolean;
  queuedTurn: boolean;
  requestedPushes: {
    checkpointRevision: number;
    gitCommit: string;
    origin: PushRequestOrigin;
  }[];
  /** Push intents still waiting and pull request stages still open. */
  actionStages: {
    kind: "push_intent" | "pull_request";
    id: string;
    state: string;
  }[];
};

export type SlackThreadStatusTarget = {
  sessionLinkId: string;
  sessionId: string;
  workspaceId: string;
  slackAppId: string;
  channelId: string;
  threadTs: string;
};

export type SlackThreadStatusFence = {
  sessionLinkId: string;
  claimToken: string;
};

export type SlackThreadStatusClaim = SlackThreadStatusTarget &
  SlackThreadStatusFence & {
    /** dirty_rev when claimed: what a send or a skip settles, no further. */
    dirtyRev: number;
    uncertainRev: number;
    uncertain: boolean;
    /** Taken over from a writer whose lease ran out: it sends regardless. */
    inherited: boolean;
    sentStatus: string | null;
    sentAt: Date | null;
  };

export type SlackThreadStatusReconcile = SlackThreadStatusTarget & {
  sentStatus: string | null;
  sentAt: Date | null;
  facts: SlackThreadStatusFacts;
};

/**
 * The `slack` role's thread status rows (94S-1292). Every write after
 * `claim` is fenced by its token except `uncertain`, which must land even
 * when the lease is lost.
 */
export interface SlackThreadStatusStore {
  /**
   * Rows whose send outlived the lease and its grace become uncertain from
   * the send's start (design §4 rule 6), so they wait out the window first.
   */
  expireInflight(input: { graceMs: number; windowMs: number }): Promise<number>;
  /**
   * Live links' rows that changed since their last send, or whose uncertain
   * window passed, with no lease left (after its grace) and no `next_at`
   * ahead and not disabled.
   */
  claim(input: {
    limit: number;
    leaseMs: number;
    graceMs: number;
  }): Promise<SlackThreadStatusClaim[]>;
  /** Null when the session is gone. */
  facts(sessionId: string): Promise<SlackThreadStatusFacts | null>;
  /**
   * The send's start, or null when the token is no longer this writer's or
   * less than `minLeaseLeftMs` of the lease is left.
   */
  beginSend(
    fence: SlackThreadStatusFence,
    minLeaseLeftMs: number,
  ): Promise<Date | null>;
  /**
   * A send that succeeded. The uncertainty clears only when this send began
   * a window after the latest uncertain one and none was recorded since.
   */
  finish(
    fence: SlackThreadStatusFence,
    sent: {
      dirtyRev: number;
      status: string;
      startedAt: Date;
      uncertainRev: number;
      windowMs: number;
    },
  ): Promise<boolean>;
  /** The computed status is the one Slack shows: nothing to send. */
  skip(fence: SlackThreadStatusFence, dirtyRev: number): Promise<boolean>;
  /** A send whose outcome is unknown; lands without the lease. */
  uncertain(
    fence: SlackThreadStatusFence,
    startedAt: Date,
    windowMs: number,
  ): Promise<void>;
  /** Try again no sooner than `retryInMs` from now, nor any boundary set. */
  defer(fence: SlackThreadStatusFence, retryInMs: number): Promise<boolean>;
  /** Slack will not show a status there; skipped until re-enabled. */
  disable(fence: SlackThreadStatusFence, reason: string): Promise<boolean>;
  /**
   * Re-enables rows disabled `disabledForMs` ago or before their
   * installation was verified again, then up to `limit` live links whose
   * row is missing or not yet closed and not disabled, longest unreconciled
   * first.
   */
  reconcileBatch(input: {
    limit: number;
    disabledForMs: number;
  }): Promise<SlackThreadStatusReconcile[]>;
  /** Stamps the links reconciled, raising dirty_rev where marked dirty. */
  reconciled(rows: { sessionLinkId: string; dirty: boolean }[]): Promise<void>;
}

/**
 * What a posted card shows: its buttons (`open`), only Reject for a push
 * that can no longer be approved (`reject_only`), or how it ended (`done`
 * for a turn's notice from before the cards).
 */
export type SlackCardRendered =
  | "open"
  | "reject_only"
  | "allowed"
  | "allowedSession"
  | "denied"
  | "answered"
  | "approved"
  | "rejected"
  | "expired"
  | "closed"
  | "done";

export type SlackCardFence = { id: string; claimToken: string };

export type SlackCardClaim = SlackCardFence & {
  workspaceId: string;
  slackAppId: string;
  sessionId: string | null;
  channelId: string;
  slackTs: string;
  dedupeKey: string;
  body: SlackOutboxBody;
  rendered: SlackCardRendered | null;
  uncertainRev: number;
  /** An edit of unknown outcome is on record: it sends regardless. */
  uncertain: boolean;
  /** Taken over from a writer whose lease ran out: it sends regardless. */
  inherited: boolean;
  /** Failures so far, rate limits not counted. */
  attempts: number;
};

/** A push card still showing a choice, for `pushApprovability`. */
export type SlackOpenPushCard = {
  id: string;
  seq: number;
  sessionId: string;
  rendered: "open" | "reject_only";
  sessionCheckpointRevision: number | null;
  checkpointRevision: number;
  gitCommit: string;
  origin: PushRequestOrigin;
};

/**
 * The `slack` role's redraws of posted cards (design slack-approval-ui §4).
 * Every write after `claim` is fenced by its token except `uncertain`,
 * which must land even when the lease is lost.
 */
export interface SlackCardSettleStore {
  /**
   * Marks `due` the sent cards whose request moved on from what they show:
   * answered or closed (web, expiry, session close), a push decided, a
   * turn's notice whose turn waits no more. Returns how many.
   */
  markDue(): Promise<number>;
  /** Marks one card `due` (its press), unless abandoned. */
  markDueAt(card: { channelId: string; slackTs: string }): Promise<boolean>;
  /** Marks one card `due` by its row (a push whose approvability moved). */
  markDueById(id: string): Promise<boolean>;
  /**
   * Push cards still showing a choice whose session has moved on since, in
   * `seq` order after `afterSeq`, so a pass can page past cards that stay
   * as they are.
   */
  openPushCards(input: {
    limit: number;
    afterSeq: number | null;
  }): Promise<SlackOpenPushCard[]>;
  /** Edits that outlived the lease and its grace become uncertain. */
  expireInflight(input: { graceMs: number; windowMs: number }): Promise<number>;
  /**
   * `due` cards, and ones whose uncertain window passed, with no lease left
   * (after its grace) and no `settle_next_at` ahead; `only` narrows to one.
   */
  claim(input: {
    limit: number;
    leaseMs: number;
    graceMs: number;
    only?: { channelId: string; slackTs: string };
  }): Promise<SlackCardClaim[]>;
  /** The card's request as stored now; null when it is gone. */
  card(claim: SlackCardClaim): Promise<SlackPromptCard | null>;
  /** True while the card is a turn's notice whose turn still waits. */
  turnWaits(claim: SlackCardClaim): Promise<boolean>;
  /** The edit's start, or null when the lease is lost or nearly over. */
  beginSend(
    fence: SlackCardFence,
    minLeaseLeftMs: number,
  ): Promise<Date | null>;
  /**
   * An edit that succeeded. An end state settles the row; the uncertainty
   * clears only as in the thread status writer.
   */
  finish(
    fence: SlackCardFence,
    sent: {
      rendered: SlackCardRendered;
      uncertainRev: number;
      windowMs: number;
    },
  ): Promise<boolean>;
  /** Shows what it showed already: release the row as drawn. */
  skip(fence: SlackCardFence): Promise<boolean>;
  /** An edit whose outcome is unknown; lands without the lease. */
  uncertain(
    fence: SlackCardFence,
    startedAt: Date,
    windowMs: number,
  ): Promise<void>;
  /** Try again no sooner than `retryInMs`; `failed` counts an attempt. */
  defer(
    fence: SlackCardFence,
    /** A null `error` keeps the one recorded before. */
    input: { retryInMs: number; failed: boolean; error: string | null },
  ): Promise<boolean>;
  /** Slack takes no more edits of it. */
  abandon(fence: SlackCardFence, error: string): Promise<boolean>;
}

export interface SlackOutboxStore {
  /** Absent in stores without the thread status table. */
  threadStatus?: SlackThreadStatusStore;
  /** Absent in stores without the card settle columns. */
  cards?: SlackCardSettleStore;
  /**
   * `whileHome`: insert only while that binding is the agent's live home
   * and that release is active, checked under share locks so a home move
   * or an activation committing meanwhile is waited for, not missed.
   */
  enqueue(
    entry: SlackOutboxEntry,
    whileHome?: { bindingId: string; releaseId: string },
  ): Promise<"enqueued" | "duplicate" | "not_home">;
  /** The language of the user that Slack account is linked to, if any. */
  readerLocale(reader: {
    workspaceId: string;
    teamId: string;
    slackUserId: string;
  }): Promise<UserLocale | null>;
  /**
   * Moves each live link's mark past the turns that need nothing more: those
   * with their outbox row, interrupted or cancelled, or ended before the
   * link. A turn still running or waiting stops it. Returns links moved.
   */
  advanceAnswered(): Promise<number>;
  /**
   * Linked turns past the link's mark, asked from the web or the API after
   * the link, with no `instruction` row yet; neither cancelled nor
   * interrupted.
   */
  unpostedInstructions(limit: number): Promise<SlackUnpostedInstruction[]>;
  /**
   * Linked turns past the link's mark that ended without their outbox
   * row. A turn that owes an `instruction` row waits for it,
   * so the answer never goes ahead of what it answers.
   */
  unansweredTurns(limit: number): Promise<SlackUnansweredTurn[]>;
  /**
   * The card posted as that message for that request, or null when no
   * `input_notice` row of the session sent it.
   */
  promptCard(input: {
    sessionId: string;
    requestId: string;
    channelId: string;
    slackTs: string;
  }): Promise<SlackPromptCard | null>;
  /** Requests of live linked sessions without their `input_notice` row. */
  unpromptedRequests(limit: number): Promise<SlackPendingPrompt[]>;
  /** Moves `sending` rows whose lease ran out to `uncertain`. */
  expireSending(): Promise<SlackOutboxLost[]>;
  /**
   * Fails `pending` rows with nowhere left to go: a revoked installation, or
   * a link revoked, muted or turned to summary since the row was enqueued.
   */
  closeUnaddressed(): Promise<
    Pick<SlackOutboxLost, "id" | "kind" | "channelId">[]
  >;
  /** `uncertain` replies whose thread has not been told so yet. */
  untoldUncertain(limit: number): Promise<SlackOutboxLost[]>;
  /**
   * Due `pending` rows under a lease from the database clock. They stay
   * `pending` until beginSend, so a crash before the send is claimed again.
   */
  claim(input: { limit: number; leaseMs: number }): Promise<SlackOutboxClaim[]>;
  /** `sending` from here on: a lease that runs out now leaves it `uncertain`. */
  beginSend(fence: SlackOutboxFence): Promise<boolean>;
  /** False when the lease was lost: the row is someone else's now. */
  settle(fence: SlackOutboxFence, outcome: SlackOutboxSettle): Promise<boolean>;
}
