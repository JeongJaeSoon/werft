import type {
  AdmissionState,
  AuthorizationSubject,
  BudgetOwnerKind,
  ConversationId,
  ConversationTopicId,
  CountSessionsQuery,
  CountSessionsResponse,
  CreateSessionResponse,
  EngagementKind,
  EnvRefusal,
  GitHubPolicySource,
  ListSessionsQuery,
  ListTurnsQuery,
  PermissionWaitRequest,
  PlatformPrompt,
  PostSessionMessageResponse,
  Receipt,
  SessionDetail,
  SessionExtension,
  SessionSummary,
  SlackMessageRef,
  SpecSource,
  SseEvent,
  SurfaceKind,
  ThreadReplyRule,
  TurnDetail,
  TurnSummary,
} from "@werft-ai/contracts";
import type {
  CallerLimitDimension,
  Principal,
} from "../../musterrolle/index.ts";
import type { SessionViewer } from "./session-share-store.ts";
import type { SessionTitleSource } from "./session-title-store.ts";

// Checked inside the acceptance transaction, after an idempotent replay has
// been answered: a replay is never refused for a limit.
export type InputLimits = {
  queuedInputLimitPerSession: number;
  storageLimitBytes: number;
};

// A function is asked only for a new input and throws while the limits
// cannot be read, so a replay answers then too. Synchronous: nothing waits
// between the replay check and the insert.
export type InputLimitsSource = InputLimits | (() => InputLimits);

export function inputLimitsOf(source: InputLimitsSource): InputLimits {
  return typeof source === "function" ? source() : source;
}

// Why an input was not queued although nothing else was wrong with it.
// queue_full: the session already holds its limit of queued turns.
// storage_exhausted: the message would take retained content past the
// installation's limit.
export type InputLimitRefusal = { outcome: "queue_full" | "storage_exhausted" };

/**
 * The topic a Slack turn's message is taken into and how the agent took it:
 * the transaction that inserts the turn takes the message as the topic's
 * next input, so the turn and its input exist together or not at all.
 */
export type TurnInputTopic = {
  topicId: ConversationTopicId;
  engagement: EngagementKind;
  /** An unmentioned reply M1 judges too, with what the current path's rule said. */
  judgment?: { rule: ThreadReplyRule };
};

export type AcceptSessionInput = {
  principal: Principal;
  idempotencyKey: string;
  payloadHash: string;
  // The surface the creating request came from, kept as the session's
  // channel; left out, the session records none.
  channel?: SurfaceKind;
  // The Slack message the first input came from, kept on turn 1.
  slackMessage?: SlackMessageRef;
  // Set with slackMessage alone.
  slackInput?: TurnInputTopic;
  // The request span's traceparent for turn 1; see AppendMessageInput.
  traceContext?: string;
  // As given, or derived from the message; null when neither has text.
  title?: string | null;
  // `user` when the request gave one; left out, it is `derived`.
  titleSource?: SessionTitleSource;
  // null when the catalog no longer lists the repository: a replay of an
  // earlier acceptance must still succeed, a new request must not. "none"
  // for a session started without one.
  repository: { id: string; url: string; branch: string } | "none" | null;
  // Already checked against the release; left out, the column stays null.
  attachedRepositoryIds?: string[];
  extensions?: SessionExtension[];
  extensionsRefused?: true;
  /** Absent: `release`. */
  githubPolicySource?: GitHubPolicySource;
  /**
   * Set for an `agent` session: the store reads the agent's GitHub settings
   * and switch inside the creating transaction, holding the settings row so
   * they cannot change before the session exists, and keeps them as the
   * session's start snapshot.
   */
  captureGitHubPolicyStart?: true;
  // The model the session runs; the store pins the release's spec on it.
  // Left out, the session does not run (a replay only).
  model?: string;
  // The connection declared `billing: none`; fixed on the session for good.
  unmetered?: boolean;
  // The agent release the session belongs to and runs the spec of.
  agentReleaseId: string;
  // Stored on the row as it is; absent, the session is revision 0.
  platformPrompt?: PlatformPrompt;
  // The policy found a name the release uses unbound: only a replay of an
  // earlier acceptance goes through. Without it, the names are rechecked
  // under lock against a concurrent unbind.
  credentialsUnbound?: true;
  // The policy found the agent private and the requester outside it:
  // only a replay of an earlier acceptance goes through. Without
  // it the write still judges the requester over locked rows. Carries the
  // visibility result and nothing else.
  agentPrivate?: true;
  callerLimited?: CallerLimitDimension;
  callerSubject?: AuthorizationSubject;
  // The pinned agent is paused or archived, or the release never approved:
  // only a replay of an earlier acceptance goes through, and the check runs
  // before the unbound one.
  notRunnableReason?: "agent_inactive" | "release_unapproved";
  // The variable names the release's card declares. The accept resolves them
  // against the agent's and the workspace's variables and keeps the values
  // with the session. Left out or empty, the session takes none and nothing
  // about its acceptance changes.
  envNames?: readonly string[];
  // A Slack DM's session starts seen by its creator alone (design 4.6);
  // left out, by the whole workspace.
  shareScope?: "private" | "private_channel";
  // The main conversation a Slack session belongs to; left out, none (a
  // standalone session).
  parentConversationId?: ConversationId;
  // A preview: the write refuses it unless the requester, a person, still
  // manages the release's agent over the locked rows.
  preview?: true;
  // The session's own waits, kept as given: a request takes the lower of
  // them and the installation's when it is raised.
  permissionWait?: PermissionWaitRequest;
  message: string;
  limits: InputLimitsSource;
};

export type AcceptSessionResult =
  | { outcome: "accepted" | "replayed"; response: CreateSessionResponse }
  | { outcome: "conflict" | "unsupported" }
  | { outcome: "actor_inactive" }
  /** Outside the agent while axis A is not `use`, judged in the write. */
  | { outcome: "agent_use_refused" }
  /** The agent is private and the requester is not among those who use it. */
  | { outcome: "agent_private" }
  | { outcome: "caller_limited"; dimension: CallerLimitDimension }
  /** A preview by someone who no longer manages the agent. */
  | { outcome: "preview_refused" }
  /**
   * `agent_ownerless`: no one has administered the agent for the whole grace
   * period, judged in the write alone.
   */
  | {
      outcome: "not_runnable";
      reason: "agent_inactive" | "agent_ownerless" | "release_unapproved";
    }
  | { outcome: "credential_unbound"; receiptId: string }
  /** A declared name has no value for this agent; no session was created. */
  | { outcome: "variables_refused"; reason: EnvRefusal; receiptId: string }
  /** The Slack message it came from was deleted; no session was created. */
  | { outcome: "source_deleted" }
  | InputLimitRefusal;

export type AppendMessageInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  message: string;
  limits: InputLimitsSource;
  // Where the input came from; left out, the turn records none.
  channel?: SurfaceKind;
  slackMessage?: SlackMessageRef;
  // Set with slackMessage alone.
  slackInput?: TurnInputTopic;
  // The request span's W3C traceparent, stored with the turn as opaque text;
  // platform never parses it.
  traceContext?: string;
  // As `AcceptSessionInput.agentPrivate`: only a replay goes through.
  agentPrivate?: true;
  callerSubject?: AuthorizationSubject;
  /**
   * The platform queues this input as the agent's own turn after a push
   * decision: nothing about a person is judged or recorded, everything about
   * the session is. One such turn per push request.
   */
  platform?: { pushRequestId: string; decision: "approve" | "reject" };
  /**
   * The public id of a turn of this session that its worker's lost lease
   * ended (`WORKER_OWNERSHIP_LOST_REASON`): the new turn takes that turn's
   * input, read from the turn, and `message` is not used. `not_found` for
   * any other turn, `superseded` once any later turn follows it. The caller is
   * judged as for any input of their own. The
   * turn is the request's key, apart from every key sent for a message, so
   * `idempotencyKey` is not used either: one lost turn, one continuation.
   */
  continueTurn?: number;
};

export type AppendMessageResult =
  | { outcome: "accepted" | "replayed"; response: PostSessionMessageResponse }
  | { outcome: "conflict" | "not_found" }
  /** The push request's follow-up turn is already in the session. */
  | { outcome: "already_queued" }
  /** A continuation of a lost turn that a later turn of the session follows. */
  | { outcome: "superseded" }
  /** A session the requester sees, of an agent they may not use. */
  | { outcome: "agent_private" }
  | { outcome: "caller_limited"; dimension: CallerLimitDimension }
  /** A preview session's sender no longer manages its agent. */
  | { outcome: "preview_refused" }
  // The session exists but its admission state does not take new input.
  | { outcome: "rejected"; admissionState: Exclude<AdmissionState, "active"> }
  // The session cannot be checkpointed (blocking pending reason): a turn run
  // now could never be reported as durably finished, so none is accepted.
  // `reason` is the stored text, which may be one a newer build recorded.
  | { outcome: "checkpoint_unavailable"; reason: string }
  | { outcome: "awaiting_takeover" }
  | { outcome: "actor_inactive" }
  | { outcome: "credential_unbound"; agentId: string; receiptId: string }
  // The input would revive a failed session that has no spec pin on its own
  // model, which an authoritative pin refuses; nothing is recorded.
  | { outcome: "pin_required" }
  /**
   * The turn would carry a Slack message that was deleted: the input's own,
   * or one an earlier turn of the session came from. sessionStopped when
   * the session is stopped for it (source_deleted_at) and takes no input at
   * all. Nothing is recorded.
   */
  | { outcome: "source_deleted"; sessionStopped?: true }
  | InputLimitRefusal;

// Storage rows carry the session's spec source; the service turns it into
// the runtime view. Null for a session with no spec pin.
export type SessionRecord = Omit<SessionSummary, "runtime"> & {
  spec: SpecSource | null;
};
export type SessionDetailRecord = Omit<SessionDetail, "runtime"> & {
  spec: SpecSource | null;
  // What the session has spent; the service turns it into `attention`
  // against the current limit, so a changed limit applies at once.
  cost_usd: number;
  provider_tokens: number;
  // What the claim matches against the catalog, so the service can say the
  // catalog no longer allows it. Never exposed: the URL may embed
  // a credential. Null for a session accepted without a repository.
  repo_url: string | null;
  branch: string | null;
  // The row's own value: `none` for a session accepted without a
  // repository, `repository` for every other, a row from before the catalog
  // included. Never exposed.
  repository_mode: "repository" | "none";
  github_policy_source: string;
  auto_model_migration: boolean;
  // Whether the session row names an execution now. `execution` alone cannot
  // say: once released it still shows the last attempt's. Never exposed.
  holds_execution: boolean;
  // Whose budget account refused one of the session's calls since its last
  // completed turn; null when none did. The service makes it `attention`
  // only below the session's own limit, which outranks it.
  budget_account_refused: BudgetOwnerKind | null;
};

export interface SessionUnitOfWork {
  acceptInputAtomic(input: AcceptSessionInput): Promise<AcceptSessionResult>;
  appendInputAtomic(input: AppendMessageInput): Promise<AppendMessageResult>;
}
export type InputAcceptance = Pick<
  SessionUnitOfWork,
  "acceptInputAtomic" | "appendInputAtomic"
>;

// A page cursor the reader did not issue; the routes answer it with 400.
export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
  }
}

export interface SessionReader {
  // Only the sessions shared with `viewer` (design 4.6).
  listSessions(
    ownerId: string,
    query: ListSessionsQuery,
    viewer: SessionViewer,
  ): Promise<{ items: SessionRecord[]; next_cursor: string | null }>;
  // What listSessions would return across every page, per status.
  countSessions(
    ownerId: string,
    query: CountSessionsQuery,
    viewer: SessionViewer,
  ): Promise<CountSessionsResponse>;
  // With `viewer`, a session whose agent the viewer may not use carries no
  // agent (`agent_hidden`); without, the read is internal and shows it.
  getSession(
    ownerId: string,
    sessionId: string,
    viewer?: SessionViewer,
  ): Promise<SessionDetailRecord | null>;
  // null when the session is not visible to the owner.
  listTurns(
    ownerId: string,
    sessionId: string,
    query: ListTurnsQuery,
  ): Promise<{ items: TurnSummary[]; next_cursor: string | null } | null>;
  // null when the session or the turn is not visible to the owner.
  getTurn(
    ownerId: string,
    sessionId: string,
    turnId: string,
  ): Promise<TurnDetail | null>;
  // null when the receipt does not exist or belongs to another owner.
  getReceipt(ownerId: string, receiptId: string): Promise<Receipt | null>;
  /**
   * Which of these agents and releases `viewer` may not use: the ids
   * given that name such an agent or a release of one, and, when `sessionId`
   * is given, that session's own agent and release when it is one. An id of
   * no agent is not hidden; there is nothing to hide.
   */
  hiddenAgentRefs(
    ownerId: string,
    viewer: SessionViewer,
    refs: {
      agentIds: readonly string[];
      releaseIds: readonly string[];
      sessionId: string | null;
    },
  ): Promise<{
    agentIds: ReadonlySet<string>;
    releaseIds: ReadonlySet<string>;
  }>;
  // Events after the cursor in session order: at most `limit` rows and,
  // past the first row, at most `maxBytes` of payload, so one page never
  // holds more memory than that whatever the history looks like. `more` is
  // false only when the page reached the high-watermark; a page cut short by
  // either bound says true so the caller keeps replaying instead of waiting.
  // null when the session is not visible to the owner.
  readEvents(
    ownerId: string,
    sessionId: string,
    query: ReadEventsQuery,
  ): Promise<EventPage | null>;
}

export type ReadEventsQuery = {
  after?: string;
  limit: number;
  maxBytes: number;
};

export type EventPage = {
  items: SseEvent[];
  more: boolean;
};
