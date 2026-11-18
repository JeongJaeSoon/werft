import {
  BarChart,
  Heading,
  KeyValueList,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { type JSX, type ReactNode, useId } from "react";

import type { ToolCallSort, ToolDetailMessages } from "./messages.ts";
import { ToolCalls } from "./tool-calls.tsx";
import type { UsageTool, UsageToolCall } from "./tools.ts";
import { useOperationsMessages } from "./use-messages.ts";

/** The calls the section lists; a host asks the API for this many. */
export const TOOL_DETAIL_CALLS = 7;
/** The days the chart draws, the period's last. */
export const TOOL_DETAIL_DAYS = 14;

const CHART_HEIGHT = "5.25rem";

const monthDay = (date: string) =>
  `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export interface ToolDetailProps {
  /** The tool shown; undefined until the tools are read. */
  readonly name: string | undefined;
  /** Its GET /v1/usage/tools row; undefined while read. */
  readonly tool: UsageTool | undefined;
  /** A short note under the name, such as "셸 명령"; not an API field. */
  readonly note?: string | undefined;
  /** GET /v1/usage/tools/{name}/calls `per_day`; undefined while read. */
  readonly perDay:
    | readonly { readonly date: string; readonly calls: number }[]
    | undefined;
  /** GET /v1/usage/tools/{name}/calls `calls`; undefined while read. */
  readonly calls: readonly UsageToolCall[] | undefined;
  readonly callSort: ToolCallSort;
  readonly onCallSortChange: (sort: ToolCallSort) => void;
  /** The zone the call times are read in; the viewer's by default. */
  readonly timeZone?: string | undefined;
  /** Shown in place of the chart and calls when they could not be read. */
  readonly error?: ReactNode | undefined;
  /** The section's id, for the list's openers to point at. */
  readonly id?: string | undefined;
  /** True once the reader picked this tool: its heading is then said once. */
  readonly announce?: boolean | undefined;
  /**
   * The period's days when the picked tool is not in that period's list.
   * The figures only its row holds are then left out, not drawn as 0; the
   * chart and the calls still come from its calls' answer.
   */
  readonly absentDays?: number | undefined;
  readonly messages?: Partial<ToolDetailMessages> | undefined;
}

function Value({
  children,
  width = "4rem",
}: {
  readonly children: ReactNode | undefined;
  readonly width?: string;
}) {
  return children === undefined ? (
    <Skeleton
      inline
      decorative
      width={width}
      height="1lh"
      className="justify-center"
    />
  ) : (
    children
  );
}

/**
 * One tool, under the list it was picked from: its figures, its calls per
 * day and its latest calls. Each part keeps its place while it is read, so
 * nothing moves when it comes; the host says once that the screen is loading.
 *
 * The heading is drawn before the section, not in it, so that it sticks to
 * the screen's bottom while a long list above still hides the section: put
 * both right after the list, in a box of its own. They keep their own space
 * from it; a box that adds a gap only widens it.
 */
export function ToolDetail({
  name,
  tool,
  note,
  perDay,
  calls,
  callSort,
  onCallSortChange,
  timeZone,
  error,
  id,
  announce = false,
  absentDays,
  messages: override,
}: ToolDetailProps): JSX.Element {
  const titleId = useId();
  const { messages, format } = useOperationsMessages("toolDetail", override);
  // The period picker's own word for the period.
  const period = useOperationsMessages("usageFilters", undefined).messages.days;
  const days = perDay?.slice(-TOOL_DETAIL_DAYS);
  const peak = days?.reduce(
    (a, b) => (b.calls > a.calls ? b : a),
    days[0] ?? { date: "", calls: 0 },
  );
  const total = days?.reduce((sum, d) => sum + d.calls, 0) ?? 0;
  // The list's row alone holds these.
  const figures = [
    {
      label: messages.calls,
      value: tool && messages.callsValue(format.count(tool.calls)),
    },
    {
      label: messages.total,
      value: tool && format.elapsed(tool.total_ms),
    },
    {
      label: messages.median,
      value: tool && format.elapsed(tool.median_ms),
    },
    {
      label: messages.failed,
      value:
        tool &&
        messages.failedValue(
          format.count(tool.failed),
          format.percent(tool.failed, tool.calls),
        ),
    },
  ].map((item) => ({
    label: item.label,
    value: <Value>{item.value}</Value>,
  }));
  return (
    <>
      <div
        data-slot="tool-detail-head"
        className="sticky bottom-0 z-10 mt-8 flex min-w-0 flex-col gap-1 border-border border-t bg-surface py-3"
      >
        <Heading id={titleId} className="truncate">
          {messages.label}{" "}
          <Text as="span" mono className="text-body font-semibold leading-5">
            <Value width="5rem">{name}</Value>
            {name === undefined ? (
              <span className="sr-only">{messages.loading}</span>
            ) : null}
          </Text>
        </Heading>
        {note ? (
          <Text as="p" variant="meta" className="truncate">
            {note}
          </Text>
        ) : null}
        {absentDays === undefined ? null : (
          <Text as="p" variant="meta" data-slot="tool-detail-absent">
            {messages.absent(period(absentDays))}
          </Text>
        )}
        <output className="sr-only">
          {announce && name !== undefined ? `${messages.label} ${name}` : ""}
        </output>
      </div>
      <section
        id={id}
        aria-labelledby={titleId}
        data-slot="tool-detail"
        className="min-w-0"
      >
        <div
          className={
            absentDays === undefined
              ? "grid gap-6 @min-[48rem]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
              : undefined
          }
        >
          {absentDays === undefined ? <KeyValueList items={figures} /> : null}
          <Section
            titleAs="h3"
            className="min-w-0"
            title={messages.perDay}
            description={messages.perDayNote(days?.length ?? TOOL_DETAIL_DAYS)}
          >
            {error ? (
              error
            ) : days === undefined ||
              peak === undefined ||
              name === undefined ? (
              <Skeleton
                decorative
                shape="block"
                height={CHART_HEIGHT}
                className="justify-center"
              />
            ) : (
              <BarChart
                compact
                data={days.map((d) => ({ x: d.date, y: d.calls }))}
                yMax={peak.calls || undefined}
                label={messages.perDayChart({
                  name,
                  days: days.length,
                  total: format.count(total),
                  peakDay: monthDay(peak.date),
                  peak: format.count(peak.calls),
                })}
                formatX={monthDay}
              />
            )}
          </Section>
        </div>
        {error ? null : (
          <Section
            titleAs="h3"
            className="mt-6 min-w-0"
            title={messages.recent}
            actions={
              <SegmentedControl
                aria-label={messages.callSort}
                value={callSort}
                onValueChange={(value) =>
                  onCallSortChange(value as ToolCallSort)
                }
              >
                <SegmentedControlItem value="recent">
                  {messages.callSortBy.recent}
                </SegmentedControlItem>
                <SegmentedControlItem value="slowest">
                  {messages.callSortBy.slowest}
                </SegmentedControlItem>
              </SegmentedControl>
            }
          >
            <ToolCalls
              calls={calls}
              loadingRows={TOOL_DETAIL_CALLS}
              timeZone={timeZone}
            />
          </Section>
        )}
      </section>
    </>
  );
}
