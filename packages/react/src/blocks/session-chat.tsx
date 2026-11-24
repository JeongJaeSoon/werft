import {
  eventToolCall,
  eventToolResult,
  presentTurnEvent,
  TURN_WORKSPACE_QUOTA_EXCEEDED_REASON,
  type TurnSummary,
} from "@werft-ai/contracts";
import {
  Badge,
  ChatList,
  ChatMessage,
  ChatToolGroup,
  ChatToolItem,
  CodeBlock,
  formatClockTime,
  Text,
} from "@werft-ai/ui";
import { type JSX, type ReactNode, useMemo } from "react";
import { Markdown, turnSummaryText } from "../components/index.ts";
import { inputText } from "../components/session/input-text.ts";
import type { EventStreamState, SessionEventFrame } from "../sessions.ts";
import { SlackMessageLink } from "./slack-message-link.tsx";
import { useBlockText } from "./text.ts";

/** One line of the chat, in the order it happened. */
export type ChatItem =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly at: string;
      readonly turn: TurnSummary;
    }
  | {
      readonly kind: "reply";
      readonly id: string;
      readonly at: string;
      /** Markdown as the model wrote it, or the error's words. */
      readonly text: string;
      readonly error: boolean;
      /** The turn's instruction was deleted in Slack: its replies are held back. */
      readonly withheld?: true;
      /** The run stopped the turn for outgrowing its workspace; no event says so. */
      readonly workspaceQuotaExceeded?: true;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly at: string;
      readonly name: string;
      readonly input: unknown;
      readonly result: {
        readonly text: string;
        readonly error: boolean;
      } | null;
      readonly withheld?: true;
    };

/**
 * The session as a chat: each turn's instruction as the person's message,
 * the agent's replies and errors as its messages, and each tool call as one
 * folded line holding its result. Status, thinking and engine bookkeeping
 * are left out; the head's status label says where the session stands.
 * A turn whose instruction was deleted in Slack shows a placeholder for its
 * instruction and one for its replies, and its tool calls by name alone,
 * whatever text an event streamed before the turn was read so.
 */
export function chatItems(
  events: readonly SessionEventFrame[],
  turns: readonly TurnSummary[] | undefined,
  formatMessage: Parameters<typeof turnSummaryText>[1],
): ChatItem[] {
  // A frame marked withheld withholds its whole turn, its instruction and
  // the frames streamed before the delete too, whatever turns were read.
  const withheldAt = new Map<string, string>([
    ...events.flatMap((frame) =>
      frame.sourceDeletedAt !== undefined && frame.turnId !== null
        ? [[frame.turnId, frame.sourceDeletedAt] as const]
        : [],
    ),
    ...(turns ?? []).flatMap((turn) =>
      turn.source_deleted_at
        ? [[turn.turn_id, turn.source_deleted_at] as const]
        : [],
    ),
  ]);
  const withheldTurns = new Set(withheldAt.keys());
  const items: ChatItem[] = (turns ?? []).map((turn) => {
    const deletedAt = withheldAt.get(turn.turn_id);
    return {
      kind: "user",
      id: `turn:${turn.turn_id}`,
      at: turn.created_at,
      turn:
        deletedAt === undefined || turn.source_deleted_at
          ? turn
          : { ...turn, message: "", source_deleted_at: deletedAt },
    };
  });
  const heldReplies = new Set<string>();
  const tools = new Map<string, number>();
  const seen = new Set<string>();
  for (const frame of events) {
    // A resumed stream may deliver a frame twice.
    if (seen.has(frame.id)) continue;
    seen.add(frame.id);
    const { payload } = frame;
    const withheld =
      frame.sourceDeletedAt !== undefined ||
      (frame.turnId !== null && withheldTurns.has(frame.turnId));
    if (payload.event === "tool_result") {
      const result = eventToolResult(payload.data);
      const index =
        result === null ? undefined : tools.get(result.tool_call_id);
      if (result === null || index === undefined) continue;
      const call = items[index];
      if (call?.kind !== "tool") continue;
      items[index] = {
        ...call,
        result: {
          text: withheld ? "" : result.text,
          error: result.is_error === true,
        },
      };
      continue;
    }
    if (payload.event === "error" && withheld) {
      items.push({
        kind: "reply",
        id: frame.id,
        at: frame.occurredAt,
        text: "",
        error: true,
        withheld: true,
      });
      continue;
    }
    if (payload.event === "error") {
      const presentation = presentTurnEvent(payload);
      const text = turnSummaryText(presentation.summary, formatMessage);
      if (text) {
        items.push({
          kind: "reply",
          id: frame.id,
          at: frame.occurredAt,
          text,
          error: true,
        });
      }
      continue;
    }
    if (payload.event !== "assistant" && payload.event !== "tool_use") continue;
    const call = eventToolCall(payload.data);
    if (withheld) {
      const held = frame.turnId ?? frame.id;
      if (call === null && !heldReplies.has(held)) {
        heldReplies.add(held);
        items.push({
          kind: "reply",
          id: frame.id,
          at: frame.occurredAt,
          text: "",
          error: false,
          withheld: true,
        });
      }
      if (call !== null && !tools.has(call.id)) {
        tools.set(call.id, items.length);
        items.push({
          kind: "tool",
          id: `tool:${call.id}`,
          at: frame.occurredAt,
          name: call.name,
          input: {},
          result: null,
          withheld: true,
        });
      }
      continue;
    }
    const presentation = presentTurnEvent(payload);
    if (presentation.reply?.trim()) {
      items.push({
        kind: "reply",
        id: frame.id,
        at: frame.occurredAt,
        text: presentation.reply as string,
        error: presentation.error === true,
      });
    }
    if (call !== null && !tools.has(call.id)) {
      tools.set(call.id, items.length);
      items.push({
        kind: "tool",
        id: `tool:${call.id}`,
        at: frame.occurredAt,
        name: call.name,
        input: call.input,
        result: null,
      });
    }
  }
  for (const turn of turns ?? []) {
    if (
      turn.status !== "failed" ||
      turn.terminal_reason !== TURN_WORKSPACE_QUOTA_EXCEEDED_REASON
    ) {
      continue;
    }
    items.push({
      kind: "reply",
      id: `quota:${turn.turn_id}`,
      at: turn.ended_at ?? turn.created_at,
      text: "",
      error: true,
      workspaceQuotaExceeded: true,
    });
  }
  // Stable: a turn's message stays ahead of the events it started.
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        Date.parse(a.item.at) - Date.parse(b.item.at) || a.index - b.index,
    )
    .map(({ item }) => item);
}

type ToolCallItem = Extract<ChatItem, { kind: "tool" }>;

/** The chat's lines with each run of tool calls drawn as one fold. */
export function groupTools(
  items: readonly ChatItem[],
): (
  | Exclude<ChatItem, ToolCallItem>
  | { kind: "tools"; id: string; calls: ToolCallItem[] }
)[] {
  const out: ReturnType<typeof groupTools> = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind !== "tool") out.push(item);
    else if (last?.kind === "tools") last.calls.push(item);
    else out.push({ kind: "tools", id: `tools:${item.id}`, calls: [item] });
  }
  return out;
}

export interface SessionChatProps {
  readonly events: readonly SessionEventFrame[];
  readonly state: EventStreamState;
  readonly turns?: readonly TurnSummary[] | undefined;
  /** The agent's name over its messages; a generic word without one. */
  readonly agentName?: string | undefined;
  /** Whether a call with no result yet still runs (the session is working). */
  readonly working?: boolean;
  /** At the chat's end, full width: the requests waiting for an answer. */
  readonly after?: ReactNode;
}

/** The session's conversation, the person on the right and the agent left. */
export function SessionChat({
  events,
  state,
  turns,
  agentName,
  working = false,
  after,
}: SessionChatProps): JSX.Element {
  const { t, formatMessage, locale } = useBlockText();
  const items = useMemo(
    () => chatItems(events, turns, formatMessage),
    [events, turns, formatMessage],
  );
  // The chat draws no status lines; a screen reader still hears the latest.
  const lastStatus = [...events]
    .reverse()
    .find((frame) => frame.payload.event === "status");
  const status = lastStatus
    ? turnSummaryText(
        presentTurnEvent(lastStatus.payload).summary,
        formatMessage,
      )
    : null;
  const time = (at: string) => (
    <time dateTime={at}>{formatClockTime(at, locale)}</time>
  );
  const agent = agentName || t("session.chat.agent");
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <output className="sr-only">{status}</output>
      {state === "open" ? null : (
        <Text variant="meta" role="status" className="text-center">
          {state === "connecting"
            ? t("session.events.connecting")
            : t("session.events.closed")}
        </Text>
      )}
      {items.length === 0 && state === "open" ? (
        <Text variant="meta" className="text-center">
          {t("session.events.empty")}
        </Text>
      ) : null}
      <ChatList aria-label={t("session.events")}>
        {groupTools(items).map((item) =>
          item.kind === "tools" ? (
            <li key={item.id}>
              <ChatToolGroup
                summary={
                  item.calls.length === 1
                    ? t("session.chat.tools.one")
                    : t("session.chat.tools", { count: item.calls.length })
                }
                status={
                  item.calls.some((call) => call.result?.error) ? (
                    <Badge variant="red">{t("session.chat.failed")}</Badge>
                  ) : working && item.calls.some((call) => !call.result) ? (
                    <span className="flex-none text-caption text-[var(--werft-tone-progress-fg)]">
                      {t("session.chat.running")}
                    </span>
                  ) : null
                }
              >
                {item.calls.map((call) => (
                  <ChatToolItem
                    key={call.id}
                    name={call.name}
                    time={time(call.at)}
                    status={
                      call.result?.error ? (
                        <Badge variant="red">{t("session.chat.failed")}</Badge>
                      ) : call.result === null && working ? (
                        <span className="flex-none text-caption text-[var(--werft-tone-progress-fg)]">
                          {t("session.chat.running")}
                        </span>
                      ) : null
                    }
                  >
                    {call.withheld ? (
                      <Text variant="meta">{t("session.sourceDeleted")}</Text>
                    ) : (
                      <>
                        <Text variant="meta">{t("session.chat.input")}</Text>
                        <CodeBlock className="max-h-60 overflow-y-auto">
                          {inputText(call.input)}
                        </CodeBlock>
                      </>
                    )}
                    {call.result === null || call.withheld ? null : (
                      <>
                        <Text variant="meta">{t("session.chat.result")}</Text>
                        <CodeBlock className="max-h-60 overflow-y-auto">
                          {call.result.text}
                        </CodeBlock>
                      </>
                    )}
                  </ChatToolItem>
                ))}
              </ChatToolGroup>
            </li>
          ) : (
            <li key={item.id}>
              {item.kind === "user" ? (
                <ChatMessage
                  side="self"
                  author={
                    item.turn.created_by?.display_name ||
                    t("session.events.prompt")
                  }
                  time={time(item.at)}
                  source={
                    item.turn.slack_permalink ? (
                      <SlackMessageLink href={item.turn.slack_permalink} />
                    ) : null
                  }
                >
                  {item.turn.source_deleted_at ? (
                    // The bubble's own colour: muted text on it fails contrast.
                    <span className="italic">{t("session.sourceDeleted")}</span>
                  ) : (
                    item.turn.message
                  )}
                </ChatMessage>
              ) : (
                <ChatMessage
                  side="other"
                  author={agent}
                  time={time(item.at)}
                  tone={item.error ? "error" : "default"}
                >
                  {item.withheld ? (
                    <span className="text-muted-foreground">
                      {t("session.sourceDeleted")}
                    </span>
                  ) : item.workspaceQuotaExceeded ? (
                    t("session.chat.workspaceQuotaExceeded")
                  ) : item.error ? (
                    <span className="whitespace-pre-wrap">{item.text}</span>
                  ) : (
                    <Markdown
                      text={item.text}
                      fold={{
                        more: t("session.events.more"),
                        less: t("session.events.less"),
                      }}
                      tableLabel={t("session.events.table")}
                      newTabLabel={t("session.events.newTab")}
                    />
                  )}
                </ChatMessage>
              )}
            </li>
          ),
        )}
      </ChatList>
      {after}
    </div>
  );
}
