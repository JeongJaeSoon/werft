import { Link } from "@tanstack/react-router";
import type { CountSessionsResponse, SessionStatus } from "@werft-ai/contracts";
import { OPERATIONS_MESSAGES } from "@werft-ai/react/components";
import {
  ListSummary,
  ListSummaryItem,
  type StatusDotStatus,
} from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

/** The figures that link to one of the sessions list's status filters. */
const STATUS_FIGURES = [
  ["running", "run"],
  ["failed", "failed"],
] as const satisfies readonly (readonly [SessionStatus, StatusDotStatus])[];

export interface SessionSummaryProps {
  /** GET /v1/sessions/counts, read with the list's relation and search. */
  readonly counts: CountSessionsResponse;
  /**
   * Adds running and failed, each a link to the sessions list with that filter
   * on. The sessions list leaves them out: its status tabs show both.
   */
  readonly statusLinks?: boolean;
}

/** One line over a list: how many sessions and their cost. */
export function SessionSummary({ counts, statusLinks }: SessionSummaryProps) {
  const { t, locale } = useI18n();
  const number = new Intl.NumberFormat(locale);
  return (
    <ListSummary aria-label={t("sessionList.summary.label")}>
      <ListSummaryItem
        label={t("sessionList.summary.total")}
        value={number.format(counts.total)}
      />
      {statusLinks
        ? STATUS_FIGURES.map(([status, dot]) => (
            <ListSummaryItem
              key={status}
              label={t(`sessions.status.${status}`)}
              value={number.format(counts.counts[status])}
              status={dot}
              link={<Link to="/sessions" search={{ status }} />}
            />
          ))
        : null}
      {/* A server older than the field sends none: no figure, not $0. */}
      {counts.cost_usd === undefined ? null : (
        <ListSummaryItem
          label={t("sessionList.summary.cost")}
          value={OPERATIONS_MESSAGES[locale].format.usd(counts.cost_usd)}
        />
      )}
    </ListSummary>
  );
}
