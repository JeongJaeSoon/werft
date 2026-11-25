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
import type { JSX, ReactElement, ReactNode } from "react";

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
// With the conversation column a half-width table at 1280px (about 474px)
// would wrap an agent's name, so that table drops tokens below 560px.
const NARROW_TABLE_TALK =
  "[@container(460px<=width<560px)]:grid-cols-[minmax(0,1fr)_48px_96px_104px] [@container(width<460px)]:grid-cols-[minmax(0,1fr)_88px_80px]";
const TALK_HIDE = "[@container(width<560px)]:hidden";
// Below 460px the sessions go too: four columns left a phone's agent name a
// few letters wide.
const TALK_SESSIONS_HIDE = "[@container(width<460px)]:hidden";

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
  /**
   * The conversation column of `by=agent` rows: an agent's conversation
   * calls beside its sessions' cost, split under it by class.
   */
  readonly conversation?: boolean | undefined;
  /**
   * Links a row's judgment line to the agent's M1 judgment records; without
   * it the line is plain text.
   */
  readonly judgmentLink?:
    | ((agentId: string, children: ReactNode) => ReactElement)
    | undefined;
  /** How many rows hold their place while the rows are read. */
  readonly placeholderRows?: number | undefined;
  readonly messages?: Partial<UsageCostTableMessages> | undefined;
}

type Conversation = NonNullable<Row["conversation"]>;

// Judgment, turn and summary always; other only when a call had no class.
function classLines(
  conversation: Conversation,
  messages: UsageCostTableMessages,
): [string, string][] {
  const { by_class: split } = conversation;
  return [
    [messages.judgment, split.judgment_usd],
    [messages.turn, split.turn_usd],
    [messages.summary, split.summary_usd],
    ...(Number(split.other_usd) === 0
      ? []
      : [[messages.other, split.other_usd] as [string, string]]),
  ];
}

/**
 * A name over its share of the cost, then sessions, tokens, the agent's
 * conversation calls when asked, and the sessions' cost.
 */
export function UsageCostTable({
  label,
  head,
  by,
  rows,
  tokens = true,
  conversation = false,
  judgmentLink,
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
  const spent = (r: Row) =>
    Number(r.cost_usd) +
    (conversation ? Number(r.conversation?.cost_usd ?? 0) : 0);
  const max = Math.max(0, ...(rows ?? []).map(spent));
  const columns = [
    "minmax(0,1fr)",
    tokens ? "56px" : "64px",
    ...(tokens ? ["80px"] : []),
    ...(conversation ? ["104px"] : []),
    "112px",
  ];
  const shown = rows ?? Array.from({ length: placeholderRows }, () => null);
  return (
    <Card flush>
      <GridTable
        aria-label={label}
        aria-busy={loading || undefined}
        className={cn(
          conversation ? NARROW_TABLE_TALK : tokens && NARROW_TABLE,
        )}
        columns={columns.join(" ")}
        align={columns.map((_, i) => (i === 0 ? "start" : "end"))}
      >
        <GridTableHeader>
          <GridTableColumnHeader>{head}</GridTableColumnHeader>
          <GridTableColumnHeader
            className={cn(conversation && TALK_SESSIONS_HIDE)}
          >
            {messages.sessions}
          </GridTableColumnHeader>
          {tokens ? (
            <GridTableColumnHeader
              className={conversation ? TALK_HIDE : NARROW_HIDE}
            >
              {messages.tokens}
            </GridTableColumnHeader>
          ) : null}
          {conversation ? (
            <GridTableColumnHeader>
              {messages.conversation}
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
                    value={spent(row)}
                    max={max || 1}
                    label={messages.costShare(name)}
                    className="w-full"
                  />
                )}
              </GridTableCell>
              <GridTableCell
                className={cn(
                  "tabular-nums",
                  conversation && TALK_SESSIONS_HIDE,
                )}
              >
                <Value loading={loading} width="1.5rem">
                  {row ? format.count(row.session_count) : null}
                </Value>
              </GridTableCell>
              {tokens ? (
                <GridTableCell
                  className={cn(
                    "tabular-nums",
                    conversation ? TALK_HIDE : NARROW_HIDE,
                  )}
                >
                  <Value loading={loading}>
                    {row ? format.tokens(row.token_count) : null}
                  </Value>
                </GridTableCell>
              ) : null}
              {conversation ? (
                <GridTableCell lines className="items-end tabular-nums">
                  <Value loading={loading}>
                    {row ? format.usd(row.conversation?.cost_usd ?? 0) : null}
                  </Value>
                  {row?.conversation && row.conversation.call_count > 0
                    ? classLines(row.conversation, messages).map(
                        ([label, usd]) => {
                          const text = `${label} ${format.usd(usd)}`;
                          return (
                            <Text
                              key={label}
                              as="span"
                              variant="meta"
                              title={text}
                            >
                              {label === messages.judgment &&
                              judgmentLink &&
                              row.key !== null
                                ? judgmentLink(row.key, text)
                                : text}
                            </Text>
                          );
                        },
                      )
                    : null}
                  {row?.conversation && row.conversation.call_count > 0
                    ? (
                        [
                          [
                            messages.person,
                            row.conversation.by_requester.person_usd,
                          ],
                          [
                            messages.agent,
                            row.conversation.by_requester.agent_usd,
                          ],
                        ] as const
                      ).map(([label, usd]) => (
                        <Text
                          key={label}
                          as="span"
                          variant="meta"
                          title={`${label} ${format.usd(usd)}`}
                        >
                          {label} {format.usd(usd)}
                        </Text>
                      ))
                    : null}
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
