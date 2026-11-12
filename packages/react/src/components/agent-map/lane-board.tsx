import { Badge, Button, RelativeTime, RowAction, Skeleton } from "@werft-ai/ui";
import { Bot, ShieldQuestion } from "lucide-react";
import { type JSX, useId, useRef } from "react";

import { useWerft } from "../../provider.tsx";
import { StatusLabel } from "../status/status-label.tsx";
import { FRESH_CLASS, useArrival } from "./fresh.ts";
import type { AgentMapMessages } from "./messages.ts";
import type { Lane, MapSession } from "./types.ts";
import { useAgentMapMessages } from "./use-messages.ts";

const LANES = ["attention", "running", "queued", "idle"] as const;

/** Where a session sits: its pinned lane until the reader tidies up. */
export function laneOf(session: MapSession): Lane {
  if (session.pinnedLane) return session.pinnedLane;
  if (
    session.status === "needs_input" ||
    session.status === "failed" ||
    session.needsRecovery
  )
    return "attention";
  if (session.status === "running") return "running";
  if (session.status === "queued") return "queued";
  if (session.status === "idle") return "idle";
  return "done";
}

export interface MapSessionCardProps {
  readonly session: MapSession;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly now?: number | undefined;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

/** A session on the board, pressed while its relations are open. */
export function MapSessionCard({
  session,
  selected,
  onSelect,
  now,
  messages: override,
}: MapSessionCardProps): JSX.Element {
  const messages = useAgentMapMessages(override);
  const { locale } = useWerft();
  const ref = useRef<HTMLButtonElement>(null);
  useArrival(ref, session.fresh);
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      data-fresh={session.fresh ? "" : undefined}
      className={`flex w-full flex-col gap-2 rounded-(--radius-card) border bg-card p-3 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none ${FRESH_CLASS} ${
        selected
          ? "border-(color:--color-focus-ring) ring-1 ring-(color:--color-focus-ring)"
          : ""
      }`}
    >
      <span className="flex items-center gap-2">
        <StatusLabel
          axis="session"
          state={session.status}
          label={messages.status(session.status)}
          appearance="dot"
        />
        <span className="ml-auto text-caption text-muted-foreground">
          <RelativeTime
            value={session.lastEventAt}
            locale={locale}
            {...(now === undefined ? {} : { now })}
          />
        </span>
      </span>
      <span className="min-w-0 truncate font-semibold">{session.title}</span>
      <span className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
        <Bot aria-hidden="true" className="size-3 flex-none" />
        <span className="truncate">{session.agent}</span>
        {session.subagentCount > 0 ? (
          <span className="flex-none">
            {messages.subagents(session.subagentCount)}
          </span>
        ) : null}
      </span>
      <span className="line-clamp-1 text-caption text-muted-foreground">
        {session.note}
      </span>
      <span className="flex flex-wrap items-center gap-2 text-caption">
        <span className="text-muted-foreground tabular-nums">
          {messages.tools(session.toolCount)}
        </span>
        {session.errorCount > 0 ? (
          <Badge variant="red">{messages.errors(session.errorCount)}</Badge>
        ) : null}
        {session.pending ? (
          <Badge variant="amber">
            {session.pending.kind === "question"
              ? messages.questions(1)
              : session.pending.kind === "request"
                ? messages.requests(1)
                : messages.approvals(1)}
          </Badge>
        ) : null}
        {session.pinnedLane ? (
          <Badge variant="gray">{messages.pinned}</Badge>
        ) : null}
      </span>
    </button>
  );
}

// Shared with the strip's stand-in, which must come out the same height.
const STRIP =
  "flex flex-col gap-1 rounded-(--radius-card) border border-(color:--werft-tone-attention-border) bg-(color:--werft-tone-attention-bg) p-2";
const STRIP_TITLE =
  "m-0 px-1 font-semibold text-(color:--werft-tone-attention-fg) text-control";
const STRIP_LIST = "m-0 flex list-none flex-col gap-1 p-0";
const STRIP_ITEM =
  "flex items-center gap-2 rounded-(--radius-control) bg-card px-2 py-2";
// With height 1lh, a block skeleton one line of its text style tall; a block
// bar's 4rem floor would spill over it.
const LINE = "min-w-0 [&>span]:min-h-0";

/** The strip's place while the list loads, as tall as `rows` requests make it. */
export function ApprovalStripStandIn({
  rows,
}: {
  readonly rows: number;
}): JSX.Element | null {
  if (rows === 0) return null;
  return (
    <div aria-hidden="true" data-stand-in="strip" className={STRIP}>
      <Skeleton
        shape="block"
        height="1lh"
        width="45%"
        label=""
        className={`${STRIP_TITLE} ${LINE}`}
      />
      <div className={STRIP_LIST}>
        {Array.from({ length: rows }, (_, row) => `row-${row}`).map((key) => (
          <div key={key} className={STRIP_ITEM}>
            <span className="size-4 flex-none" />
            <span className="flex min-w-0 flex-1 flex-col">
              <Skeleton
                shape="block"
                height="1lh"
                width="60%"
                label=""
                className={`text-control ${LINE}`}
              />
              <Skeleton
                shape="block"
                height="1lh"
                width="80%"
                label=""
                className={`text-caption ${LINE}`}
              />
            </span>
            <span className="h-(--werft-control-height-sm) w-12 flex-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

export interface ApprovalStripProps {
  readonly sessions: readonly MapSession[];
  readonly onSelect: (id: string) => void;
  /** More requests wait than the sessions read hold. */
  readonly more?: boolean | undefined;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

/** Every open request a person has to answer, the longest wait first. */
export function ApprovalStrip({
  sessions,
  onSelect,
  more = false,
  messages: override,
}: ApprovalStripProps): JSX.Element | null {
  const messages = useAgentMapMessages(override);
  const waiting = sessions
    .filter((s) => s.pending)
    .sort(
      (a, b) =>
        (b.pending?.waitedMinutes ?? 0) - (a.pending?.waitedMinutes ?? 0),
    );
  if (waiting.length === 0) return null;
  return (
    <section aria-label={messages.waitingLabel} className={STRIP}>
      <h2 className={STRIP_TITLE}>
        {messages.waitingTitle(
          more ? `${waiting.length}+` : waiting.length,
          waiting[0]?.pending?.waitedMinutes ?? 0,
        )}
      </h2>
      <ul className={STRIP_LIST}>
        {waiting.map((s) => (
          <ApprovalStripItem
            key={s.id}
            session={s}
            onSelect={onSelect}
            messages={messages}
          />
        ))}
      </ul>
    </section>
  );
}

function ApprovalStripItem({
  session,
  onSelect,
  messages,
}: {
  readonly session: MapSession;
  readonly onSelect: (id: string) => void;
  readonly messages: AgentMapMessages;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const id = useId();
  useArrival(ref, session.fresh);
  return (
    <li
      ref={ref}
      data-fresh={session.fresh ? "" : undefined}
      className={`${STRIP_ITEM} ${FRESH_CLASS}`}
    >
      <ShieldQuestion
        aria-hidden="true"
        className="size-4 flex-none text-(color:--werft-tone-attention-fg)"
      />
      <span id={`${id}-what`} className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-control">{session.pending?.tool}</span>
        <span className="truncate text-caption text-muted-foreground">
          {messages.waitingLine(
            session.agent,
            session.title,
            session.pending?.waitedMinutes ?? 0,
          )}
        </span>
      </span>
      <RowAction
        id={`${id}-open`}
        aria-labelledby={`${id}-open ${id}-what`}
        onClick={() => onSelect(session.id)}
      >
        {messages.open}
      </RowAction>
    </li>
  );
}

export interface LaneBoardProps {
  readonly sessions: readonly MapSession[];
  /** Sessions that ended recently, folded under one count. */
  readonly doneCount: number;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onExpandDone?: (() => void) | undefined;
  /** More requests wait than `sessions` hold; the strip counts with a plus. */
  readonly waitingMore?: boolean | undefined;
  readonly now?: number | undefined;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

/**
 * Status lanes stacked top to bottom in the order a person acts on them,
 * under the strip of open requests.
 */
export function LaneBoard({
  sessions,
  doneCount,
  selectedId,
  onSelect,
  onExpandDone,
  waitingMore,
  now,
  messages: override,
}: LaneBoardProps): JSX.Element {
  const messages = useAgentMapMessages(override);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ApprovalStrip
        sessions={sessions}
        onSelect={onSelect}
        more={waitingMore}
        messages={messages}
      />
      {LANES.map((lane) => {
        const rows = sessions.filter((s) => laneOf(s) === lane);
        const label = messages.lane(lane);
        return (
          <section
            key={lane}
            aria-label={label}
            className="flex flex-col gap-2"
          >
            <h2 className="m-0 flex items-center gap-2 text-control font-semibold">
              {label}
              <span className="font-normal text-muted-foreground tabular-nums">
                {rows.length}
              </span>
            </h2>
            {rows.length === 0 ? (
              <p className="m-0 text-caption text-subtle-foreground">
                {messages.emptyLane}
              </p>
            ) : (
              <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0">
                {rows.map((s) => (
                  <li key={s.id}>
                    <MapSessionCard
                      session={s}
                      selected={selectedId === s.id}
                      onSelect={() => onSelect(s.id)}
                      now={now}
                      messages={messages}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <section aria-label={messages.done} className="flex flex-col gap-2">
        <h2 className="m-0 flex items-center gap-2 text-control font-semibold">
          {messages.done}
          <span className="font-normal text-muted-foreground tabular-nums">
            {doneCount}
          </span>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={onExpandDone}
        >
          {messages.expandDone}
        </Button>
      </section>
    </div>
  );
}
