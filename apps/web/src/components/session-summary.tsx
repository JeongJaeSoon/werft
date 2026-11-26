import { Link } from "@tanstack/react-router";
import type { CountSessionsResponse, SessionStatus } from "@werft-ai/contracts";
import { OPERATIONS_MESSAGES } from "@werft-ai/react/components";
import {
  ListSummary,
  ListSummaryItem,
  type StatusDotStatus,
} from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

/** The figures that are one of the sessions list's status filters. */
const STATUS_FIGURES = [
  ["running", "run"],
  ["failed", "failed"],
] as const satisfies readonly (readonly [SessionStatus, StatusDotStatus])[];
export type SessionSummaryStatus = (typeof STATUS_FIGURES)[number][0];

export interface SessionSummaryProps {
  /** GET /v1/sessions/counts, read with the list's relation and search. */
  readonly counts: CountSessionsResponse;
  /**
   * On the sessions list: the status filter it shows and how to set it, so a
   * figure presses that filter on and off. Without it each figure links to
   * the sessions list with its filter on.
   */
  readonly filter?:
    | {
        readonly status: string | undefined;
        readonly onChange: (status: SessionSummaryStatus | null) => void;
      }
    | undefined;
}

/** One line over a list: how many sessions, running, failed, and their cost. */
export function SessionSummary({ counts, filter }: SessionSummaryProps) {
  const { t, locale } = useI18n();
  const number = new Intl.NumberFormat(locale);
  return (
    <ListSummary aria-label={t("sessionList.summary.label")}>
      <ListSummaryItem
        label={t("sessionList.summary.total")}
        value={number.format(counts.total)}
      />
      {STATUS_FIGURES.map(([status, dot]) => {
        const label = t(`sessions.status.${status}`);
        const value = number.format(counts.counts[status]);
        if (filter) {
          const pressed = filter.status === status;
          return (
            <ListSummaryItem
              key={status}
              label={label}
              value={value}
              status={dot}
              pressed={pressed}
              onPress={() => filter.onChange(pressed ? null : status)}
            />
          );
        }
        return (
          <ListSummaryItem
            key={status}
            label={label}
            value={value}
            status={dot}
            link={<Link to="/sessions" search={{ status }} />}
          />
        );
      })}
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
