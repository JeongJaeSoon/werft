import type { SessionStatus, SessionSummary } from "@werft-ai/contracts";

import {
  type RunTree,
  type RunTreeNode,
  runRows,
  SPAWNING_TOOLS,
} from "../../run-tree.ts";
import { shortSessionId } from "../session/session-overview.tsx";
import { laneOf } from "./lane-board.tsx";
import type { AgentMapMessages } from "./messages.ts";
import type { Lane, MapRunNode, MapSession, MapToolCall } from "./types.ts";

/** Chips a run row shows before "+n". */
export const ROW_TOOLS = 3;

/** A card from the list's summary, as the board draws it before placement. */
export function mapSessionOf(
  summary: SessionSummary,
  now: number,
  messages: AgentMapMessages,
): MapSession {
  const activity = summary.activity;
  const last = activity?.last ?? null;
  const current = activity?.current_tool ?? null;
  const request = current?.state === "waiting" ? current.request : null;
  const pending =
    current && request
      ? {
          kind:
            request.kind === "question"
              ? ("question" as const)
              : ("approval" as const),
          tool:
            request.kind === "question"
              ? joinTool(messages.question, request.prompt ?? "")
              : joinTool(current.name, current.target),
          waitedMinutes: Math.max(
            0,
            Math.floor((now - Date.parse(current.since)) / 60_000),
          ),
        }
      : summary.status === "needs_input"
        ? // Its request is not in the activity (asked before the event
          // window, or behind a newer open call); it still waits on a person.
          {
            kind: "request" as const,
            tool: messages.openRequest,
            waitedMinutes: Math.max(
              0,
              Math.floor(
                (now -
                  Date.parse(summary.last_event_at ?? summary.created_at)) /
                  60_000,
              ),
            ),
          }
        : undefined;
  const needsRecovery = summary.admission_state === "recovery_required";
  return {
    id: summary.id,
    title: summary.title ?? shortSessionId(summary.id),
    agent: summary.agent?.name ?? messages.noAgent,
    status: summary.status,
    model: summary.model ?? "",
    branch: summary.repository?.branch ?? null,
    lastEventAt: summary.last_event_at ?? summary.created_at,
    // A card that waits says what it waits on, as the strip does.
    note:
      pending?.tool ??
      (needsRecovery
        ? messages.recoveryNote
        : last === null
          ? summary.status === "queued"
            ? messages.queuedNote
            : messages.noActivity
          : last.kind === "text"
            ? last.text
            : joinTool(last.name, last.target)),
    toolCount: activity?.tool_count ?? 0,
    errorCount: activity?.error_count ?? 0,
    subagentCount: activity?.subagent_count ?? 0,
    ...(pending ? { pending } : {}),
    ...(needsRecovery ? { needsRecovery } : {}),
  };
}

function joinTool(name: string, target: string) {
  return [name, target].filter((part) => part !== "").join(" · ");
}

/**
 * The relation panel's rows: the session's own calls, then every subagent
 * run depth first. Each row shows its newest calls first, a subagent's
 * spawns of one type as one chip.
 */
export function runNodesOf(tree: RunTree): MapRunNode[] {
  const rows = runRows(tree);
  const spawned = new Map(rows.map((run) => [run.id, run.label]));
  return rows.map((run) => ({
    kind: "run",
    id: run.id,
    label: rowLabel(run),
    status: run.status,
    edge: run.edge,
    ...newestChips(run, spawned),
  }));
}

function rowLabel(run: RunTreeNode) {
  if (run.label === null) return null;
  const target = run.spawn?.target ?? "";
  return target === "" ? run.label : `${run.label} · ${target}`;
}

function newestChips(
  run: RunTreeNode,
  spawned: ReadonlyMap<string, string | null>,
): { tools: MapToolCall[]; hiddenTools?: number } {
  const tools: MapToolCall[] = [];
  const counts: number[] = [];
  let used = 0;
  for (let i = run.tools.length - 1; i >= 0; i -= 1) {
    const call = run.tools[i] as RunTreeNode["tools"][number];
    const kind = SPAWNING_TOOLS.has(call.name)
      ? (spawned.get(call.id) ?? call.target)
      : null;
    const previous = tools[tools.length - 1];
    if (
      kind !== null &&
      previous?.name === call.name &&
      previous.id.startsWith(`${kind}\u0000`)
    ) {
      const count = (counts[counts.length - 1] as number) + 1;
      counts[counts.length - 1] = count;
      tools[tools.length - 1] = {
        ...previous,
        target: `${kind} × ${count}`,
        state:
          STATE_RANK[call.state] > STATE_RANK[previous.state]
            ? call.state
            : previous.state,
      };
      used += 1;
      continue;
    }
    if (tools.length === ROW_TOOLS) break;
    tools.push(
      kind === null
        ? {
            id: call.id,
            name: call.name,
            target: call.target,
            state: call.state,
          }
        : {
            id: `${kind}\u0000${call.id}`,
            name: call.name,
            target: kind,
            state: call.state,
          },
    );
    counts.push(1);
    used += 1;
  }
  const hidden = run.tools.length - used;
  return hidden > 0 ? { tools, hiddenTools: hidden } : { tools };
}

// The state a grouped chip shows: the one that needs a look first.
const STATE_RANK: Record<MapToolCall["state"], number> = {
  ok: 0,
  interrupted: 1,
  running: 2,
  error: 3,
  waiting: 4,
};

/** What the board remembers between two reads of the list. */
export interface BoardMemory {
  /** The lane each card stands in until the reader tidies up. */
  readonly placed: ReadonlyMap<string, Lane>;
  readonly status: ReadonlyMap<string, SessionStatus>;
}

export interface StatusChange {
  readonly title: string;
  readonly from: SessionStatus;
  readonly to: SessionStatus;
}

/**
 * Places a fresh read of the list: a new card goes to its lane's end, a card
 * whose status moved stays where it stood, marked, until `tidy`. The first
 * read (no memory) marks nothing.
 */
export function arrangeBoard(
  sessions: readonly MapSession[],
  memory: BoardMemory | null,
  tidy: boolean,
): {
  readonly sessions: MapSession[];
  readonly memory: BoardMemory;
  readonly changes: StatusChange[];
  readonly added: number;
} {
  const placed = new Map<string, Lane>();
  const status = new Map<string, SessionStatus>();
  const changes: StatusChange[] = [];
  let added = 0;
  const arranged = sessions.map((session) => {
    const lane = laneOf(session);
    const before = memory?.placed.get(session.id);
    const was = memory?.status.get(session.id);
    // An ended card stood in no lane, so one that resumes has none to keep.
    const kept =
      tidy || before === undefined || before === "done" ? lane : before;
    placed.set(session.id, kept);
    status.set(session.id, session.status);
    if (memory !== null && was === undefined) added += 1;
    if (was !== undefined && was !== session.status)
      changes.push({ title: session.title, from: was, to: session.status });
    const fresh =
      memory !== null && (was === undefined || was !== session.status);
    return {
      ...session,
      ...(kept === lane ? {} : { pinnedLane: kept }),
      ...(fresh ? { fresh } : {}),
    };
  });
  return { sessions: arranged, memory: { placed, status }, changes, added };
}
