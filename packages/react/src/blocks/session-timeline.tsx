import {
  presentTurnEvent,
  type TurnEventPart,
  type TurnEventPresentation,
  type TurnSummary,
} from "@werft-ai/contracts";
import { type ReactNode, useMemo, useState } from "react";
import {
  Message,
  Timeline,
  type TimelineEntry,
  turnSummaryText,
} from "../components/index.ts";
import {
  type EventStreamState,
  eventToolCallId,
  type SessionEventFrame,
} from "../sessions.ts";
import { SlackMessageLink } from "./slack-message-link.tsx";
import { useBlockText } from "./text.ts";

type Translate = ReturnType<typeof useBlockText>["t"];

// The worker's own words for why it stopped waiting, each read as a duration.
const REASONS = [
  [/^No input for (\d+(?:\.\d+)?)s$/, "session.reason.idle"],
  [/^No answer arrived within (\d+(?:\.\d+)?)s$/, "session.reason.noAnswer"],
  [
    /^Turn \S+ ran past its (\d+(?:\.\d+)?)s budget/,
    "session.reason.turnBudget",
  ],
  [/ ran past its (\d+(?:\.\d+)?)s budget$/, "session.reason.stageBudget"],
] as const;

function duration(seconds: number, locale: string) {
  const minutes = seconds >= 60;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: minutes ? "minute" : "second",
    unitDisplay: "long",
    maximumFractionDigits: 0,
  }).format(minutes ? seconds / 60 : seconds);
}

/** A worker reason this screen can say in the reader's words, or null. */
export function readableReason(
  text: string,
  t: Translate,
  locale: string,
): string | null {
  if (text === "The turn ran out of time") return t("session.reason.turnOver");
  for (const [pattern, key] of REASONS) {
    const seconds = pattern.exec(text)?.[1];
    if (seconds !== undefined) {
      return t(key, { duration: duration(Number(seconds), locale) });
    }
  }
  return null;
}

// The worker's sentence moves to the folded detail, so it is still there to
// quote in a report.
function withReadableReasons(
  presentation: TurnEventPresentation,
  t: Translate,
  locale: string,
): TurnEventPresentation {
  let original: string | undefined;
  const summary = presentation.summary.map((part): TurnEventPart => {
    if (!("text" in part)) return part;
    const readable = readableReason(part.text, t, locale);
    if (readable === null) return part;
    original = part.text;
    return { text: readable };
  });
  return original === undefined
    ? presentation
    : { ...presentation, summary, detail: presentation.detail ?? original };
}

function questionOf(frame: SessionEventFrame) {
  if (frame.payload.event !== "question") return {};
  const { request_id, input } = frame.payload.data;
  const questions = (input as { questions?: unknown } | null)?.questions;
  const options = Array.isArray(questions)
    ? questions.flatMap((question: { options?: unknown }) =>
        Array.isArray(question?.options)
          ? question.options.flatMap((option: { label?: unknown }) =>
              typeof option?.label === "string" ? [option.label] : [],
            )
          : [],
      )
    : [];
  return { requestId: request_id, options };
}

/**
 * The tool calls a question or permission request holds back: asked, with
 * neither an answer nor a result yet. As in run-tree, a request is answered
 * once a later status leaves needs_input; the session stays there while any
 * other request waits, so one known `answered` is let go sooner.
 */
export function heldToolCalls(
  events: readonly SessionEventFrame[],
  answered: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const held = new Set<string>();
  for (const { payload } of events) {
    if (payload.event === "question") {
      if (!answered.has(payload.data.request_id))
        held.add(payload.data.tool_use_id);
    } else if (payload.event === "status") {
      if (payload.data.phase !== "needs_input") held.clear();
    } else if (payload.event === "tool_result") {
      const id = eventToolCallId(payload);
      if (id !== undefined) held.delete(id);
    }
  }
  return held;
}

/** A pending requests query as `SessionTimeline`'s `pending` reads it. */
export function listedRequests(query: {
  readonly data?:
    | { readonly items: readonly { request_id: string }[] }
    | undefined;
  readonly dataUpdatedAt: number;
}) {
  return query.data
    ? {
        requestIds: query.data.items.map((item) => item.request_id),
        at: query.dataUpdatedAt,
      }
    : undefined;
}

/** A session's events as the timeline reads them. */
export function SessionTimeline({
  events,
  state,
  debug = false,
  request,
  pending,
  turns,
}: {
  readonly events: readonly SessionEventFrame[];
  readonly state: EventStreamState;
  readonly debug?: boolean;
  /** Drawn under a request's line; see `Timeline`. */
  readonly request?: ((requestId: string) => ReactNode) | undefined;
  /**
   * The requests waiting for an answer and when the list was read
   * (`listedRequests`): one missing from it was answered, so its call no
   * longer waits.
   */
  readonly pending?:
    | { readonly requestIds: readonly string[]; readonly at: number }
    | undefined;
  /** The session's turns: each one's message heads its events. */
  readonly turns?: readonly TurnSummary[] | undefined;
}) {
  const { t, formatMessage, locale } = useBlockText();
  const entries = useMemo(
    () =>
      events.map(
        (frame): TimelineEntry => ({
          id: frame.id,
          occurredAt: frame.occurredAt,
          turnId: frame.turnId,
          presentation: withReadableReasons(
            presentTurnEvent(frame.payload, { toolName: frame.toolName }),
            t,
            locale,
          ),
          toolCallId: eventToolCallId(frame.payload),
          ...questionOf(frame),
        }),
      ),
    [events, t, locale],
  );
  // Each new `pending.at` is one more read of the list. A read already under
  // way when a request's line arrived may predate the request, so only a list
  // read twice since then can say it is gone; until then its call waits.
  const [reads, setReads] = useState({ at: pending?.at, count: 0 });
  const read = pending !== undefined && pending.at !== reads.at;
  // A read that lands with a line counts as under way before it.
  const count = read ? reads.count + 1 : reads.count;
  if (read) setReads({ at: pending.at, count });
  const [readsWhenSeen, setReadsWhenSeen] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const unseen = events.flatMap(({ payload }) =>
    payload.event === "question" && !readsWhenSeen.has(payload.data.request_id)
      ? [payload.data.request_id]
      : [],
  );
  if (unseen.length > 0)
    setReadsWhenSeen(
      new Map([...readsWhenSeen, ...unseen.map((id) => [id, count] as const)]),
    );
  const answered = new Set(
    pending === undefined
      ? []
      : [...readsWhenSeen].flatMap(([requestId, seen]) =>
          count > seen + 1 && !pending.requestIds.includes(requestId)
            ? [requestId]
            : [],
        ),
  );
  const held = heldToolCalls(events, answered);
  const asked = useMemo(
    () => new Map(turns?.map((turn) => [turn.turn_id, turn])),
    [turns],
  );
  const latestStatus = entries
    .filter((_, index) => events[index]?.payload.event === "status")
    .at(-1);
  return (
    <div className="px-4">
      <output className="sr-only">
        {latestStatus
          ? turnSummaryText(latestStatus.presentation.summary, formatMessage)
          : null}
      </output>
      <Timeline
        entries={entries}
        formatMessage={formatMessage}
        messages={{
          label: t("session.events"),
          empty: t("session.events.empty"),
          connecting: t("session.events.connecting"),
          closed: t("session.events.closed"),
          turn: (turn) => t("session.events.turn", { turn }),
          kind: (kind) => t(`session.events.kind.${kind}`),
          folded: (count) => t("session.events.folded", { count }),
          running: t("session.events.running"),
          waiting: t("sessions.status.needs_input"),
          options: t("session.events.options"),
          more: t("session.events.more"),
          less: t("session.events.less"),
          table: t("session.events.table"),
          newTab: t("session.events.newTab"),
        }}
        state={state}
        showDebug={debug}
        locale={locale}
        request={request}
        held={held}
        prompt={(turnId) => {
          const turn = asked.get(turnId);
          return turn ? (
            <Message
              from="user"
              author={[
                turn.created_by?.display_name || t("session.events.prompt"),
                turn.channel ? t(`session.channel.${turn.channel}`) : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
              text={turn.message}
              source={
                turn.slack_permalink ? (
                  <SlackMessageLink href={turn.slack_permalink} />
                ) : null
              }
            />
          ) : null;
        }}
      />
    </div>
  );
}
