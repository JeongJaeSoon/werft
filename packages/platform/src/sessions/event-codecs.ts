import {
  type RuntimeKind,
  type SessionEventPayload,
  sessionEventPayloadSchema,
} from "@werft-ai/contracts";
import type { EventCodec } from "@werft-ai/runtime-core";

/**
 * One stored or incoming event with the engine-neutral fields added by the
 * codec of its session's runtime, which the session's spec names. An event
 * whose runtime cannot be told (no spec, a kind with no codec installed)
 * comes back as it was.
 */
export type NeutralizeEvent = (
  runtimeKind: RuntimeKind | null,
  event: SessionEventPayload,
) => SessionEventPayload;

export function createNeutralizer(
  codecs: readonly EventCodec[],
  warn: {
    unknown?: (runtimeKind: RuntimeKind | null) => void;
    // The codec's output broke the contract; the event is kept as it was.
    refused?: (kind: RuntimeKind, event: string, reason: string) => void;
  } = {},
): NeutralizeEvent {
  const byKind = new Map<RuntimeKind, EventCodec>(
    codecs.map((codec) => [codec.kind, codec]),
  );
  return (kind, event) => {
    const codec = kind === null ? undefined : byKind.get(kind);
    if (kind === null || codec === undefined) {
      warn.unknown?.(kind);
      return event;
    }
    const out = codec.withNeutralFields(event);
    if (out === event) return out;
    // Stored, a field the contract refuses would leave the event unreadable.
    const checked = sessionEventPayloadSchema.safeParse(out);
    if (checked.success) return out;
    warn.refused?.(kind, event.event, checked.error.message);
    return event;
  };
}

/**
 * Only the neutral fields the codec adds to the data (`events.neutral`), or
 * null when it adds none. The data goes to the codec unparsed: parsing would
 * drop the keys the contract does not name.
 */
export function neutralFieldsOf(
  neutralize: NeutralizeEvent,
  runtimeKind: RuntimeKind | null,
  event: { event: string; data: unknown },
): Record<string, unknown> | null {
  const data = event.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const stored = data as Record<string, unknown>;
  const out = neutralize(runtimeKind, event as SessionEventPayload).data as
    | Record<string, unknown>
    | undefined;
  const added = Object.entries(out ?? {}).filter(([key]) => !(key in stored));
  return added.length === 0 ? null : Object.fromEntries(added);
}
