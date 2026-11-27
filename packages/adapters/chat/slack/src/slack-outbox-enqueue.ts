import {
  DEFAULT_USER_LOCALE,
  eventText,
  eventToolCall,
  SLACK_NOTICE_MESSAGES,
  slackMirrorCorrelationIdSchema,
  slackNoticeText,
} from "@werft-ai/contracts";
import type {
  SurfaceOutboxStore,
  SurfacePendingPrompt,
  SurfaceUnansweredTurn,
} from "@werft-ai/platform";
import { WORKER_OWNERSHIP_LOST_REASON } from "@werft-ai/platform";
import type { SlackNoticeSink } from "./slack-notice-sink.ts";
import {
  SLACK_OUTBOX_MESSAGES,
  sessionUrl,
  slackInstructionSender,
  slackOutboxGuard,
} from "./slack-outbox-render.ts";
import {
  slackOwnershipLostNotice,
  slackPromptMessage,
  slackStartFreshNotice,
} from "./slack-prompts.ts";

/** Enqueues the instructions sent from the web or the API, once each. */
export async function enqueueSlackInstructions(deps: {
  outbox: Pick<SurfaceOutboxStore, "unpostedInstructions" | "enqueue">;
  limit: number;
}): Promise<number> {
  const turns = await deps.outbox.unpostedInstructions(deps.limit);
  for (const turn of turns) {
    const username = slackInstructionSender(
      turn.channel,
      turn.senderName,
      turn.locale ?? DEFAULT_USER_LOCALE,
    );
    await deps.outbox.enqueue({
      workspaceId: turn.workspaceId,
      agentId: turn.agentId,
      slackAppId: turn.slackAppId,
      installationId: turn.installationId,
      kind: "instruction",
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      slackUserId: null,
      sessionId: turn.sessionId,
      sessionLinkId: turn.sessionLinkId,
      body: {
        text: turn.message,
        sender:
          turn.senderSlackUserId === null
            ? { username }
            : { username, slack_user_id: turn.senderSlackUserId },
      },
      dedupeKey: `instruction:${turn.sessionLinkId}:${turn.turnId}`,
      sources: turn.sources,
      sourcesTurn: turn.turnId,
    });
  }
  return turns.length;
}

/**
 * Enqueues each web input owed a Slack mirror, once: shown as an instruction
 * from the web is, its sources the input itself.
 */
export async function enqueueSlackInputMirrors(deps: {
  outbox: Pick<SurfaceOutboxStore, "unmirroredInputs" | "enqueue">;
  limit: number;
}): Promise<number> {
  const inputs = await deps.outbox.unmirroredInputs(deps.limit);
  for (const input of inputs) {
    const username = slackInstructionSender(
      "web",
      input.senderName,
      input.locale ?? DEFAULT_USER_LOCALE,
    );
    await deps.outbox.enqueue({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      slackAppId: input.slackAppId,
      installationId: input.installationId,
      kind: "input_mirror",
      channelId: input.channelId,
      threadTs: input.threadTs,
      slackUserId: null,
      sessionId: null,
      sessionLinkId: null,
      body: {
        text: input.body,
        sender:
          input.senderSlackUserId === null
            ? { username }
            : { username, slack_user_id: input.senderSlackUserId },
      },
      dedupeKey: `input_mirror:${input.inputId}`,
      sources: { direct: [{ input_id: input.inputId }], inherited: [] },
      inputId: input.inputId,
      correlationId: slackMirrorCorrelationIdSchema.parse(crypto.randomUUID()),
    });
  }
  return inputs.length;
}

/** One outbox row per turn and kind: what makes a turn answered. */
export function slackTurnDedupeKey(
  state: SurfaceUnansweredTurn["state"],
  sessionLinkId: string,
  turnId: number,
): string {
  return `${state === "completed" ? "reply" : "failure"}:${sessionLinkId}:${turnId}`;
}

export function slackPromptDedupeKey(
  kind: SurfacePendingPrompt["prompt"]["kind"],
  sessionLinkId: string,
  requestId: string,
): string {
  return `${kind === "push" ? "push" : "prompt"}:${sessionLinkId}:${requestId}`;
}

/**
 * The text the model wrote after its last tool call: what it said once the
 * work was done. Read whole, unlike presentTurnEvent's clipped summary.
 */
export function finalReplyText(
  events: SurfaceUnansweredTurn["events"],
): string {
  let parts: string[] = [];
  for (const event of events) {
    if (eventToolCall(event.payload) !== null) parts = [];
    else {
      const text = eventText(event.payload);
      if (text !== null) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Refusal notices become ephemeral outbox rows, one per onceKey, in the
 * language of the user the reader's Slack account is linked to.
 */
export function createOutboxSlackNoticeSink(
  outbox: Pick<SurfaceOutboxStore, "enqueue" | "readerLocale">,
): SlackNoticeSink {
  return {
    async record(notice) {
      const locale =
        (await outbox.readerLocale({
          workspaceId: notice.workspaceId,
          teamId: notice.teamId,
          slackUserId: notice.slackUserId,
        })) ?? DEFAULT_USER_LOCALE;
      const { message: _message, count: _count, ...link } = notice.notice;
      await outbox.enqueue({
        workspaceId: notice.workspaceId,
        agentId: notice.agentId,
        slackAppId: notice.slackAppId,
        installationId: notice.installationId,
        kind: "notice",
        channelId: notice.channelId,
        threadTs: notice.threadTs,
        slackUserId: notice.slackUserId,
        sessionId: null,
        sessionLinkId: null,
        body: { text: slackNoticeText(locale, notice.notice), locale, ...link },
        dedupeKey: `notice:${notice.onceKey}`,
      });
    },
    // Posted like a turn that could not go on: in the thread, for everyone
    // there, in its reader's language when the line names one. The kind
    // is the thread notice's, a stop's line too: nothing counts a failure
    // by kind, only by how the send went.
    async recordInThread(notice) {
      const locale =
        (notice.readerSlackUserId === undefined
          ? null
          : await outbox.readerLocale({
              workspaceId: notice.workspaceId,
              teamId: notice.teamId,
              slackUserId: notice.readerSlackUserId,
            })) ?? DEFAULT_USER_LOCALE;
      const { message: _message, count: _count, ...link } = notice.notice;
      await outbox.enqueue({
        workspaceId: notice.workspaceId,
        agentId: notice.agentId,
        slackAppId: notice.slackAppId,
        installationId: notice.installationId,
        kind: "failure_notice",
        channelId: notice.channelId,
        threadTs: notice.threadTs,
        slackUserId: null,
        sessionId: notice.sessionId,
        sessionLinkId: notice.sessionLinkId,
        body: { text: slackNoticeText(locale, notice.notice), locale, ...link },
        dedupeKey: `thread_notice:${notice.onceKey}`,
      });
    },
  };
}

/** How long a worker waits for room before its thread hears of it. */
export const SLACK_CAPACITY_WAIT_NOTICE_MS = 30_000;

/** One notice per thread per launch that waits: a wait is told once. */
export function slackCapacityWaitDedupeKey(
  sessionLinkId: string,
  executionId: string,
  generation: number,
): string {
  return `capacity_wait:${sessionLinkId}:${executionId}:${generation}`;
}

/**
 * Tells each thread, once, that its session's worker waits for room. Nothing
 * says when room is found; if none is, the failed turns' notice says so.
 */
export async function enqueueSlackCapacityWaits(deps: {
  outbox: Pick<SurfaceOutboxStore, "capacityWaits" | "enqueue">;
  consoleOrigin: string | null;
  limit: number;
}): Promise<number> {
  const capacityWaits = deps.outbox.capacityWaits;
  if (capacityWaits === undefined) return 0;
  const waits = await capacityWaits.call(
    deps.outbox,
    deps.limit,
    SLACK_CAPACITY_WAIT_NOTICE_MS,
  );
  for (const wait of waits) {
    const link_url = sessionUrl(deps.consoleOrigin, wait.sessionId);
    const locale = wait.locale ?? DEFAULT_USER_LOCALE;
    await deps.outbox.enqueue({
      workspaceId: wait.workspaceId,
      agentId: wait.agentId,
      slackAppId: wait.slackAppId,
      installationId: wait.installationId,
      // A thread notice for everyone there, like a failed turn's.
      kind: "failure_notice",
      channelId: wait.channelId,
      threadTs: wait.threadTs,
      slackUserId: null,
      sessionId: wait.sessionId,
      sessionLinkId: wait.sessionLinkId,
      body: {
        text: SLACK_NOTICE_MESSAGES[locale].capacityWait,
        locale,
        ...(link_url === undefined ? {} : { link_url }),
      },
      dedupeKey: slackCapacityWaitDedupeKey(
        wait.sessionLinkId,
        wait.executionId,
        wait.generation,
      ),
    });
  }
  return waits.length;
}

/** Enqueues the reply or failure notice of turns that lack one. */
export async function enqueueSlackTurnAnswers(deps: {
  outbox: Pick<SurfaceOutboxStore, "unansweredTurns" | "enqueue">;
  consoleOrigin: string | null;
  limit: number;
}): Promise<number> {
  const turns = await deps.outbox.unansweredTurns(deps.limit);
  for (const turn of turns) {
    const link_url = sessionUrl(deps.consoleOrigin, turn.sessionId);
    const locale = turn.locale ?? DEFAULT_USER_LOCALE;
    // How the turn ended decides its notice: one its worker's lost lease
    // ended says so, whatever was refused before the lease went.
    const ownershipLost =
      turn.state === "failed" &&
      turn.terminalReason === WORKER_OWNERSHIP_LOST_REASON;
    // A turn of unknown outcome with no save point before it offers to run
    // it again in a new context.
    const startFresh = !ownershipLost && turn.startFreshOffered === true;
    const refusal =
      turn.state === "completed" || ownershipLost || startFresh
        ? null
        : turn.budgetRefusal;
    // A budget account's later refusal goes to the person who asked alone;
    // the first, and every one in a direct message, to the thread.
    const alone =
      refusal != null &&
      !refusal.first &&
      !turn.channelId.startsWith("D") &&
      turn.requesterSlackUserId !== null
        ? turn.requesterSlackUserId
        : null;
    // A turn its worker's lost lease ended says so in place of "try again",
    // with the button that goes on from it, and so does one start_fresh can
    // run again; nothing runs either again by itself.
    const card = ownershipLost
      ? slackOwnershipLostNotice({
          locale,
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          ...(link_url === undefined ? {} : { linkUrl: link_url }),
        })
      : startFresh
        ? slackStartFreshNotice({
            locale,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            ...(link_url === undefined ? {} : { linkUrl: link_url }),
          })
        : null;
    const text =
      turn.state === "completed"
        ? finalReplyText(turn.events) ||
          SLACK_OUTBOX_MESSAGES[locale].emptyReply
        : card !== null
          ? card.text
          : refusal != null
            ? SLACK_NOTICE_MESSAGES[locale][
                refusal.owner === "user"
                  ? "budgetAccountUser"
                  : "budgetAccountTeam"
              ]
            : turn.terminalReason === "no_capacity"
              ? SLACK_NOTICE_MESSAGES[locale][
                  turn.sessionPaused ? "noCapacityPaused" : "noCapacity"
                ]
              : turn.terminalReason === "codex_sandbox_not_installed"
                ? SLACK_NOTICE_MESSAGES[locale].codexSandboxNotInstalled
                : SLACK_NOTICE_MESSAGES[locale].failed;
    await deps.outbox.enqueue({
      workspaceId: turn.workspaceId,
      agentId: turn.agentId,
      slackAppId: turn.slackAppId,
      installationId: turn.installationId,
      kind:
        turn.state === "completed"
          ? "reply"
          : alone === null
            ? "failure_notice"
            : "notice",
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      slackUserId: alone,
      sessionId: turn.sessionId,
      sessionLinkId: turn.sessionLinkId,
      body: {
        text,
        locale,
        ...(link_url === undefined ? {} : { link_url }),
        ...(card === null ? {} : { blocks: card.blocks }),
        ...(turn.requesterSlackUserId === null || alone !== null
          ? {}
          : { mention_user_ids: [turn.requesterSlackUserId] }),
      },
      dedupeKey: slackTurnDedupeKey(
        turn.state,
        turn.sessionLinkId,
        turn.turnId,
      ),
      sources: turn.sources,
      sourcesTurn: turn.turnId,
    });
  }
  return turns.length;
}

export async function enqueueSlackPrompts(deps: {
  outbox: Pick<SurfaceOutboxStore, "unpromptedRequests" | "enqueue">;
  consoleOrigin: string | null;
  limit: number;
}): Promise<number> {
  const pending = await deps.outbox.unpromptedRequests(deps.limit);
  for (const row of pending) {
    const locale = row.locale ?? DEFAULT_USER_LOCALE;
    const link_url = sessionUrl(deps.consoleOrigin, row.sessionId);
    // A card is the agent's words, never a person's own: G7 and A3 both.
    const { guard } = slackOutboxGuard({
      kind: "input_notice",
      channelId: row.channelId,
      conversationScope: row.conversationScope ?? null,
    });
    const message = slackPromptMessage(
      { ...row.prompt, sessionId: row.sessionId },
      {
        locale,
        requesterSlackUserId: row.requesterSlackUserId,
        ...(link_url === undefined ? {} : { linkUrl: link_url }),
        guard,
      },
    );
    await deps.outbox.enqueue({
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      slackAppId: row.slackAppId,
      installationId: row.installationId,
      kind: "input_notice",
      channelId: row.channelId,
      threadTs: row.threadTs,
      slackUserId: null,
      sessionId: row.sessionId,
      sessionLinkId: row.sessionLinkId,
      body: {
        text: message.text,
        locale,
        blocks: message.blocks,
        ...(link_url === undefined ? {} : { link_url }),
        ...(row.requesterSlackUserId === null
          ? {}
          : { mention_user_ids: [row.requesterSlackUserId] }),
      },
      dedupeKey: slackPromptDedupeKey(
        row.prompt.kind,
        row.sessionLinkId,
        row.prompt.requestId,
      ),
      sources: row.sources,
      sourcesTurn: row.sourcesTurn,
    });
  }
  return pending.length;
}
