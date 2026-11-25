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
  const { messages, format } = useOperationsMessages(
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
      <GridTableCell>
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
      <GridTableCell className="tabular-nums">
        <Value loading={loading}>{format.usd(usd)}</Value>
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
          columns="minmax(0,1fr) minmax(48px,120px) 96px 48px"
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
