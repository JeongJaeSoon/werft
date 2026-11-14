import type { LimitsResponse } from "@werft-ai/contracts";
import {
  Badge,
  Card,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Meter,
  Section,
  StatCard,
  Text,
} from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import type { InstallationLimitsMessages } from "./messages.ts";
import { Box, Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

export interface InstallationLimitsProps {
  /** GET /v1/limits, or with `scope=me`; undefined while it is read. */
  readonly limits: LimitsResponse | undefined;
  /**
   * Which read `limits` is, so the layout holds while it loads: `me` shows the
   * per-session limits a member runs under, and no installation-wide figure.
   */
  readonly scope?: LimitsResponse["scope"] | undefined;
  /** The zone `refreshed_at` is shown in; the viewer's by default. */
  readonly timeZone?: string | undefined;
  /** An ApiErrorState in place of the figures when they cannot be read. */
  readonly error?: ReactNode;
  readonly messages?: Partial<InstallationLimitsMessages> | undefined;
}

/**
 * The installation's execution capacity, slots and stored input, over every
 * limit it sets and the outputs stored without one. The per-session limits have no installation-wide figure.
 * With `scope="me"`, only the limits table: the per-session limits a member
 * runs under, beside the per-member limits that do not exist yet.
 */
export function InstallationLimits({
  limits,
  scope = "installation",
  timeZone,
  error,
  messages: override,
}: InstallationLimitsProps): JSX.Element {
  const { messages, format } = useOperationsMessages(
    "installationLimits",
    override,
  );
  const loading = limits === undefined;
  const member = scope === "me";
  const installation = limits?.scope === "installation" ? limits : undefined;
  const cap = installation?.limits;
  const use = installation?.usage;
  const session = limits?.limits;
  const perSession = (
    <Text as="span" variant="sub" className="text-subtle-foreground">
      {messages.perSession}
    </Text>
  );
  // These are the contract's, not the response's: shown while loading too.
  const noLimit = <Badge>{messages.noLimit}</Badge>;
  const notSet = <Badge>{messages.notSet}</Badge>;
  const notMeasured = <Badge>{messages.notMeasured}</Badge>;
  const none = (
    <>
      <span aria-hidden>—</span>
      <span className="sr-only">{messages.noFigure}</span>
    </>
  );
  const fixed: readonly ReactNode[] = [
    perSession,
    noLimit,
    notSet,
    notMeasured,
    none,
  ];
  type Row = readonly [string, ReactNode, ReactNode, string];
  const sessionRows: readonly Row[] = [
    [
      messages.sessionCost,
      perSession,
      session ? format.usd(session.session_cost_limit_usd) : null,
      messages.sessionCostNote,
    ],
    [
      messages.sessionTokens,
      perSession,
      session === undefined ? null : session.session_token_limit === null ? (
        <Badge key="unset">{messages.notSet}</Badge>
      ) : (
        format.count(session.session_token_limit)
      ),
      messages.sessionTokensNote,
    ],
    [
      messages.queuedInput,
      perSession,
      session
        ? messages.queuedInputValue(
            format.count(session.queued_input_limit_per_session),
          )
        : null,
      messages.queuedInputNote,
    ],
    [
      messages.maxTurn,
      perSession,
      session ? format.duration(session.max_turn_seconds) : null,
      messages.maxTurnNote,
    ],
  ];
  // No member figure exists for these yet, so none is made up from the
  // installation's.
  const memberRows: readonly Row[] = [
    [messages.memberSlots, none, notSet, messages.memberSlotsNote],
    [messages.memberMonthlyCost, none, notSet, messages.memberMonthlyCostNote],
    [messages.memberOutputs, notMeasured, noLimit, messages.memberOutputsNote],
  ];
  const installationRows: readonly Row[] = [
    [
      messages.slots,
      cap && use
        ? `${format.count(use.execution_slots_used)} / ${format.count(cap.execution_slot_limit)}`
        : null,
      cap ? format.count(cap.execution_slot_limit) : null,
      messages.slotsRowNote,
    ],
    [
      messages.storage,
      use ? format.bytes(use.storage.used_bytes) : null,
      cap ? format.bytes(cap.storage_limit_bytes) : null,
      messages.storageRowNote,
    ],
    [
      messages.outputs,
      use === undefined
        ? null
        : use.outputs.complete
          ? format.bytes(use.outputs.used_bytes)
          : messages.outputsAtLeast(format.bytes(use.outputs.used_bytes)),
      noLimit,
      use?.outputs.complete === false
        ? messages.outputsIncompleteNote
        : messages.outputsRowNote,
    ],
  ];
  const rows = [...(member ? memberRows : installationRows), ...sessionRows];
  if (error) {
    return (
      <div className="flex min-w-0 flex-col gap-8">
        <Section title={member ? messages.limits : messages.capacity}>
          {error}
        </Section>
      </div>
    );
  }
  const asOf = (note: string) =>
    limits ? (
      `${note} · ${messages.asOf(format.clock(limits.refreshed_at, timeZone))}`
    ) : (
      <>
        {note} ·{" "}
        <Value loading width="5rem">
          {null}
        </Value>
      </>
    );
  return (
    <div
      aria-busy={loading || undefined}
      className="flex min-w-0 flex-col gap-8"
    >
      {member ? null : (
        <Section
          title={messages.capacity}
          description={asOf(messages.capacityNote)}
        >
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
            <StatCard
              label={messages.slotsInUse}
              value={
                <Value loading={loading} width="4rem">
                  {use ? format.count(use.execution_slots_used) : null}
                </Value>
              }
              outOf={
                <Value loading={loading} width="1.5rem">
                  {cap ? format.count(cap.execution_slot_limit) : null}
                </Value>
              }
              chart={
                cap && use ? (
                  <Meter
                    value={use.execution_slots_used}
                    max={cap.execution_slot_limit}
                    label={messages.slotsMeter}
                  />
                ) : (
                  <Box height="0.5rem" />
                )
              }
              description={
                <Value loading={loading} width="5rem">
                  {cap && use
                    ? messages.slotsFree(
                        format.count(
                          cap.execution_slot_limit - use.execution_slots_used,
                        ),
                      )
                    : null}
                </Value>
              }
            />
            <StatCard
              label={messages.storage}
              value={
                <Value loading={loading} width="4rem">
                  {use ? format.bytes(use.storage.used_bytes) : null}
                </Value>
              }
              outOf={
                <Value loading={loading} width="3rem">
                  {cap ? format.bytes(cap.storage_limit_bytes) : null}
                </Value>
              }
              chart={
                cap && use ? (
                  <Meter
                    value={use.storage.used_bytes}
                    max={cap.storage_limit_bytes}
                    label={messages.storageMeter}
                  />
                ) : (
                  <Box height="0.5rem" />
                )
              }
              description={messages.storageNote}
            />
          </div>
        </Section>
      )}
      <Section
        title={messages.limits}
        {...(member ? { description: asOf(messages.memberNote) } : {})}
      >
        <Card flush>
          <GridTable
            aria-label={messages.limits}
            columns="minmax(0,1fr) 128px 112px minmax(0,1.6fr)"
            narrowAt={480}
            narrowColumns="minmax(0,1fr) 112px 80px"
          >
            <GridTableHeader>
              <GridTableColumnHeader>{messages.item}</GridTableColumnHeader>
              <GridTableColumnHeader>{messages.current}</GridTableColumnHeader>
              <GridTableColumnHeader>{messages.limit}</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {messages.note}
              </GridTableColumnHeader>
            </GridTableHeader>
            {rows.map(([item, now, limit, note]) => (
              <GridTableRow key={item}>
                <GridTableCell>{item}</GridTableCell>
                <GridTableCell className="tabular-nums">
                  {fixed.includes(now) ? (
                    now
                  ) : (
                    <Value loading={loading}>{now}</Value>
                  )}
                </GridTableCell>
                <GridTableCell className="tabular-nums">
                  {fixed.includes(limit) ? (
                    limit
                  ) : (
                    <Value loading={loading}>{limit}</Value>
                  )}
                </GridTableCell>
                <GridTableCell hideNarrow className="text-muted-foreground">
                  {note}
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        </Card>
      </Section>
      {messages.loading ? (
        <output className="sr-only">{loading ? messages.loading : ""}</output>
      ) : null}
    </div>
  );
}
