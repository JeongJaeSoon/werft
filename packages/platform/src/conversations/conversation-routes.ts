import type {
  ConversationId,
  ConversationRouteEffect,
  ConversationTopicId,
  ConversationTurnId,
  SlackNotice,
  SlackNoticeMessage,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  SessionServiceError,
} from "../access-control/index.ts";
import type { SessionService } from "../sessions/index.ts";
import {
  CONNECT_REASONS,
  type ConversationTurnSurfaceSubject,
  callerOf,
  RETRYABLE_SESSION_CODES,
  reasonCodeOf,
} from "./conversation-tasks.ts";
import type { StoredSourceSet } from "./source-sets.ts";

/** A mention turn whose route_to_task decision has had no effect yet. */
export type PendingConversationRoute = {
  turnId: ConversationTurnId;
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  topicId: ConversationTopicId;
  /** The open task the decision named, as its tool checked it. */
  sessionId: string;
  /** The turn's thread and the message that asked, as the server keeps them. */
  thread: {
    installationId: string;
    /** The agent's Slack app; null when it is gone. */
    slackAppId: string | null;
    teamId: string;
    channelId: string;
    threadTs: string;
    messageTs: string;
  };
  requesterUserId: string;
  subject: ConversationTurnSurfaceSubject | null;
  sources: StoredSourceSet | null;
  /**
   * A DM turn's: its person, and the DM's binding a standalone session's
   * link is kept under (null when gone). Null for a channel turn.
   */
  dm: { personUserId: string; surfaceBindingId: string | null } | null;
};

/** The thread a task reports in: its open primary link's. */
export type ConversationRouteTaskThread = {
  channelId: string;
  threadTs: string;
};

/**
 * The named task as the effect finds it: open in a thread, with the message
 * that opened that thread's link, or a standalone session of the DM's
 * person, which the hand-off binds to the turn's DM thread (v1-b/DM3).
 */
export type ConversationRouteTask =
  | (ConversationRouteTaskThread & { kind: "linked"; openedByTs: string })
  | { kind: "standalone" };

/** Why a standalone session could not be bound to the turn's DM thread. */
export type StandaloneBindRefusal = "gone" | "thread_taken" | "other_parent";

/**
 * What the effect reads and writes of a turn. `settle` records the effect
 * once, lets go of the request the queue kept for it, and in the same
 * transaction writes the server's one line in the turn's thread, or the
 * mirror row and its pointer line: all of it or none.
 */
export interface ConversationRouteStore {
  /** The turn's route_to_task decision with no effect yet; null for none. */
  pending(turnId: ConversationTurnId): Promise<PendingConversationRoute | null>;
  /**
   * The turn's input is in its task: written by an earlier run, or one
   * running beside this one, whatever has changed since.
   */
  handed(route: PendingConversationRoute): Promise<boolean>;
  /** Check spot ④: a message the turn read is marked deleted. */
  sourceDeleted(route: PendingConversationRoute): Promise<boolean>;
  /** The request as the turn's runtime was given it; null once it is gone. */
  requestText(turnId: ConversationTurnId): Promise<string | null>;
  /**
   * The named task when it is still an open task of the turn's own
   * conversation (G3), never one of another channel or another person's DM,
   * or for a DM turn, a standalone session of the DM's own person. Null
   * otherwise.
   */
  openTask(
    route: PendingConversationRoute,
  ): Promise<ConversationRouteTask | null>;
  /**
   * Binds the named standalone session to the turn's DM thread, its parent
   * the DM's conversation and its primary link opened by the turn's
   * message, in one transaction, while it is still one: `bound`, or why not.
   */
  bindStandalone(
    route: PendingConversationRoute,
  ): Promise<"bound" | StandaloneBindRefusal>;
  /**
   * Records the effect. `line` is a server line for the turn's thread;
   * `mirror`, for a hand-off from another thread, points that thread at the
   * task and, when the thread pointed elsewhere or nowhere before, posts
   * the pointer line once. True for the run that recorded it; an effect
   * other than `routed` is not recorded once the turn's input is in its
   * task. An effect other than `routed` also takes back what
   * `bindStandalone` wrote for the turn, unless an input went in by it.
   */
  settle(
    route: PendingConversationRoute,
    effect: ConversationRouteEffect,
    line: SlackNoticeMessage | null,
    mirror: ConversationRouteTaskThread | null,
  ): Promise<boolean>;
}

/** What a turn's route_to_task decision did, or `none` when it holds none. */
export type ConversationRouteOutcome = "none" | ConversationRouteEffect;

/** What a requester refused the hand-off is told: never which right was missing. */
export function routeRefusalNotice(
  reason: string | undefined,
  connectUrl: string,
): SlackNotice {
  return reason !== undefined &&
    (CONNECT_REASONS as ReadonlySet<string>).has(reason)
    ? { message: "routeConnect", link_url: connectUrl }
    : { message: "routeNoRight" };
}

/** The idempotency key of the input a turn's hand-off writes in its task. */
export const conversationRouteInputKey = (turnId: ConversationTurnId) =>
  `conversation_route:${turnId}`;

/**
 * The effect of a mention turn's route_to_task decision (v1-b/E4): the
 * requester's message, the server's copy (G6), becomes an input of the open
 * task the turn named, queued behind its running turn when it has one, and
 * no task is made. The task is checked again here: an open task of the
 * turn's conversation (G3), and the requester's `session.submit` on it
 * (G5), who is the input's requester. Handed from another thread, that
 * thread is pointed at the task and told once where the work goes on; the
 * task's reports stay in its own thread. Run again for the same turn, it
 * writes one input, one mirror row and one line.
 *
 * From a DM, the named task may be the person's standalone session
 * (v1-b/DM3): it is bound to the DM thread before its input is written, so
 * the input's turn reports there, and the thread is told once it is a task
 * now. A hand-off that does not go through takes the binding back, unless
 * an input or a Slack row went in by it, or a writer holds it then: kept, the
 * thread stays the session's.
 */
export async function routeConversationTurn(
  deps: {
    store: ConversationRouteStore;
    authorization: Pick<AuthorizationPolicy, "authorize">;
    sessions: Pick<SessionService, "appendMessage">;
    /** An ephemeral line to the requester; false when Slack did not take it. */
    tellRequester(
      route: PendingConversationRoute,
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
): Promise<ConversationRouteOutcome> {
  const route = await deps.store.pending(turnId);
  if (route === null) return "none";
  const ids = {
    turn_id: turnId,
    agent_id: route.agentId,
    session_id: route.sessionId,
  };
  // This turn bound a standalone session to its thread, now or on a run
  // before this one.
  const boundHere = (found: ConversationRouteTask | null) =>
    found?.kind === "linked" &&
    found.channelId === route.thread.channelId &&
    found.threadTs === route.thread.threadTs &&
    found.openedByTs === route.thread.messageTs;
  let bound = false;
  const told = async (
    effect: ConversationRouteEffect,
    line: SlackNoticeMessage | null,
    reason: string,
  ): Promise<ConversationRouteOutcome> => {
    deps.logger.info("Conversation turn not handed to its task", {
      ...ids,
      reason,
    });
    if (await deps.store.settle(route, effect, line, null)) return effect;
    return settledElsewhere();
  };
  // Not recorded: ended already, or its input is in the task by a run
  // beside this one, which this run then records.
  const settledElsewhere = async () =>
    (await deps.store.handed(route)) ? routed(task) : ("none" as const);
  const routed = async (
    task: ConversationRouteTask | null,
  ): Promise<ConversationRouteOutcome> => {
    const standalone = bound || boundHere(task);
    const elsewhere =
      task?.kind === "linked" &&
      (task.channelId !== route.thread.channelId ||
        task.threadTs !== route.thread.threadTs);
    if (
      !(await deps.store.settle(
        route,
        "routed",
        standalone ? "routeStandalone" : null,
        elsewhere
          ? { channelId: task.channelId, threadTs: task.threadTs }
          : null,
      ))
    ) {
      return "none";
    }
    deps.logger.info("Conversation turn handed to its task", ids);
    return "routed";
  };

  const task = await deps.store.openTask(route);
  bound = boundHere(task);
  // Written before a crash: it is the hand-off, whatever has changed since.
  if (await deps.store.handed(route)) return routed(task);
  // Deleted before the hand-off: nothing is written, and nothing is said.
  if (await deps.store.sourceDeleted(route)) {
    return told("voided", null, "source_deleted");
  }
  const { thread, subject } = route;
  if (subject === null || thread.slackAppId === null) {
    return told("failed", "routeFailed", "turn_unbound");
  }
  // A set cut short names too little for the input to be stopped by.
  if (route.sources?.overflow === true) {
    return told("failed", "routeFailed", "sources_overflow");
  }
  // Closed since, or never this conversation's (G3).
  if (task === null) return told("failed", "routeFailed", "task_not_open");

  const requestId = deps.newRequestId?.() ?? crypto.randomUUID();
  const refused = async (reason: string | undefined) => {
    deps.logger.info("Conversation turn refused by its task", {
      ...ids,
      reason,
    });
    if (await deps.store.handed(route)) return routed(task);
    const heard = await deps.tellRequester(
      route,
      routeRefusalNotice(reason, deps.connectUrl),
    );
    if (
      await deps.store.settle(
        route,
        "refused",
        heard ? null : "routeFailed",
        null,
      )
    ) {
      return "refused" as const;
    }
    return settledElsewhere();
  };
  const decision = await deps.authorization.authorize({
    action: "session.submit",
    subject: subject.subject,
    resource: {
      kind: "session",
      id: route.sessionId,
      owner_scope: route.workspaceId,
    },
    request_id: requestId,
  });
  if (decision.outcome !== "allow") return refused(decision.reason_code);

  const requestText = await deps.store.requestText(turnId);
  if (requestText === null) {
    return told("failed", "routeFailed", "request_gone");
  }
  if (task.kind === "standalone") {
    const binding = await deps.store.bindStandalone(route);
    if (binding !== "bound") {
      return told("failed", "routeFailed", `standalone_${binding}`);
    }
    bound = true;
  }
  try {
    await deps.sessions.appendMessage(
      callerOf(subject.subject, route, requestId),
      route.sessionId,
      {
        idempotencyKey: conversationRouteInputKey(turnId),
        conversationTurnId: turnId,
        // Behind the task's running turn, if it has one.
        body: { message: requestText, mode: "enqueue" },
        slackMessage: {
          team_id: thread.teamId,
          channel_id: thread.channelId,
          ts: thread.messageTs,
          thread_ts:
            thread.threadTs === thread.messageTs ? null : thread.threadTs,
          permalink: null,
        },
        slackInput: { topicId: route.topicId, engagement: "mention" },
        carriedSources: route.sources,
      },
    );
  } catch (error) {
    if (
      !(error instanceof SessionServiceError) ||
      RETRYABLE_SESSION_CODES.has(error.code)
    ) {
      throw error;
    }
    const reason = reasonCodeOf(error.details);
    if (error.code === "SOURCE_DELETED") {
      return told("voided", null, "source_deleted");
    }
    if (error.code === "FORBIDDEN") return refused(reason);
    return told("failed", "routeFailed", reason ?? error.code);
  }
  return routed(task);
}
