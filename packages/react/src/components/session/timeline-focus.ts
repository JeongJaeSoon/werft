import type { TurnEventMessage } from "@werft-ai/contracts";

import type { TimelineEntry } from "./timeline.tsx";

/*
 * Focus view: the timeline keeps open what a person reads or answers (the
 * instruction, replies, requests and their outcome, failures, the latest
 * status) and folds each run of the agent's own work between them (tool
 * calls, thinking, status and system bookkeeping) into one line that counts
 * what it did, as Claude Code's focus view does.
 */

/** What a folded line counts, in the order it names them. */
export const WORK_KINDS = [
  "command",
  "read",
  "write",
  "edit",
  "search",
  "tool",
  "event",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export type WorkCounts = Readonly<Record<WorkKind, number>>;

// Claude Code's own tool names; any other tool counts as a tool call.
const TOOL_WORK: Readonly<Record<string, WorkKind>> = {
  Bash: "command",
  BashOutput: "command",
  KillShell: "command",
  Read: "read",
  NotebookRead: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebSearch: "search",
};

// Lines a reader needs whatever surrounds them.
const KEPT: ReadonlySet<TurnEventMessage["key"]> = new Set([
  "session.event.kind.assistant",
  "session.event.kind.permission",
  "session.event.kind.question",
  "session.event.kind.error",
]);

/** A row as the focus view reads it: a call with what landed inside it. */
export interface FocusRow extends TimelineEntry {
  readonly key: string;
  readonly result?: TimelineEntry | undefined;
  readonly inner?: readonly TimelineEntry[] | undefined;
}

export interface FocusContext {
  /** Calls a request holds back: a person has to act, so they stay open. */
  readonly held?: ReadonlySet<string> | undefined;
  /** The key of the timeline's latest status line, which stays open. */
  readonly finalStatus?: string | undefined;
}

/**
 * What a row counts as when focus folds it, or null when it stays open:
 * a reply, a request (and the call it held, answered or not), a failure,
 * and the latest status.
 */
export function focusWork(
  row: FocusRow,
  { held, finalStatus }: FocusContext = {},
): WorkKind | null {
  const { presentation } = row;
  if (presentation.error || row.result?.presentation.error) return null;
  const key = presentation.label.key;
  if (KEPT.has(key)) return null;
  switch (key) {
    case "session.event.kind.toolUse": {
      if (row.toolCallId !== undefined && held?.has(row.toolCallId)) {
        return null;
      }
      // A request answered for it: the answer is the reader's to see.
      if (row.inner?.some((inner) => KEPT.has(inner.presentation.label.key))) {
        return null;
      }
      return (row.toolName && TOOL_WORK[row.toolName]) || "tool";
    }
    case "session.event.kind.status":
      return row.key === finalStatus ? null : "event";
    default:
      // Thinking, a lone tool result, turn end, system and internal lines.
      return "event";
  }
}

/** How many of each kind a folded run holds. */
export function workCounts(
  rows: readonly FocusRow[],
  context: FocusContext = {},
): WorkCounts {
  const counts: Record<WorkKind, number> = {
    command: 0,
    read: 0,
    write: 0,
    edit: 0,
    search: 0,
    tool: 0,
    event: 0,
  };
  for (const row of rows) counts[focusWork(row, context) ?? "event"] += 1;
  return counts;
}

/** The key of the last status line, the one focus leaves open. */
export function finalStatusKey(rows: readonly FocusRow[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.presentation.label.key === "session.event.kind.status") {
      return row.key;
    }
  }
  return undefined;
}
