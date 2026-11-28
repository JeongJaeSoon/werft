import {
  DEFAULT_USER_LOCALE,
  type PendingQuestion,
  type PushDecision,
  pushRequestIdSchema,
  type QuestionAnswer,
  requestIdSchema,
  SLACK_INTERACTION_ACTIONS,
  SLACK_NOTE_VIEW_CALLBACK,
  SLACK_NOTICE_MESSAGES,
  SLACK_QUESTION_VIEW_CALLBACK,
  type SlackBlockActionsPayload,
  type SlackInteractionResponse,
  type SlackInteractionValue,
  type SlackNoticeMessage,
  type SlackQuestionViewMetadata,
  type SlackViewSubmissionPayload,
  sessionIdSchema,
  sessionLinkIdSchema,
  slackBlockActionsPayloadSchema,
  slackInteractionPayloadSchema,
  slackInteractionValueSchema,
  slackQuestionViewMetadataSchema,
  slackViewSubmissionPayloadSchema,
  type UserLocale,
} from "@werft-ai/contracts";
import type {
  AgentIdentityStore,
  LinkedAccountStore,
  PendingRequestService,
  PushActor,
  PushFollowUpStore,
  PushRequestService,
  RequesterCloseReason,
  SurfaceBindingStore,
  SurfaceConversationScope,
  SurfaceOutboxStore,
  SurfacePostedCardKey,
  SurfaceProgressLink,
  TaskClose,
} from "@werft-ai/platform";
import {
  type AuthorizationPolicy,
  agentForSlackEvent,
  type Caller,
  messageOf,
  type SessionService,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  SLACK_CARD_SETTLE_TIMING,
  type SlackRequesterLeft,
  settleSlackCards,
} from "./slack-card-settle.ts";
import type { SlackBotApi, SlackBotSender } from "./slack-config-api.ts";
import {
  authorizeSlackInput,
  type SlackDecision,
  slackCallerOf,
} from "./slack-decision.ts";
import {
  type SlackSignedRequest,
  type SlackSigningSecrets,
  verifySlackRequest,
} from "./slack-events-service.ts";
import type { SlackInboxLogger } from "./slack-inbox.ts";
import {
  sessionUrl,
  slackAiLabelSuffix,
  slackOutboxGuard,
  slackOutboxText,
  withSlackAiLabel,
} from "./slack-outbox-render.ts";
import {
  SLACK_PROMPT_MESSAGES,
  type SlackPromptResult,
  slackNoteText,
  slackNoteView,
  slackNoticeView,
  slackOptionAnswer,
  slackOwnershipLostNotice,
  slackQuestionAnswers,
  slackQuestionView,
  slackSettledCard,
  slackStartFreshNotice,
} from "./slack-prompts.ts";

/** Redraws the card; `via` is "slack" when this press settled it. */
type SettleCard = () => Promise<void>;

/**
 * What the session reads once a push it asked for is decided in Slack.
 */
export function slackPushFollowUp(
  decision: PushDecision,
  push: { id: string; repositoryId: string; targetBranch: string },
): string {
  return decision === "approve"
    ? `A person approved push request ${push.id} (repository ${push.repositoryId}, branch ${push.targetBranch}). The push runs in the background.`
    : `A person rejected push request ${push.id} (repository ${push.repositoryId}, branch ${push.targetBranch}). Nothing was pushed.`;
}

export type SlackInteractionOutcome =
  | { kind: "unauthorized" }
  | { kind: "bad_request" }
  | { kind: "ok"; body: SlackInteractionResponse; result: string };

export type SlackInteractionDeps = {
  signingSecrets: Pick<SlackSigningSecrets, "forAgent">;
  /** refuse keeps a press refused as surface_mismatch in the decision log. */
  authorization: AuthorizationPolicy &
    Required<Pick<AuthorizationPolicy, "refuse">>;
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  links: Pick<LinkedAccountStore, "resolveLinkedSubject">;
  bindings: Pick<
    SurfaceBindingStore,
    "resolveSlackChannel" | "findPendingApproval" | "findLiveSlackChannel"
  >;
  pending: Pick<
    PendingRequestService,
    "answer" | "listPendingRequests" | "outcome"
  >;
  pushes: Pick<PushRequestService, "decide" | "get">;
  sessions: Pick<
    SessionService,
    "queuePushFollowUp" | "continueTurn" | "startFreshTurn"
  >;
  followUps: PushFollowUpStore;
  /** Closes a task from its progress message's buttons (v1-b/C1). */
  tasks?: Pick<TaskClose, "close">;
  slack: Pick<SlackBotApi, "userInfo"> &
    Required<Pick<SlackBotApi, "updateMessage" | "openView" | "updateView">> &
    Pick<SlackBotSender, "postEphemeral">;
  botToken(workspaceId: string, slackAppId: string): Promise<string | null>;
  outbox: Pick<
    SurfaceOutboxStore,
    | "readerLocale"
    | "promptCard"
    | "postedCard"
    | "progressLink"
    | "cards"
    | "aiLabelFor"
  >;
  /** The web page where a person links their Slack account. */
  connectUrl: string;
  logger: SlackInboxLogger;
  now?: () => Date;
  newRequestId?: () => string;
  wait?: (ms: number) => Promise<void>;
  /**
   * Runs a press's work after Slack has its answer: Slack waits three
   * seconds, the card and the session may take longer.
   */
  defer?: (work: () => Promise<void>) => void;
  /** How long a submitted form waits on its checks before asking again. */
  submitDeadlineMs?: number;
  requesterLeft?: SlackRequesterLeft;
};

const OK: SlackInteractionResponse = { ok: true };
const FOLLOW_UP_ATTEMPTS = 3;
const CLEAR: SlackInteractionResponse = { response_action: "clear" };
// The buttons of a request's card, each judged against the card pressed.
const CARD_ACTIONS: ReadonlySet<string> = new Set([
  SLACK_INTERACTION_ACTIONS.permissionAllow,
  SLACK_INTERACTION_ACTIONS.permissionAllowSession,
  SLACK_INTERACTION_ACTIONS.permissionDeny,
  SLACK_INTERACTION_ACTIONS.questionOption,
  SLACK_INTERACTION_ACTIONS.pushApprove,
  SLACK_INTERACTION_ACTIONS.pushReject,
]);

const REQUEST_GONE_CODES = new Set([
  "REQUEST_EXPIRED",
  "REQUEST_STALE",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "PUSH_REQUEST_RESOLVED",
]);

type Pressed = {
  agentId: string;
  workspaceId: string;
  slackAppId: string;
  appId: string;
  teamId: string;
  userId: string;
  channelId: string;
  threadTs: string;
  botToken: string;
  locale: UserLocale;
};

type Allowed = { caller: Caller; pressed: Pressed };

// A card's text shown again on a press, in its session's conversation as the
// server reads it; with none, every Slack channel is outside (94S-2213).
const cardGuard = (
  pressed: Pressed,
  scope: SurfaceConversationScope | null | undefined,
) =>
  slackOutboxGuard({
    kind: "input_notice",
    channelId: pressed.channelId,
    conversationScope: scope ?? null,
  }).guard;

export type SlackInteractionService = ReturnType<
  typeof createSlackInteractionService
>;

/**
 * Slack's interactivity request URL for one agent's app: the buttons and
 * the modal of the cards the outbox posts for requests a session waits on.
 * Signed like events; every press is judged as `session.approve` for the
 * person who pressed it, the same decision the web makes.
 */
export function createSlackInteractionService(deps: SlackInteractionDeps) {
  const now = deps.now ?? (() => new Date());
  const newRequestId = deps.newRequestId ?? (() => crypto.randomUUID());
  const submitDeadlineMs = deps.submitDeadlineMs ?? 2500;
  const wait =
    deps.wait ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const defer =
    deps.defer ??
    ((work: () => Promise<void>) => {
      void work().catch((error: unknown) => {
        deps.logger.warn("Slack interaction failed after its answer", {
          error: messageOf(error),
        });
      });
    });

  const ok = (result: string, body = OK): SlackInteractionOutcome => ({
    kind: "ok",
    body,
    result,
  });

  async function tell(pressed: Pressed, text: string, linkUrl?: string) {
    try {
      // Every answer to a press goes through here: none reaches a channel the
      // bot was removed from, whichever step failed first.
      if (await channelLeftFor(pressed.agentId, pressed, pressed)) return;
      await deps.slack.postEphemeral(pressed.botToken, {
        channelId: pressed.channelId,
        userId: pressed.userId,
        threadTs: pressed.threadTs,
        text: slackOutboxText({
          text,
          locale: pressed.locale,
          ...(linkUrl === undefined ? {} : { link_url: linkUrl }),
        }),
      });
    } catch (error) {
      deps.logger.warn("Slack ephemeral for a press failed", {
        agent_id: pressed.agentId,
        error: messageOf(error),
      });
    }
  }

  const notice = (pressed: Pressed, message: SlackNoticeMessage) =>
    tell(pressed, SLACK_NOTICE_MESSAGES[pressed.locale][message]);

  /**
   * Redraws a card from its request as stored, in the language it was
   * posted in, so whoever pressed and whatever the message held, the
   * settled card is the same. With the card store, the press marks the row
   * due and runs the drain's writer on it now, under the same lease and
   * fence; a lease it cannot take leaves the row to the next pass.
   */
  async function settle(
    pressed: Pressed,
    ts: string,
    value: SlackInteractionValue,
  ) {
    try {
      const cards = deps.outbox.cards;
      if (cards !== undefined) {
        const only = { channelId: pressed.channelId, slackTs: ts };
        if (!(await cards.markDueAt(only))) return;
        await settleSlackCards({
          store: cards,
          slack: deps.slack,
          botToken: async () => pressed.botToken,
          logger: deps.logger,
          batchSize: 1,
          deadline: Date.now() + SLACK_CARD_SETTLE_TIMING.leaseMs,
          only,
          ...(deps.requesterLeft === undefined
            ? {}
            : { requesterLeft: deps.requesterLeft }),
        });
        return;
      }
      const posted = await deps.outbox.promptCard({
        sessionId: value.s,
        requestId: value.r,
        channelId: pressed.channelId,
        slackTs: ts,
      });
      if (posted === null) {
        deps.logger.warn("Slack card to update not found", {
          agent_id: pressed.agentId,
          session_id: value.s,
          request_id: value.r,
        });
        return;
      }
      const card = slackSettledCard(
        posted,
        cardGuard(pressed, posted.conversationScope),
      );
      if (card === null) return;
      await deps.slack.updateMessage(pressed.botToken, {
        channelId: pressed.channelId,
        ts,
        ...card,
      });
    } catch (error) {
      deps.logger.warn("Slack card update failed", {
        agent_id: pressed.agentId,
        error: messageOf(error),
      });
    }
  }

  /**
   * Whether the pressed card's channel is one the bot was removed from, or
   * one Slack deleted.
   */
  async function channelLeftFor(
    agentId: string,
    app: { appId: string },
    input: { teamId: string; channelId: string },
  ): Promise<boolean> {
    if (input.channelId.startsWith("D")) return false;
    const agent = await agentForSlackEvent(deps.agents, {
      appId: app.appId,
      teamId: input.teamId,
      agentId,
    });
    if (agent.status === "dropped") return false;
    const live = await deps.bindings.findLiveSlackChannel(
      agent.installationId,
      input.channelId,
    );
    return live?.status === "left" || live?.status === "gone";
  }

  /** Who pressed and how to answer them; null when the app has no bot. */
  async function pressedFor(
    agentId: string,
    app: { workspaceId: string; slackAppId: string; appId: string },
    input: {
      teamId: string;
      userId: string;
      channelId: string;
      threadTs: string;
    },
  ): Promise<Pressed | null> {
    const botToken = await deps.botToken(app.workspaceId, app.slackAppId);
    if (botToken === null) return null;
    const locale = await localeOf(agentId, app, input);
    return { agentId, ...app, ...input, botToken, locale };
  }

  /** The presser's language; the default one when it cannot be read. */
  async function localeOf(
    agentId: string,
    app: { workspaceId: string },
    input: { teamId: string; userId: string },
  ): Promise<UserLocale> {
    try {
      return (
        (await deps.outbox.readerLocale({
          workspaceId: app.workspaceId,
          teamId: input.teamId,
          slackUserId: input.userId,
        })) ?? DEFAULT_USER_LOCALE
      );
    } catch (error) {
      deps.logger.warn("Slack presser language unreadable; using the default", {
        agent_id: agentId,
        error: messageOf(error),
      });
      return DEFAULT_USER_LOCALE;
    }
  }

  async function admit(
    pressed: Pressed,
    sessionId: string,
    request: { pushRequestId?: string; pendingRequestId?: string },
    action: "session.approve" | "session.submit" = "session.approve",
    judged: {
      channelId?: string;
      refuse?: "surface_mismatch";
      notice?: SlackNoticeMessage;
    } = {},
  ): Promise<Allowed | { refused: string }> {
    const user = await deps.slack.userInfo(pressed.botToken, pressed.userId);
    const requestId = newRequestId();
    const channelId = judged.channelId ?? pressed.channelId;
    const decision: SlackDecision = await authorizeSlackInput(deps, {
      event: {
        appId: pressed.appId,
        teamId: pressed.teamId,
        agentId: pressed.agentId,
      },
      user,
      action,
      channel: { id: channelId, dm: channelId.startsWith("D") },
      resource: { kind: "session", id: sessionId, ...request },
      requestId,
      connectUrl: deps.connectUrl,
      ...(judged.refuse === undefined ? {} : { refuse: judged.refuse }),
    });
    if (decision.status === "dropped") return { refused: decision.reason };
    if (decision.decision.outcome !== "allow") {
      const told = decision.notice;
      if (told !== null) {
        defer(() =>
          tell(
            pressed,
            SLACK_NOTICE_MESSAGES[pressed.locale][
              judged.notice ?? told.message
            ],
            told.link_url,
          ),
        );
      }
      return { refused: decision.decision.reason_code };
    }
    return { caller: slackCallerOf(decision, requestId), pressed };
  }

  /**
   * A press on a message of the session's own thread, `link`, judged at
   * that thread's channel whatever channel it came from. Refused as
   * surface_mismatch, kept and told, when the message pressed is not in
   * that thread or the value's link id is not that link's.
   */
  async function admitOnThread(
    pressed: Pressed,
    sessionId: string,
    linkId: string,
    link: SurfaceProgressLink | null,
    action: "session.approve" | "session.submit",
    request: { pushRequestId?: string; pendingRequestId?: string } = {},
  ): Promise<Allowed | { refused: string }> {
    const parsed = sessionLinkIdSchema.safeParse(linkId);
    const onIt =
      parsed.success &&
      link !== null &&
      link.id.toLowerCase() === parsed.data.toLowerCase() &&
      link.agentId.toLowerCase() === pressed.agentId.toLowerCase() &&
      link.channelId === pressed.channelId &&
      link.threadId === pressed.threadTs;
    if (!onIt || link === null) {
      return admit(pressed, sessionId, request, action, {
        refuse: "surface_mismatch",
      });
    }
    return admit(pressed, sessionId, request, action, {
      channelId: link.channelId,
    });
  }

  /**
   * A press on a posted card, the message `ts` of the pressed channel,
   * judged at the channel of the link the card went out on (a mirror's own
   * when it was one) whatever the value says. Refused as surface_mismatch,
   * kept and told, when no row of the value's session posted that message
   * for the value's request or turn.
   */
  async function admitOnCard(
    pressed: Pressed,
    ts: string,
    value: SlackInteractionValue,
    card: SurfacePostedCardKey | null,
    action: "session.approve" | "session.submit",
    request: { pushRequestId?: string; pendingRequestId?: string } = {},
  ): Promise<Allowed | { refused: string }> {
    const session = sessionIdSchema.safeParse(value.s);
    const link =
      session.success && card !== null
        ? await deps.outbox.postedCard({
            sessionId: session.data,
            agentId: pressed.agentId,
            channelId: pressed.channelId,
            slackTs: ts,
            card,
          })
        : null;
    if (link === "earlier") {
      return admit(pressed, value.s, request, action, {
        refuse: "surface_mismatch",
        notice: "pressEarlierCard",
      });
    }
    const onIt =
      link !== null &&
      link.agentId.toLowerCase() === pressed.agentId.toLowerCase() &&
      link.channelId === pressed.channelId;
    if (!onIt || link === null) {
      return admit(pressed, value.s, request, action, {
        refuse: "surface_mismatch",
      });
    }
    return admit(pressed, value.s, request, action, {
      channelId: link.channelId,
    });
  }

  async function pendingQuestions(
    caller: Caller,
    value: SlackInteractionValue,
  ): Promise<PendingQuestion[] | null> {
    const listed = await deps.pending.listPendingRequests(caller, value.s);
    const request = listed.items.find(
      (item) => item.request_id === value.r && item.kind === "question",
    );
    return request?.kind === "question" ? request.questions : null;
  }

  async function permissionOpen(
    caller: Caller,
    value: SlackInteractionValue,
  ): Promise<boolean> {
    const listed = await deps.pending.listPendingRequests(caller, value.s);
    return listed.items.some(
      (item) => item.request_id === value.r && item.kind === "permission",
    );
  }

  async function standing(
    caller: Caller,
    value: SlackInteractionValue,
  ): Promise<SlackPromptResult | "open"> {
    const outcome = await deps.pending.outcome(caller, value.s, value.r);
    if (outcome === null) return "closed";
    if (outcome.state !== "answered") return outcome.state;
    if (outcome.kind === "question") return "answered";
    if (outcome.decision !== "allow") return "denied";
    return outcome.remember === "session" ? "allowedSession" : "allowed";
  }

  async function answer(
    { caller, pressed }: Allowed,
    value: SlackInteractionValue,
    body:
      | {
          kind: "permission";
          decision: "allow" | "deny";
          remember?: "session";
          reason?: string;
        }
      | { kind: "question"; answers: QuestionAnswer[] },
    card: SettleCard,
  ): Promise<string> {
    try {
      await deps.pending.answer(caller, value.s, {
        // Per presser: a replay names whoever pressed first, so another
        // person's press must miss it and read the request as answered.
        idempotencyKey: `slack:${value.r}:${pressed.userId}`,
        body: { request_id: value.r, ...body },
      });
    } catch (error) {
      if (!(error instanceof SessionServiceError)) throw error;
      if (error.code === "FORBIDDEN") {
        await notice(pressed, "noApproveRight");
        return "refused";
      }
      // A refused note leaves the request open; any other bad request gets
      // the plain failure below.
      const reasonCode =
        error.code === "BAD_REQUEST" &&
        body.kind === "permission" &&
        body.reason !== undefined
          ? (error.details as { reason_code?: unknown } | null)?.reason_code
          : undefined;
      if (
        reasonCode === "note_not_accepted" ||
        reasonCode === "answer_too_long"
      ) {
        deps.logger.warn("Slack note not taken", {
          agent_id: pressed.agentId,
          reason_code: reasonCode,
        });
        const copy = SLACK_PROMPT_MESSAGES[pressed.locale].note;
        await tell(
          pressed,
          reasonCode === "note_not_accepted"
            ? copy.refused
            : copy.tooLongForTurn,
        );
        return reasonCode === "note_not_accepted"
          ? "note_refused"
          : "note_too_long";
      }
      const now = REQUEST_GONE_CODES.has(error.code)
        ? await standing(caller, value)
        : "open";
      if (now === "open") {
        deps.logger.warn("Slack answer not taken", {
          agent_id: pressed.agentId,
          code: error.code,
        });
        await notice(pressed, "failed");
        return "failed";
      }
      await card();
      return "already";
    }
    await card();
    return "answered";
  }

  async function decidePush(
    { caller, pressed }: Allowed,
    value: SlackInteractionValue,
    decision: PushDecision,
    card: SettleCard,
  ): Promise<string> {
    if (caller.subject.principal === null) return "refused";
    const actor: PushActor = {
      caller,
      principal: caller.subject.principal,
      ownerId: caller.ownerId,
      verified: true,
    };
    const read = () =>
      deps.pushes.get(actor, value.s, value.r).catch((error: unknown) => {
        if (
          error instanceof SessionServiceError &&
          error.code === "NOT_FOUND"
        ) {
          return null;
        }
        throw error;
      });
    const stateOf = async (): Promise<SlackPromptResult | "open"> => {
      const request = await read();
      if (request === null) return "closed";
      if (request.state === "requested") return "open";
      return request.state === "rejected" ? "rejected" : "approved";
    };
    const request = await read();
    if (request === null || request.state !== "requested") {
      await card();
      return "already";
    }
    // An `actions` request is finished by the platform (the push, the pull
    // request when one was asked for, and the notice), and the stored flow
    // decides, not today's install setting. Its follow-up turn would tell the
    // model to open a pull request even for a push that asked for none. The
    // flow is read before the decision: a read that fails leaves the request
    // open for another press instead of guessing `legacy`.
    // The request already carries its flow; only a row without one is read.
    let flow: Awaited<ReturnType<typeof deps.followUps.flowOf>> =
      request.flow ?? null;
    try {
      if (request.flow === undefined) {
        flow = await deps.followUps.flowOf({
          sessionId: value.s,
          pushRequestId: request.id,
        });
      }
    } catch (error) {
      deps.logger.warn("Slack push flow not read", {
        agent_id: pressed.agentId,
        code: messageOf(error),
      });
      await notice(pressed, "failed");
      return "failed";
    }
    try {
      await deps.pushes.decide(actor, value.s, value.r, {
        idempotencyKey: `slack:${value.r}:${pressed.userId}`,
        readBody: async () => ({ decision, git_commit: request.git_commit }),
      });
    } catch (error) {
      if (!(error instanceof SessionServiceError)) throw error;
      const now = await stateOf();
      if (now !== "open") {
        await card();
        return "already";
      }
      const refusal = (error.details as { refusal?: unknown } | undefined)
        ?.refusal;
      deps.logger.warn("Slack push decision not taken", {
        agent_id: pressed.agentId,
        code: error.code,
        refusal: typeof refusal === "string" ? refusal : null,
      });
      await notice(
        pressed,
        error.code === "FORBIDDEN" ? "noApproveRight" : "failed",
      );
      return "failed";
    }
    // An actions-flow push has no continuation turn: the turn that asked for
    // it already ended, and the platform carries the push on from here.
    if (flow === "actions") {
      await card();
      return decision === "approve" ? "approved" : "rejected";
    }
    // The decision stands; the session only learns of it from this turn,
    // which is the agent's: the platform queues it, whoever pressed. The key
    // makes a retry a no-op once one attempt has landed.
    const followUp = {
      idempotencyKey: `slack-push:${value.r}`,
      message: slackPushFollowUp(decision, {
        id: request.id,
        repositoryId: request.repository_id,
        targetBranch: request.target_branch,
      }),
      pushRequestId: request.id,
      decision,
      requestId: caller.requestId,
    };
    // A turn running now may open the pull request itself; a second turn
    // asking for it only repeats the request and the reply.
    let queued = false;
    if (decision === "approve") {
      try {
        const hold = await deps.followUps.hold({
          sessionId: value.s,
          pushRequestId: request.id,
          message: followUp.message,
        });
        if (hold !== "now") {
          queued = true;
          deps.logger.info("Slack push follow-up turn not queued now", {
            agent_id: pressed.agentId,
            reason: hold,
          });
        }
      } catch (error) {
        deps.logger.warn("Slack push follow-up hold failed", {
          agent_id: pressed.agentId,
          code: messageOf(error),
        });
      }
    }
    for (
      let attempt = 1;
      !queued && attempt <= FOLLOW_UP_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await deps.sessions.queuePushFollowUp(
          caller.ownerId,
          value.s,
          followUp,
        );
        queued = true;
      } catch (error) {
        deps.logger.warn("Slack push follow-up turn not queued", {
          agent_id: pressed.agentId,
          attempt,
          code:
            error instanceof SessionServiceError
              ? error.code
              : error instanceof Error
                ? error.message
                : String(error),
        });
        if (attempt < FOLLOW_UP_ATTEMPTS) await wait(attempt * 500);
      }
    }
    if (!queued) {
      await tell(pressed, SLACK_PROMPT_MESSAGES[pressed.locale].followUpFailed);
    }
    await card();
    return decision === "approve" ? "approved" : "rejected";
  }

  function handled(agentId: string, outcome: SlackInteractionOutcome) {
    if (outcome.kind === "ok") {
      deps.logger.info("Slack interaction handled", {
        agent_id: agentId,
        result: outcome.result,
      });
    }
  }

  function failedQuietly(
    pressed: Pressed,
    error: unknown,
    value?: SlackInteractionValue,
  ) {
    deps.logger.warn("Slack interaction failed after its answer", {
      agent_id: pressed.agentId,
      session_id: value?.s ?? null,
      request_id: value?.r ?? null,
      error: messageOf(error),
    });
  }

  // The card a button's request names; null for a value no card could hold.
  function promptKey(r: string): SurfacePostedCardKey | null {
    const parsed = requestIdSchema.safeParse(r);
    return parsed.success ? { kind: "prompt", requestId: parsed.data } : null;
  }

  function pushKey(r: string): SurfacePostedCardKey | null {
    const parsed = pushRequestIdSchema.safeParse(r);
    return parsed.success ? { kind: "push", pushRequestId: parsed.data } : null;
  }

  function buttonValue(raw: string | undefined): SlackInteractionValue | null {
    try {
      return slackInteractionValueSchema.parse(JSON.parse(raw ?? ""));
    } catch {
      return null;
    }
  }

  /**
   * Slack takes the answer to a press within three seconds, and a trigger
   * opens a modal only inside them: a press is answered at once and its
   * work runs after; a form opens as a loading modal and is filled once
   * the presser is judged.
   */
  async function onAction(
    agentId: string,
    app: { workspaceId: string; slackAppId: string; appId: string },
    payload: SlackBlockActionsPayload,
  ): Promise<SlackInteractionOutcome> {
    const [action] = payload.actions;
    const value = buttonValue(action?.value);
    if (action === undefined || value === null) return ok("ignored");
    const input = {
      teamId: payload.team.id,
      userId: payload.user.id,
      channelId: payload.channel.id,
      threadTs: payload.message.thread_ts ?? payload.message.ts,
    };
    // The token is read first, like the signing secret, so a press that
    // cannot reach Slack fails where Slack shows it; the language, the
    // decision and the card come after the answer.
    const form =
      action.action_id === SLACK_INTERACTION_ACTIONS.questionOpen
        ? "question"
        : action.action_id === SLACK_INTERACTION_ACTIONS.permissionAllowNote
          ? "note"
          : null;
    if (form === null) {
      const botToken = await deps.botToken(app.workspaceId, app.slackAppId);
      if (botToken === null) return ok("refused:no_bot_token");
      defer(async () => {
        const locale = await localeOf(agentId, app, input);
        const pressed = { agentId, ...app, ...input, botToken, locale };
        handled(
          agentId,
          await actOn(pressed, payload, action.action_id, value),
        );
      });
      return ok("accepted");
    }
    // Before the loading modal: a channel the bot left shows nothing.
    if (await channelLeftFor(agentId, app, input)) {
      return ok("refused:channel_left");
    }
    const botToken = await deps.botToken(app.workspaceId, app.slackAppId);
    if (botToken === null) return ok("refused:no_bot_token");
    // The trigger lasts three seconds: the loading modal waits only on the
    // channel check above and the token, so it speaks the default language.
    const loading = DEFAULT_USER_LOCALE;
    const copy = SLACK_PROMPT_MESSAGES[loading];
    const { viewId } = await deps.slack.openView(botToken, {
      triggerId: payload.trigger_id,
      view:
        form === "note"
          ? slackNoticeView(copy.note.loading, loading, copy.note.title)
          : slackNoticeView(copy.loading, loading),
    });
    defer(async () =>
      handled(
        agentId,
        await fillView(
          {
            agentId,
            ...app,
            ...input,
            botToken,
            locale: await localeOf(agentId, app, input),
          },
          viewId,
          payload,
          value,
          form,
        ),
      ),
    );
    return ok("view_opened");
  }

  const cardOf =
    (pressed: Pressed, payload: SlackBlockActionsPayload) =>
    (value: SlackInteractionValue): SettleCard =>
    () =>
      settle(pressed, payload.message.ts, value);

  async function fillView(
    pressed: Pressed,
    viewId: string,
    payload: SlackBlockActionsPayload,
    value: SlackInteractionValue,
    form: "question" | "note",
  ): Promise<SlackInteractionOutcome> {
    const copy = SLACK_PROMPT_MESSAGES[pressed.locale];
    const metadata = {
      s: value.s,
      r: value.r,
      c: pressed.channelId,
      m: payload.message.ts,
      t: pressed.threadTs,
    };
    const show = (text: string) =>
      deps.slack
        .updateView(pressed.botToken, {
          viewId,
          view:
            form === "note"
              ? slackNoticeView(text, pressed.locale, copy.note.title)
              : slackNoticeView(text, pressed.locale),
        })
        .catch((error: unknown) => {
          failedQuietly(pressed, error, value);
          return tell(pressed, text);
        });
    try {
      const admitted = await admitOnCard(
        pressed,
        payload.message.ts,
        value,
        promptKey(value.r),
        "session.approve",
        { pendingRequestId: value.r },
      );
      if ("refused" in admitted) {
        await show(copy.unavailable);
        return ok(`refused:${admitted.refused}`);
      }
      const questions =
        form === "question"
          ? await pendingQuestions(admitted.caller, value)
          : null;
      const open =
        form === "note"
          ? await permissionOpen(admitted.caller, value)
          : questions !== null;
      if (!open) {
        const state = await standing(admitted.caller, value);
        const result = state === "open" ? "closed" : state;
        await cardOf(pressed, payload)(value)();
        await show(copy.already[result]);
        return ok("already");
      }
      // The card's row names the scope its questions were first shown in.
      const posted =
        questions === null
          ? null
          : await deps.outbox.promptCard({
              sessionId: value.s,
              requestId: value.r,
              channelId: pressed.channelId,
              slackTs: payload.message.ts,
            });
      const view =
        questions === null
          ? slackNoteView(metadata, pressed.locale)
          : slackQuestionView(
              questions,
              metadata,
              pressed.locale,
              cardGuard(pressed, posted?.conversationScope),
            );
      if (view === null) {
        await show(copy.unavailable);
        return ok("failed");
      }
      await deps.slack.updateView(pressed.botToken, { viewId, view });
      return ok("view_filled");
    } catch (error) {
      failedQuietly(pressed, error, value);
      await show(SLACK_NOTICE_MESSAGES[pressed.locale].failed);
      return ok("failed");
    }
  }

  async function actOn(
    pressed: Pressed,
    payload: SlackBlockActionsPayload,
    actionId: string,
    value: SlackInteractionValue,
  ): Promise<SlackInteractionOutcome> {
    try {
      if (actionId === SLACK_INTERACTION_ACTIONS.turnContinue) {
        return ok(await continueTurn(pressed, payload.message.ts, value));
      }
      if (actionId === SLACK_INTERACTION_ACTIONS.turnStartFresh) {
        return ok(await startFreshTurn(pressed, payload.message.ts, value));
      }
      if (actionId === SLACK_INTERACTION_ACTIONS.taskComplete) {
        return ok(await closeTask(pressed, value, "completed"));
      }
      if (actionId === SLACK_INTERACTION_ACTIONS.taskCancel) {
        return ok(await closeTask(pressed, value, "cancelled"));
      }
      // Option buttons share a block, where Slack wants each id once.
      const kind = actionId.startsWith(
        `${SLACK_INTERACTION_ACTIONS.questionOption}:`,
      )
        ? SLACK_INTERACTION_ACTIONS.questionOption
        : actionId;
      if (!CARD_ACTIONS.has(kind)) return ok("ignored");
      // A press names its request, which the policy reads for a requester
      // who left a private channel.
      const push =
        kind === SLACK_INTERACTION_ACTIONS.pushApprove ||
        kind === SLACK_INTERACTION_ACTIONS.pushReject;
      const admitted = await admitOnCard(
        pressed,
        payload.message.ts,
        value,
        push ? pushKey(value.r) : promptKey(value.r),
        "session.approve",
        push ? { pushRequestId: value.r } : { pendingRequestId: value.r },
      );
      if ("refused" in admitted) return ok(`refused:${admitted.refused}`);
      const card = cardOf(pressed, payload)(value);
      switch (kind) {
        case SLACK_INTERACTION_ACTIONS.permissionAllow:
        case SLACK_INTERACTION_ACTIONS.permissionAllowSession:
        case SLACK_INTERACTION_ACTIONS.permissionDeny:
          return ok(
            await answer(
              admitted,
              value,
              {
                kind: "permission",
                decision:
                  kind === SLACK_INTERACTION_ACTIONS.permissionDeny
                    ? "deny"
                    : "allow",
                ...(kind === SLACK_INTERACTION_ACTIONS.permissionAllowSession
                  ? { remember: "session" as const }
                  : {}),
              },
              card,
            ),
          );
        case SLACK_INTERACTION_ACTIONS.questionOption: {
          const questions = await pendingQuestions(admitted.caller, value);
          const answers =
            questions === null ? null : slackOptionAnswer(questions, value.o);
          if (answers === null) {
            const state = await standing(admitted.caller, value);
            if (state === "open") {
              await notice(pressed, "failed");
              return ok("failed");
            }
            await card();
            return ok("already");
          }
          return ok(
            await answer(admitted, value, { kind: "question", answers }, card),
          );
        }
        case SLACK_INTERACTION_ACTIONS.pushApprove:
        case SLACK_INTERACTION_ACTIONS.pushReject:
          return ok(
            await decidePush(
              admitted,
              value,
              kind === SLACK_INTERACTION_ACTIONS.pushApprove
                ? "approve"
                : "reject",
              card,
            ),
          );
        default:
          return ok("ignored");
      }
    } catch (error) {
      failedQuietly(pressed, error, value);
      await notice(pressed, "failed");
      return ok("failed");
    }
  }

  /**
   * [Continue] on the notice of a turn its worker's lost lease ended: a new
   * queued turn with that turn's input, for the person who pressed, judged
   * as a message they typed in the thread would be. The session takes one
   * such turn per lost turn, whoever presses and however often.
   */
  async function continueTurn(
    pressed: Pressed,
    ts: string,
    value: SlackInteractionValue,
  ): Promise<string> {
    const turnId = Number(value.r);
    if (!Number.isSafeInteger(turnId) || turnId < 1) return "ignored";
    const admitted = await admitOnCard(
      pressed,
      ts,
      value,
      { kind: "turn", turnId },
      "session.submit",
    );
    if ("refused" in admitted) return `refused:${admitted.refused}`;
    // A later turn already went on from it: no turn, and the button goes.
    const superseded = await deps.sessions
      .continueTurn(admitted.caller, value.s, { turnId })
      .then(
        () => false,
        (error: unknown) => {
          if (
            error instanceof SessionServiceError &&
            error.code === "CONTROL_SUPERSEDED"
          ) {
            return true;
          }
          throw error;
        },
      );
    try {
      // The console is where a person links their Slack account, too.
      const linkUrl = sessionUrl(new URL(deps.connectUrl).origin, value.s);
      const redrawn = slackOwnershipLostNotice({
        locale: pressed.locale,
        sessionId: value.s,
        turnId,
        continued: true,
        ...(linkUrl === undefined ? {} : { linkUrl }),
      });
      const label =
        (await deps.outbox.aiLabelFor({
          agentId: pressed.agentId,
          sessionId: value.s,
          turnId,
        })) ?? undefined;
      await deps.slack.updateMessage(pressed.botToken, {
        channelId: pressed.channelId,
        ts,
        text: redrawn.text + slackAiLabelSuffix(pressed.locale, label),
        blocks: withSlackAiLabel(redrawn.blocks, pressed.locale, label),
      });
    } catch (error) {
      deps.logger.warn("Slack notice update failed", {
        agent_id: pressed.agentId,
        error: messageOf(error),
      });
    }
    return superseded ? "superseded" : "continued";
  }

  /**
   * [Continue in a new context] on the notice of a turn whose outcome is
   * unknown on a session with no committed checkpoint: a start_fresh
   * decision that runs the turn again, for the person who pressed, judged as
   * a message they typed in the thread would be. One decision per turn,
   * whoever presses and however often.
   */
  async function startFreshTurn(
    pressed: Pressed,
    ts: string,
    value: SlackInteractionValue,
  ): Promise<string> {
    const turnId = Number(value.r);
    if (!Number.isSafeInteger(turnId) || turnId < 1) return "ignored";
    const admitted = await admitOnCard(
      pressed,
      ts,
      value,
      { kind: "turn", turnId },
      "session.submit",
    );
    if ("refused" in admitted) return `refused:${admitted.refused}`;
    // The session moved on another way (a decision elsewhere, a close): the
    // decision no longer applies and nothing is run.
    const stale = await deps.sessions
      .startFreshTurn(admitted.caller, value.s, { turnId })
      .then(
        () => false,
        (error: unknown) => {
          if (
            error instanceof SessionServiceError &&
            error.code === "REQUEST_STALE"
          ) {
            return true;
          }
          throw error;
        },
      );
    if (stale) return "stale";
    try {
      const linkUrl = sessionUrl(new URL(deps.connectUrl).origin, value.s);
      const redrawn = slackStartFreshNotice({
        locale: pressed.locale,
        sessionId: value.s,
        turnId,
        continued: true,
        ...(linkUrl === undefined ? {} : { linkUrl }),
      });
      const label =
        (await deps.outbox.aiLabelFor({
          agentId: pressed.agentId,
          sessionId: value.s,
          turnId,
        })) ?? undefined;
      await deps.slack.updateMessage(pressed.botToken, {
        channelId: pressed.channelId,
        ts,
        text: redrawn.text + slackAiLabelSuffix(pressed.locale, label),
        blocks: withSlackAiLabel(redrawn.blocks, pressed.locale, label),
      });
    } catch (error) {
      deps.logger.warn("Slack notice update failed", {
        agent_id: pressed.agentId,
        error: messageOf(error),
      });
    }
    return "started_fresh";
  }

  /**
   * [Done] or [Cancel] on a task's progress message: the task closes with
   * that reason for whoever pressed, if they may control its session; anyone
   * else is told so alone. The message says so on the outbox's next pass.
   */
  const closeTask = async (
    pressed: Pressed,
    value: SlackInteractionValue,
    reason: RequesterCloseReason,
  ): Promise<string> => {
    if (deps.tasks === undefined) return "ignored";
    const admitted = await admitOnThread(
      pressed,
      value.s,
      value.r,
      await deps.outbox.progressLink(value.s),
      "session.submit",
    );
    if ("refused" in admitted) return `refused:${admitted.refused}`;
    const outcome = await deps.tasks.close(admitted.caller, value.s, reason);
    if (outcome === "not_permitted") {
      await notice(pressed, "taskCloseNotPermitted");
      return "refused:not_permitted";
    }
    if (outcome === "refused") await notice(pressed, "failed");
    return `task_${outcome}`;
  };

  async function onSubmit(
    agentId: string,
    app: { workspaceId: string; slackAppId: string; appId: string },
    payload: SlackViewSubmissionPayload,
  ): Promise<SlackInteractionOutcome> {
    const form =
      payload.view.callback_id === SLACK_QUESTION_VIEW_CALLBACK
        ? "question"
        : payload.view.callback_id === SLACK_NOTE_VIEW_CALLBACK
          ? "note"
          : null;
    if (form === null) return ok("ignored", CLEAR);
    let metadata: SlackQuestionViewMetadata;
    try {
      metadata = slackQuestionViewMetadataSchema.parse(
        JSON.parse(payload.view.private_metadata),
      );
    } catch {
      return ok("ignored", CLEAR);
    }
    const value: SlackInteractionValue = { s: metadata.s, r: metadata.r };
    let locale: UserLocale = DEFAULT_USER_LOCALE;

    // What has to be known before the form may close: who submitted, and
    // that the answers fit the request as stored.
    const check = async (): Promise<
      SlackInteractionOutcome | (() => Promise<void>)
    > => {
      const pressed = await pressedFor(agentId, app, {
        teamId: payload.team.id,
        userId: payload.user.id,
        channelId: metadata.c,
        threadTs: metadata.t,
      });
      if (pressed === null) return ok("refused:no_bot_token", CLEAR);
      locale = pressed.locale;
      // The card the form was opened from, as the form names it: checked
      // again now, whatever was checked when it opened.
      const admitted = await admitOnCard(
        pressed,
        metadata.m,
        value,
        promptKey(metadata.r),
        "session.approve",
        { pendingRequestId: metadata.r },
      );
      if ("refused" in admitted) {
        return ok(`refused:${admitted.refused}`, CLEAR);
      }
      const questions =
        form === "question"
          ? await pendingQuestions(admitted.caller, value)
          : null;
      const open =
        form === "note"
          ? await permissionOpen(admitted.caller, value)
          : questions !== null;
      if (!open) {
        const state = await standing(admitted.caller, value);
        defer(() =>
          tell(
            pressed,
            SLACK_PROMPT_MESSAGES[pressed.locale].already[
              state === "open" ? "closed" : state
            ],
          ),
        );
        return ok("already", CLEAR);
      }
      const values = payload.view.state.values;
      const parsed =
        questions === null
          ? slackNoteText(values, pressed.locale)
          : slackQuestionAnswers(questions, values, pressed.locale);
      if (!parsed.ok) {
        return ok("invalid", {
          response_action: "errors",
          errors: parsed.errors,
        });
      }
      const body =
        "text" in parsed
          ? {
              kind: "permission" as const,
              decision: "allow" as const,
              reason: parsed.text,
            }
          : { kind: "question" as const, answers: parsed.answers };
      return async () => {
        try {
          const result = await answer(admitted, value, body, () =>
            settle(pressed, metadata.m, value),
          );
          // The form closed on an open request; its note went nowhere.
          if (result === "already" && body.kind === "permission") {
            await tell(
              pressed,
              SLACK_PROMPT_MESSAGES[pressed.locale].note.lost,
            );
          }
          handled(agentId, ok(result));
        } catch (error) {
          failedQuietly(pressed, error, value);
          await notice(pressed, "failed");
        }
      };
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const checked = await Promise.race([
      check(),
      new Promise<"late">((done) => {
        timer = setTimeout(() => done("late"), submitDeadlineMs);
      }),
    ]).finally(() => clearTimeout(timer));
    // A check that finishes later is dropped: nothing is answered for a
    // form Slack was told to keep open.
    if (checked === "late") {
      const block = Object.keys(payload.view.state.values)[0] ?? "q0";
      return ok("late", {
        response_action: "errors",
        errors: { [block]: SLACK_PROMPT_MESSAGES[locale].retry },
      });
    }
    if (typeof checked !== "function") return checked;
    defer(checked);
    return ok("accepted", CLEAR);
  }

  return {
    async receive(
      request: SlackSignedRequest,
    ): Promise<SlackInteractionOutcome> {
      const verified = await verifySlackRequest(deps, request, now);
      if (verified === null) return { kind: "unauthorized" };
      const { agentId, app } = verified;

      let body: unknown;
      try {
        const form = new URLSearchParams(
          new TextDecoder("utf-8", { fatal: true }).decode(request.rawBody),
        );
        body = JSON.parse(form.get("payload") ?? "");
      } catch {
        return { kind: "bad_request" };
      }
      const parsed = slackInteractionPayloadSchema.safeParse(body);
      if (!parsed.success) return { kind: "bad_request" };
      const target = {
        workspaceId: app.workspaceId,
        slackAppId: app.slackAppId,
        appId: app.appId,
      };
      const actions = slackBlockActionsPayloadSchema.safeParse(parsed.data);
      if (actions.success) {
        if (actions.data.api_app_id !== app.appId) return ok("app_mismatch");
        return onAction(agentId, target, actions.data);
      }
      const submit = slackViewSubmissionPayloadSchema.safeParse(parsed.data);
      if (submit.success) {
        if (submit.data.api_app_id !== app.appId) {
          return ok("app_mismatch", CLEAR);
        }
        return onSubmit(agentId, target, submit.data);
      }
      if (
        parsed.data.type === "block_actions" ||
        parsed.data.type === "view_submission"
      ) {
        return { kind: "bad_request" };
      }
      return ok("ignored");
    },
  };
}
