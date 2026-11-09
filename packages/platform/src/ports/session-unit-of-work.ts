import type {
  AdmissionState,
  CountSessionsQuery,
  CountSessionsResponse,
  CreateSessionResponse,
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
  SseEvent,
  SurfaceKind,
  TurnDetail,
  TurnSummary,
} from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";
import type { SessionViewer } from "./session-share-store.ts";
import type { SessionTitleSource } from "./session-title-store.ts";

// Checked inside the acceptance transaction, after an idempotent replay has
// been answered: a replay is never refused for a limit.
export type InputLimits = {
  queuedInputLimitPerSession: number;
  storageLimitBytes: number;
};

// Why an input was not queued although nothing else was wrong with it.
// queue_full: the session already holds its limit of queued turns.
// storage_exhausted: the message would take retained content past the
// installation's limit.
export type InputLimitRefusal = { outcome: "queue_full" | "storage_exhausted" };

export type AcceptSessionInput = {
  principal: Principal;
  idempotencyKey: string;
  payloadHash: string;
  profileId: string;
  // The surface the creating request came from, kept as the session's
  // channel; left out, the session records none.
  channel?: SurfaceKind;
  // The Slack message the first input came from, kept on turn 1.
  slackMessage?: SlackMessageRef;
  // As given, or derived from the message; null when neither has text.
  title?: string | null;
  // `user` when the request gave one; left out, it is `derived`.
  titleSource?: SessionTitleSource;
  // null when the catalog no longer lists the profile/repository: a replay
  // of an earlier acceptance must still succeed, a new request must not.
  // "none" when the profile is allowed to run without one.
  repository: { id: string; url: string; branch: string } | "none" | null;
  // Already checked against the release; left out, the column stays null.
  attachedRepositoryIds?: string[];
  // The bundles the session runs with, resolved once for this request and
  // stored as given. Left out, the column stays null: the session runs with
  // none, as rows from before it do.
  extensions?: SessionExtension[];
  // The resolution refused: only a replay of an earlier acceptance goes
  // through, which only the stored acceptance can tell.
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
  // The profile's fingerprint under the catalog that allowed the pair, which
  // every claim of the session is then held to. Left out, the row
  // is pinned by its first claim, as one from before the column is.
  profileFingerprint?: string;
  // The model the session runs, set with profileFingerprint.
  model?: string;
  // The profile declared `billing: none`; fixed on the session for good.
  unmetered?: boolean;
  // The agent release the session belongs to, already checked against
  // profileId.
  agentReleaseId?: string;
  // Stored on the row as it is; absent, the session is revision 0.
  platformPrompt?: PlatformPrompt;
  // The policy found a name the release uses unbound: only a replay of an
  // earlier acceptance goes through. Without it, the names are rechecked
  // under lock against a concurrent unbind.
  credentialsUnbound?: true;
  // The variable names the release's card declares. The accept resolves them
  // against the agent's and the workspace's variables and keeps the values
  // with the session. Left out or empty, the session takes none and nothing
  // about its acceptance changes.
  envNames?: readonly string[];
  // A Slack DM's session starts seen by its creator alone (design 4.6);
  // left out, by the whole workspace.
  shareScope?: "private";
  // The session's own waits, kept as given: a request takes the lower of
  // them and its profile's when it is raised.
  permissionWait?: PermissionWaitRequest;
  message: string;
  limits: InputLimits;
};

export type AcceptSessionResult =
  | { outcome: "accepted" | "replayed"; response: CreateSessionResponse }
  | { outcome: "conflict" | "unsupported" }
  | { outcome: "actor_inactive" }
  /** Outside the agent while axis A is not `use`, judged in the write. */
  | { outcome: "agent_use_refused" }
  | { outcome: "credential_unbound"; receiptId: string }
  /** A declared name has no value for this agent; no session was created. */
  | { outcome: "variables_refused"; reason: EnvRefusal; receiptId: string }
  | InputLimitRefusal;

export type AppendMessageInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  message: string;
  limits: InputLimits;
  // Where the input came from; left out, the turn records none.
  channel?: SurfaceKind;
  slackMessage?: SlackMessageRef;
  // The operator blocked the session's profile: only a replay of an earlier
  // acceptance goes through.
  profileBlocked?: true;
};

export type AppendMessageResult =
  | { outcome: "accepted" | "replayed"; response: PostSessionMessageResponse }
  | { outcome: "conflict" | "not_found" | "profile_blocked" }
  // The session exists but its admission state does not take new input.
  | { outcome: "rejected"; admissionState: Exclude<AdmissionState, "active"> }
  // The session cannot be checkpointed (blocking pending reason): a turn run
  // now could never be reported as durably finished, so none is accepted.
  // `reason` is the stored text, which may be one a newer build recorded.
  | { outcome: "checkpoint_unavailable"; reason: string }
  | { outcome: "awaiting_takeover" }
  | { outcome: "actor_inactive" }
  | { outcome: "credential_unbound"; agentId: string; receiptId: string }
  | InputLimitRefusal;

// Storage rows carry profile_id; the service resolves runtime from the catalog.
export type SessionRecord = Omit<SessionSummary, "runtime"> & {
  profile_id: string | null;
  // With `model`, what the session is pinned to; never exposed.
  profile_fingerprint: string | null;
};
export type SessionDetailRecord = Omit<SessionDetail, "runtime"> & {
  profile_id: string | null;
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
  // included. Not the profile's repository_mode, and never exposed.
  repository_mode: "repository" | "none";
  github_policy_source: string;
  profile_fingerprint: string | null;
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
  getSession(
    ownerId: string,
    sessionId: string,
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
