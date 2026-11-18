import type { CountSessionsResponse, SessionStatus } from "@werft-ai/contracts";
import { Card, Meter, Section, Skeleton, StatusDot } from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import { statusDot } from "../status/vocabulary.ts";
import type { SessionCountsMessages } from "./messages.ts";
import { useOperationsMessages } from "./use-messages.ts";

// The order the counts read in; each dot comes from the status vocabulary.
const STATUSES: readonly SessionStatus[] = [
  "queued",
  "running",
  "needs_input",
  "idle",
  "failed",
  "stopped",
];

// Three across below 640px with rules between, six across above it.
const CELL =
  "flex flex-col gap-1 border-b border-r px-4 py-3 text-inherit no-underline hover:bg-hover [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0 sm:border-b-0 sm:[&:nth-child(3n)]:border-r sm:last:border-r-0";

export interface SessionCountsProps {
  /** GET /v1/sessions/counts `counts`; undefined while it is first read. */
  readonly counts: CountSessionsResponse["counts"] | undefined;
  /**
   * GET /v1/limits `usage.execution_slots_used` and
   * `limits.execution_slot_limit`, for the installation operator only.
   * Without it there is no slot line; `null` keeps the line while it is
   * first read.
   */
  readonly slots?:
    | { readonly used: number; readonly limit: number }
    | null
    | undefined;
  /** The session list filtered to one status, as the host's link. */
  readonly statusLink: (
    status: SessionStatus,
    link: { readonly className: string; readonly children: ReactNode },
  ) => ReactNode;
  /** An ApiErrorState in place of the counts when they cannot be read. */
  readonly error?: ReactNode;
  readonly messages?: Partial<SessionCountsMessages> | undefined;
}

/**
 * "Now": how many sessions the viewer can read are in each status, each a
 * link to that slice of the session list, and the installation's slot use.
 * The counts follow the viewer, not the page's scope choice.
 */
export function SessionCounts({
  counts,
  slots,
  statusLink,
  error,
  messages: override,
}: SessionCountsProps): JSX.Element {
  const { messages, format } = useOperationsMessages("sessionCounts", override);
  const [used, rest] = slots
    ? messages.slotsUsed(format.count(slots.used), format.count(slots.limit))
    : ["", ""];
  return (
    <Section
      data-slot="session-counts"
      title={messages.title}
      description={messages.description}
    >
      {error ?? (
        <Card flush>
          <div className="grid grid-cols-3 sm:grid-cols-6">
            {STATUSES.map((status) => (
              <SessionCount
                key={status}
                count={counts?.[status]}
                format={format.count}
                link={(children) =>
                  statusLink(status, { className: CELL, children })
                }
              >
                <StatusDot status={statusDot("session", status)} />
                {messages.status(status)}
              </SessionCount>
            ))}
          </div>
          {slots === undefined ? null : (
            <div className="flex flex-col gap-2 border-t p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{messages.slots}</span>
                {slots ? (
                  <span className="tabular-nums">
                    <b className="font-bold">{used}</b>
                    {rest}
                  </span>
                ) : (
                  <span aria-hidden="true" className="inline-block w-16">
                    <Skeleton
                      height="1lh"
                      className="justify-center"
                      decorative
                    />
                  </span>
                )}
              </div>
              {slots ? (
                <Meter
                  value={slots.used}
                  max={slots.limit}
                  label={messages.slotsMeter}
                />
              ) : (
                <span aria-hidden="true" className="block">
                  <Skeleton
                    height="0.5rem"
                    className="justify-center"
                    decorative
                  />
                </span>
              )}
            </div>
          )}
          {/*
           * One message for every placeholder above, which are hidden. A
           * screen that announces its own loading passes `loading: ""`.
           */}
          {messages.loading ? (
            <output className="sr-only">
              {counts === undefined || slots === null ? messages.loading : ""}
            </output>
          ) : null}
        </Card>
      )}
    </Section>
  );
}

function SessionCount({
  count,
  format,
  link,
  children,
}: {
  readonly count: number | undefined;
  readonly format: (n: number) => string;
  readonly link: (children: ReactNode) => ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return link(
    <>
      <span className="flex items-center gap-2 text-muted-foreground">
        {children}
      </span>
      {count === undefined ? (
        <span aria-hidden="true" className="block">
          <Skeleton className="my-1.5 h-5 w-8" decorative />
        </span>
      ) : (
        <span className="font-semibold text-number tabular-nums">
          {format(count)}
        </span>
      )}
    </>,
  );
}
