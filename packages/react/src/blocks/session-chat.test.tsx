import { describe, expect, test } from "bun:test";
import type { TurnSummary } from "@werft-ai/contracts";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import type { SessionEventFrame } from "../sessions.ts";

await setupDom();
// After setupDom: session-chat loads @werft-ai/ui, whose Radix decides at
// import time whether a DOM exists, for every later file in the run too.
const { chatItems } = await import("./session-chat.tsx");

const DELETED_AT = "2026-11-23T02:00:00.000Z";

const turn = (
  turn_id: string,
  message: string,
  source_deleted_at: string | null,
): TurnSummary => ({
  turn_id,
  session_id: "0192f0c4-3d1e-4c7a-9b2f-5e6d7c8a9b01",
  status: "completed",
  message,
  channel: "slack",
  created_by: null,
  requester: null,
  slack_permalink: null,
  source_deleted_at,
  terminal_reason: null,
  prepended_turn_id: null,
  checkpoint_revision: null,
  created_at: `2026-11-23T01:0${turn_id}:00.000Z`,
  started_at: null,
  ended_at: null,
});

const frame = (
  id: string,
  turnId: string,
  minute: string,
  payload: SessionEventFrame["payload"],
): SessionEventFrame => ({
  id,
  turnId,
  attemptId: null,
  occurredAt: `2026-11-23T01:0${minute}:00.000Z`,
  payload,
});

// As streamed before the delete: the text is in the frames themselves.
const EVENTS: SessionEventFrame[] = [
  frame("1", "1", "1", {
    event: "assistant",
    data: { type: "assistant", text: "Secret answer" },
  }),
  frame("2", "1", "1", {
    event: "tool_use",
    data: {
      type: "assistant",
      tool_call: { id: "tu-1", name: "Read", input: { path: "secret" } },
    },
  }),
  frame("3", "1", "1", {
    event: "tool_result",
    data: {
      tool_result: {
        tool_call_id: "tu-1",
        is_error: false,
        text: "Secret file",
      },
    },
  }),
  frame("4", "2", "2", {
    event: "assistant",
    data: { type: "assistant", text: "Second answer" },
  }),
];

const shape = (items: ReturnType<typeof chatItems>) =>
  items.map((item) =>
    item.kind === "user"
      ? ["user", item.turn.message, item.turn.source_deleted_at]
      : item.kind === "reply"
        ? ["reply", item.text, item.withheld ?? false]
        : item.kind === "notice"
          ? ["notice", item.text]
          : [
              "tool",
              item.name,
              item.input,
              item.result,
              item.withheld ?? false,
            ],
  );

describe("chatItems for a turn whose Slack message was deleted", () => {
  const format = () => "";

  test("with no deleted message every line reads as streamed", () => {
    expect(
      shape(
        chatItems(
          EVENTS,
          [turn("1", "Secret ask", null), turn("2", "Follow-up", null)],
          format,
        ),
      ),
    ).toEqual([
      ["user", "Secret ask", null],
      ["reply", "Secret answer", false],
      [
        "tool",
        "Read",
        { path: "secret" },
        { text: "Secret file", error: false },
        false,
      ],
      ["user", "Follow-up", null],
      ["reply", "Second answer", false],
    ]);
  });

  test("the withheld turn shows placeholders, even for text it streamed before; the next turn reads as streamed", () => {
    expect(
      shape(
        chatItems(
          EVENTS,
          [turn("1", "", DELETED_AT), turn("2", "Follow-up", null)],
          format,
        ),
      ),
    ).toEqual([
      ["user", "", DELETED_AT],
      ["reply", "", true],
      ["tool", "Read", {}, { text: "", error: false }, true],
      ["user", "Follow-up", null],
      ["reply", "Second answer", false],
    ]);
  });
  test("frames marked withheld show placeholders without the turns read, an error too", () => {
    const marked = [
      ...EVENTS.slice(0, 3),
      frame("5", "1", "1", {
        event: "error",
        data: { message: "Withheld: this turn's Slack message was deleted" },
      }),
    ].map((item) => ({ ...item, sourceDeletedAt: DELETED_AT }));
    expect(shape(chatItems(marked, undefined, format))).toEqual([
      ["reply", "", true],
      ["tool", "Read", {}, { text: "", error: false }, true],
      ["reply", "", true],
    ]);
  });

  test("a frame marked withheld hides the instruction of turns read before the delete", () => {
    const later = {
      ...frame("5", "1", "2", {
        event: "tool_result",
        data: {
          tool_result: { tool_call_id: "tu-1", is_error: false, text: "" },
        },
      }),
      sourceDeletedAt: DELETED_AT,
    };
    expect(
      shape(
        chatItems(
          [later],
          [turn("1", "Secret ask", null), turn("2", "Follow-up", null)],
          format,
        ),
      ),
    ).toEqual([
      ["user", "", DELETED_AT],
      ["user", "Follow-up", null],
    ]);
  });

  test("one frame marked withheld hides the frames of its turn streamed before it", () => {
    const later = {
      ...frame("5", "1", "2", {
        event: "tool_result",
        data: {
          tool_result: { tool_call_id: "tu-1", is_error: false, text: "" },
        },
      }),
      sourceDeletedAt: DELETED_AT,
    };
    expect(
      shape(
        chatItems(
          [...EVENTS.slice(0, 2), later, EVENTS[3]!],
          undefined,
          format,
        ),
      ),
    ).toEqual([
      ["reply", "", true],
      ["tool", "Read", {}, { text: "", error: false }, true],
      ["reply", "Second answer", false],
    ]);
  });
});

describe("chatItems for a turn its worker's lost lease cut off", () => {
  test("says so where the turn ended, naming the turn, for that turn alone", () => {
    const lost: TurnSummary = {
      ...turn("1", "Run the ten steps", null),
      status: "failed",
      terminal_reason: "worker_ownership_lost",
      ended_at: "2026-11-23T01:01:30.000Z",
    };
    const other: TurnSummary = {
      ...turn("2", "Follow-up", null),
      status: "failed",
      terminal_reason: "runtime_error",
      ended_at: "2026-11-23T01:06:00.000Z",
    };
    const items = chatItems([EVENTS[0]!], [lost, other], () => "");
    expect(shape(items)).toEqual([
      ["user", "Run the ten steps", null],
      ["reply", "Secret answer", false],
      ["reply", "", false],
      ["user", "Follow-up", null],
    ]);
    expect(items[2]).toMatchObject({ error: true, ownershipLost: "1" });
    expect(items.filter((item) => "ownershipLost" in item)).toHaveLength(1);
  });
});

describe("chatItems for a turn stopped by the workspace limit", () => {
  const format = () => "";

  test("says so after the turn's replies, for that turn alone", () => {
    const stopped: TurnSummary = {
      ...turn("1", "Write a big file", null),
      status: "failed",
      terminal_reason: "workspace_quota_exceeded",
      ended_at: "2026-11-23T01:01:30.000Z",
    };
    const other: TurnSummary = {
      ...turn("2", "Follow-up", null),
      status: "failed",
      terminal_reason: "runtime_error",
      ended_at: "2026-11-23T01:06:00.000Z",
    };
    const items = chatItems([EVENTS[0]!], [stopped, other], format);
    expect(shape(items)).toEqual([
      ["user", "Write a big file", null],
      ["reply", "Secret answer", false],
      ["reply", "", false],
      ["user", "Follow-up", null],
    ]);
    expect(items[2]).toMatchObject({
      error: true,
      workspaceQuotaExceeded: true,
    });
  });
});
describe("chatItems for background work stopped while idle", () => {
  const format = (part: {
    key: string;
    params?: Readonly<Record<string, string | number>>;
  }) => `${part.key}(${part.params?.commands ?? ""})`;
  const stopped = (id: string, minute: string, data: Record<string, unknown>) =>
    frame(id, "1", minute, {
      event: "system",
      data: { type: "system", subtype: "background_tasks_stopped", ...data },
    });

  test("is one line at its time, even when it arrives after later lines", () => {
    const items = chatItems(
      [
        ...EVENTS.filter((event) => event.id === "1" || event.id === "4"),
        // Streamed last, it happened between turn 1's reply and turn 2.
        {
          ...stopped("5", "1", { commands: ["bash", "sleep"] }),
          occurredAt: "2026-11-23T01:01:30.000Z",
        },
      ],
      [turn("1", "Start a loop", null), turn("2", "Follow-up", null)],
      format,
    );
    expect(shape(items)).toEqual([
      ["user", "Start a loop", null],
      ["reply", "Secret answer", false],
      ["notice", "session.event.backgroundTasksStopped(bash, sleep)"],
      ["user", "Follow-up", null],
      ["reply", "Second answer", false],
    ]);
    // It shows its own time, not the line before it.
    expect(items[2]?.at).toBe("2026-11-23T01:01:30.000Z");
  });

  test("names only the checked commands, whatever else the event carries", () => {
    const items = chatItems(
      [
        stopped("5", "1", {
          commands: ["bash", "rm -rf /", "sleep"],
          engine_event: { name: "x".repeat(500), category: "other" },
        }),
      ],
      [],
      format,
    );
    expect(shape(items)).toEqual([
      ["notice", "session.event.backgroundTasksStopped(bash, sleep)"],
    ]);
  });

  test("draws nothing for an event with no command it could name", () => {
    expect(
      chatItems(
        [stopped("5", "1", { commands: [] }), stopped("6", "1", {})],
        [],
        format,
      ),
    ).toEqual([]);
  });
});
