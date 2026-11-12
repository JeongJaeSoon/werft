import type { SessionEventFrame } from "@werft-ai/client";
import {
  eventToolCall,
  eventToolResult,
  type StatusEventPhase,
} from "@werft-ai/contracts";
import type { RunStatus, ToolCallState } from "./components/agent-map/types.ts";

/*
 * One session's events as the tree the agent map's relation panel draws: the
 * session's own run, the subagent runs its Task/Agent calls spawned (linked
 * only by parent_tool_use_id, never across sessions), and each run's tool
 * calls paired with their results. The result does not depend on the order
 * frames arrive in or on a frame arriving twice: where two frames disagree,
 * the earlier one by (occurredAt, id) wins.
 */

export interface ToolNode {
  /** The tool_use id. */
  readonly id: string;
  readonly name: string;
  /** What the call acts on, read from its input; "" when the input names nothing. */
  readonly target: string;
  readonly state: ToolCallState;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly ms: number | null;
}

export interface RunTreeNode {
  readonly kind: "run";
  /** `ROOT_RUN_ID` for the session's own run, else the spawning tool_use id. */
  readonly id: string;
  /** Null for the session's own run; a subagent's subagent_type, else its tool name. */
  readonly label: string | null;
  readonly status: RunStatus;
  /** "approval" while a call of a run still going waits on a person's permission; a question only makes it "wait". */
  readonly edge: "delegation" | "approval";
  /** Oldest first. */
  readonly tools: readonly ToolNode[];
  /** In spawn order. */
  readonly children: readonly RunTreeNode[];
  /** The call that spawned this run, in its parent's tools; null for the root and a run whose call has not arrived. */
  readonly spawn: ToolNode | null;
  readonly startedAt: string | null;
  /**
   * The spawning call's result. The session's own run starts at its first
   * event and ends at the latest status saying it is not working.
   */
  readonly endedAt: string | null;
  readonly ms: number | null;
  /** Calls of this run that ended in an error. */
  readonly failed: number;
}

export interface RunTree {
  readonly root: RunTreeNode;
  /**
   * Runs drawn apart from the root: their spawning call has not arrived (or
   * fell out of the event window), or their parent_tool_use_id chain loops.
   */
  readonly detached: readonly RunTreeNode[];
  readonly tools: number;
  readonly errors: number;
}

export type RunTreeFrame = Pick<
  SessionEventFrame,
  "id" | "occurredAt" | "turnId" | "payload"
>;

export interface RunTreeBuilder {
  /** False when the frame's id was already taken in, as a reconnect replays them. */
  push(frame: RunTreeFrame): boolean;
  /** Only runs a push touched since the last call are rebuilt; the rest keep their identity. */
  tree(): RunTree;
}

export const ROOT_RUN_ID = "root";

export const SPAWNING_TOOLS = new Set(["Task", "Agent"]);
const TARGET_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
] as const;
const PHASE_STATUS: Record<StatusEventPhase, RunStatus> = {
  queued: "idle",
  running: "run",
  needs_input: "wait",
  idle: "idle",
  failed: "failed",
  stopped: "done",
  interrupting: "run",
  engine_stopped: "done",
};
// Past these the session is not working, whatever calls are still open.
const LIVE_PHASES = new Set<StatusEventPhase>([
  "running",
  "needs_input",
  "interrupting",
]);

interface Stamp {
  readonly t: number;
  readonly id: string;
  readonly at: string;
}

interface ToolRecord {
  readonly id: string;
  readonly name: string;
  readonly target: string;
  readonly label: string;
  readonly parent: string | null;
  readonly start: Stamp;
  readonly turn: string | null;
}

interface RunRecord {
  readonly id: string;
  parentRun: string | null;
  first: Stamp | null;
  readonly tools: string[];
  readonly children: string[];
}

const before = (a: Stamp, b: Stamp) =>
  a.t < b.t || (a.t === b.t && a.id < b.id);

// An event id is its row id in base36 behind `ev_` (packages/db cursors.ts);
// padded to the 11 digits it may take, string order is storage order. The id
// itself follows, so aliases such as ev_1 and ev_01 still differ.
const EVENT_ID = /^ev_[0-9a-z]{1,11}$/;
const storageOrder = (id: string) =>
  EVENT_ID.test(id) ? `ev_${id.slice(3).padStart(11, "0")}${id}` : id;

function stamp(frame: RunTreeFrame): Stamp {
  const t = Date.parse(frame.occurredAt);
  return {
    t: Number.isNaN(t) ? 0 : t,
    id: storageOrder(frame.id),
    at: frame.occurredAt,
  };
}

function insertSorted(list: string[], id: string, key: (id: string) => Stamp) {
  const mine = key(id);
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (before(mine, key(list[mid] as string))) high = mid;
    else low = mid + 1;
  }
  list.splice(low, 0, id);
}

function remove(list: string[], id: string) {
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
}

function toolUses(data: unknown) {
  const call = eventToolCall(data);
  // A call may not take the root's id, or it would stand in for the root.
  return call !== null && call.id !== ROOT_RUN_ID ? [call] : [];
}

function field(input: unknown, key: string) {
  const value = (input as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function createRunTreeBuilder(): RunTreeBuilder {
  const seen = new Set<string>();
  const tools = new Map<string, ToolRecord>();
  const results = new Map<
    string,
    { readonly end: Stamp; readonly error: boolean }
  >();
  const questions = new Map<string, Stamp>();
  // Calls whose latest question asks for a permission, not for an answer.
  const permissions = new Set<string>();
  const runs = new Map<string, RunRecord>();
  // Sorted when read: a detached run's key changes once its call arrives.
  const detached = new Set<string>();
  // Runs drawn apart because their chain loops; a replaced call may undo it.
  const looped = new Set<string>();
  let lastStatus: {
    readonly stamp: Stamp;
    readonly phase: StatusEventPhase;
  } | null = null;
  let errors = 0;
  // A question is answered once the session moves on from needs_input.
  let answeredUntil: Stamp | null = null;
  const openQuestions = new Set<string>();
  // Calls without a result, and what ends them without one.
  const open = new Set<string>();
  const endedTurns = new Set<string>();
  let sessionEndedAt: Stamp | null = null;
  let sessionFirst: Stamp | null = null;

  const dirtyTools = new Set<string>();
  const dirtyRuns = new Set<string>([ROOT_RUN_ID]);
  const toolCache = new Map<string, ToolNode>();
  const runCache = new Map<string, RunTreeNode>();
  let last: RunTree | null = null;

  runs.set(ROOT_RUN_ID, {
    id: ROOT_RUN_ID,
    parentRun: null,
    first: null,
    tools: [],
    children: [],
  });

  const unanswered = (question: Stamp) =>
    answeredUntil === null || before(answeredUntil, question);

  const runFirst = (id: string) => {
    const spawn = tools.get(id);
    return spawn ? spawn.start : (runs.get(id)?.first ?? { t: 0, id, at: "" });
  };

  const touchTool = (id: string) => {
    dirtyTools.add(id);
    const tool = tools.get(id);
    if (tool) dirtyRuns.add(tool.parent ?? ROOT_RUN_ID);
    // The tool may spawn a run, whose status and end follow the tool's result.
    if (runs.has(id)) dirtyRuns.add(id);
  };

  const setApart = (id: string) => {
    const run = runs.get(id) as RunRecord;
    if (run.parentRun !== null) {
      remove((runs.get(run.parentRun) as RunRecord).children, id);
      dirtyRuns.add(run.parentRun);
      run.parentRun = null;
    }
    detached.add(id);
    dirtyRuns.add(id);
  };

  // The runs on the parent_tool_use_id loop through runId, following the
  // calls as they stand now; empty when its chain ends at the root or an
  // unknown call.
  const loopThrough = (runId: string) => {
    const loop: string[] = [];
    const visited = new Set<string>();
    for (
      let up = tools.get(runId)?.parent ?? null;
      up !== null && !visited.has(up);
      up = tools.get(up)?.parent ?? null
    ) {
      loop.push(up);
      if (up === runId) return loop;
      visited.add(up);
    }
    return [];
  };

  const attach = (runId: string) => {
    const run = runs.get(runId) as RunRecord;
    const spawn = tools.get(runId);
    const parent = spawn ? (spawn.parent ?? ROOT_RUN_ID) : null;
    if (parent === null) {
      setApart(runId);
      return;
    }
    // A loop needs a call inside this run (or the run as its own parent).
    // Every run on it is drawn apart, so the result does not depend on which
    // link arrived last.
    const loop =
      run.tools.length > 0 || parent === runId ? loopThrough(runId) : [];
    if (loop.length > 0) {
      for (const id of loop) {
        looped.add(id);
        setApart(id);
      }
      return;
    }
    looped.delete(runId);
    detached.delete(runId);
    if (run.parentRun !== null) {
      remove((runs.get(run.parentRun) as RunRecord).children, runId);
      dirtyRuns.add(run.parentRun);
    }
    run.parentRun = parent;
    insertSorted((runs.get(parent) as RunRecord).children, runId, runFirst);
    dirtyRuns.add(parent);
    dirtyRuns.add(runId);
  };

  const ensureRun = (id: string, at: Stamp | null) => {
    const run = runs.get(id);
    if (run) {
      if (at && (run.first === null || before(at, run.first))) {
        run.first = at;
        dirtyRuns.add(id);
      }
      return;
    }
    runs.set(id, { id, parentRun: null, first: at, tools: [], children: [] });
    attach(id);
  };

  const removeTool = (record: ToolRecord) => {
    const parent = record.parent ?? ROOT_RUN_ID;
    remove((runs.get(parent) as RunRecord).tools, record.id);
    dirtyRuns.add(parent);
    if (results.get(record.id)?.error) errors -= 1;
    tools.delete(record.id);
    open.delete(record.id);
  };

  const addTool = (record: ToolRecord) => {
    tools.set(record.id, record);
    const parent = record.parent ?? ROOT_RUN_ID;
    ensureRun(parent, record.start);
    insertSorted(
      (runs.get(parent) as RunRecord).tools,
      record.id,
      (id) => (tools.get(id) as ToolRecord).start,
    );
    if (runs.has(record.id)) attach(record.id);
    else if (SPAWNING_TOOLS.has(record.name)) ensureRun(record.id, null);
    if (!results.has(record.id)) open.add(record.id);
    const question = questions.get(record.id);
    if (question && !results.has(record.id) && unanswered(question))
      openQuestions.add(record.id);
    if (results.get(record.id)?.error) errors += 1;
    touchTool(record.id);
  };

  const push = (frame: RunTreeFrame) => {
    if (seen.has(frame.id)) return false;
    seen.add(frame.id);
    const at = stamp(frame);
    if (sessionFirst === null || before(at, sessionFirst)) {
      sessionFirst = at;
      dirtyRuns.add(ROOT_RUN_ID);
    }
    const { payload } = frame;
    switch (payload.event) {
      case "assistant":
      case "tool_use": {
        const parent = payload.data.parent_tool_use_id ?? null;
        ensureRun(parent ?? ROOT_RUN_ID, at);
        toolUses(payload.data).forEach((use) => {
          const start = at;
          const known = tools.get(use.id);
          if (known && !before(start, known.start)) {
            // Whether a run exists must not depend on which frame came first.
            if (SPAWNING_TOOLS.has(use.name)) ensureRun(use.id, null);
            return;
          }
          if (known) removeTool(known);
          const target = TARGET_KEYS.map((key) => field(use.input, key)).find(
            (v) => v !== undefined,
          );
          addTool({
            id: use.id,
            name: use.name,
            target: target ?? "",
            label: field(use.input, "subagent_type") ?? use.name,
            parent,
            start,
            turn: frame.turnId,
          });
          if (known) {
            for (const id of [...looped]) {
              if (loopThrough(id).length === 0) attach(id);
            }
          }
        });
        break;
      }
      case "tool_result": {
        const result = eventToolResult(payload.data);
        if (result === null) break;
        const id = result.tool_call_id;
        const known = results.get(id);
        if (known && !before(at, known.end)) break;
        const error = result.is_error === true;
        if (tools.has(id)) errors += (error ? 1 : 0) - (known?.error ? 1 : 0);
        results.set(id, { end: at, error });
        openQuestions.delete(id);
        open.delete(id);
        touchTool(id);
        break;
      }
      case "result": {
        const turn = frame.turnId;
        if (turn === null || endedTurns.has(turn)) break;
        endedTurns.add(turn);
        for (const id of open) if (tools.get(id)?.turn === turn) touchTool(id);
        break;
      }
      case "question": {
        const id = payload.data.tool_use_id;
        const known = questions.get(id);
        if (known && !before(known, at)) break;
        questions.set(id, at);
        if (payload.data.kind === "permission") permissions.add(id);
        else permissions.delete(id);
        if (tools.has(id) && !results.has(id) && unanswered(at))
          openQuestions.add(id);
        touchTool(id);
        break;
      }
      case "status": {
        const { phase } = payload.data;
        if (lastStatus === null || before(lastStatus.stamp, at)) {
          // The root's status and end follow the latest status.
          if (lastStatus?.phase !== phase || !LIVE_PHASES.has(phase))
            dirtyRuns.add(ROOT_RUN_ID);
          lastStatus = { stamp: at, phase };
        }
        if (phase !== "needs_input" && unanswered(at)) {
          answeredUntil = at;
          for (const id of openQuestions) {
            if (unanswered(questions.get(id) as Stamp)) continue;
            openQuestions.delete(id);
            touchTool(id);
          }
        }
        if (
          !LIVE_PHASES.has(phase) &&
          (sessionEndedAt === null || before(sessionEndedAt, at))
        ) {
          const previous = sessionEndedAt;
          sessionEndedAt = at;
          for (const id of open) {
            const start = (tools.get(id) as ToolRecord).start;
            if (before(start, at) && !(previous && before(start, previous)))
              touchTool(id);
          }
        }
        break;
      }
      default:
        break;
    }
    return true;
  };

  const toolState = (id: string): ToolCallState => {
    const result = results.get(id);
    if (result) return result.error ? "error" : "ok";
    const tool = tools.get(id) as ToolRecord;
    if (
      (tool.turn !== null && endedTurns.has(tool.turn)) ||
      (sessionEndedAt !== null && before(tool.start, sessionEndedAt))
    )
      return "interrupted";
    const question = questions.get(id);
    return question && unanswered(question) ? "waiting" : "running";
  };

  const toolNode = (id: string): ToolNode => {
    const cached = toolCache.get(id);
    if (cached && !dirtyTools.has(id)) return cached;
    const tool = tools.get(id) as ToolRecord;
    const end = results.get(id)?.end ?? null;
    const node: ToolNode = {
      id,
      name: tool.name,
      target: tool.target,
      state: toolState(id),
      startedAt: tool.start.at,
      endedAt: end?.at ?? null,
      ms: end ? Math.max(0, end.t - tool.start.t) : null,
    };
    // A Task call is read twice per tree: in its run's tools and as its child's spawn.
    toolCache.set(id, node);
    dirtyTools.delete(id);
    return node;
  };

  // The session's own run spans its first event to the latest status that
  // says it is not working.
  const rootSpan = (ended: boolean) => {
    const end = ended ? (lastStatus?.stamp ?? null) : null;
    return {
      startedAt: sessionFirst?.at ?? null,
      endedAt: end?.at ?? null,
      ms: end && sessionFirst ? Math.max(0, end.t - sessionFirst.t) : null,
    };
  };

  const buildRun = (id: string): RunTreeNode => {
    const run = runs.get(id) as RunRecord;
    const own = run.tools.map(toolNode);
    const children = run.children.map(
      (child) => runCache.get(child) as RunTreeNode,
    );
    const spawn = id !== ROOT_RUN_ID && tools.has(id) ? toolNode(id) : null;
    const waiting = own.some((tool) => tool.state === "waiting");
    const phase = lastStatus?.phase;
    const ended = phase !== undefined && !LIVE_PHASES.has(phase);
    // A run whose spawning call has its result is over, whatever its own calls say.
    const over =
      spawn !== null && spawn.state !== "running" && spawn.state !== "waiting";
    let status: RunStatus;
    if (id === ROOT_RUN_ID && phase !== undefined && ended)
      status = PHASE_STATUS[phase];
    else if (spawn?.state === "ok") status = "done";
    else if (spawn?.state === "error") status = "failed";
    else if (spawn?.state === "interrupted") status = "done";
    else if (waiting) status = "wait";
    else if (id !== ROOT_RUN_ID) status = "run";
    else if (own.some((tool) => tool.state === "running")) status = "run";
    else status = phase ? PHASE_STATUS[phase] : "idle";
    const node: RunTreeNode = {
      kind: "run",
      id,
      label: id === ROOT_RUN_ID ? null : (tools.get(id)?.label ?? "Task"),
      status,
      edge:
        !over &&
        !(id === ROOT_RUN_ID && ended) &&
        own.some((tool) => tool.state === "waiting" && permissions.has(tool.id))
          ? "approval"
          : "delegation",
      tools: own,
      children,
      spawn,
      ...(id === ROOT_RUN_ID
        ? rootSpan(ended)
        : {
            startedAt: spawn?.startedAt ?? run.first?.at ?? null,
            endedAt: spawn?.endedAt ?? null,
            ms: spawn?.ms ?? null,
          }),
      failed: own.filter((tool) => tool.state === "error").length,
    };
    runCache.set(id, node);
    return node;
  };

  const fresh = (id: string) => runCache.has(id) && !dirtyRuns.has(id);

  // Children first from an explicit stack: a deep parent_tool_use_id chain
  // would overflow the call stack.
  const runNode = (start: string): RunTreeNode => {
    const stack = [start];
    while (stack.length > 0) {
      const id = stack[stack.length - 1] as string;
      if (fresh(id)) {
        stack.pop();
        continue;
      }
      const pending = (runs.get(id) as RunRecord).children.filter(
        (child) => !fresh(child),
      );
      if (pending.length > 0) {
        for (const child of pending) stack.push(child);
        continue;
      }
      stack.pop();
      buildRun(id);
      dirtyRuns.delete(id);
    }
    return runCache.get(start) as RunTreeNode;
  };

  const tree = () => {
    if (last && dirtyRuns.size === 0 && dirtyTools.size === 0) return last;
    // A rebuilt run is a new object, so every run above it is rebuilt too.
    for (const id of [...dirtyRuns]) {
      for (
        let up = runs.get(id)?.parentRun ?? null;
        up !== null;
        up = runs.get(up)?.parentRun ?? null
      ) {
        if (dirtyRuns.has(up)) break;
        dirtyRuns.add(up);
      }
    }
    const root = runNode(ROOT_RUN_ID);
    const apart = [...detached]
      .sort((a, b) => {
        const [first, second] = [runFirst(a), runFirst(b)];
        if (before(first, second)) return -1;
        if (before(second, first)) return 1;
        return a < b ? -1 : 1;
      })
      .map(runNode);
    dirtyRuns.clear();
    dirtyTools.clear();
    last = {
      root,
      detached:
        apart.length === last?.detached.length &&
        apart.every((run, i) => run === last?.detached[i])
          ? last.detached
          : apart,
      tools: tools.size,
      errors,
    };
    return last;
  };

  return { push, tree };
}

export function buildRunTree(frames: readonly RunTreeFrame[]): RunTree {
  const builder = createRunTreeBuilder();
  for (const frame of frames) builder.push(frame);
  return builder.tree();
}

/** The relation panel's rows: the session's run, then every subagent run depth first. */
export function runRows(tree: RunTree): readonly RunTreeNode[] {
  const rows: RunTreeNode[] = [];
  const stack = [...tree.detached].reverse();
  stack.push(tree.root);
  for (let run = stack.pop(); run !== undefined; run = stack.pop()) {
    rows.push(run);
    for (let i = run.children.length - 1; i >= 0; i -= 1) {
      stack.push(run.children[i] as RunTreeNode);
    }
  }
  return rows;
}
