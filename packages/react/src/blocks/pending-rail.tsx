import { useQueryClient } from "@tanstack/react-query";
import type { SessionSummary } from "@werft-ai/contracts";
import { waitingSessionsQuery } from "@werft-ai/core";
import { Button } from "@werft-ai/ui";
import { X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  DetailRail,
  DetailRailSection,
  SessionStatusLabel,
  shortSessionId,
} from "../components/index.ts";
import { useWerft } from "../provider.tsx";
import {
  usePendingRequests,
  useSession,
  useSessionEvents,
} from "../sessions.ts";
import { PendingAnswers, type SessionActionProps } from "./session-actions.tsx";
import { listedRequests, SessionTimeline } from "./session-timeline.tsx";
import { useBlockText } from "./text.ts";

export interface PendingRailOptions extends SessionActionProps {
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
}

export interface PendingRail {
  /** The `DetailLayout` rail while a session is open, else undefined. */
  readonly rail: ReactNode;
  /** The open session's id, for the line whose button opened it. */
  readonly openedId: string | null;
  /**
   * Opens `session` in the rail. Closing it gives the keyboard back to
   * `opener`, or to `fallback` when the opener has left with its line.
   */
  readonly open: (
    session: SessionSummary,
    opener: HTMLElement,
    fallback?: HTMLElement | null,
  ) => void;
}

interface Opened {
  readonly session: SessionSummary;
  readonly opener: HTMLElement;
  readonly fallback: HTMLElement | null;
  /** Counts each open, so opening the session on show again still focuses. */
  readonly turn: number;
}

/**
 * A waiting session opened in the same right rail a session's own page has:
 * its timeline, with each request it waits on answered on the request's own
 * line. Not a dialog: the page stays usable beside it.
 */
export function usePendingRail(options: PendingRailOptions): PendingRail {
  const [opened, setOpened] = useState<Opened | null>(null);
  const open = useCallback(
    (
      session: SessionSummary,
      opener: HTMLElement,
      fallback: HTMLElement | null = null,
    ) =>
      setOpened((last) => ({
        session,
        opener,
        fallback,
        turn: (last?.turn ?? 0) + 1,
      })),
    [],
  );
  const close = () => {
    if (opened === null) return;
    setOpened(null);
    (opened.opener.isConnected ? opened.opener : opened.fallback)?.focus();
  };
  return {
    open,
    openedId: opened?.session.id ?? null,
    rail:
      opened === null ? undefined : (
        <RailBody
          // A new session is a new rail: its forms and stream start over.
          key={opened.session.id}
          session={opened.session}
          turn={opened.turn}
          onClose={close}
          {...options}
        />
      ),
  };
}

function RailBody({
  session: listed,
  turn,
  onClose,
  renderError,
  unavailable,
  refusal,
}: PendingRailOptions & {
  readonly session: SessionSummary;
  readonly turn: number;
  readonly onClose: () => void;
}) {
  const { t } = useBlockText();
  const { renderLink, client } = useWerft();
  const queryClient = useQueryClient();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const id = listed.id;
  const detail = useSession(id);
  const pending = usePendingRequests(id, true);
  const events = useSessionEvents(id, true);
  // Each open moves the keyboard to the rail. Below 1280px the rail is under
  // the page, and the title's scroll margin brings it near the top; focus's
  // own scrolling ignores scroll margins.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each open focuses again
  useEffect(() => {
    const heading = titleRef.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView?.({ block: "nearest" });
  }, [turn]);
  // Each request's form is rendered once, into a node of its own, and the
  // node is moved to where the request stands: on its timeline line, or on
  // top when the stream has no line for it. Moving never remounts the form,
  // so what was chosen and a send in flight survive. A form stays after its
  // request is gone, so its "sent" line keeps the keyboard.
  const [seen, setSeen] = useState<readonly string[]>([]);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  // The page the rail is drawn on, known once it is: the nodes are its own.
  const [page, setPage] = useState<Document | null>(null);
  const items = pending.data?.items ?? [];
  const asked = new Set(
    events.events.flatMap((frame) =>
      frame.payload.event === "question" ? [frame.payload.data.request_id] : [],
    ),
  );
  // Until the stream has replayed, a request's line may still be on its way.
  const settled = events.state !== "connecting";
  const fresh = items
    .map((request) => request.request_id)
    .filter(
      (requestId) =>
        !seen.includes(requestId) && (settled || asked.has(requestId)),
    );
  if (fresh.length > 0) setSeen([...seen, ...fresh]);
  const nodeOf = (requestId: string, on: Document) => {
    let node = nodes.current.get(requestId);
    if (node === undefined) {
      node = on.createElement("div");
      nodes.current.set(requestId, node);
    }
    return node;
  };
  const slot = (requestId: string) => (
    <div
      key={requestId}
      ref={(host) => {
        if (host === null) return;
        const node = nodeOf(requestId, host.ownerDocument);
        if (node.parentNode !== host) host.appendChild(node);
      }}
    />
  );
  // Asked before the timeline's window, never seen on the stream, or since
  // dropped from it.
  const onTop = seen.filter((requestId) => !asked.has(requestId));
  const status = detail.data?.status ?? listed.status;
  const title = detail.data?.title ?? listed.title ?? shortSessionId(id);
  const forms =
    pending.data && page
      ? seen.map((requestId) =>
          createPortal(
            <PendingAnswers
              sessionId={id}
              items={items.filter(
                (request) => request.request_id === requestId,
              )}
              answerable={pending.data.answerable}
              status={status}
              showEmpty={false}
              unavailable={unavailable}
              refusal={refusal}
              // The lists beside the rail learn the session moved on.
              onAnswered={() =>
                void queryClient.invalidateQueries({
                  ...waitingSessionsQuery(client),
                  exact: true,
                })
              }
            />,
            nodeOf(requestId, page),
            requestId,
          ),
        )
      : null;
  const facts = [
    listed.agent?.name,
    shortSessionId(id),
    detail.data?.runtime?.model,
  ].filter((fact) => fact !== undefined);

  return (
    <DetailRail
      label={title}
      // Under the page below 1280px: a screen tall, so its title can scroll
      // to the top while the timeline is still loading.
      className="max-xl:min-h-[calc(100dvh-var(--werft-topbar-h))]"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div
        ref={(head) => {
          if (head && page === null) setPage(head.ownerDocument);
        }}
        // Across the band's columns below 1280px, above them all.
        className="col-span-full flex min-w-0 items-start gap-3 pb-6 xl:pb-[var(--werft-space-6)]"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2
            ref={titleRef}
            tabIndex={-1}
            className="m-0 scroll-mb-[calc(100dvh-10rem)] font-semibold text-body [overflow-wrap:anywhere]"
          >
            {title}
          </h2>
          <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
            <SessionStatusLabel
              status={status}
              label={t(`sessions.status.${status}`)}
              axisLabel={t("sessions.column.status")}
            />
            {facts.map((fact) => (
              <span key={fact} className="[overflow-wrap:anywhere]">
                <span aria-hidden="true">· </span>
                {fact}
              </span>
            ))}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("panel.close")}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <DetailRailSection
        title={t("panel.timeline")}
        description={t("panel.note")}
        actions={renderLink({
          to: "session",
          id,
          className:
            "text-(color:--werft-color-link) text-control underline-offset-2 hover:underline focus-visible:underline",
          children: t("panel.openSession"),
        })}
      >
        <div className="flex min-w-0 flex-col gap-3">
          {pending.error
            ? renderError(pending.error, () => void pending.refetch())
            : null}
          {forms}
          {onTop.length === 0 ? null : (
            <div className="flex flex-col gap-2">{onTop.map(slot)}</div>
          )}
          <div className="min-w-0 rounded-card border bg-card">
            <SessionTimeline
              events={events.events}
              state={events.state}
              request={(requestId) =>
                seen.includes(requestId) ? slot(requestId) : null
              }
              pending={listedRequests(pending)}
            />
          </div>
        </div>
      </DetailRailSection>
    </DetailRail>
  );
}
