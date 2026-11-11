import { expect, test } from "bun:test";
import {
  type SessionEventPayload,
  sessionEventPayloadSchema,
  withStoredNeutralFields,
  workerEventSchema,
} from "@werft-ai/contracts";
import { createNeutralizer, neutralFieldsOf } from "@werft-ai/platform";
import { finalReplyText } from "./slack-outbox-enqueue.ts";

type EventCodec = Parameters<typeof createNeutralizer>[0][number];

// A second engine whose own fields only its codec reads. The reply body is
// built from the neutral fields the codec stores, never from the engine's
// shape (moved here from platform's event-codecs.test.ts, which cannot import
// the adapter).
const secondEngine: EventCodec = {
  kind: "codex_app_server",
  withNeutralFields(event) {
    const data = event.data as Record<string, unknown>;
    const item = (data.item ?? data.message) as
      | Record<string, unknown>
      | undefined;
    if (item === undefined) return event;
    const added =
      event.event === "assistant"
        ? { text: item.said }
        : event.event === "tool_use"
          ? { tool_call: { id: item.call, name: item.tool, input: item.args } }
          : {};
    return { ...event, data: { ...data, ...added } } as SessionEventPayload;
  },
};

const stream = [
  {
    event: "assistant",
    data: { type: "assistant", message: { said: "Looking." } },
  },
  {
    event: "tool_use",
    data: {
      type: "assistant",
      message: { call: "c1", tool: "shell", args: { command: "ls" } },
    },
  },
  {
    event: "assistant",
    data: { type: "assistant", message: { said: "Done." } },
  },
] as SessionEventPayload[];

test("a second engine's reply body reads through the neutral fields alone", () => {
  const neutralize = createNeutralizer([secondEngine]);
  const events = stream.map((sent, index) => {
    const {
      source_sequence: _,
      occurred_at: __,
      ...event
    } = workerEventSchema.parse({
      ...sent,
      source_sequence: index + 1,
      occurred_at: "2026-10-27T00:00:00.000Z",
    });
    const neutral = neutralFieldsOf(neutralize, "codex_app_server", event);
    return sessionEventPayloadSchema.parse({
      event: event.event,
      data: withStoredNeutralFields(event.data, neutral),
    });
  });
  expect(
    finalReplyText(
      events.map((event) => ({ type: event.event, payload: event.data })),
    ),
  ).toBe("Done.");
});
