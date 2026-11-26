import type {
  PendingRequest,
  SessionDetail as SessionDetailData,
} from "@werft-ai/contracts";
import { Badge, Button, cn, formatDuration, Text } from "@werft-ai/ui";
import { ChevronDown, Clock, ListChecks, Wrench } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { ModuleMessageKey } from "../messages/index.ts";
import { useWerft } from "../provider.tsx";
import { useAgentOpenable } from "../sessions.ts";
import {
  type SessionStep,
  type SessionStepState,
  type SessionSteps,
  sessionTime,
} from "./session-steps.ts";
import { type BlockText, useBlockText } from "./text.ts";

const STATE_LABEL: Record<SessionStepState, ModuleMessageKey> = {
  queued: "session.steps.state.queued",
  running: "session.steps.state.running",
  approval: "session.steps.state.approval",
  answer: "session.steps.state.answer",
  done: "session.steps.state.done",
  failed: "session.steps.state.failed",
  cut_off: "session.steps.state.cut_off",
  stopped: "session.steps.state.stopped",
  unknown: "session.steps.state.unknown",
};

const STATE_TONE: Record<
  SessionStepState,
  "gray" | "blue" | "amber" | "green" | "red"
> = {
  queued: "gray",
  running: "blue",
  approval: "amber",
  answer: "amber",
  done: "green",
  failed: "red",
  cut_off: "red",
  stopped: "gray",
  unknown: "gray",
};

/** The step whose tool calls the head counts: the focused one, else the last. */
function headStep(steps: SessionSteps): SessionStep | undefined {
  return steps.steps[steps.focus ?? steps.steps.length - 1];
}

export interface SessionProgressProps {
  readonly session: SessionDetailData;
  /** Undefined until the turns are read: the line then leaves steps out. */
  readonly steps: SessionSteps | undefined;
  readonly now: number;
  /** The step list's id and whether it shows, for the toggle. */
  readonly listId: string;
  readonly listOpen: boolean;
  readonly onListToggle: () => void;
  /** The session's cost and tokens, drawn last. */
  readonly usage?: ReactNode;
}

/**
 * The head's progress line: which step of how many, the tool calls of that
 * step, the time the turns have run and what they cost. The step count opens
 * and closes the step list.
 */
export function SessionProgress({
  session,
  steps,
  now,
  listId,
  listOpen,
  onListToggle,
  usage,
}: SessionProgressProps) {
  const { t, locale } = useBlockText();
  const step = steps ? headStep(steps) : undefined;
  const duration = steps
    ? formatDuration(sessionTime(session, steps, now), locale)
    : null;
  return (
    <div
      data-slot="session-progress"
      className="flex min-w-0 flex-wrap items-center gap-x-[var(--werft-space-4)] gap-y-[var(--werft-space-1)] text-caption text-muted-foreground"
    >
      {steps && steps.steps.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-caption text-foreground"
          aria-expanded={listOpen}
          aria-controls={listId}
          onClick={onListToggle}
        >
          <ListChecks
            className="size-[var(--werft-leading-caption)]"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="tabular-nums">
            {steps.focus === null
              ? t("session.steps.count", { total: steps.steps.length })
              : t("session.steps.progress", {
                  current: steps.focus + 1,
                  total: steps.steps.length,
                })}
          </span>
          <span className="sr-only">, {t("session.steps.toggle")}</span>
          <ChevronDown
            className={cn(
              "size-[var(--werft-leading-caption)] motion-safe:transition-transform",
              listOpen && "rotate-180",
            )}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Button>
      ) : null}
      {step && step.toolCalls > 0 ? (
        <span className="inline-flex items-center gap-[var(--werft-space-1)] tabular-nums">
          <Wrench
            className="size-[var(--werft-leading-caption)] shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          {t(
            step.toolCallsPartial
              ? "session.progress.toolsAtLeast"
              : "session.progress.tools",
            { count: step.toolCalls },
          )}
        </span>
      ) : null}
      {duration ? (
        <span className="inline-flex items-center gap-[var(--werft-space-1)] tabular-nums">
          <Clock
            className="size-[var(--werft-leading-caption)] shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          {t("session.progress.time", { duration })}
        </span>
      ) : null}
      {usage}
    </div>
  );
}

/**
 * Says the session waits on the viewer, how many approvals and questions, and
 * takes them to the requests. Nothing while none is open.
 */
export function SessionInputNeeded({
  requests,
  onShow,
}: {
  readonly requests: readonly PendingRequest[];
  readonly onShow: () => void;
}) {
  const { t } = useBlockText();
  const titleId = useId();
  if (requests.length === 0) return null;
  const approvals = requests.filter((r) => r.kind === "permission").length;
  const questions = requests.length - approvals;
  const counts = [
    approvals > 0
      ? t("session.needsInput.approvals", { count: approvals })
      : null,
    questions > 0
      ? t("session.needsInput.questions", { count: questions })
      : null,
  ].filter((part) => part !== null);
  return (
    <section
      data-slot="session-input-needed"
      aria-labelledby={titleId}
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-[var(--werft-space-4)] gap-y-[var(--werft-space-2)] rounded-control border border-[var(--werft-tone-attention-border)] bg-card px-[var(--werft-space-3)] py-[var(--werft-space-2)]"
    >
      <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-[var(--werft-space-2)] text-body">
        <span id={titleId} className="font-medium">
          {t("session.needsInput.title")}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {counts.join(" · ")}
        </span>
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onShow}>
        {t("session.needsInput.show")}
      </Button>
    </section>
  );
}

type Blocked = {
  readonly text: string;
  /** The fix is in the agent's settings. */
  readonly agent: boolean;
};

/**
 * Why the session takes no next step, from its attention. A limit has its own
 * line above the composer, and a pause or close refusal blocks no step.
 */
export function blockedReason(
  t: BlockText,
  attention: SessionDetailData["attention"],
): Blocked | null {
  if (!attention) return null;
  const decision = (retryAt: string | null) =>
    t(
      retryAt === null
        ? "session.blocked.needsDecision"
        : "session.blocked.retrying",
    );
  switch (attention.code) {
    case "CONTEXT_GAP":
      return { text: t("session.blocked.contextGap"), agent: false };
    case "CATALOG_MISMATCH":
      return { text: t("session.blocked.catalogMismatch"), agent: true };
    case "NO_WORKER_IMAGE":
      return { text: t("session.blocked.noWorkerImage"), agent: false };
    case "RESTORE_FAILED":
      return {
        text: `${t("session.blocked.restoreFailed")} ${decision(attention.retry_at)}`,
        agent: false,
      };
    case "STARTUP_FAILED":
      return {
        text: `${t("session.blocked.startupFailed")} ${decision(attention.retry_at)}`,
        agent: false,
      };
    case "TRANSCRIPT_LIMIT":
      return attention.reason === "transcript_near_limit"
        ? null
        : { text: t("session.blocked.transcriptLimit"), agent: false };
    case "VARIABLE_REFUSED":
      return { text: t("session.blocked.variableRefused"), agent: true };
    case "SOURCE_DELETED":
      return { text: t("session.blocked.sourceDeleted"), agent: false };
    default:
      return null;
  }
}

function AgentFix({ agent }: { readonly agent: SessionDetailData["agent"] }) {
  const { t } = useBlockText();
  const { renderLink } = useWerft();
  const openable = useAgentOpenable(agent?.id);
  if (!agent || !openable) return null;
  return renderLink({
    to: "agent",
    id: agent.id,
    className:
      "inline-flex w-fit items-center text-caption text-(color:--werft-color-link) underline",
    children: t("session.steps.openAgent"),
  });
}

function BlockedNote({
  blocked,
  agent,
  lead,
}: {
  readonly blocked: Blocked;
  readonly agent: SessionDetailData["agent"];
  readonly lead?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--werft-space-1)]">
      <Text variant="meta" className="m-0 text-destructive">
        {lead ? `${lead} ` : null}
        {blocked.text}
      </Text>
      {blocked.agent ? <AgentFix agent={agent} /> : null}
    </div>
  );
}

export interface SessionStepListProps {
  readonly id: string;
  readonly open: boolean;
  readonly session: SessionDetailData;
  readonly steps: SessionSteps;
  readonly now: number;
  /** The fix for a step a lost worker cut off, drawn in its place. */
  readonly cutOffAction?: (step: SessionStep) => ReactNode;
}

/**
 * The session's turns as numbered steps. Only the step the session is on
 * shows its detail at first; any step opens and closes by its row.
 */
export function SessionStepList({
  id,
  open,
  session,
  steps,
  now,
  cutOffAction,
}: SessionStepListProps) {
  const { t } = useBlockText();
  const titleId = useId();
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({});
  const blocked = blockedReason(t, session.attention);
  return (
    <section
      id={id}
      hidden={!open}
      aria-labelledby={titleId}
      data-slot="session-steps"
      className="min-w-0 rounded-card border bg-card"
    >
      <h2 id={titleId} className="sr-only">
        {t("session.steps.title")}
      </h2>
      {steps.steps.length === 0 ? (
        <Text
          variant="meta"
          className="m-0 px-[var(--werft-space-3)] py-[var(--werft-space-2)]"
        >
          {t("session.steps.empty")}
        </Text>
      ) : (
        // A long session scrolls inside its box; the keyboard needs a stop.
        <div
          {...{ role: "group", tabIndex: 0, "aria-labelledby": titleId }}
          className="max-h-[40dvh] overflow-y-auto rounded-card p-[var(--werft-space-1)]"
        >
          <ol className="m-0 flex list-none flex-col p-0">
            {steps.steps.map((step, index) => {
              const focused = index === steps.focus;
              const expanded = toggled[step.turn.turn_id] ?? focused;
              return (
                <StepRow
                  key={step.turn.turn_id}
                  step={step}
                  now={now}
                  current={focused && steps.current}
                  expanded={expanded}
                  onToggle={() =>
                    setToggled((was) => ({
                      ...was,
                      [step.turn.turn_id]: !expanded,
                    }))
                  }
                  blocked={focused ? blocked : null}
                  agent={session.agent}
                  cutOffAction={cutOffAction}
                />
              );
            })}
          </ol>
        </div>
      )}
      {steps.focus === null && blocked ? (
        <div className="border-t px-[var(--werft-space-3)] py-[var(--werft-space-2)]">
          <BlockedNote
            blocked={blocked}
            agent={session.agent}
            lead={t("session.steps.blocked")}
          />
        </div>
      ) : null}
    </section>
  );
}

function StepRow({
  step,
  now,
  current,
  expanded,
  onToggle,
  blocked,
  agent,
  cutOffAction,
}: {
  readonly step: SessionStep;
  readonly now: number;
  readonly current: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly blocked: Blocked | null;
  readonly agent: SessionDetailData["agent"];
  readonly cutOffAction: SessionStepListProps["cutOffAction"];
}) {
  const { t, locale } = useBlockText();
  const panelId = useId();
  const { turn, state } = step;
  const message =
    turn.source_deleted_at || turn.message === ""
      ? t("session.sourceDeleted")
      : turn.message;
  const started = turn.started_at ? Date.parse(turn.started_at) : null;
  const ended = turn.ended_at ? Date.parse(turn.ended_at) : null;
  // A turn the session no longer runs has an end the turns read lacks.
  const time =
    started === null || (ended === null && state === "unknown")
      ? null
      : ended === null
        ? t("session.steps.since", {
            duration: formatDuration(Math.max(0, now - started), locale) ?? "",
          })
        : t("session.steps.took", {
            duration:
              formatDuration(Math.max(0, ended - started), locale) ?? "",
          });
  const approvals = step.requests.flatMap((request) =>
    request.kind === "permission" ? [request] : [],
  );
  const questions = step.requests.reduce(
    (sum, request) =>
      request.kind === "question" ? sum + request.questions.length : sum,
    0,
  );
  const waiting = state === "approval" || state === "answer";
  return (
    <li
      aria-current={current ? "step" : undefined}
      data-state={state}
      className="flex min-w-0 flex-col"
    >
      <Button
        type="button"
        variant="ghost"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        // The primitive's focus ring and hover, on a row as tall as its text.
        className="h-auto min-h-[var(--werft-control-height)] w-full min-w-0 justify-start gap-[var(--werft-space-3)] whitespace-normal px-[var(--werft-space-2)] py-[var(--werft-space-1)] text-left font-normal text-body text-foreground"
      >
        <span
          aria-hidden="true"
          className={cn(
            "grid size-[var(--werft-size-icon-tile)] flex-none place-content-center rounded-[var(--werft-radius-pill)] border font-medium text-caption tabular-nums",
            current
              ? "border-(color:--werft-tone-progress-border) bg-(color:--werft-tone-progress-bg) text-(color:--werft-tone-progress-fg)"
              : waiting
                ? "border-(color:--werft-tone-caution-border) border-dashed text-(color:--werft-tone-caution-fg)"
                : "border-border-strong text-muted-foreground",
          )}
        >
          {step.number}
        </span>
        <span className="sr-only">
          {t("session.steps.step", { number: step.number })}:{" "}
        </span>
        <span className="min-w-0 flex-1 truncate">{message}</span>
        <span className="sr-only">, </span>
        <Badge variant={STATE_TONE[state]}>{t(STATE_LABEL[state])}</Badge>
        {current ? (
          <span className="sr-only">, {t("session.steps.now")}</span>
        ) : null}
        <ChevronDown
          className={cn(
            "size-[var(--werft-leading-caption)] shrink-0 text-muted-foreground motion-safe:transition-transform",
            expanded && "rotate-180",
          )}
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </Button>
      <div
        id={panelId}
        hidden={!expanded}
        className={cn(
          "flex min-w-0 flex-col gap-[var(--werft-space-1)] pr-[var(--werft-space-2)] pb-[var(--werft-space-2)] pl-[calc(var(--werft-size-icon-tile)+var(--werft-space-3)+var(--werft-space-2))]",
          // A host without Tailwind's preflight would let flex beat hidden.
          !expanded && "hidden",
        )}
      >
        {time || step.toolCalls > 0 ? (
          <Text variant="meta" className="m-0 tabular-nums">
            {[
              time,
              step.toolCalls > 0
                ? t(
                    step.toolCallsPartial
                      ? "session.steps.toolsAtLeast"
                      : "session.steps.tools",
                    { count: step.toolCalls },
                  )
                : null,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </Text>
        ) : null}
        {approvals.map((request) => (
          <Text
            key={request.request_id}
            variant="meta"
            // An MCP tool's name can be one long unbroken word.
            className="m-0 text-(color:--werft-tone-caution-fg) [overflow-wrap:anywhere]"
          >
            {t("session.steps.approvalOf", { tool: request.tool })}
          </Text>
        ))}
        {questions > 0 ? (
          <Text
            variant="meta"
            className="m-0 text-(color:--werft-tone-caution-fg)"
          >
            {t("session.steps.questions", { count: questions })}
          </Text>
        ) : null}
        {waiting ? (
          <Text variant="meta" className="m-0">
            {t("session.steps.waitingHint")}
          </Text>
        ) : null}
        {state === "cut_off" ? (
          <div className="flex min-w-0 flex-col items-start gap-[var(--werft-space-1)]">
            <Text variant="meta" className="m-0 text-destructive">
              {t("session.steps.cutOff")}
            </Text>
            {cutOffAction?.(step)}
          </div>
        ) : null}
        {blocked ? <BlockedNote blocked={blocked} agent={agent} /> : null}
      </div>
    </li>
  );
}
