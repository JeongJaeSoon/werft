import type { UsageSeriesResponse } from "@werft-ai/contracts";
import { Badge, Sparkline, StatCard } from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import type { UsageKpisMessages } from "./messages.ts";
import { Box, Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

type Bucket = UsageSeriesResponse["buckets"][number];

interface Totals {
  readonly session_count: number;
  readonly run_seconds: number;
  /** The sessions' and the conversation calls' together. */
  readonly cost_usd: number;
  readonly session_cost_usd: number;
  readonly conversation_cost_usd: number;
  readonly cost_complete: boolean;
  readonly token_count: number;
}

/** A day's whole spend: its sessions' and its conversation calls'. */
export function spentOn(bucket: Bucket): number {
  return Number(bucket.cost_usd) + Number(bucket.conversation_cost_usd);
}

function totalsOf(buckets: readonly Bucket[], unknownUsd: number): Totals {
  const sessions = buckets.reduce((sum, b) => sum + Number(b.cost_usd), 0);
  // What the limits counted for calls nothing prices is not what they cost:
  // the amounts are the rest, and the card names that part apart from them.
  const known = Math.max(0, sessions - unknownUsd);
  return {
    session_count: buckets.reduce((sum, b) => sum + b.session_count, 0),
    run_seconds: buckets.reduce((sum, b) => sum + b.run_seconds, 0),
    cost_usd:
      known +
      buckets.reduce((sum, b) => sum + Number(b.conversation_cost_usd), 0),
    session_cost_usd: known,
    conversation_cost_usd: buckets.reduce(
      (sum, b) => sum + Number(b.conversation_cost_usd),
      0,
    ),
    cost_complete: buckets.every(
      (b) => b.cost_complete && b.conversation_cost_complete,
    ),
    token_count: buckets.reduce((sum, b) => sum + b.token_count, 0),
  };
}

export interface UsageKpisProps {
  /** GET /v1/usage/series `buckets` of the period; undefined while read. */
  readonly buckets: readonly Bucket[] | undefined;
  /** GET /v1/usage/series `unknown_price` of the same answer. */
  readonly unknownPrice?: UsageSeriesResponse["unknown_price"] | undefined;
  readonly messages?: Partial<UsageKpisMessages> | undefined;
}

/** Sessions, run time, cost and tokens of a period, each over its daily line. */
export function UsageKpis({
  buckets,
  unknownPrice,
  messages: override,
}: UsageKpisProps): JSX.Element {
  const { messages, format } = useOperationsMessages("usageKpis", override);
  const totals =
    buckets === undefined
      ? undefined
      : totalsOf(buckets, Number(unknownPrice?.cost_usd ?? 0));
  const unknown =
    unknownPrice === undefined || unknownPrice.call_count === 0 ? null : (
      <span className="block">
        {messages.costUnknown(
          format.count(unknownPrice.call_count),
          format.tokens(unknownPrice.token_count),
          format.usd(unknownPrice.cost_usd),
        )}
      </span>
    );
  const loading = totals === undefined;
  const spark = (pick: (bucket: Bucket) => number, label: string) =>
    buckets === undefined ? (
      <Box height="2rem" />
    ) : (
      <Sparkline values={buckets.map(pick)} label={label} />
    );
  const value = (width: string | undefined, text: (t: Totals) => ReactNode) => (
    <Value loading={loading} {...(width ? { width } : {})}>
      {totals ? text(totals) : null}
    </Value>
  );
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
      <StatCard
        label={messages.sessions}
        value={value(undefined, (t) => format.count(t.session_count))}
        chart={spark((b) => b.session_count, messages.sessionsChart)}
        description={messages.sessionsNote}
      />
      <StatCard
        label={messages.runTime}
        value={value("6rem", (t) => format.duration(t.run_seconds))}
        chart={spark((b) => b.run_seconds, messages.runTimeChart)}
        description={messages.runTimeNote}
      />
      <StatCard
        label={messages.cost}
        badge={<Badge>{messages.estimated}</Badge>}
        value={value("5rem", (t) => format.usd(t.cost_usd))}
        chart={spark(spentOn, messages.costChart)}
        description={
          totals === undefined ? (
            // Most periods hold a running turn; keeping its room stops the
            // card growing when the figures come.
            <span aria-hidden="true" className="invisible">
              {messages.costIncomplete}
            </span>
          ) : totals.conversation_cost_usd === 0 && unknown === null ? (
            totals.cost_complete ? undefined : (
              messages.costIncomplete
            )
          ) : (
            <>
              {totals.conversation_cost_usd === 0 ? null : (
                <span className="block">
                  {messages.costSplit(
                    format.usd(totals.session_cost_usd),
                    format.usd(totals.conversation_cost_usd),
                  )}
                </span>
              )}
              {unknown}
              {totals.cost_complete ? null : (
                <span className="block">{messages.costIncomplete}</span>
              )}
            </>
          )
        }
      />
      <StatCard
        label={messages.tokens}
        value={value("4rem", (t) => format.tokens(t.token_count))}
        chart={spark((b) => b.token_count, messages.tokensChart)}
        description={messages.tokensNote}
      />
      {messages.loading ? (
        <output className="sr-only">{loading ? messages.loading : ""}</output>
      ) : null}
    </div>
  );
}
