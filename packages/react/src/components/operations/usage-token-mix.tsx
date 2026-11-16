import type { UsageBreakdownResponse } from "@werft-ai/contracts";
import {
  Card,
  GridTable,
  GridTableCell,
  GridTableRow,
  Meter,
  Section,
} from "@werft-ai/ui";
import type { JSX } from "react";

import type { UsageTokenMixMessages } from "./messages.ts";
import { Box, Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

const KINDS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cache_read_input_tokens"],
  ["cacheWrite", "cache_creation_input_tokens"],
] as const;

const TYPICAL_TOTAL_TOKENS = 38_160_000;

export interface UsageTokenMixProps {
  /** GET /v1/usage/breakdown `totals`; undefined while they are read. */
  readonly totals: UsageBreakdownResponse["totals"] | undefined;
  readonly messages?: Partial<UsageTokenMixMessages> | undefined;
}

/** The period's tokens split into input, output and cache reads and writes. */
export function UsageTokenMix({
  totals,
  messages: override,
}: UsageTokenMixProps): JSX.Element {
  const { messages, format } = useOperationsMessages("usageTokenMix", override);
  const loading = totals === undefined;
  const total = totals?.token_count ?? 0;
  return (
    <Section
      title={messages.title}
      description={
        totals ? (
          messages.description(format.tokens(total))
        ) : (
          <span aria-hidden="true" className="invisible">
            {messages.description(format.tokens(TYPICAL_TOTAL_TOKENS))}
          </span>
        )
      }
    >
      <Card flush>
        <GridTable
          aria-label={messages.title}
          columns="96px minmax(0,1fr) 80px 56px"
        >
          {KINDS.map(([kind, column]) => {
            const label = messages[kind];
            const n = totals?.[column] ?? 0;
            return (
              <GridTableRow key={column}>
                <GridTableCell>{label}</GridTableCell>
                <GridTableCell>
                  {loading ? (
                    <Box height="0.25rem" />
                  ) : (
                    <Meter
                      size="inline"
                      value={n}
                      max={total || 1}
                      label={messages.share(label)}
                      className="w-full"
                    />
                  )}
                </GridTableCell>
                <GridTableCell className="tabular-nums">
                  <Value loading={loading}>{format.tokens(n)}</Value>
                </GridTableCell>
                <GridTableCell className="text-subtle-foreground tabular-nums">
                  <Value loading={loading} width="2rem">
                    {`${total ? Math.round((100 * n) / total) : 0}%`}
                  </Value>
                </GridTableCell>
              </GridTableRow>
            );
          })}
        </GridTable>
      </Card>
    </Section>
  );
}
