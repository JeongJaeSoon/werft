import { describe, expect, test } from "bun:test";
import {
  presentTurnEvent,
  type SessionEventPayload,
  sessionEventPayloadSchema,
  withStoredNeutralFields,
  workerEventSchema,
} from "@werft-ai/contracts";
import type { EventCodec } from "@werft-ai/runtime-core";
import type { CatalogProfileView } from "./catalog.ts";
import { createNeutralizer, neutralFieldsOf } from "./event-codecs.ts";

// A second engine with an event shape of its own, in the fields the contract
// keeps opaque (`message`, a result's or a tool result's own keys): its codec
// reads them, no consumer outside it does.
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
          : event.event === "tool_result"
            ? {
                tool_result: {
                  tool_call_id: item.call,
                  is_error: item.failed,
                  text: item.output,
                },
              }
            : event.event === "result"
              ? {
                  turn: {
                    outcome: item.outcome,
                    is_error: false,
                    terminal_reason: null,
                    tokens: item.tokens,
                  },
                  runtime: {
                    kind: "codex_app_server",
                    session_ref: item.thread,
                  },
                }
              : {};
    return { ...event, data: { ...data, ...added } } as SessionEventPayload;
  },
};

const catalog = {
  profiles: {
    second: { runtime_kind: "codex_app_server" } as CatalogProfileView,
    other: { runtime_kind: "pi_coding_agent" } as CatalogProfileView,
  },
};

const stream: SessionEventPayload[] = [
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
    event: "tool_result",
    data: {
      type: "tool_result",
      item: { call: "c1", failed: false, output: "README.md" },
    },
  },
  {
    event: "assistant",
    data: { type: "assistant", message: { said: "Done." } },
  },
  {
    event: "result",
    data: {
      type: "result",
      item: { outcome: "completed", tokens: 12, thread: "th_1" },
    },
  },
] as SessionEventPayload[];

describe("createNeutralizer", () => {
  test("picks the codec the session profile's runtime kind names", () => {
    const unknown: Array<string | null> = [];
    const neutralize = createNeutralizer([secondEngine], catalog, {
      unknown: (id) => unknown.push(id),
    });
    const [said] = stream;
    expect(
      neutralize("second", said as SessionEventPayload).data,
    ).toMatchObject({ text: "Looking." });
    // No profile, a profile gone from the catalog, a kind with no codec.
    for (const id of [null, "gone", "other"]) {
      expect(neutralize(id, said as SessionEventPayload)).toBe(
        said as SessionEventPayload,
      );
    }
    expect(unknown).toEqual([null, "gone", "other"]);
  });

  test("fields the contract refuses are not added, with a warning", () => {
    const broken: EventCodec = {
      kind: "codex_app_server",
      withNeutralFields: (event) =>
        ({
          ...event,
          data: { ...event.data, tool_call: { id: 7 } },
        }) as SessionEventPayload,
    };
    const [said] = stream as [SessionEventPayload];
    const refused: string[] = [];
    const neutralize = createNeutralizer([broken], catalog, {
      refused: (kind, event) => refused.push(`${kind} ${event}`),
    });
    expect(neutralize("second", said)).toBe(said);
    expect(refused).toEqual(["codex_app_server assistant"]);
  });

  test("a second engine's stream reads through the neutral fields alone", () => {
    const neutralize = createNeutralizer([secondEngine], catalog);
    // As /append-events takes it, stores it (neutral fields beside the data)
    // and the event stream reads it back.
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
      const neutral = neutralFieldsOf(neutralize, "second", event);
      return sessionEventPayloadSchema.parse({
        event: event.event,
        data: withStoredNeutralFields(event.data, neutral),
      });
    });
    for (const event of events) {
      for (const engineField of ["session_id", "native_type"]) {
        expect(event.data).not.toHaveProperty(engineField);
      }
    }
    expect(events.map((event) => presentTurnEvent(event).summary)).toEqual([
      [{ text: "Looking." }],
      [{ text: "shell: ls" }],
      [
        { key: "session.event.toolResult.unknown" },
        { key: "session.event.toolResult.ok" },
        { text: "README.md" },
      ],
      [{ text: "Done." }],
      [
        { key: "session.event.result.other", params: { subtype: "completed" } },
        { key: "session.event.result.tokens", params: { count: 12 } },
      ],
    ]);
    expect(presentTurnEvent(events[4] as SessionEventPayload).error).not.toBe(
      true,
    );
  });
});
