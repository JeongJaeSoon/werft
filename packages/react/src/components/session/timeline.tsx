import type {
  TurnEventMessage,
  TurnEventPart,
  TurnEventPresentation,
} from "@werft-ai/contracts";
import {
  Badge,
  cn,
  formatRelativeTime,
  RelativeTime,
  type TimestampLocale,
} from "@werft-ai/ui";
import {
  Bot,
  ChevronRight,
  CircleDot,
  CircleX,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
  Wrench,
} from "lucide-react";
import { type JSX, type ReactNode, useId, useState } from "react";

import { Sparkles } from "../console-icons.ts";
import { Markdown } from "./markdown.tsx";
import {
  type FocusContext,
  finalStatusKey,
  focusWork,
  type WorkCounts,
  workCounts,
} from "./timeline-focus.ts";
import { type FormatTurnMessage, turnSummaryText } from "./turn-text.ts";

export interface TimelineEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly turnId: string | null;
  /** presentTurnEvent's reading, with the tool call paired by the screen. */
  readonly presentation: TurnEventPresentation;
  /**
   * The tool_use block's id, on the call, its result and a request holding
   * it back alike; those with the id of an earlier call are drawn inside
   * that call's row, in the order they came.
   */
  readonly toolCallId?: string | undefined;
  /** A question or permission event's request, for the `request` slot. */
  readonly requestId?: string | undefined;
  /** What a question offers to choose from, shown under its line. */
  readonly options?: readonly string[] | undefined;
  /** A tool call's tool, which the focus view counts it by. */
  readonly toolName?: string | undefined;
}

/**
 * `focus` keeps open what a person reads or answers and folds each run of
 * the agent's work between them; `all` opens every event, internal ones
 * included. Without a view, runs of status and system lines fold.
 */
export type TimelineView = "focus" | "all";

/** Who or what an event came from; each has its own icon. */
export type TimelineKind = "agent" | "tool" | "request" | "error" | "system";

export interface TimelineMessages {
  /** Names the list for screen readers. */
  readonly label: string;
  readonly empty: string;
  readonly connecting: string;
  readonly closed: string;
  readonly turn: (turnId: string) => string;
  /** Names each icon; without it the icons stay hidden from screen readers. */
  readonly kind?: ((kind: TimelineKind) => string) | undefined;
  /**
   * Names a run of status and system lines folded into one; without it each
   * stays a compact line of its own.
   */
  readonly folded?: ((count: number) => string) | undefined;
  /** Says what a run folded in the focus view did, such as "Ran 2 commands". */
  readonly work?: ((counts: WorkCounts) => string) | undefined;
  /** Marks a tool call whose result has not arrived. */
  readonly running?: string | undefined;
  /** Marks a tool call that waits on an answer instead; see `held`. */
  readonly waiting?: string | undefined;
  /** Names a question's list of options. */
  readonly options?: string | undefined;
  /**
   * Fold a very long reply behind a button that says so and its undo; without
   * both, a reply is always whole.
   */
  readonly more?: string | undefined;
  readonly less?: string | undefined;
  /** Names a table inside a reply for screen readers. */
  readonly table?: string | undefined;
  /** Appended to a reply link's text: it opens in a new tab. */
  readonly newTab?: string | undefined;
}

export function timelineKind(
  presentation: TurnEventPresentation,
): TimelineKind {
  if (presentation.error) return "error";
  switch (presentation.label.key) {
    case "session.event.kind.assistant":
    case "session.event.kind.thinking":
      return "agent";
    case "session.event.kind.toolUse":
    case "session.event.kind.toolResult":
      return "tool";
    case "session.event.kind.permission":
    case "session.event.kind.question":
      return "request";
    case "session.event.kind.error":
      return "error";
    default:
      return "system";
  }
}

// Console v4 `.ev .who`: the agent and its tools blue, what waits on a
// person amber, the rest neutral. A failure stays red (lead decision C6),
// where v4 draws it amber.
const AGENT_TONE =
  "bg-[var(--werft-tone-progress-bg)] text-[var(--werft-tone-progress-fg)]";
const KIND_TONE = {
  agent: AGENT_TONE,
  tool: AGENT_TONE,
  request:
    "bg-[var(--werft-tone-attention-bg)] text-[var(--werft-tone-attention-fg)]",
  error: "bg-[var(--werft-tone-danger-bg)] text-[var(--werft-tone-danger-fg)]",
  system: "bg-active text-muted-foreground",
} as const satisfies Record<TimelineKind, string>;

const KIND_ICON = {
  agent: Sparkles,
  tool: Wrench,
  request: Hourglass,
  error: CircleX,
  system: CircleDot,
} as const satisfies Record<TimelineKind, LucideIcon>;

// Status, system and internal lines: bookkeeping a reader skims past.
const NOISE_LABELS: ReadonlySet<TurnEventMessage["key"]> = new Set([
  "session.event.kind.status",
  "session.event.kind.system",
  "session.event.kind.internal",
]);

const STATE_ALONE = "px-4 py-6 text-center";
const ROW = "relative grid grid-cols-[24px_minmax(0,1fr)] gap-3 border-b";
const TIME = "text-caption font-normal text-subtle-foreground";
const FOCUS =
  "rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export interface TimelineProps {
  readonly entries: readonly TimelineEntry[];
  readonly formatMessage: FormatTurnMessage;
  readonly messages: TimelineMessages;
  /** The event stream: `connecting` and `closed` say so above the list. */
  readonly state?: "connecting" | "open" | "closed" | undefined;
  /** Shows the events presentTurnEvent marks `fold: "debug"`. */
  readonly showDebug?: boolean | undefined;
  /** See `TimelineView`; the focus view folds `debug` events with the work. */
  readonly view?: TimelineView | undefined;
  readonly locale?: TimestampLocale | undefined;
  /** The instant relative times count from; defaults to the clock. */
  readonly now?: number | Date | undefined;
  readonly className?: string | undefined;
  /**
   * Drawn under a request's line, such as its answer form while it waits;
   * null leaves the line as it is, with a question's options listed.
   */
  readonly request?: ((requestId: string) => ReactNode) | undefined;
  /**
   * The tool calls a question or permission request holds back until it is
   * answered: they do not run yet, so they read as waiting, not running.
   */
  readonly held?: ReadonlySet<string> | undefined;
  /**
   * Drawn under a turn's head, before its lines, such as the message the
   * turn was asked; null leaves the turn as it is.
   */
  readonly prompt?: ((turnId: string) => ReactNode) | undefined;
  /** Who the agent's replies are from: with it they are drawn as chat. */
  readonly agentName?: string | undefined;
}

export interface TimelineRow extends TimelineEntry {
  readonly key: string;
  /** The tool result paired with this call, drawn in the same row. */
  readonly result?: TimelineEntry | undefined;
  /**
   * The result and the requests that held this call back, in the order
   * they came, drawn under the call: a permission granted before the call
   * ran reads above its result.
   */
  readonly inner?: readonly TimelineEntry[] | undefined;
}

export type TimelineItem =
  | { readonly fold: false; readonly row: TimelineRow }
  | {
      readonly fold: true;
      readonly key: string;
      readonly rows: readonly TimelineRow[];
    };

export interface TurnGroup {
  readonly key: string;
  readonly turnId: string | null;
  readonly startedAt: string;
  readonly items: readonly TimelineItem[];
}

function withCount(
  summary: readonly TurnEventPart[],
  count: number,
): TurnEventPart[] {
  return summary.map((part) =>
    "key" in part ? { ...part, params: { ...part.params, count } } : part,
  );
}

const innerKey = (row: TimelineRow, inner: TimelineEntry): string =>
  `${row.key}:${inner.id}`;

const isNoise = (row: TimelineEntry): boolean =>
  !row.presentation.error && NOISE_LABELS.has(row.presentation.label.key);

export function timelineRows(
  entries: readonly TimelineEntry[],
  showDebug: boolean,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const calls = new Map<string, number>();
  let ticks = 0;
  for (const entry of entries) {
    const { presentation } = entry;
    if (presentation.fold === "debug" && !showDebug) continue;
    if (presentation.fold === "thinking_tick") {
      const last = rows.at(-1);
      // A run of ticks in one turn reads as one line; it keeps the run's
      // first key so the row does not remount as the count grows.
      ticks = ticks > 0 && last?.turnId === entry.turnId ? ticks + 1 : 1;
      const row = {
        ...entry,
        key: ticks > 1 && last ? last.key : entry.id,
        presentation: {
          ...presentation,
          summary: withCount(presentation.summary, ticks),
        },
      };
      if (ticks > 1) rows[rows.length - 1] = row;
      else rows.push(row);
      continue;
    }
    ticks = 0;
    const callAt =
      entry.toolCallId === undefined ? undefined : calls.get(entry.toolCallId);
    const call = callAt === undefined ? undefined : rows[callAt];
    if (call && callAt !== undefined) {
      const isResult =
        presentation.label.key === "session.event.kind.toolResult" &&
        call.result === undefined;
      if (isResult || timelineKind(presentation) === "request") {
        rows[callAt] = {
          ...call,
          ...(isResult ? { result: entry } : {}),
          inner: [...(call.inner ?? []), entry],
        };
        continue;
      }
    }
    // Nothing to say: a row here would be an empty card.
    if (presentation.summary.length === 0) continue;
    if (
      entry.toolCallId !== undefined &&
      presentation.label.key === "session.event.kind.toolUse"
    ) {
      calls.set(entry.toolCallId, rows.length);
    }
    rows.push({ ...entry, key: entry.id });
  }
  return rows;
}

/**
 * How a group's lines fold: `noise` folds runs of two or more status and
 * system lines, `focus` every run of work (one line included), `none` none.
 */
export type FoldMode = "noise" | "focus" | "none";

export function turnGroups(
  rows: readonly TimelineRow[],
  mode: FoldMode,
  focus: FocusContext = {},
): TurnGroup[] {
  // A line with no turn between two lines of one turn belongs to that turn,
  // so a turn is not split in two around it.
  const nextTurn: (string | null)[] = [];
  let next: string | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    nextTurn[index] = next;
    next = rows[index]?.turnId ?? next;
  }
  const turnOf = rows.map((row) => row.turnId);
  let previous: string | null = null;
  rows.forEach((row, index) => {
    if (row.turnId !== null) previous = row.turnId;
    else if (previous !== null && nextTurn[index] === previous) {
      turnOf[index] = previous;
    }
  });
  // Lines with no turn share a group without a head, so their noise folds too.
  const groups: { key: string; turnId: string | null; rows: TimelineRow[] }[] =
    [];
  rows.forEach((row, index) => {
    const turnId = turnOf[index] ?? null;
    const last = groups.at(-1);
    if (last && last.turnId === turnId) last.rows.push(row);
    else groups.push({ key: row.key, turnId, rows: [row] });
  });
  return groups.map((group) => {
    const items: TimelineItem[] = [];
    let run: TimelineRow[] = [];
    const flush = () => {
      const [first] = run;
      if (first && (run.length > 1 || mode === "focus")) {
        items.push({ fold: true, key: `fold-${first.key}`, rows: run });
      } else if (first) items.push({ fold: false, row: first });
      run = [];
    };
    for (const row of group.rows) {
      if (
        mode === "focus"
          ? focusWork(row, focus) !== null
          : mode === "noise" && isNoise(row)
      ) {
        run.push(row);
        continue;
      }
      flush();
      items.push({ fold: false, row });
    }
    flush();
    return {
      key: group.key,
      turnId: group.turnId,
      startedAt: group.rows[0]?.occurredAt ?? "",
      items,
    };
  });
}

/** The turn's token count, read from its result event's summary. */
function turnTokens(group: TurnGroup): TurnEventMessage | undefined {
  for (const row of group.items.flatMap((item) =>
    item.fold ? item.rows : [item.row],
  )) {
    const { presentation } = row;
    if (presentation.label.key !== "session.event.kind.result") continue;
    for (const part of presentation.summary) {
      if ("key" in part && part.key === "session.event.result.tokens") {
        return part;
      }
    }
  }
  return undefined;
}

interface TimeContext {
  readonly locale: TimestampLocale;
  readonly now: number | Date | undefined;
}

interface StampProps {
  readonly at: string;
  readonly time: TimeContext;
}

/** A relative time a keyboard can reach, its exact time in a tooltip. */
function Stamp({ at, time }: StampProps): JSX.Element {
  return (
    <RelativeTime
      value={at}
      locale={time.locale}
      {...(time.now === undefined ? {} : { now: time.now })}
      className={TIME}
    />
  );
}

/**
 * Where the line above already reads the same: unseen until it takes focus,
 * so keyboard and screen reader users still reach this row's exact time. It
 * sits inside the text it follows and takes no place of its own.
 */
function HiddenStamp({ at, time }: StampProps): JSX.Element {
  return (
    <>
      {" "}
      <RelativeTime
        value={at}
        locale={time.locale}
        {...(time.now === undefined ? {} : { now: time.now })}
        className={cn(TIME, "sr-only focus-visible:not-sr-only")}
      />
    </>
  );
}

/** The 1px line joining the icons above and below; `top` is the icon's. */
function Rail({
  top,
  bottom,
  first,
  last,
}: {
  readonly top: string;
  readonly bottom: string;
  readonly first: boolean;
  readonly last: boolean;
}): JSX.Element | null {
  if (first && last) return null;
  return (
    <>
      {first ? null : (
        <span
          aria-hidden="true"
          className={cn("absolute top-0 left-[11.5px] w-px bg-border", top)}
        />
      )}
      {last ? null : (
        <span
          aria-hidden="true"
          className={cn(
            "absolute bottom-0 left-[11.5px] w-px bg-border",
            bottom,
          )}
        />
      )}
    </>
  );
}

export function Timeline({
  entries,
  formatMessage,
  messages,
  state = "open",
  showDebug = false,
  view,
  locale = "ko",
  now,
  className,
  request,
  held,
  prompt,
  agentName,
}: TimelineProps): JSX.Element {
  const idBase = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const rows = timelineRows(entries, showDebug || view !== undefined);
  const focus: FocusContext = { held, finalStatus: finalStatusKey(rows) };
  const groups = turnGroups(
    rows,
    view === "focus"
      ? "focus"
      : view === "all" || messages.folded === undefined
        ? "none"
        : "noise",
    focus,
  );
  const time: TimeContext = { locale, now };

  // A time that would read the same as the one above it is not repeated,
  // in reading order.
  const shown = new Set<string>();
  let said: string | undefined;
  const see = (key: string, at: string) => {
    const next = formatRelativeTime(at, locale, now);
    if (next !== said) shown.add(key);
    said = next;
  };
  for (const group of groups) {
    // A turn's head always says when it began.
    if (group.turnId !== null) {
      said = formatRelativeTime(group.startedAt, locale, now);
    }
    for (const item of group.items) {
      if (!item.fold) {
        see(item.row.key, item.row.occurredAt);
        for (const inner of item.row.inner ?? []) {
          see(innerKey(item.row, inner), inner.occurredAt);
        }
        continue;
      }
      // Closed, the folded lines are out of sight, so the line after the
      // fold compares with what stood before it.
      const before = said;
      for (const row of item.rows) {
        see(row.key, row.occurredAt);
        for (const inner of row.inner ?? []) {
          see(innerKey(row, inner), inner.occurredAt);
        }
      }
      if (!open.has(item.key)) said = before;
    }
  }

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const renderItems = (items: readonly TimelineItem[]) => {
    // Each line knows whether the rail continues above and below it.
    const lines: {
      key: string;
      draw: (first: boolean, last: boolean) => JSX.Element;
    }[] = [];
    const drawRow = (row: TimelineRow) => ({
      key: row.key,
      draw: (first: boolean, last: boolean) =>
        isNoise(row) ? (
          <NoiseItem
            key={row.key}
            row={row}
            formatMessage={formatMessage}
            messages={messages}
            time={time}
            shown={shown.has(row.key)}
            first={first}
            last={last}
          />
        ) : (
          <EventItem
            key={row.key}
            row={row}
            formatMessage={formatMessage}
            messages={messages}
            time={time}
            shown={shown.has(row.key)}
            innerShown={(inner) => shown.has(innerKey(row, inner))}
            first={first}
            last={last}
            request={request}
            held={held}
            agentName={agentName}
          />
        ),
    });
    for (const item of items) {
      if (!item.fold) {
        lines.push(drawRow(item.row));
        continue;
      }
      const expanded = open.has(item.key);
      lines.push({
        key: item.key,
        draw: (first, last) => (
          <FoldItem
            key={item.key}
            rows={item.rows}
            work={
              view === "focus" && messages.work
                ? messages.work(workCounts(item.rows, focus))
                : undefined
            }
            running={
              view === "focus" &&
              item.rows.some(
                (row) =>
                  row.toolCallId !== undefined &&
                  row.result === undefined &&
                  row.presentation.label.key === "session.event.kind.toolUse" &&
                  !held?.has(row.toolCallId),
              )
            }
            expanded={expanded}
            onToggle={() => toggle(item.key)}
            formatMessage={formatMessage}
            messages={messages}
            first={first}
            last={last}
          />
        ),
      });
      if (!expanded) continue;
      for (const row of item.rows) lines.push(drawRow(row));
    }
    return lines.map((line, index) =>
      line.draw(index === 0, index === lines.length - 1),
    );
  };

  return (
    <div data-slot="timeline" className={cn("flex flex-col", className)}>
      {/* One layer inside the screen's card: alone, the line stands where
          the list would (console v4 `.empty.sm`); above rows, it is the
          first line of the list. */}
      {state === "open" ? null : (
        <output
          className={cn(
            "text-control text-muted-foreground",
            rows.length === 0 ? STATE_ALONE : "border-b py-3",
          )}
        >
          {state === "connecting" ? messages.connecting : messages.closed}
        </output>
      )}
      {rows.length === 0 ? (
        state === "open" ? (
          <p
            className={cn(
              "m-0 text-control text-muted-foreground",
              STATE_ALONE,
            )}
          >
            {messages.empty}
          </p>
        ) : null
      ) : (
        <ol aria-label={messages.label} className="flex flex-col">
          {groups.map((group, index) => {
            if (group.turnId === null) return renderItems(group.items);
            const headId = `${idBase}-turn-${index}`;
            const tokens = turnTokens(group);
            const asked = prompt?.(group.turnId);
            return (
              // biome-ignore lint/a11y/useSemanticElements: every <li> in the list stays one event, which the session screen's tests count
              <div
                key={group.key}
                role="listitem"
                data-slot="timeline-turn"
                className="border-b last:border-b-0"
              >
                <div
                  id={headId}
                  className="flex flex-wrap items-center gap-x-2 pt-4 text-caption"
                >
                  <span className="font-medium">
                    {messages.turn(group.turnId)}
                  </span>
                  <Stamp at={group.startedAt} time={time} />
                  {tokens ? (
                    <span className="text-subtle-foreground">
                      {formatMessage(tokens)}
                    </span>
                  ) : null}
                </div>
                {asked == null ? null : (
                  <div className="flex flex-col pt-3">{asked}</div>
                )}
                <ol aria-labelledby={headId} className="flex flex-col">
                  {renderItems(group.items)}
                </ol>
              </div>
            );
          })}
        </ol>
      )}
    </div>
  );
}

interface LineProps {
  readonly formatMessage: FormatTurnMessage;
  readonly messages: TimelineMessages;
  readonly first: boolean;
  readonly last: boolean;
}

function KindIcon({
  kind,
  messages,
  small = false,
  running = false,
}: {
  readonly kind: TimelineKind;
  readonly messages: TimelineMessages;
  readonly small?: boolean;
  /** A tool call still running: its ring turns, unless motion is reduced. */
  readonly running?: boolean;
}): JSX.Element {
  const kindName = messages.kind?.(kind);
  const Icon = running ? LoaderCircle : KIND_ICON[kind];
  return (
    <span
      {...(kindName
        ? { role: "img", "aria-label": kindName }
        : { "aria-hidden": true })}
      className={cn(
        "relative flex items-center justify-center rounded-full",
        small ? "size-4 justify-self-center" : "size-6",
        KIND_TONE[kind],
      )}
    >
      <Icon
        size={small ? 10 : 14}
        strokeWidth={1.5}
        aria-hidden="true"
        className={
          running ? "animate-spin motion-reduce:animate-none" : undefined
        }
      />
    </span>
  );
}

const NOISE_LINE = "min-w-0 text-caption leading-4 text-muted-foreground";
const DETAIL =
  "mt-1 whitespace-pre-wrap rounded-control border bg-muted px-3 py-2 font-mono text-caption leading-[1.6] [overflow-wrap:anywhere]";

function Summary({
  entry,
  formatMessage,
  stamp,
  messages,
}: {
  readonly entry: TimelineEntry;
  readonly formatMessage: FormatTurnMessage;
  /** Its own time, for a result drawn in its call's row. */
  readonly stamp?: JSX.Element | undefined;
  readonly messages?: TimelineMessages | undefined;
}): JSX.Element {
  const { presentation } = entry;
  // A reply is the agent's words for the reader: whole, as Markdown.
  if (presentation.reply !== undefined) {
    return (
      <Markdown
        text={presentation.reply}
        fold={
          messages?.more && messages.less
            ? { more: messages.more, less: messages.less }
            : undefined
        }
        tableLabel={messages?.table}
        newTabLabel={messages?.newTab}
        className={cn(presentation.error && "text-destructive")}
      />
    );
  }
  const summary = turnSummaryText(presentation.summary, formatMessage);
  const summaryClass = cn(
    "min-w-0 text-control leading-[1.5] [overflow-wrap:anywhere]",
    presentation.error && "text-destructive",
  );
  if (!presentation.detail) {
    return (
      <span className={summaryClass}>
        {summary}
        {stamp}
      </span>
    );
  }
  return (
    <details className="min-w-0">
      <summary className={cn(summaryClass, "cursor-pointer")}>
        {summary}
        {stamp}
      </summary>
      <p className={DETAIL}>{presentation.detail}</p>
    </details>
  );
}

function EventItem({
  row,
  formatMessage,
  messages,
  time,
  shown,
  innerShown,
  first,
  last,
  request,
  held,
  agentName,
}: LineProps & {
  readonly row: TimelineRow;
  readonly time: TimeContext;
  readonly shown: boolean;
  readonly innerShown: (inner: TimelineEntry) => boolean;
  readonly request: TimelineProps["request"];
  readonly held: TimelineProps["held"];
  readonly agentName: string | undefined;
}): JSX.Element {
  const { presentation, result } = row;
  if (
    agentName !== undefined &&
    presentation.reply !== undefined &&
    presentation.error !== true &&
    timelineKind(presentation) === "agent"
  ) {
    // The agent's words as chat: its icon and name over a bubble.
    return (
      <li
        data-kind="agent"
        className="flex items-start gap-3 border-b py-3 last:border-b-0"
      >
        <span
          role="img"
          aria-label={messages.kind?.("agent") ?? agentName}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <Bot size={16} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-control">
            <span className="font-medium">{agentName}</span>
            <Stamp at={row.occurredAt} time={time} />
          </div>
          <div className="min-w-0 rounded-card bg-muted px-3 py-2">
            <Summary
              entry={row}
              formatMessage={formatMessage}
              messages={messages}
            />
          </div>
        </div>
      </li>
    );
  }
  const callText = turnSummaryText(presentation.summary, formatMessage);
  const innerStamp = (inner: TimelineEntry) =>
    innerShown(inner) ? (
      <>
        {" "}
        <Stamp at={inner.occurredAt} time={time} />
      </>
    ) : (
      <HiddenStamp at={inner.occurredAt} time={time} />
    );
  const error =
    presentation.error === true || result?.presentation.error === true;
  const kind = error ? "error" : timelineKind(presentation);
  const open =
    row.toolCallId !== undefined &&
    result === undefined &&
    presentation.label.key === "session.event.kind.toolUse";
  const running = open && !held?.has(row.toolCallId as string);
  const progress = !open
    ? undefined
    : running
      ? { text: messages.running, tone: "text-[var(--werft-tone-progress-fg)]" }
      : {
          text: messages.waiting,
          tone: "text-[var(--werft-tone-attention-fg)]",
        };
  return (
    <li
      data-error={error || undefined}
      data-kind={kind}
      className={cn(ROW, "py-3 last:border-b-0")}
    >
      <Rail top="h-3" bottom="top-9" first={first} last={last} />
      <KindIcon kind={kind} messages={messages} running={running && !error} />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-control font-medium">
          <span>
            {formatMessage(presentation.label)}
            {shown ? null : <HiddenStamp at={row.occurredAt} time={time} />}
          </span>
          {shown ? <Stamp at={row.occurredAt} time={time} /> : null}
          {progress?.text ? (
            <span className={cn("text-caption font-normal", progress.tone)}>
              {progress.text}
            </span>
          ) : null}
        </div>
        <Summary
          entry={row}
          formatMessage={formatMessage}
          messages={messages}
        />
        {(row.inner ?? []).map((inner) => {
          const stamp = innerStamp(inner);
          return timelineKind(inner.presentation) === "request" ? (
            <InnerRequest
              key={inner.id}
              entry={inner}
              callText={callText}
              stamp={stamp}
              formatMessage={formatMessage}
              messages={messages}
              request={request}
            />
          ) : (
            <Summary
              key={inner.id}
              entry={inner}
              formatMessage={formatMessage}
              stamp={stamp}
            />
          );
        })}
        <RequestBody entry={row} messages={messages} request={request} />
      </div>
    </li>
  );
}

/**
 * A request inside the call it held back: its name and time between the
 * call and its result, and its answer form while it waits.
 */
function InnerRequest({
  entry,
  callText,
  stamp,
  formatMessage,
  messages,
  request,
}: {
  readonly entry: TimelineEntry;
  /** The call's own line: a request that only repeats it says nothing new. */
  readonly callText: string;
  readonly stamp: JSX.Element;
  readonly formatMessage: FormatTurnMessage;
  readonly messages: TimelineMessages;
  readonly request: TimelineProps["request"];
}): JSX.Element {
  const { presentation } = entry;
  const summary = turnSummaryText(presentation.summary, formatMessage);
  return (
    <div data-slot="timeline-request" className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-control font-medium">
        <KindIcon kind="request" messages={messages} small={true} />
        <span className="min-w-0">
          {formatMessage(presentation.label)}
          {stamp}
        </span>
      </div>
      {summary.length === 0 || summary === callText ? null : (
        <Summary entry={entry} formatMessage={formatMessage} />
      )}
      <RequestBody entry={entry} messages={messages} request={request} />
    </div>
  );
}

/** A request's answer form, or a question's options when there is none. */
function RequestBody({
  entry,
  messages,
  request,
}: {
  readonly entry: TimelineEntry;
  readonly messages: TimelineMessages;
  readonly request: TimelineProps["request"];
}): ReactNode {
  const slot =
    entry.requestId === undefined ? null : (request?.(entry.requestId) ?? null);
  const options = entry.options ?? [];
  return (
    slot ??
    (options.length === 0 ? null : (
      <ul
        aria-label={messages.options}
        className="m-0 flex list-none flex-wrap gap-1.5 p-0"
      >
        {options.map((option, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat; the position tells them apart
          <li key={index} className="max-w-full">
            {/* A long option wraps inside the badge, never past the row. */}
            <Badge className="h-auto min-h-5 max-w-full whitespace-normal [overflow-wrap:anywhere]">
              {option}
            </Badge>
          </li>
        ))}
      </ul>
    ))
  );
}

function NoiseItem({
  row,
  formatMessage,
  messages,
  time,
  shown,
  first,
  last,
}: LineProps & {
  readonly row: TimelineRow;
  readonly time: TimeContext;
  readonly shown: boolean;
}): JSX.Element {
  const { presentation } = row;
  const line = (
    <>
      <span className="font-medium">{formatMessage(presentation.label)}</span>{" "}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {turnSummaryText(presentation.summary, formatMessage)}
        {shown ? null : <HiddenStamp at={row.occurredAt} time={time} />}
      </span>
      {shown ? (
        <>
          {" "}
          <Stamp at={row.occurredAt} time={time} />
        </>
      ) : null}
    </>
  );
  return (
    <li
      data-kind="system"
      data-noise="true"
      className={cn(ROW, "py-2 last:border-b-0")}
    >
      <Rail top="h-2" bottom="top-6" first={first} last={last} />
      <KindIcon kind="system" messages={messages} small={true} />
      {presentation.detail ? (
        <details className="min-w-0">
          <summary className={cn(NOISE_LINE, "cursor-pointer")}>{line}</summary>
          <p className={DETAIL}>{presentation.detail}</p>
        </details>
      ) : (
        <div className={cn(NOISE_LINE, "flex flex-wrap items-center gap-x-2")}>
          {line}
        </div>
      )}
    </li>
  );
}

function FoldItem({
  rows,
  work,
  running,
  expanded,
  onToggle,
  formatMessage,
  messages,
  first,
  last,
}: LineProps & {
  readonly rows: readonly TimelineRow[];
  /** The focus view's count of what the run did, in place of the labels. */
  readonly work?: string | undefined;
  /** A call in the run is still running. */
  readonly running?: boolean | undefined;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const labels = [
    ...new Set(rows.map((row) => formatMessage(row.presentation.label))),
  ];
  return (
    <li data-slot="timeline-fold" className={cn(ROW, "py-2 last:border-b-0")}>
      <Rail top="h-2" bottom="top-6" first={first} last={last} />
      <span
        aria-hidden="true"
        className={cn(
          "relative flex size-4 items-center justify-center justify-self-center rounded-full",
          KIND_TONE.system,
        )}
      >
        <ChevronRight
          size={10}
          strokeWidth={1.5}
          className={expanded ? "rotate-90" : undefined}
        />
      </span>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "min-w-0 cursor-pointer justify-self-start text-left text-caption leading-4 text-muted-foreground hover:text-foreground",
          FOCUS,
        )}
      >
        {work === undefined ? (
          <>
            <span className="font-medium">
              {messages.folded?.(rows.length)}
            </span>
            {` · ${labels.join(", ")}`}
          </>
        ) : (
          <span className="font-medium">{work}</span>
        )}
        {running && messages.running ? (
          <span className="text-[var(--werft-tone-progress-fg)]">
            {` · ${messages.running}`}
          </span>
        ) : null}
      </button>
    </li>
  );
}
