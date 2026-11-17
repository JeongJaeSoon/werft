import type { UsageBreakdownResponse } from "@werft-ai/contracts";
import {
  Card,
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

// GridTable's narrowest step (480px) drops the token column from a half-width
// table at 1280px once a classic scrollbar takes 15-17px (about 472px), so
// this table steps at 460px itself. Below that the name column would wrap a
// model name; a phone still drops the column. The rows are subgrids of the
// table, so the template changes on the table.
const NARROW_TABLE =
  "[@container(width<460px)]:grid-cols-[minmax(0,1fr)_48px_104px]";
const NARROW_HIDE = "[@container(width<460px)]:hidden";

export interface UsageCostTableProps {
  /** Names the table and heads its first column: "모델별", "에이전트". */
  readonly label: string;
  readonly head: string;
  /** What the rows are; a model's name is set in mono. */
  readonly by: "model" | "agent";
  /** GET /v1/usage/breakdown `rows`, largest cost first; undefined while read. */
  readonly rows: readonly Row[] | undefined;
  /** The token column, hidden below 460px so the names keep their room. */
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
    <Card flush>
      <GridTable
        aria-label={label}
        aria-busy={loading || undefined}
        className={cn(tokens && NARROW_TABLE)}
        columns={
          tokens ? "minmax(0,1fr) 56px 80px 112px" : "minmax(0,1fr) 64px 112px"
        }
        align={
          tokens ? ["start", "end", "end", "end"] : ["start", "end", "end"]
        }
      >
        <GridTableHeader>
          <GridTableColumnHeader>{head}</GridTableColumnHeader>
          <GridTableColumnHeader>{messages.sessions}</GridTableColumnHeader>
          {tokens ? (
            <GridTableColumnHeader className={NARROW_HIDE}>
              {messages.tokens}
            </GridTableColumnHeader>
          ) : null}
          <GridTableColumnHeader>{messages.cost}</GridTableColumnHeader>
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
              <GridTableCell className="tabular-nums">
                <Value loading={loading} width="1.5rem">
                  {row ? format.count(row.session_count) : null}
                </Value>
              </GridTableCell>
              {tokens ? (
                <GridTableCell className={cn("tabular-nums", NARROW_HIDE)}>
                  <Value loading={loading}>
                    {row ? format.tokens(row.token_count) : null}
                  </Value>
                </GridTableCell>
              ) : null}
              <GridTableCell className="tabular-nums">
                <Value loading={loading}>
                  {row ? format.usd(row.cost_usd) : null}
                </Value>
              </GridTableCell>
            </GridTableRow>
          );
        })}
      </GridTable>
    </Card>
  );
}
