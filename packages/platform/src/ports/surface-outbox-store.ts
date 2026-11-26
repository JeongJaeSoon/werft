import type {
  AdmissionState,
  BudgetOwnerKind,
  ConversationInputId,
  ConversationKind,
  ConversationTurnId,
  PendingQuestion,
  PushRequestOrigin,
  SlackMirrorCorrelationId,
  SlackNoticeVersion,
  UserLocale,
} from "@werft-ai/contracts";
import type { PushRequestDisplay } from "../action/ports/push-requests.ts";
import type { StoredSourceSet } from "../conversations/index.ts";
import type {
  PendingRequestDisplay,
  ToolSummaryContext,
} from "../sessions/ports/pending-requests.ts";

/**
 * `reply`: a turn's answer in its thread. `failure_notice`: a turn the model
 * could not finish, a reply whose send nobody can vouch for, or a bot's
 * mention the thread's bot-turn limit stopped (no session then when the
 * agent has none there). `input_notice`:
 * a request the session waits on, with the buttons that settle it. `notice`: a refusal,
 * ephemeral to the person who typed. `welcome`: a deployment's one message
 * in the agent's home channel, outside any thread (`threadTs` is "").
 * `instruction`: an input sent from the web or the API, shown in the thread
 * ahead of its answer. `model_notice`: a session's model left the agent's
 * allowed list or moved, or its worker image was retracted, told in the
 * session's thread with a link to the session; no person is sent one
 * directly, and a session with no thread is told on the web only.
 * `input_mirror`: a web input shown in Slack
 * as an `instruction` is, with no session; its post's ts becomes the input's
 * Slack alias, and its topic's when the topic had none (`threadTs` "" then).
 * `channel_notice`: the one line telling a channel the agent reads it, once
 * per agent, channel and notice version that asked for approval, outside any
 * thread (`threadTs` "").
 * `progress`: one update of a message edited in place (its `progressKey`):
 * the first goes as a new post, later ones edit it, at most one every
 * `SURFACE_PROGRESS_EDIT_INTERVAL_MS`, and an update a newer one overtakes
 * before it goes is dropped (`superseded`). A post Slack lost is put up
 * again once; after that the message stops (`progress_stopped`).
 * `reaction`: the one 👀 on the message `threadTs` names in `channelId`
 * (not a post: `body` is unused), keyed once per Slack team, channel and
 * message. Slack's `already_reacted` counts as sent; `slack_ts` is the
 * message reacted to.
 * `conversation_reply`: a conversation turn's answer, the effect of its
 * "reply" decision (v1-b/E1), with no session: its turn (`conversationTurnId`)
 * names it, keyed once per turn. It goes in the turn's topic thread, never at
 * the top of a channel (`threadTs` is never ""), and ends with the AI line.
 */
export const SURFACE_OUTBOX_KIND_VALUES = [
  "instruction",
  "reply",
  "notice",
  "failure_notice",
  "input_notice",
  "welcome",
  "action_notice",
  "model_notice",
  "input_mirror",
  "channel_notice",
  "progress",
  "reaction",
  "conversation_reply",
] as const;
export type SurfaceOutboxKind = (typeof SURFACE_OUTBOX_KIND_VALUES)[number];

/**
 * The sends a reaction gets, its lease running out included: asking again
 * is safe (Slack answers `already_reacted` to one it holds).
 */
export const SURFACE_REACTION_MAX_ATTEMPTS = 5;

/** The least time between two sends of one progress message. */
export const SURFACE_PROGRESS_EDIT_INTERVAL_MS = 10_000;
/** A progress update a newer one overtook before it went: never sent. */
export const SURFACE_PROGRESS_SUPERSEDED_CODE = "superseded";
/**
 * A progress message Slack lost after it was put up again: this update and
 * every later one are never sent.
 */
export const SURFACE_PROGRESS_STOPPED_CODE = "progress_stopped";

/**
 * `uncertain`: the send was under way when its lease ran out or its answer
 * never came, so Slack may hold the message; it is never sent again.
 * `voided_by_delete`: one of its sources was deleted in Slack before its
 * send began, so it was never sent (`error_code` `source_deleted`).
 */
export type SurfaceOutboxStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "voided_by_delete";

/**
 * What goes out, before Slack controls are escaped. `mention_user_ids`: the
 * only Slack users the text may notify (a reply's requester). `sender`: the
 * name an instruction is shown under, and the Slack account whose profile
 * image goes with it. `locale`: the language of the words the platform adds,
 * the link's label included; rows from before it have none and read English.
 */
export type SurfaceOutboxBody = {
  text: string;
  link_url?: string;
  locale?: UserLocale;
  mention_user_ids?: string[];
  /** Block Kit, shown in place of `text`, which stays the notification. */
  blocks?: unknown[];
  sender?: { username: string; slack_user_id?: string };
  /**
   * The person a `conversation_reply` answers, by their Werft name, for its
   * AI line; absent when no linked person asked.
   */
  requested_by?: string;
};

export type SurfaceOutboxEntry = {
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  installationId: string;
  kind: SurfaceOutboxKind;
  channelId: string;
  threadTs: string;
  /** The ephemeral's reader; set exactly for `notice`. */
  slackUserId: string | null;
  /**
   * The link whose thread the row reports to, fixed when it is enqueued;
   * null for a row outside a linked thread.
   */
  sessionLinkId: string | null;
  /** The session the console link opens; null for a refusal. */
  sessionId: string | null;
  body: SurfaceOutboxBody;
  /** The same key twice enqueues once. */
  dedupeKey: string;
  /**
   * The sources of the turn the row answers or tells of, as that turn holds
   * them; absent or null for none, and for a row of no one turn.
   */
  sources?: StoredSourceSet | null;
  /**
   * That turn's public id. An overflowed set is judged by the direct sources
   * of it and the turns before it, not of turns that came later.
   */
  sourcesTurn?: number | null;
  /** The web input an `input_mirror` row shows; absent or null otherwise. */
  inputId?: ConversationInputId | null;
  /**
   * An `input_mirror` row's value for this one request, sent as the post's
   * message metadata so the post Slack sends back can name it.
   */
  correlationId?: SlackMirrorCorrelationId | null;
  /**
   * A row bound for this web input's mirror thread. Until the mirror's post
   * is known the row is held, unsent, and its `channelId` and `threadTs`
   * are placeholders; the post's settle writes the thread in and frees it.
   * A row enqueued once the thread is known goes there at once.
   */
  heldForInputId?: ConversationInputId | null;
  /**
   * The progress message a `progress` row updates; set on it alone. One key
   * is one message across the installation: name it after what it reports.
   */
  progressKey?: string | null;
  /** The conversation turn a `conversation_reply` row answers; set on it alone. */
  conversationTurnId?: ConversationTurnId | null;
};

export type SurfaceOutboxFence = { id: string; claimToken: string };

/**
 * The conversation a row speaks in, as the server reads it: a channel's team
 * and channel, or a DM's team (its D… channel is not kept on the
 * conversation).
 */
export type SurfaceConversationScope = {
  kind: ConversationKind;
  teamId: string;
  channelId: string | null;
};

export type SurfaceOutboxClaim = SurfaceOutboxEntry &
  SurfaceOutboxFence & {
    /**
     * Attempts so far, this one included. A claim whose lease lapses before
     * beginSend or settle does not count.
     */
    attempts: number;
    /**
     * The parent conversation of the row's session, read at claim: the only
     * Slack channel the text may link to or name. Null or absent for a row
     * with no session, or a session with no parent conversation.
     */
    conversationScope?: SurfaceConversationScope | null;
  };

/**
 * Who a row goes out as: the agent's name and, for a task (a session with a
 * Slack link), that session's title, null while it has none.
 */
export type SurfaceOutboxPostedAs = {
  agentName: string;
  taskTitle: string | null;
};

/**
 * The AI line a post of an agent whose conversation rollout is `on` ends with.
 * `requestedBy`: the Werft name of whoever sent the turn the row answers or
 * asks about; null for a row of no such turn, or a name nobody can read.
 */
export type SurfaceAiLabel = { requestedBy: string | null };

/**
 * What beginSend read for a row about to go. `progress`, on a `progress`
 * row: the ts of the post its update edits, null when it posts, and whether
 * the message was already put up again once. `aiLabel`: absent while the
 * rollout is `off` or `shadow`.
 */
export type SurfaceOutboxBegun = SurfaceOutboxPostedAs & {
  progress?: { ts: string | null; reposted: boolean };
  aiLabel?: SurfaceAiLabel;
};

/** A row the lease ran out on mid-send, now `uncertain`. */
export type SurfaceOutboxLost = SurfaceOutboxEntry & { id: string };

/**
 * Where a linked session's turns answer: the link's thread. `locale`: that
 * of whoever started the session, whom the thread is in their language for.
 */
export type SurfaceLinkedTurnTarget = {
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
export type SurfaceUnansweredTurn = SurfaceLinkedTurnTarget & {
  /** The public turn id, 1-based within the session. */
  turnId: number;
  /** The turn's sources, which its reply or failure notice carries on. */
  sources: StoredSourceSet | null;
  state: "completed" | "failed";
  /** The Slack account linked to whoever asked for the turn, if any. */
  requesterSlackUserId: string | null;
  /** Why a failed turn ended (`no_capacity`); null or absent when unsaid. */
  terminalReason?: string | null;
  /** The session is paused: a resume that found no room went back to it. */
  sessionPaused?: boolean;
  /**
   * The turn's outcome is unknown and its session has no committed
   * checkpoint: its notice offers start_fresh, which runs the turn again.
   */
  startFreshOffered?: boolean;
  /**
   * A failed turn a budget account refused (recordBudgetAccountRefusal):
   * its notice says so in place of "try again". `first`: the session's first
   * refusal while the limit holds (no told refusal on an earlier turn since
   * the last completed one, in the same UTC month), told in the thread; a
   * later one goes only to the person who asked, except in a direct message.
   * Null or absent otherwise.
   */
  budgetRefusal?: { owner: BudgetOwnerKind; first: boolean } | null;
  /**
   * The final attempt's top-level assistant and tool_use event payloads,
   * in order; empty unless the turn completed.
   */
  events: { type: string; payload: unknown }[];
};

/**
 * A channel the agent now reads every message of (`stillListened`): its
 * switch is raised under a counted notice approval, the binding is `ready`,
 * `on`, listening `free`, not shared with another organization, and the bot
 * is in it. `noticeVersion`: the latest version that asked for approval, so
 * a version that only rewords it is told nothing new. `attempt`: how many
 * rows the channel took for it before, all failed unsent.
 */
export type SurfaceChannelNoticeTarget = {
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  installationId: string;
  teamId: string;
  channelId: string;
  noticeVersion: SlackNoticeVersion;
  attempt: number;
};

/**
 * A live linked session whose worker has waited for room past the notice
 * threshold, and the launch that waits: its thread hears of each wait once.
 */
export type SurfaceCapacityWait = SurfaceLinkedTurnTarget & {
  executionId: string;
  generation: number;
};

/**
 * A turn of a live linked session asked from the web or the API that the
 * thread has not been shown yet.
 */
export type SurfaceUnpostedInstruction = SurfaceLinkedTurnTarget & {
  turnId: number;
  sources: StoredSourceSet | null;
  channel: "web" | "api";
  message: string;
  /** Who sent it; null for an API key no person created. */
  senderName: string | null;
  /** The Slack account linked to the sender, if any. */
  senderSlackUserId: string | null;
};

/**
 * A web input still owed its Slack mirror, and where the mirror goes: its
 * topic's thread, or, for a topic Slack has not placed (`threadTs` ""), the
 * top of its channel, or of the person's DM a placed topic of theirs names.
 */
export type UnmirroredWebInput = {
  inputId: ConversationInputId;
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
  body: string;
  senderName: string | null;
  /** The sender's Slack account in the installation's team, if linked. */
  senderSlackUserId: string | null;
  locale: UserLocale | null;
};

/**
 * A request of a live linked session that a person can still settle, with
 * no outbox row yet: a permission or question a client can answer, or a
 * push request waiting for its decision.
 */
export type SurfacePendingPrompt = SurfaceLinkedTurnTarget & {
  /** The session's parent conversation, as the outbox claim reads it. */
  conversationScope?: SurfaceConversationScope | null;
  /** The sources of the turn that asked. */
  sources: StoredSourceSet | null;
  /** That turn's public id; null with no sources. */
  sourcesTurn: number | null;
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
export type SurfacePromptCard = {
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
  /** The session's parent conversation, as the outbox claim reads it. */
  conversationScope?: SurfaceConversationScope | null;
};

export type SurfaceOutboxSettle =
  | { status: "sent"; slackTs: string }
  /** `retryInMs`: the wait Slack asked for, kept for a progress message's next update. */
  | { status: "failed"; errorCode: string; retryInMs?: number }
  | { status: "uncertain"; errorCode: string }
  | { status: "pending"; retryInMs: number; errorCode: string };

/** One session's state as stored, read for its thread status. */
export type SurfaceThreadStatusFacts = {
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

export type SurfaceThreadStatusTarget = {
  sessionLinkId: string;
  sessionId: string;
  workspaceId: string;
  slackAppId: string;
  channelId: string;
  threadTs: string;
};

export type SurfaceThreadStatusFence = {
  sessionLinkId: string;
  claimToken: string;
};

export type SurfaceThreadStatusClaim = SurfaceThreadStatusTarget &
  SurfaceThreadStatusFence & {
    /** dirty_rev when claimed: what a send or a skip settles, no further. */
    dirtyRev: number;
    uncertainRev: number;
    uncertain: boolean;
    /** Taken over from a writer whose lease ran out: it sends regardless. */
    inherited: boolean;
    sentStatus: string | null;
    sentAt: Date | null;
  };

export type SurfaceThreadStatusReconcile = SurfaceThreadStatusTarget & {
  sentStatus: string | null;
  sentAt: Date | null;
  facts: SurfaceThreadStatusFacts;
};

/**
 * The `slack` role's thread status rows. Every write after
 * `claim` is fenced by its token except `uncertain`, which must land even
 * when the lease is lost.
 */
export interface SurfaceThreadStatusStore {
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
  }): Promise<SurfaceThreadStatusClaim[]>;
  /** Null when the session is gone. */
  facts(sessionId: string): Promise<SurfaceThreadStatusFacts | null>;
  /**
   * The send's start, or null when the token is no longer this writer's or
   * less than `minLeaseLeftMs` of the lease is left.
   */
  beginSend(
    fence: SurfaceThreadStatusFence,
    minLeaseLeftMs: number,
  ): Promise<Date | null>;
  /**
   * A send that succeeded. The uncertainty clears only when this send began
   * a window after the latest uncertain one and none was recorded since.
   */
  finish(
    fence: SurfaceThreadStatusFence,
    sent: {
      dirtyRev: number;
      status: string;
      startedAt: Date;
      uncertainRev: number;
      windowMs: number;
    },
  ): Promise<boolean>;
  /** The computed status is the one Slack shows: nothing to send. */
  skip(fence: SurfaceThreadStatusFence, dirtyRev: number): Promise<boolean>;
  /** A send whose outcome is unknown; lands without the lease. */
  uncertain(
    fence: SurfaceThreadStatusFence,
    startedAt: Date,
    windowMs: number,
  ): Promise<void>;
  /** Try again no sooner than `retryInMs` from now, nor any boundary set. */
  defer(fence: SurfaceThreadStatusFence, retryInMs: number): Promise<boolean>;
  /** Slack will not show a status there; skipped until re-enabled. */
  disable(fence: SurfaceThreadStatusFence, reason: string): Promise<boolean>;
  /**
   * Re-enables rows disabled `disabledForMs` ago or before their
   * installation was verified again, then up to `limit` live links whose
   * row is missing or not yet closed and not disabled, longest unreconciled
   * first.
   */
  reconcileBatch(input: {
    limit: number;
    disabledForMs: number;
  }): Promise<SurfaceThreadStatusReconcile[]>;
  /** Stamps the links reconciled, raising dirty_rev where marked dirty. */
  reconciled(rows: { sessionLinkId: string; dirty: boolean }[]): Promise<void>;
}

/**
 * What a posted card shows: its buttons (`open`), only Reject for a push
 * that can no longer be approved (`reject_only`), either one with a
 * private channel push's requester gone from the channel
 * (`*_requester_left`), or how it ended (`done` for a turn's notice from
 * before the cards).
 */
export type SurfaceCardRendered =
  | CardChoice
  | "allowed"
  | "allowedSession"
  | "denied"
  | "answered"
  | "approved"
  | "rejected"
  | "expired"
  | "closed"
  | "done";

export type SurfaceCardFence = { id: string; claimToken: string };

export type SurfaceCardClaim = SurfaceCardFence & {
  workspaceId: string;
  slackAppId: string;
  sessionId: string | null;
  channelId: string;
  slackTs: string;
  dedupeKey: string;
  body: SurfaceOutboxBody;
  rendered: SurfaceCardRendered | null;
  uncertainRev: number;
  /** An edit of unknown outcome is on record: it sends regardless. */
  uncertain: boolean;
  /** Taken over from a writer whose lease ran out: it sends regardless. */
  inherited: boolean;
  /** The line the redrawn card ends with, read at claim; see `SurfaceOutboxBegun`. */
  aiLabel?: SurfaceAiLabel;
  /** Failures so far, rate limits not counted. */
  attempts: number;
  /** The session's parent conversation, as the outbox claim reads it. */
  conversationScope?: SurfaceConversationScope | null;
};

/** A card still waiting on its request. */
type CardChoice =
  | "open"
  | "reject_only"
  | "open_requester_left"
  | "reject_only_requester_left";

/** A push card still showing a choice, for `pushApprovability`. */
export type SurfaceOpenPushCard = {
  id: string;
  seq: number;
  sessionId: string;
  rendered: CardChoice;
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
export interface SurfaceCardSettleStore {
  /**
   * Marks `due` the sent cards whose request moved on from what they show:
   * answered or closed (web, expiry, session close), a push decided, a
   * turn's notice whose turn waits no more. Returns how many.
   */
  markDue(): Promise<number>;
  /** Marks one card `due` (its press), unless abandoned. */
  markDueAt(card: { channelId: string; slackTs: string }): Promise<boolean>;
  /** Marks one card `due` by its row (a push whose approvability moved). */
  /**
   * Marks `due` the push, tool permission and question cards still showing
   * a choice in one channel of an install, whose requester may have joined
   * or left it; one being drawn
   * now is drawn again `windowMs` later. Returns how many.
   */
  markChoiceCardsDueIn(input: {
    installationId: string;
    channelId: string;
    windowMs: number;
  }): Promise<number>;
  markDueById(id: string): Promise<boolean>;
  /**
   * Push cards still showing a choice whose session has moved on since, in
   * `seq` order after `afterSeq`, so a pass can page past cards that stay
   * as they are.
   */
  openPushCards(input: {
    limit: number;
    afterSeq: number | null;
  }): Promise<SurfaceOpenPushCard[]>;
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
  }): Promise<SurfaceCardClaim[]>;
  /** The card's request as stored now; null when it is gone. */
  card(claim: SurfaceCardClaim): Promise<SurfacePromptCard | null>;
  /** True while the card is a turn's notice whose turn still waits. */
  turnWaits(claim: SurfaceCardClaim): Promise<boolean>;
  /** The edit's start, or null when the lease is lost or nearly over. */
  beginSend(
    fence: SurfaceCardFence,
    minLeaseLeftMs: number,
  ): Promise<Date | null>;
  /**
   * An edit that succeeded. An end state settles the row; the uncertainty
   * clears only as in the thread status writer.
   */
  finish(
    fence: SurfaceCardFence,
    sent: {
      rendered: SurfaceCardRendered;
      uncertainRev: number;
      windowMs: number;
    },
  ): Promise<boolean>;
  /** Shows what it showed already: release the row as drawn. */
  skip(fence: SurfaceCardFence): Promise<boolean>;
  /** An edit whose outcome is unknown; lands without the lease. */
  uncertain(
    fence: SurfaceCardFence,
    startedAt: Date,
    windowMs: number,
  ): Promise<void>;
  /** Try again no sooner than `retryInMs`; `failed` counts an attempt. */
  defer(
    fence: SurfaceCardFence,
    /** A null `error` keeps the one recorded before. */
    input: { retryInMs: number; failed: boolean; error: string | null },
  ): Promise<boolean>;
  /** Slack takes no more edits of it. */
  abandon(fence: SurfaceCardFence, error: string): Promise<boolean>;
}

export interface SurfaceOutboxStore {
  /** Absent in stores without the thread status table. */
  threadStatus?: SurfaceThreadStatusStore;
  /** Absent in stores without the card settle columns. */
  cards?: SurfaceCardSettleStore;
  /**
   * `link_closed`: the entry's link is closed, and the entry is not the
   * notice that one of that link's own rows went uncertain.
   * `whileHome`: insert only while that binding is the agent's live home
   * and that release is active, checked under share locks so a home move
   * or an activation committing meanwhile is waited for, not missed.
   */
  enqueue(
    entry: SurfaceOutboxEntry,
    whileHome?: { bindingId: string; releaseId: string },
  ): Promise<"enqueued" | "duplicate" | "not_home" | "link_closed">;
  /** The language of the user that Slack account is linked to, if any. */
  readerLocale(reader: {
    workspaceId: string;
    teamId: string;
    slackUserId: string;
  }): Promise<UserLocale | null>;
  /**
   * The AI line of a notice redrawn after its post, outside the outbox: that
   * of a turn's own row, as `beginSend` reads it.
   */
  aiLabelFor(turn: {
    agentId: string;
    sessionId: string;
    turnId: number;
  }): Promise<SurfaceAiLabel | null>;
  /**
   * Moves each live link's mark past the turns that need nothing more: those
   * with their outbox row, interrupted or cancelled, or ended before the
   * link. A turn still running or waiting stops it. Returns links moved.
   */
  advanceAnswered(): Promise<number>;
  /**
   * Closes, oldest first and at most `limit`, the open links of closed
   * sessions that are owed nothing more (their last report is in), revoked
   * ones aside: `completed` after the owner's close, else `abandoned`.
   * Returns links closed.
   */
  closeFinishedLinks(limit: number): Promise<number>;
  /**
   * Linked turns past the link's mark, asked from the web or the API after
   * the link, with no `instruction` row yet; neither cancelled nor
   * interrupted.
   */
  unpostedInstructions(limit: number): Promise<SurfaceUnpostedInstruction[]>;
  /**
   * Web inputs owed a Slack mirror with no `input_mirror` row yet, oldest
   * first. A topic Slack has not placed has only its earliest such input
   * mirrored: that post places it, and the rest go into its thread after.
   */
  unmirroredInputs(limit: number): Promise<UnmirroredWebInput[]>;
  /**
   * Closes, unsent, the rows held for a web input's thread longer than
   * `holdMs` (`failed`, `input_unplaced`); an input still unplaced is
   * marked `unconfirmed`. No new thread is opened for them.
   */
  closeOverdueHeld(holdMs: number): Promise<number>;
  /**
   * A post of this app Slack sent back whose message metadata names a
   * mirror's correlation id: when exactly one `uncertain` mirror of that
   * app and channel has it, that row is `sent` with the post's ts, its
   * input takes the post as its alias and the rows held for it go. No
   * candidate, or more than one, links nothing. Text is never compared.
   */
  matchMirrorEcho(echo: {
    workspaceId: string;
    slackAppId: string;
    correlationId: SlackMirrorCorrelationId;
    channelId: string;
    ts: string;
  }): Promise<"linked" | "no_candidate" | "ambiguous">;
  /**
   * Linked turns past the link's mark that ended without their outbox
   * row. A turn that owes an `instruction` row waits for it,
   * so the answer never goes ahead of what it answers.
   */
  unansweredTurns(limit: number): Promise<SurfaceUnansweredTurn[]>;
  /**
   * Live linked sessions whose worker has waited at least `waitedMs` for
   * room no node has, and whose thread was not told of that wait
   * (`slackCapacityWaitDedupeKey`).
   */
  capacityWaits?(
    limit: number,
    waitedMs: number,
  ): Promise<SurfaceCapacityWait[]>;
  /**
   * Channels the agent reads every message of that have not been told so
   * under the current notice (`slackChannelNoticeDedupeKey`).
   */
  unnoticedChannels?(limit: number): Promise<SurfaceChannelNoticeTarget[]>;
  /**
   * The card posted as that message for that request, or null when no
   * `input_notice` row of the session sent it.
   */
  promptCard(input: {
    sessionId: string;
    requestId: string;
    channelId: string;
    slackTs: string;
  }): Promise<SurfacePromptCard | null>;
  /** Requests of live linked sessions without their `input_notice` row. */
  unpromptedRequests(limit: number): Promise<SurfacePendingPrompt[]>;
  /** Moves `sending` rows whose lease ran out to `uncertain`. */
  expireSending(): Promise<SurfaceOutboxLost[]>;
  /**
   * Fails `pending` rows with nowhere left to go: a revoked installation, or
   * a link revoked, muted or turned to summary since the row was enqueued.
   */
  closeUnaddressed(): Promise<
    Pick<SurfaceOutboxLost, "id" | "kind" | "channelId">[]
  >;
  /** `uncertain` replies whose thread has not been told so yet. */
  untoldUncertain(limit: number): Promise<SurfaceOutboxLost[]>;
  /**
   * Due `pending` rows under a lease from the database clock. They stay
   * `pending` until beginSend, so a crash before the send is claimed again.
   */
  claim(input: {
    limit: number;
    leaseMs: number;
  }): Promise<SurfaceOutboxClaim[]>;
  /**
   * `sending` from here on: a lease that runs out now leaves it `uncertain`.
   * `voided_by_delete`: a source of the row was deleted in Slack, and the
   * row is settled so; nothing may go out. Begun, who the row goes out as
   * when the store reads it, under the same locks: a title whose message
   * Slack deleted is never sent; `true` when it reads none.
   */
  beginSend(
    fence: SurfaceOutboxFence,
  ): Promise<boolean | "voided_by_delete" | SurfaceOutboxBegun>;
  /** False when the lease was lost: the row is someone else's now. */
  /**
   * False when the lease was lost. A sent `input_mirror` row gives its input
   * the post as its Slack alias in the same transaction, and its topic too
   * when the topic had none; `topic_alias_taken` when another topic already
   * holds that thread (a reply taken before this), which is left as it is.
   */
  settle(
    fence: SurfaceOutboxFence,
    outcome: SurfaceOutboxSettle,
  ): Promise<boolean | "topic_alias_taken">;
}
