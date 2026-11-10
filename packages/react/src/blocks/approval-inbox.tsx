import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PendingRequest,
  SessionRelation,
  SessionSummary,
} from "@werft-ai/contracts";
import {
  pendingRequestsQuery,
  waitingSessionsByQuery,
  waitingSessionsQuery,
} from "@werft-ai/core";
import { Badge, cn, RowAction, Skeleton } from "@werft-ai/ui";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AgentMark } from "../components/agent-mark.tsx";
import { useMinute } from "../components/session/use-minute.ts";
import { useWerft } from "../provider.tsx";
import type { PendingRail } from "./pending-rail.tsx";
import {
  type ApprovalLayout,
  focusLost,
  PendingAnswers,
  type SessionActionProps,
} from "./session-actions.tsx";
import { useBlockText } from "./text.ts";

export interface ApprovalInboxProps extends SessionActionProps {
  /** Shown until the waiting sessions arrive, in place of the block's rows. */
  readonly loading?: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
  /**
   * "row" draws each permission request as one line instead of a card;
   * "summary" draws each request as a line under its session's name, in one
   * framed list.
   */
  readonly layout?: ApprovalLayout | undefined;
  /** The heading's words, in place of the block's own. */
  readonly title?: ReactNode;
  /** Drawn at the heading's end, such as a link to every waiting session. */
  readonly action?: ReactNode;
  /** Shown when nothing waits, in place of the block's one line. */
  readonly empty?: ReactNode;
  /** The time the summary layout's waits are counted to. */
  readonly now?: number | undefined;
  /** At most this many sessions are drawn; the rest are left to `more`. */
  readonly limit?: number | undefined;
  /**
   * The list's last line when sessions are left out, by `limit` or past the
   * first page: `count` is how many, with "+" when the page has more.
   */
  readonly more?: ((count: string) => ReactNode) | undefined;
  /**
   * Summary layout only: each line opens its session in the host's rail
   * (`usePendingRail`), its timeline and its answers, instead of answering
   * on the line.
   */
  readonly rail?: Pick<PendingRail, "open" | "openedId"> | undefined;
}

// Framed like the list it stands in for, one placeholder per line at a
// line's least height.
function InboxSkeleton({
  rows,
  label,
}: {
  readonly rows: number;
  readonly label?: string;
}) {
  return (
    <div
      data-slot="inbox-skeleton"
      className="flex flex-col divide-y rounded-card border bg-card"
    >
      {Array.from({ length: rows }, (_, index) => index).map((index) => (
        <div
          // Placeholder rows have no identity beyond their position.
          key={index}
          className="flex min-h-[var(--werft-row-min-height)] flex-col justify-center gap-1.5 px-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)]"
        >
          <Skeleton
            width="40%"
            {...(index === 0 && label !== undefined
              ? { label }
              : { decorative: true })}
          />
          <Skeleton width="25%" decorative />
        </div>
      ))}
    </div>
  );
}

// Why a request came to the reader, the first that holds in the design's order.
const REASONS = [
  "started",
  "shared",
  "administered",
] as const satisfies readonly SessionRelation[];
type Reason = (typeof REASONS)[number];

const FRAME = "rounded-card border bg-card";
const FRAME_PADDING =
  "px-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)]";

/**
 * The reader's sessions waiting on an answer, each request answerable here.
 * It reads the same first page as the shell's badge, so the two counts agree.
 */
export function ApprovalInbox({
  loading,
  renderError,
  unavailable,
  refusal,
  layout,
  title,
  action,
  empty,
  now: givenNow,
  limit,
  more: moreLine,
  rail,
}: ApprovalInboxProps) {
  const { t } = useBlockText();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const titleId = useId();
  const waiting = useQuery(waitingSessionsQuery(client));
  const now = useMinute(layout === "summary" && givenNow === undefined);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const drawnBefore = useRef<readonly string[]>([]);
  const [sent, setSent] = useState(0);

  const sessions = waiting.data?.items ?? [];
  // The same reads each line makes, so the block knows which sessions still
  // hold a request before it draws or counts them.
  const lists = useQueries({
    queries: sessions.map((session) =>
      pendingRequestsQuery(client, session.id),
    ),
  });
  // A session listed as waiting whose own list came back empty was answered
  // or lapsed since the waiting list was read: it is left out, and the
  // waiting list read again so the count and the shell's badge catch up.
  const shown = sessions.filter(
    (_, index) => lists[index]?.data?.items.length !== 0,
  );
  // Past `limit` a session is not drawn: it leaves the list as an answered
  // one does.
  const drawn = limit === undefined ? shown : shown.slice(0, limit);
  // Rail lines are one per request, and one can leave while its session
  // stays; answer forms move focus within their session themselves.
  const railLines = rail !== undefined && layout === "summary";
  // Read only once a line is drawn, so a reader with nothing waiting pays
  // for none of them.
  const lineDrawn = lists.some((list) => (list.data?.items.length ?? 0) > 0);
  const related = useQueries({
    queries: REASONS.map((relation) => ({
      ...waitingSessionsByQuery(client, relation),
      enabled: railLines && lineDrawn,
    })),
  });
  // The waiting list is read again after an answer or a status change; the
  // relation lists follow it, so a session that just arrived has its reason.
  const waitedAt = waiting.dataUpdatedAt;
  useEffect(() => {
    if (waitedAt === 0) return;
    for (const relation of REASONS) {
      void queryClient.invalidateQueries({
        ...waitingSessionsByQuery(client, relation),
        exact: true,
      });
    }
  }, [waitedAt, queryClient, client]);
  const reasonOf = (id: string) =>
    REASONS.find((_, index) =>
      related[index]?.data?.items.some((session) => session.id === id),
    );
  const lineKey = drawn
    .flatMap((session) => {
      const items = railLines
        ? lists[sessions.indexOf(session)]?.data?.items
        : undefined;
      return items?.map((request) => request.request_id) ?? [session.id];
    })
    .join();
  const emptyKey = sessions
    .filter((_, index) => lists[index]?.data?.items.length === 0)
    .map((session) => session.id)
    .join();
  useEffect(() => {
    if (emptyKey === "") return;
    void queryClient.invalidateQueries({
      ...waitingSessionsQuery(client),
      exact: true,
    });
  }, [emptyKey, queryClient, client]);

  // A session answered from here leaves the list with the focus it held;
  // the keyboard goes back to the inbox's heading. One answered in the open
  // rail keeps it there: only focus last held in the list is given back.
  // A removed element fires no blur, so the flag outlives its line.
  const focusInList = useRef(false);
  const railOpen = rail?.openedId != null;
  useLayoutEffect(() => {
    const ids = lineKey === "" ? [] : lineKey.split(",");
    const left = drawnBefore.current.some((id) => !ids.includes(id));
    drawnBefore.current = ids;
    if (
      left &&
      (!railOpen || focusInList.current) &&
      focusLost(titleRef.current)
    ) {
      titleRef.current?.focus();
    }
  }, [lineKey, railOpen]);

  let body: ReactNode;
  let count: ReactNode = null;
  if (waiting.data === undefined) {
    body = waiting.isPending
      ? (loading ?? <InboxSkeleton rows={2} label={t("inbox.loading")} />)
      : // The host's error state carries its own frame.
        renderError(waiting.error, () => void waiting.refetch());
  } else {
    const more = waiting.data.next_cursor !== null;
    const left = shown.length - drawn.length;
    if (shown.length > 0) {
      count = (
        <Badge variant="amber">
          <span aria-hidden="true">
            {shown.length}
            {more ? "+" : ""}
          </span>
          <span className="sr-only">
            {t(more ? "inbox.countMore" : "inbox.count", {
              count: shown.length,
            })}
          </span>
        </Badge>
      );
    }
    body =
      shown.length === 0 ? (
        (empty ?? (
          <p
            className={cn(
              "m-0 text-muted-foreground text-body",
              FRAME,
              FRAME_PADDING,
            )}
          >
            {t("inbox.empty")}
          </p>
        ))
      ) : (
        <ul
          className={cn(
            "m-0 flex list-none flex-col p-0",
            layout === "summary"
              ? cn("divide-y", FRAME)
              : "gap-[var(--werft-space-block)]",
          )}
          onFocus={() => {
            focusInList.current = true;
          }}
          onBlur={(event) => {
            // Null when focus falls to the page, as when its line is removed.
            const next = event.relatedTarget;
            if (next !== null && !event.currentTarget.contains(next)) {
              focusInList.current = false;
            }
          }}
        >
          {drawn.map((session) => (
            <WaitingSession
              key={session.id}
              session={session}
              unavailable={unavailable}
              refusal={refusal}
              renderError={renderError}
              layout={layout}
              now={givenNow ?? now}
              onAnswered={() => setSent((count) => count + 1)}
              opened={rail?.openedId === session.id}
              reason={railLines ? reasonOf(session.id) : undefined}
              onOpen={
                rail && layout === "summary"
                  ? (opener) => rail.open(session, opener, titleRef.current)
                  : undefined
              }
            />
          ))}
          {left > 0 && moreLine !== undefined ? (
            <li
              className={cn(
                "text-control",
                layout === "summary" ? FRAME_PADDING : null,
              )}
            >
              {moreLine(`${left}${more ? "+" : ""}`)}
            </li>
          ) : null}
        </ul>
      );
  }
  return (
    <section
      className="flex min-w-0 flex-col gap-[var(--werft-space-block)]"
      aria-labelledby={titleId}
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            className="m-0 font-semibold text-body"
          >
            {title ?? t("inbox.title")}
          </h2>
          {count}
          {/* On the heading's line, not the answered one: that line leaves
              with the read that follows. Always mounted so a screen reader
              hears it; in the line, so nothing below moves. */}
          <output className="min-w-0 truncate text-caption text-muted-foreground">
            {/* A fresh node each time, so every answer is announced. */}
            {sent ? <span key={sent}>{t("session.answer.sent")}</span> : null}
          </output>
        </div>
        {action}
      </div>
      {body}
    </section>
  );
}

function WaitingSession({
  session,
  unavailable,
  refusal,
  renderError,
  layout,
  now,
  onAnswered,
  opened,
  reason,
  onOpen,
}: SessionActionProps & {
  readonly session: SessionSummary;
  readonly renderError: ApprovalInboxProps["renderError"];
  readonly layout: ApprovalInboxProps["layout"];
  readonly now: number;
  readonly onAnswered: () => void;
  /** Whether the rail shows this session. */
  readonly opened: boolean;
  /** Why the session came to the reader, when a relation list names it. */
  readonly reason?: Reason | undefined;
  /** Given, each line opens the rail instead of answering. */
  readonly onOpen?: ((opener: HTMLElement) => void) | undefined;
}) {
  const { t } = useBlockText();
  const { renderLink, client } = useWerft();
  const queryClient = useQueryClient();
  const pending = useQuery(pendingRequestsQuery(client, session.id));
  const link = renderLink({
    to: "session",
    id: session.id,
    className: "font-mono text-link underline underline-offset-2",
    "aria-label": `${t("inbox.open")} ${session.id}`,
    children: <code>{session.id.slice(0, 8)}…</code>,
  });
  const short = session.id.slice(0, 8);
  const summary = layout === "summary";
  const heading = summary
    ? renderLink({
        to: "session",
        id: session.id,
        className: "text-foreground hover:underline focus-visible:underline",
        "aria-label": `${t("inbox.open")} ${session.title ?? session.id}`,
        children: session.title ?? short,
      })
    : undefined;
  const meta = (request: PendingRequest) => {
    const waited = t("inbox.waited", {
      minutes: Math.max(
        0,
        Math.floor((now - Date.parse(request.created_at)) / 60_000),
      ),
    });
    // Untitled, the name line already is the short id. A rail line follows
    // the design: why it came to the reader in place of the id.
    const parts = [
      session.agent?.name,
      onOpen
        ? reason && t("inbox.why", { reason: t(`inbox.why.${reason}`) })
        : session.title
          ? short
          : undefined,
      waited,
    ].filter((part) => part !== undefined);
    return (
      <>
        {parts.map((part, index) => (
          // A long agent name or reason wraps; the id and the wait stay whole.
          <span
            key={part}
            className={
              part === short || part === waited
                ? "whitespace-nowrap"
                : undefined
            }
          >
            {index === 0 ? null : <span aria-hidden="true"> · </span>}
            {part}
          </span>
        ))}
      </>
    );
  };
  // The inbox leaves out a session whose list came back empty.
  if (pending.data?.items.length === 0) return null;
  return (
    <li className={cn("flex min-w-0 flex-col", summary ? null : "gap-2")}>
      {pending.data && onOpen ? (
        <ul className="m-0 flex list-none flex-col divide-y p-0">
          {pending.data.items.map((request) => (
            <li key={request.request_id}>
              <PanelLine
                session={session}
                request={request}
                heading={heading}
                meta={meta(request)}
                name={session.title ?? short}
                opened={opened}
                onOpen={onOpen}
              />
            </li>
          ))}
        </ul>
      ) : pending.data ? (
        <PendingAnswers
          sessionId={session.id}
          items={pending.data.items}
          answerable={pending.data.answerable}
          subject={link}
          layout={layout}
          heading={heading}
          meta={summary ? meta : undefined}
          announceSent={false}
          unavailable={unavailable}
          refusal={refusal}
          // No event stream is open here; the badge and this list learn the
          // session moved on from the next read.
          onAnswered={() => {
            onAnswered();
            void queryClient.invalidateQueries({
              ...waitingSessionsQuery(client),
              exact: true,
            });
          }}
        />
      ) : pending.error ? (
        <div
          className={cn(
            summary &&
              "px-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)]",
          )}
        >
          {renderError(pending.error, () => void pending.refetch())}
        </div>
      ) : (
        <div
          data-slot="inbox-row-skeleton"
          className={cn(
            "flex min-h-[var(--werft-row-min-height)] flex-col justify-center gap-1.5",
            summary
              ? "px-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)]"
              : cn(FRAME, FRAME_PADDING),
          )}
        >
          <Skeleton width="40%" decorative />
          <Skeleton width="25%" decorative />
        </div>
      )}
    </li>
  );
}

/**
 * A waiting request as one list line whose one action opens the rail, where
 * what it asks and until when are shown.
 */
function PanelLine({
  request,
  heading,
  meta,
  name,
  opened,
  onOpen,
}: {
  readonly session: SessionSummary;
  readonly request: PendingRequest;
  readonly heading: ReactNode;
  readonly meta: ReactNode;
  /** The session as the button's accessible name says it. */
  readonly name: string;
  readonly opened: boolean;
  readonly onOpen: (opener: HTMLElement) => void;
}) {
  const { t } = useBlockText();
  return (
    <div className="flex min-h-[var(--werft-row-min-height)] items-center gap-3 px-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)]">
      <AgentMark size="two-line" />
      <div className="flex min-w-0 flex-1 flex-col gap-(--werft-row-line-gap)">
        {/* On a narrow line the badge goes under the title rather than
            both being cut. */}
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-medium text-control leading-(--werft-leading-body)">
          <span className="min-w-16 max-w-full truncate">{heading}</span>
          <Badge variant="amber" className="min-w-0 max-w-full shrink">
            <span className="truncate">
              {request.kind === "question"
                ? t("session.pending.question")
                : t("inbox.permission", { tool: request.tool })}
            </span>
          </Badge>
        </p>
        <p className="m-0 text-caption text-muted-foreground leading-(--werft-leading-caption) [overflow-wrap:anywhere]">
          {meta}
        </p>
      </div>
      <RowAction
        className="shrink-0"
        aria-expanded={opened}
        aria-label={t("inbox.answerFor", { session: name })}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        {t("inbox.answer")}
      </RowAction>
    </div>
  );
}
