import type {
  UsageBreakdownResponse,
  UsagePeopleResponse,
} from "@werft-ai/contracts";
import {
  Card,
  cn,
  GridTable,
  GridTableCell,
  GridTableRow,
  Meter,
  Section,
  Text,
} from "@werft-ai/ui";
import type { JSX, ReactElement, ReactNode } from "react";

import type { UsageInitiatorSplitMessages } from "./messages.ts";
import { Box, Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

export interface UsageInitiatorSplitProps {
  /** GET /v1/usage/breakdown?by=agent `totals`; undefined while read. */
  readonly totals: UsageBreakdownResponse["totals"] | undefined;
  /** GET /v1/usage/people `people`, under the person part; none if absent. */
  readonly people?: UsagePeopleResponse["people"] | undefined;
  /** Links the task sessions' label to the session list. */
  readonly sessionsLink?: ((children: ReactNode) => ReactElement) | undefined;
  readonly messages?: Partial<UsageInitiatorSplitMessages> | undefined;
}

/**
 * The period's spend by who started it: a person's conversation calls, the
 * agent's own, and task sessions. The three add up to the KPI cost; under
 * the person part, each person's share when the reader may see it.
 */
export function UsageInitiatorSplit({
  totals,
  people,
  sessionsLink,
  messages: override,
}: UsageInitiatorSplitProps): JSX.Element {
  const { messages, format, unknownPrice } = useOperationsMessages(
    "usageInitiatorSplit",
    override,
  );
  const loading = totals === undefined;
  const split = totals?.conversation?.by_requester;
  const parts = [
    ["person", messages.person, split?.person_usd ?? "0"],
    ["agent", messages.agent, split?.agent_usd ?? "0"],
    ["session", messages.session, totals?.cost_usd ?? "0"],
  ] as const;
  const total = parts.reduce((sum, [, , usd]) => sum + Number(usd), 0);
  // Task sessions of calls of unknown price alone: a $0.00 would read as free.
  const unknownCalls = totals?.unknown_price?.call_count ?? 0;
  const sessionUnpriced =
    Number(totals?.cost_usd ?? 0) === 0 && unknownCalls > 0;
  // As the cost table: the known amount, then its calls of unknown price.
  const unknownLine =
    unknownCalls === 0
      ? null
      : sessionUnpriced
        ? unknownPrice.calls(format.count(unknownCalls))
        : `+ ${unknownPrice.calls(format.count(unknownCalls))}`;
  const row = (
    key: string,
    label: ReactNode,
    share: string,
    usd: string,
    nested = false,
  ) => (
    <GridTableRow key={key}>
      <GridTableCell className={cn(nested && "ps-4 text-subtle-foreground")}>
        {label}
      </GridTableCell>
      <GridTableCell hideNarrow>
        {loading ? (
          <Box height="0.25rem" />
        ) : (
          <Meter
            size="inline"
            value={Number(usd)}
            max={total || 1}
            label={messages.share(share)}
            className="w-full"
          />
        )}
      </GridTableCell>
      <GridTableCell lines className="items-end tabular-nums">
        <Value loading={loading}>
          {key === "session" && sessionUnpriced
            ? unknownPrice.noAmount
            : format.usd(usd)}
        </Value>
        {key === "session" && !loading && unknownLine ? (
          <Text
            as="span"
            variant="meta"
            title={unknownLine}
            className="whitespace-normal"
          >
            {unknownLine}
          </Text>
        ) : null}
      </GridTableCell>
      <GridTableCell className="text-subtle-foreground tabular-nums">
        <Value loading={loading} width="2rem">
          {`${total ? Math.round((100 * Number(usd)) / total) : 0}%`}
        </Value>
      </GridTableCell>
    </GridTableRow>
  );
  return (
    <Section title={messages.title} description={messages.description}>
      <Card flush>
        <GridTable
          aria-label={messages.title}
          columns="minmax(0,1fr) minmax(48px,120px) max-content max-content"
          narrowAt={480}
          narrowColumns="minmax(0,1fr) max-content max-content"
          align={["start", "start", "end", "end"]}
        >
          {parts.flatMap(([key, label, usd]) => [
            row(
              key,
              key === "session" && sessionsLink ? sessionsLink(label) : label,
              label,
              usd,
            ),
            ...(key === "person"
              ? (people ?? []).map((person) => {
                  const name = person.label ?? messages.noPerson;
                  return row(
                    `person:${person.user_id ?? ""}`,
                    name,
                    name,
                    person.cost_usd,
                    true,
                  );
                })
              : []),
          ])}
        </GridTable>
      </Card>
    </Section>
  );
}
