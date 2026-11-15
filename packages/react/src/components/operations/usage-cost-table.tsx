import type { UsageBreakdownResponse } from "@werft-ai/contracts";
import {
  cn,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Meter,
  Text,
} from "@werft-ai/ui";
import type { JSX } from "react";

import type { UsageCostTableMessages } from "./messages.ts";
import { Box, Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

type Row = UsageBreakdownResponse["rows"][number];

export interface UsageCostTableProps {
  /** Names the table and heads its first column: "모델별", "에이전트". */
  readonly label: string;
  readonly head: string;
  /** What the rows are; a model's name is set in mono. */
  readonly by: "model" | "agent";
  /** GET /v1/usage/breakdown `rows`, largest cost first; undefined while read. */
  readonly rows: readonly Row[] | undefined;
  /** The token column. */
  readonly tokens?: boolean | undefined;
  /** How many rows hold their place while the rows are read. */
  readonly placeholderRows?: number | undefined;
  readonly messages?: Partial<UsageCostTableMessages> | undefined;
}

/** A name over its share of the cost, then sessions, tokens and cost. */
export function UsageCostTable({
  label,
  head,
  by,
  rows,
  tokens = true,
  placeholderRows = 3,
  messages: override,
}: UsageCostTableProps): JSX.Element {
  const { messages, format } = useOperationsMessages(
    "usageCostTable",
    override,
  );
  if (rows?.length === 0) {
    return (
      <EmptyState
        title={by === "agent" ? messages.emptyAgent : messages.emptyModel}
      />
    );
  }
  const loading = rows === undefined;
  const max = Math.max(0, ...(rows ?? []).map((r) => Number(r.cost_usd)));
  const shown = rows ?? Array.from({ length: placeholderRows }, () => null);
  return (
    // Half a 1280px page is about 600px; a phone scrolls the table sideways
    // below 24rem rather than wrap a model name.
    <GridTable
      aria-label={label}
      aria-busy={loading || undefined}
      minWidth="24rem"
      columns={
        tokens ? "minmax(0,1fr) 56px 80px 96px" : "minmax(0,1fr) 64px 96px"
      }
    >
      <GridTableHeader>
        <GridTableColumnHeader>{head}</GridTableColumnHeader>
        <GridTableColumnHeader align="end">
          {messages.sessions}
        </GridTableColumnHeader>
        {tokens ? (
          <GridTableColumnHeader align="end">
            {messages.tokens}
          </GridTableColumnHeader>
        ) : null}
        <GridTableColumnHeader align="end">
          {messages.cost}
        </GridTableColumnHeader>
      </GridTableHeader>
      {shown.map((row, i) => {
        const name =
          row === null
            ? ""
            : (row.label ??
              (by === "agent" ? messages.noAgent : messages.noModel));
        return (
          <GridTableRow key={row ? (row.key ?? "") : i}>
            <GridTableCell lines className="gap-1">
              {/* The whole name, wrapped anywhere: the cell truncates only
                    the lines after it. */}
              <Text
                as="span"
                className={cn(
                  "max-w-full [overflow-wrap:anywhere]",
                  by === "model" && row?.label && "font-mono text-control",
                )}
              >
                <Value loading={loading} width="8rem">
                  {name}
                </Value>
              </Text>
              {row === null ? (
                <Box height="0.25rem" />
              ) : (
                <Meter
                  size="inline"
                  value={Number(row.cost_usd)}
                  max={max || 1}
                  label={messages.costShare(name)}
                  className="w-full"
                />
              )}
            </GridTableCell>
            <GridTableCell align="end" className="tabular-nums">
              <Value loading={loading} width="1.5rem">
                {row ? format.count(row.session_count) : null}
              </Value>
            </GridTableCell>
            {tokens ? (
              <GridTableCell align="end" className="tabular-nums">
                <Value loading={loading}>
                  {row ? format.tokens(row.token_count) : null}
                </Value>
              </GridTableCell>
            ) : null}
            <GridTableCell align="end" className="tabular-nums">
              <Value loading={loading}>
                {row ? format.usd(row.cost_usd) : null}
              </Value>
            </GridTableCell>
          </GridTableRow>
        );
      })}
    </GridTable>
  );
}
