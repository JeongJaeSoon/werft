import type { UsageOutcomesResponse } from "@werft-ai/contracts";
import {
  Card,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Section,
  Text,
} from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import type { UsageOutcomesMessages } from "./messages.ts";
import { Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

/** What counts as an outcome; each kind is one row, in this order. */
export const USAGE_OUTCOME_KINDS = ["merged_pr"] as const;
export type UsageOutcomeKind = (typeof USAGE_OUTCOME_KINDS)[number];

const FIGURES: Readonly<
  Record<
    UsageOutcomeKind,
    (data: UsageOutcomesResponse) => {
      readonly count: number;
      readonly costEachUsd: string | null;
    }
  >
> = {
  merged_pr: (data) => ({
    count: data.merged_pr_count,
    costEachUsd: data.cost_per_merged_pr_usd,
  }),
};

export interface UsageOutcomesProps {
  /** GET /v1/usage/outcomes; undefined while read. */
  readonly data: UsageOutcomesResponse | undefined;
  /** Shown under the heading in place of the figures. */
  readonly error?: ReactNode;
  readonly messages?: Partial<UsageOutcomesMessages> | undefined;
}

/**
 * The period's task-session cost per outcome, as the API divides it: every
 * session's cost over the outcomes those sessions reached.
 */
export function UsageOutcomes({
  data,
  error,
  messages: override,
}: UsageOutcomesProps): JSX.Element {
  const { messages, format } = useOperationsMessages("usageOutcomes", override);
  const loading = data === undefined;
  const rows = USAGE_OUTCOME_KINDS.map((kind) => ({
    kind,
    ...(data ? FIGURES[kind](data) : { count: 0, costEachUsd: null }),
  }));
  const none = !loading && rows.every((row) => row.count === 0);
  return (
    <Section title={messages.title} description={messages.description}>
      {error ? (
        error
      ) : none ? (
        <EmptyState title={messages.empty} />
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <Card flush>
            <GridTable
              aria-label={messages.title}
              aria-busy={loading || undefined}
              columns="minmax(0,1fr) max-content max-content"
              align={["start", "end", "end"]}
            >
              <GridTableHeader>
                <GridTableColumnHeader>
                  {messages.outcome}
                </GridTableColumnHeader>
                <GridTableColumnHeader>{messages.count}</GridTableColumnHeader>
                <GridTableColumnHeader>
                  {messages.costEach}
                </GridTableColumnHeader>
              </GridTableHeader>
              {rows.map((row) => (
                <GridTableRow key={row.kind}>
                  <GridTableCell>{messages.kind[row.kind]}</GridTableCell>
                  <GridTableCell className="tabular-nums">
                    <Value loading={loading} width="2rem">
                      {format.count(row.count)}
                    </Value>
                  </GridTableCell>
                  <GridTableCell className="tabular-nums">
                    <Value loading={loading}>
                      {row.costEachUsd === null
                        ? "—"
                        : format.usd(row.costEachUsd)}
                    </Value>
                  </GridTableCell>
                </GridTableRow>
              ))}
            </GridTable>
          </Card>
          {data ? (
            <Text as="p" className="text-caption text-subtle-foreground">
              {messages.basis(
                format.count(data.session_count),
                format.usd(data.cost_usd),
              )}
              {data.cost_complete ? null : ` ${messages.incomplete}`}
            </Text>
          ) : null}
        </div>
      )}
    </Section>
  );
}
