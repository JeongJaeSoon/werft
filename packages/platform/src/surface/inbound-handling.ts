import type {
  BindingListen,
  BindingMode,
  ConversationRollout,
} from "@werft-ai/contracts";

// The conversation layer's handling table: what becomes of one input, by the
// channel's listen setting, the place, the thread's work and the input's
// kind. Pure; the receive path asks it and does the work (a0/D2 on).

/** Section 10's stops, checked before anything else. */
export const LIFECYCLE_STOP_VALUES = [
  "channel_archived",
  "bot_removed",
  "pending_approval",
  "agent_inactive",
] as const;
export type LifecycleStop = (typeof LIFECYCLE_STOP_VALUES)[number];

/**
 * `mention`: a mention of the agent, top-level or in a thread. `top_level`
 * and `reply`: a person's unmentioned message. `web_write`: a write to the
 * channel from the web or the Conversation API. `direct_instruction`: a turn
 * sent to a session itself. `stop_request`: the requester's "stop" alone in
 * the work's thread. `report` is outgoing: the work reporting to its thread.
 */
export const INBOUND_INPUT_VALUES = [
  "mention",
  "top_level",
  "reply",
  "web_write",
  "direct_instruction",
  "stop_request",
  "start_button",
  "allowed_bot_mention",
  "other_bot",
  "report",
] as const;
export type InboundInput = (typeof INBOUND_INPUT_VALUES)[number];

export type InboundCase = {
  place: "channel" | "dm";
  /** The work bound to the input's thread: none, open, or closed. */
  work: "none" | "open" | "closed";
  /** The agent answered in the thread or was mentioned there. */
  engaged: boolean;
  input: InboundInput;
};

export type InboundContext = InboundCase & {
  rollout: ConversationRollout;
  mode: BindingMode;
  listen: BindingListen;
  lifecycleStop: LifecycleStop | null;
};

/**
 * `m2`: answer as a new message. `m1`: judge whether to step in.
 * `buffer_m1`: hold in the buffer for that judgment. `to_task`: a turn of
 * the bound work (M0). `m1_to_task`: judged, then the work's turn or silence.
 */
export const TABLE_HANDLING_VALUES = [
  "not_received",
  "lifecycle_stopped",
  "m2",
  "m1",
  "buffer_m1",
  "to_task",
  "m1_to_task",
  "drop",
  "drop_with_off_notice",
  "reject_write",
  "reject_closed_session",
  "stop_session",
  "start_task",
  "expire_start",
  "outside_layer",
  "post_report",
] as const;
export type TableHandling = (typeof TABLE_HANDLING_VALUES)[number];

/**
 * `current_path`: the receive path as it was before the layer. In `shadow`
 * it carries the table's answer, for the record only.
 */
export type InboundHandling =
  | { kind: "table"; handling: TableHandling }
  | { kind: "current_path"; shadow: TableHandling | null };

// Slack input is what the binding's mode admits; a turn sent to a session and
// the work's own reports never came through it.
const NOT_SLACK_INPUT: ReadonlySet<InboundInput> = new Set([
  "web_write",
  "direct_instruction",
  "report",
]);

export function inboundHandling(context: InboundContext): InboundHandling {
  if (context.mode === "off" && !NOT_SLACK_INPUT.has(context.input)) {
    return { kind: "table", handling: "not_received" };
  }
  if (context.rollout === "off") return { kind: "current_path", shadow: null };
  const handling = tableHandling(context);
  return context.rollout === "shadow"
    ? { kind: "current_path", shadow: handling }
    : { kind: "table", handling };
}

// v2.4 5-6, with row 4 changed by decision 48: under `free` a reply in a
// thread the agent is not part of goes to the buffer too. Checked in order:
// lifecycle, direct instruction and stop, bound thread, listen setting.
export function tableHandling(
  context: Omit<InboundContext, "rollout" | "mode">,
): TableHandling {
  const { place, work, engaged, input, listen, lifecycleStop } = context;
  if (lifecycleStop !== null) return "lifecycle_stopped";

  switch (input) {
    case "direct_instruction": // 10, 11
      return work === "open" ? "to_task" : "reject_closed_session";
    case "stop_request": // 12; with no open work it is a plain reply
      if (work === "open") return "stop_session";
      break;
    case "report": // 18
      return "post_report";
    case "allowed_bot_mention": // 16
      return "outside_layer";
    case "other_bot": // 17
      return "drop";
    case "start_button": // 13
      return listen === "off" ? "expire_start" : "start_task";
  }

  // 14, 15: a DM has no listen setting.
  if (place === "dm") return work === "open" ? "to_task" : "m2";

  const off = listen === "off";
  if (input === "web_write") {
    // 9: as a mention (1, 5, 7), refused where the channel listens to nothing.
    if (off) return "reject_write";
    return work === "open" ? "to_task" : "m2";
  }
  if (input === "mention") {
    if (work === "open") return "to_task"; // 5
    return off ? "drop_with_off_notice" : "m2"; // 1, 7
  }
  if (input === "top_level") {
    return listen === "free" ? "buffer_m1" : "drop"; // 2
  }
  // An unmentioned reply.
  if (off) return "drop"; // 3, 4, 6, 8
  if (work === "open") return "m1_to_task"; // 6
  if (work === "closed" || engaged) return "m1"; // 8, 3
  return listen === "free" ? "buffer_m1" : "drop"; // 4
}
