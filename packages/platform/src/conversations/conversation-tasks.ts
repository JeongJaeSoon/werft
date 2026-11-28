import {
  type AuthorizationReason,
  type AuthorizationSubject,
  type ConversationId,
  type ConversationTaskEffect,
  type ConversationTopicId,
  type ConversationTurnId,
  type SlackNotice,
  type SlackNoticeMessage,
  TASK_CLOSING_DEFAULT,
  TASK_LIMITS_DEFAULT,
  TASK_OPEN_LIMIT_PER_AGENT,
  TASK_OPEN_LIMIT_PER_CONVERSATION,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  SessionServiceError,
} from "../access-control/index.ts";
import type { SessionService } from "../sessions/index.ts";
import type {
  SessionLinkRecord,
  SessionLinkStore,
} from "../sessions/ports/session-link-store.ts";
import type { StoredSourceSet } from "./source-sets.ts";

/**
 * A spawn_task decision's goal, end and repository, as the turn records
 * them: the model's reading of the request, never the request (G6).
 */
export type ConversationTaskDraft = {
  goal: string;
  doneWhen: string;
  /** The model's pick; null for the release's own. */
  repository: string | null;
};

/**
 * The Slack decision subject a mention's message was judged on, kept on its
 * turn so the task it asks for is judged on it again (v1-b/E3), with the
 * Slack account an ephemeral line reaches.
 */
export type ConversationTurnSurfaceSubject = {
  subject: AuthorizationSubject;
  slackUserId: string;
};

/** A mention turn whose spawn_task decision has had no effect yet. */
export type PendingConversationTask = {
  turnId: ConversationTurnId;
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  topicId: ConversationTopicId;
  /** The turn's thread and the message that asked, as the server keeps them. */
  thread: {
    installationId: string;
    /** The agent's Slack app; null when it is gone. */
    slackAppId: string | null;
    /** The channel's binding the link is kept under; null when gone. */
    surfaceBindingId: string | null;
    teamId: string;
    channelId: string;
    threadTs: string;
    messageTs: string;
  };
  /** A DM's task is its person's; a private channel's, its members'. */
  shareScope: "private" | "private_channel" | null;
  releaseId: string | null;
  requesterUserId: string;
  draft: ConversationTaskDraft;
  subject: ConversationTurnSurfaceSubject | null;
  sources: StoredSourceSet | null;
};

/**
 * What the effect reads and writes of a turn. `settle` records the effect
 * once and lets go of the request the queue kept for it: whatever the
 * effect did, nothing of the request is left behind but the task's own copy.
 */
export interface ConversationTaskStore {
  /** The turn's spawn_task decision with no effect yet; null for none. */
  pending(turnId: ConversationTurnId): Promise<PendingConversationTask | null>;
  /** Check spot ④: a message the turn read is marked deleted. */
  sourceDeleted(task: PendingConversationTask): Promise<boolean>;
  /** The request as the turn's runtime was given it; null once it is gone. */
  requestText(turnId: ConversationTurnId): Promise<string | null>;
  /**
   * The task session this turn's effect made, whether or not its link is
   * still open; null when it made none.
   */
  madeSession(task: PendingConversationTask): Promise<string | null>;
  /**
   * Records the effect and, with it, the server's one line in the turn's
   * thread: both or neither. True for the run that recorded it; false when
   * another run did, which writes no line.
   */
  settle(
    task: PendingConversationTask,
    effect: ConversationTaskEffect,
    line: SlackNoticeMessage | null,
  ): Promise<boolean>;
  /** Takes back a link this effect reserved that never got its session. */
  dropUnopenedLink(link: SessionLinkRecord): Promise<void>;
}

/** What a turn's spawn_task decision did, or `none` when it holds none. */
export type ConversationTaskOutcome = "none" | ConversationTaskEffect;

// What a refused requester is told, by the policy's reason: never which
// right was missing (Architect, v1-b/E3).
export const CONNECT_REASONS: ReadonlySet<AuthorizationReason> = new Set([
  "unlinked",
  "stale_link",
  "requester_unresolved",
  "requester_revoked",
]);
const CHANNEL_REASONS: ReadonlySet<AuthorizationReason> = new Set([
  "surface_ceiling",
  "guest_disabled",
  "external_user",
]);

export function taskRefusalNotice(
  reason: AuthorizationReason,
  connectUrl: string,
): SlackNotice {
  if (CONNECT_REASONS.has(reason)) {
    return { message: "taskConnect", link_url: connectUrl };
  }
  if (CHANNEL_REASONS.has(reason)) return { message: "taskChannel" };
  return { message: "taskNoRight" };
}

// A session refusal that waiting may clear: the next pass tries again.
export const RETRYABLE_SESSION_CODES = new Set([
  "RATE_LIMITED",
  "BACKEND_UNAVAILABLE",
]);

export const reasonCodeOf = (details: unknown): string | undefined =>
  typeof details === "object" &&
  details !== null &&
  "reason_code" in details &&
  typeof details.reason_code === "string"
    ? details.reason_code
    : undefined;

/**
 * The effect of a mention turn's spawn_task decision (v1-b/E3): a task
 * session, its parent the turn's conversation, bound to the turn's thread
 * by its primary link. The requester's message is the server's copy (G6),
 * the repository the agent's to allow (G3), the person judged again on the
 * subject their message was (S1's task.spawn), and the requester is the
 * budget root. Nothing the model wrote is posted: the new session's own
 * message is the notice, and a refusal is the server's line. Run again for
 * the same turn, it makes one link, one session and one line.
 */
export async function spawnConversationTask(
  deps: {
    store: ConversationTaskStore;
    links: Pick<SessionLinkStore, "find" | "reserve" | "attachSession">;
    authorization: Pick<AuthorizationPolicy, "authorize">;
    sessions: Pick<SessionService, "createSession">;
    /** An ephemeral line to the requester; false when Slack did not take it. */
    tellRequester(
      task: PendingConversationTask,
      notice: SlackNotice,
    ): Promise<boolean>;
    /** The web page where a person links their Slack account. */
    connectUrl: string;
    newRequestId?: () => string;
    logger: {
      info(message: string, fields?: Record<string, unknown>): void;
      warn(message: string, fields?: Record<string, unknown>): void;
    };
  },
  turnId: ConversationTurnId,
): Promise<ConversationTaskOutcome> {
  const task = await deps.store.pending(turnId);
  if (task === null) return "none";
  const ids = { turn_id: turnId, agent_id: task.agentId };
  const requestId = deps.newRequestId?.() ?? crypto.randomUUID();
  const told = async (
    effect: ConversationTaskEffect,
    line: SlackNoticeMessage | null,
    reason: string,
  ): Promise<ConversationTaskOutcome> => {
    deps.logger.info("Conversation task not started", { ...ids, reason });
    await deps.store.settle(task, effect, line);
    return effect;
  };

  // Deleted before the task: nothing is made, and nothing is said of it.
  if (await deps.store.sourceDeleted(task)) {
    return told("voided", null, "source_deleted");
  }
  // Made before a crash: it is the task, whatever the request or the right
  // since, and its link may be closed by now.
  const made = await deps.store.madeSession(task);
  if (made !== null) {
    const open = await deps.links.find(
      task.thread.installationId,
      `${task.thread.channelId}:${task.thread.threadTs}`,
    );
    if (open?.openedByTs === task.thread.messageTs && open.sessionId == null) {
      await deps.links.attachSession(open.id, made);
    }
    await deps.store.settle(task, "opened", null);
    return "opened";
  }
  const { thread, subject } = task;
  if (
    subject === null ||
    task.releaseId === null ||
    thread.slackAppId === null ||
    thread.surfaceBindingId === null
  ) {
    return told("failed", "taskFailed", "turn_unbound");
  }
  // A set cut short names too little for the task to be stopped by.
  if (task.sources?.overflow === true) {
    return told("failed", "taskFailed", "sources_overflow");
  }

  const surfaceRef = `${thread.channelId}:${thread.threadTs}`;
  let link = await deps.links.find(thread.installationId, surfaceRef);
  // Another message opened the thread's work since the turn was written.
  if (link !== null && link.openedByTs !== thread.messageTs) {
    return told("failed", "taskFailed", "thread_taken");
  }

  const decision = await deps.authorization.authorize({
    action: "task.spawn",
    subject: subject.subject,
    resource: {
      kind: "conversation",
      id: task.conversationId,
      owner_scope: task.workspaceId,
    },
    request_id: requestId,
  });
  if (decision.outcome !== "allow") {
    deps.logger.info("Conversation task refused", {
      ...ids,
      reason: decision.reason_code,
    });
    const notice = taskRefusalNotice(decision.reason_code, deps.connectUrl);
    const heard = await deps.tellRequester(task, notice);
    await deps.store.settle(task, "refused", heard ? null : "taskFailed");
    return "refused";
  }

  const requestText = await deps.store.requestText(turnId);
  if (requestText === null) {
    return told("failed", "taskFailed", "request_gone");
  }

  link ??= (
    await deps.links.reserve({
      workspaceId: task.workspaceId,
      installationId: thread.installationId,
      surfaceBindingId: thread.surfaceBindingId,
      surfaceRef,
      channelId: thread.channelId,
      threadId: thread.threadTs,
      openedByTs: thread.messageTs,
      agentId: task.agentId,
      releaseId: task.releaseId,
      createdBy: task.requesterUserId,
    })
  ).link;
  if (link.openedByTs !== thread.messageTs) {
    return told("failed", "taskFailed", "thread_taken");
  }

  const caller = callerOf(subject.subject, task, requestId);
  let sessionId: string;
  try {
    const created = await deps.sessions.createSession(caller, {
      idempotencyKey: link.id,
      body: {
        agent_release_id: link.releaseId,
        message: requestText,
        ...(task.draft.repository === null
          ? {}
          : { repository_id: task.draft.repository }),
      },
      ...(task.shareScope === null ? {} : { shareScope: task.shareScope }),
      parentConversationId: task.conversationId,
      slackMessage: {
        team_id: thread.teamId,
        channel_id: thread.channelId,
        ts: thread.messageTs,
        thread_ts:
          thread.threadTs === thread.messageTs ? null : thread.threadTs,
        permalink: null,
      },
      slackInput: { topicId: task.topicId, engagement: "mention" },
      task: {
        requestText,
        interpretation: {
          goal: task.draft.goal,
          doneWhen: task.draft.doneWhen,
          limits: { ...TASK_LIMITS_DEFAULT },
        },
        closing: TASK_CLOSING_DEFAULT,
        sources: task.sources,
        openLimits: {
          conversation: TASK_OPEN_LIMIT_PER_CONVERSATION,
          agent: TASK_OPEN_LIMIT_PER_AGENT,
        },
      },
    });
    sessionId = created.session_id;
  } catch (error) {
    if (
      !(error instanceof SessionServiceError) ||
      RETRYABLE_SESSION_CODES.has(error.code)
    ) {
      throw error;
    }
    // No session holds the thread: it is left as it was.
    await deps.store.dropUnopenedLink(link);
    const reason = reasonCodeOf(error.details);
    if (reason === "task_limit_conversation") {
      return told("refused", "taskLimitConversation", reason);
    }
    if (reason === "task_limit_agent") {
      return told("refused", "taskLimitAgent", reason);
    }
    if (error.code === "GITHUB_REFUSED") {
      return told("refused", "taskRepository", reason ?? error.code);
    }
    if (error.code === "SOURCE_DELETED") {
      return told("voided", null, "source_deleted");
    }
    return told("failed", "taskFailed", reason ?? error.code);
  }
  const attached = await deps.links.attachSession(link.id, sessionId);
  if (attached.sessionId !== sessionId) {
    throw new Error(`Slack thread ${link.id} already holds another session`);
  }
  await deps.store.settle(task, "opened", null);
  deps.logger.info("Conversation task started", {
    ...ids,
    session_id: sessionId,
  });
  return "opened";
}

// The Slack caller the message was judged as: its installation, for the
// person its linked account names.
export function callerOf(
  subject: AuthorizationSubject,
  task: Pick<PendingConversationTask, "workspaceId" | "requesterUserId"> & {
    thread: Pick<PendingConversationTask["thread"], "installationId">;
  },
  requestId: string,
): Caller {
  const link = subject.linked_account;
  return {
    ownerId: task.workspaceId,
    actor: {
      principal: { kind: "installation", id: task.thread.installationId },
      userId: subject.actor_user_id ?? task.requesterUserId,
      workspaceId: task.workspaceId,
      apiKeyId: null,
      ...(link === undefined
        ? {}
        : { linkedAccount: { id: link.id, revision: link.revision } }),
    },
    subject,
    requestId,
  };
}
