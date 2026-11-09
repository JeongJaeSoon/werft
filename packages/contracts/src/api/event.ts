import { z } from "zod";

import {
  attemptIdSchema,
  opaqueCursorSchema,
  requestIdSchema,
  requiredUnknownSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
} from "../shared/index.ts";
import { admissionStateSchema, SESSION_STATUS_VALUES } from "./session.ts";

export const SESSION_EVENT_NAMES = [
  "system",
  "assistant",
  "tool_use",
  "tool_result",
  "question",
  "result",
  "status",
  "error",
] as const;
export const SSE_SCHEMA_VERSION = 1;
/** The `error` event code for an attempt cut because its model left the list. */
export const MODEL_NOT_ALLOWED_EVENT_CODE = "MODEL_NOT_ALLOWED";
/**
 * Why the session's model stopped being allowed, as `data.cause` of that
 * event: the profile's list no longer has it, or the profile (its connection)
 * is gone altogether. Events written before the field are `model_removed`.
 */
export const MODEL_CUT_CAUSE_VALUES = [
  "model_removed",
  "profile_removed",
] as const;
export type ModelCutCause = (typeof MODEL_CUT_CAUSE_VALUES)[number];
// A status event reports the session's projected status, or a control step
// that no stored status names: an interrupt the worker has taken and is
// waiting on the engine's terminal for (`interrupting`), and the engine
// having stopped the turn on that interrupt (`engine_stopped`). The
// latter is the interrupt's effect; the turn is `interrupted` only once its
// checkpoint is committed, which may come later or not at all.
export const STATUS_EVENT_PHASE_VALUES = [
  ...SESSION_STATUS_VALUES,
  "interrupting",
  "engine_stopped",
] as const;
export const statusEventPhaseSchema = z.enum(STATUS_EVENT_PHASE_VALUES);

// The `system` subtypes the control plane writes, as opposed to the
// engine's: a reader may act on these without reading any engine output.
// They ride the v1 `system` event, whose payload is open, so a reader that
// does not know one shows it as an ordinary system line.
export const PLATFORM_SYSTEM_SUBTYPE_VALUES = [
  "session_closed",
  "input_wait",
  "context_gap_detected",
  "checkpoint_objects_lost",
  "checkpoint_restore_failed",
  "checkpoint_restore_fallback",
  "startup_failed",
  "transcript_near_limit",
  "execution_revoked",
  "execution_restored",
  "recovery_decision",
  "transcript_limit_reached",
  "workspace_limit_mode",
] as const;
// `parked` when a park commits, `expired` when a parked group's last
// requests expire, `lost` when the worker that held them went away first.
// It reports a stage of the wait; each request's own outcome is still the
// question and status events'.
export const INPUT_WAIT_STAGE_VALUES = ["parked", "expired", "lost"] as const;
export const inputWaitEventDataSchema = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("input_wait"),
    stage: z.enum(INPUT_WAIT_STAGE_VALUES),
    request_ids: z.array(requestIdSchema).min(1),
  })
  .strict();

// Engine-neutral fields. The session's runtime codec adds them beside the
// v1 payload when an event is stored; everything outside the runtime
// adapters reads these and never the engine's own fields, which stay in
// v1 for API compatibility as opaque values.
const ENGINE_SPECIFIC =
  "Engine-specific and opaque: its shape belongs to the session's runtime and may be absent for another one. Read the engine-neutral fields instead.";
const opaque = <T extends z.ZodType>(schema: T) =>
  schema.meta({ description: ENGINE_SPECIFIC });

export const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  input: requiredUnknownSchema,
});
export const toolResultSchema = z.object({
  tool_call_id: z.string().min(1),
  // Null when the engine said something other than true or false.
  is_error: z.boolean().nullable(),
  text: z.string(),
});
// What a reader shows for a `system` event the engine wrote; the platform's
// own subtypes are PLATFORM_SYSTEM_SUBTYPE_VALUES and carry none.
export const ENGINE_EVENT_CATEGORY_VALUES = [
  "started",
  "thinking",
  "workspace",
  "internal",
  "other",
] as const;
export const engineEventSchema = z.object({
  name: z.string(),
  category: z.enum(ENGINE_EVENT_CATEGORY_VALUES),
});
export const turnEndSchema = z.object({
  outcome: z.string().min(1),
  is_error: z.boolean(),
  terminal_reason: z.string().min(1).nullable(),
  // Input plus output tokens, when the engine counted any.
  tokens: z.number().nonnegative().nullable(),
});
export const runtimeRefSchema = z.object({
  kind: z.string().min(1),
  // The engine's own id for the session, not the platform's.
  session_ref: z.string().min(1).nullable(),
});

const assistantMessagePayloadSchema = z.object({
  type: z.literal("assistant"),
  message: opaque(requiredUnknownSchema.optional()),
  parent_tool_use_id: z.string().min(1).nullable().optional(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  tool_call: toolCallSchema.optional(),
});

// Per-kind payloads: the worker projects native SDK messages into these and the
// server wraps them into the public envelope.
export const sessionEventVariants = {
  system: z.object({
    event: z.literal("system"),
    data: z.looseObject({
      type: z.literal("system"),
      engine_event: engineEventSchema.optional(),
      native_type: opaque(z.unknown().optional()),
      schema_version: opaque(z.unknown().optional()),
      sdk_version: opaque(z.unknown().optional()),
      correlation_id: opaque(z.unknown().optional()),
    }),
  }),
  assistant: z.object({
    event: z.literal("assistant"),
    data: assistantMessagePayloadSchema,
  }),
  tool_use: z.object({
    event: z.literal("tool_use"),
    data: assistantMessagePayloadSchema,
  }),
  tool_result: z.object({
    event: z.literal("tool_result"),
    // Any value the engine sent; an object carries `tool_result`
    // (toolResultSchema) once the codec read it.
    data: requiredUnknownSchema.meta({
      description: `${ENGINE_SPECIFIC} An object here carries the engine-neutral \`tool_result\` field: { tool_call_id, is_error, text }.`,
    }),
  }),
  question: z.object({
    event: z.literal("question"),
    data: z.object({
      request_id: requestIdSchema,
      tool_use_id: z.string().min(1),
      kind: z.enum(["permission", "question"]),
      tool: z.string().min(1).optional(),
      input: requiredUnknownSchema,
      // When the control plane stops taking answers for it. Absent on
      // questions an older worker published itself.
      expires_at: timestampSchema.optional(),
    }),
  }),
  result: z.object({
    event: z.literal("result"),
    data: z.looseObject({
      type: z.literal("result"),
      subtype: opaque(z.string().min(1).optional()),
      session_id: opaque(z.string().min(1).optional()),
      usage: opaque(requiredUnknownSchema.optional()),
      turn: turnEndSchema.optional(),
      runtime: runtimeRefSchema.optional(),
    }),
  }),
  status: z.object({
    event: z.literal("status"),
    data: z.looseObject({
      phase: statusEventPhaseSchema,
      admission_state: admissionStateSchema.optional(),
      // Set on the event a rename or a generated title writes: the
      // session's title from then on.
      title: z.string().min(1).optional(),
    }),
  }),
  error: z.object({
    event: z.literal("error"),
    data: z.looseObject({
      message: z.string().min(1),
      // MODEL_NOT_ALLOWED: the proxy cut the attempt because its model left
      // the profile's list; `model` names it.
      code: z.string().min(1).optional(),
    }),
  }),
} as const;

const v = sessionEventVariants;
type EventVariant =
  (typeof sessionEventVariants)[keyof typeof sessionEventVariants];

const sseEnvelopeSchema = z.object({
  schema_version: z.literal(SSE_SCHEMA_VERSION),
  session_id: sessionIdSchema,
  turn_id: turnIdSchema.nullable(),
  attempt_id: attemptIdSchema.nullable(),
  occurred_at: timestampSchema.meta({
    description:
      "When the event happened: for an engine event, when the worker published it; for a control-plane event, when the control plane recorded it. A new event is stamped no earlier than the one before it in `id` order; events stored before that rule may still go back. Order and resume by `id`, not by this time: events can share it.",
  }),
});

function record<V extends EventVariant>(variant: V) {
  return variant.extend({ id: opaqueCursorSchema });
}
function frame<V extends EventVariant>(variant: V) {
  return z.object({
    id: opaqueCursorSchema,
    event: variant.shape.event,
    data: sseEnvelopeSchema.extend({ data: variant.shape.data }),
  });
}

export const sessionEventPayloadSchema = z.discriminatedUnion("event", [
  v.system,
  v.assistant,
  v.tool_use,
  v.tool_result,
  v.question,
  v.result,
  v.status,
  v.error,
]);
// Stored/projected event: server-assigned cursor plus kind and payload.
export const sessionEventSchema = z.discriminatedUnion("event", [
  record(v.system),
  record(v.assistant),
  record(v.tool_use),
  record(v.tool_result),
  record(v.question),
  record(v.result),
  record(v.status),
  record(v.error),
]);
// Public SSE frame: `id` is the replay cursor, `data` is the versioned envelope.
export const sseEventSchema = z.discriminatedUnion("event", [
  frame(v.system),
  frame(v.assistant),
  frame(v.tool_use),
  frame(v.tool_result),
  frame(v.question),
  frame(v.result),
  frame(v.status),
  frame(v.error),
]);

// A stored row the contract does not read (written before every writer was
// held to it) would otherwise stop each read at that row for good:
// no page past it could be served and the cursor could never move on. It
// reads instead as an `error` event under its own cursor. This code is not
// terminal; the session's state is read from the session, not from here.
// The flip side: a reader cannot tell such a row from one a newer writer
// stored, so widening this contract (a new kind or enum value) must reach
// every reader before any writer uses it.
export const UNREADABLE_EVENT_CODE = "EVENT_UNREADABLE";

export function readStoredEvent(
  event: string,
  data: unknown,
): { payload: SessionEventPayload; readable: boolean } {
  const parsed = sessionEventPayloadSchema.safeParse({ event, data });
  if (parsed.success) return { payload: parsed.data, readable: true };
  return {
    payload: {
      event: "error",
      data: {
        message: "This event could not be read and was replaced",
        code: UNREADABLE_EVENT_CODE,
      },
    },
    readable: false,
  };
}

export type SessionEventName = (typeof SESSION_EVENT_NAMES)[number];
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;
export type EngineEvent = z.infer<typeof engineEventSchema>;
export type EngineEventCategory = EngineEvent["category"];
export type TurnEnd = z.infer<typeof turnEndSchema>;
export type RuntimeRef = z.infer<typeof runtimeRefSchema>;
export type StatusEventPhase = z.infer<typeof statusEventPhaseSchema>;
export type InputWaitEventData = z.infer<typeof inputWaitEventDataSchema>;
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SseEvent = z.infer<typeof sseEventSchema>;
