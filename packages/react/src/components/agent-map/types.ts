import type { SessionStatus } from "@werft-ai/contracts";
import type { StatusDotStatus } from "@werft-ai/ui";

export type RunStatus = StatusDotStatus;

/** "interrupted": its turn or the session ended before a result came. */
export type ToolCallState =
  | "ok"
  | "error"
  | "running"
  | "waiting"
  | "interrupted";

export interface MapToolCall {
  readonly id: string;
  /** The tool_use name; the design's six names get their own icon. */
  readonly name: string;
  /** One line of the call's input: a path, a command, a pattern. */
  readonly target: string;
  readonly state: ToolCallState;
}

/**
 * How the selected session reaches a row. `delegation` is a subagent its
 * Task/Agent tool_use spawned (parent_tool_use_id), or the session's own
 * direct calls; `approval` is a run held on a person's answer. The message
 * kinds connect another session and are drawn only once sessions can
 * message each other.
 */
export type MapEdgeKind =
  | "delegation"
  | "approval"
  | "request"
  | "response"
  | "waiting";

export interface MapRunNode {
  readonly kind: "run";
  readonly id: string;
  /** subagent_type of the Task tool_use; null for the session's own calls. */
  readonly label: string | null;
  readonly status: RunStatus;
  readonly edge: "delegation" | "approval";
  /** Newest first, as many as the row shows. */
  readonly tools: readonly MapToolCall[];
  /** Calls beyond `tools`. */
  readonly hiddenTools?: number | undefined;
  /** Just arrived: marked until the next update. */
  readonly fresh?: boolean | undefined;
}

export interface MapSessionNode {
  readonly kind: "session";
  readonly id: string;
  readonly agent: string;
  readonly title: string;
  readonly status: SessionStatus;
  readonly edge: "request" | "response" | "waiting";
  /** The newest message between the two sessions, one line. */
  readonly message: string;
  /** When that message was sent, ISO 8601. */
  readonly at: string;
  readonly fresh?: boolean | undefined;
}

/** One row of the relation panel, in arrival order: new rows only append. */
export type MapNode = MapRunNode | MapSessionNode;

export type Lane = "attention" | "running" | "queued" | "idle" | "done";

export interface MapSession {
  readonly id: string;
  readonly title: string;
  readonly agent: string;
  readonly status: SessionStatus;
  readonly model: string;
  readonly branch: string | null;
  /** ISO 8601. */
  readonly lastEventAt: string;
  /** The newest assistant line or tool description. */
  readonly note: string;
  readonly toolCount: number;
  readonly errorCount: number;
  readonly subagentCount: number;
  /** The open request a person has to answer. */
  readonly pending?:
    | {
        /** "request": waiting, but on a request the list does not show. */
        readonly kind: "approval" | "question" | "request";
        readonly tool: string;
        readonly waitedMinutes: number;
      }
    | undefined;
  /**
   * A turn's outcome is unknown and a person owes a recovery decision. The
   * status does not say it: a terminate that cut a running turn is `stopped`.
   */
  readonly needsRecovery?: boolean | undefined;
  /** The lane the card keeps until the reader tidies the board. */
  readonly pinnedLane?: Lane | undefined;
  readonly fresh?: boolean | undefined;
}
