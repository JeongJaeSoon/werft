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
import { Badge, cn, Skeleton } from "@werft-ai/ui";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { shortSessionId } from "../components/session/session-overview.tsx";
import { useMinute } from "../components/session/use-minute.ts";
import { useWerft } from "../provider.tsx";
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
  const summary = layout === "summary";
  // Read only once a line is drawn, so a reader with nothing waiting pays
  // for none of them.
  const lineDrawn = lists.some((list) => (list.data?.items.length ?? 0) > 0);
  const related = useQueries({
    queries: REASONS.map((relation) => ({
      ...waitingSessionsByQuery(client, relation),
      enabled: summary && lineDrawn,
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
  // Answer forms move focus within their session themselves.
  const lineKey = drawn.map((session) => session.id).join();
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
  // the keyboard goes back to the inbox's heading.
  useLayoutEffect(() => {
    const ids = lineKey === "" ? [] : lineKey.split(",");
    const left = drawnBefore.current.some((id) => !ids.includes(id));
    drawnBefore.current = ids;
    if (left && focusLost(titleRef.current)) titleRef.current?.focus();
  }, [lineKey]);

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
            summary ? cn("divide-y", FRAME) : "gap-[var(--werft-space-block)]",
          )}
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
              reason={summary ? reasonOf(session.id) : undefined}
            />
          ))}
          {left > 0 && moreLine !== undefined ? (
            <li className={cn("text-control", summary ? FRAME_PADDING : null)}>
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
  reason,
}: SessionActionProps & {
  readonly session: SessionSummary;
  readonly renderError: ApprovalInboxProps["renderError"];
  readonly layout: ApprovalInboxProps["layout"];
  readonly now: number;
  readonly onAnswered: () => void;
  /** Why the session came to the reader, when a relation list names it. */
  readonly reason?: Reason | undefined;
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
    children: <code>{shortSessionId(session.id)}…</code>,
  });
  const short = shortSessionId(session.id);
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
    // Untitled, the name line already is the short id. The line ends with
    // why the request came to the reader. A long agent name or reason wraps;
    // the id and the wait stay whole.
    const parts = [
      {
        key: "agent",
        text:
          session.agent?.name ??
          t(
            session.agent_hidden
              ? "session.agent.hidden"
              : "session.agent.none",
          ),
      },
      { key: "id", text: session.title ? short : undefined, whole: true },
      { key: "waited", text: waited, whole: true },
      { key: "reason", text: reason && t(`inbox.why.${reason}`) },
    ].filter((part) => part.text !== undefined);
    return (
      <>
        {parts.map((part, index) => (
          <span
            key={part.key}
            className={part.whole ? "whitespace-nowrap" : undefined}
          >
            {index === 0 ? null : <span aria-hidden="true"> · </span>}
            {part.text}
          </span>
        ))}
      </>
    );
  };
  // The inbox leaves out a session whose list came back empty.
  if (pending.data?.items.length === 0) return null;
  return (
    <li className={cn("flex min-w-0 flex-col", summary ? null : "gap-2")}>
      {pending.data ? (
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
