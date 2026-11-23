import { describe, expect, test } from "bun:test";
import { BINDING_LISTEN_VALUES, type BindingListen } from "@werft-ai/contracts";
import {
  type InboundCase,
  type InboundContext,
  inboundHandling,
  LIFECYCLE_STOP_VALUES,
  type TableHandling,
  tableHandling,
} from "./inbound-handling.ts";

type Row = {
  row: number;
  what: string;
  case: InboundCase;
  // mention, free, off
  expected: readonly [TableHandling, TableHandling, TableHandling];
};

const channel = { place: "channel", engaged: false } as const;
const same = (handling: TableHandling) =>
  [handling, handling, handling] as const;

// v2.4 5-6, one entry per row; row 4 as decision 48 changed it.
const ROWS: Row[] = [
  {
    row: 1,
    what: "a mention with no work",
    case: { ...channel, work: "none", input: "mention" },
    expected: ["m2", "m2", "drop_with_off_notice"],
  },
  {
    row: 1,
    what: "a mention in an engaged thread with no work",
    case: { ...channel, work: "none", engaged: true, input: "mention" },
    expected: ["m2", "m2", "drop_with_off_notice"],
  },
  {
    row: 2,
    what: "an unmentioned top-level message",
    case: { ...channel, work: "none", input: "top_level" },
    expected: ["drop", "buffer_m1", "drop"],
  },
  {
    row: 3,
    what: "an unmentioned reply in an engaged thread",
    case: { ...channel, work: "none", engaged: true, input: "reply" },
    expected: ["m1", "m1", "drop"],
  },
  {
    row: 4,
    what: "an unmentioned reply in a thread the agent is not part of",
    case: { ...channel, work: "none", input: "reply" },
    expected: ["drop", "buffer_m1", "drop"],
  },
  {
    row: 5,
    what: "a mention in an open work's thread",
    case: { ...channel, work: "open", engaged: true, input: "mention" },
    expected: same("to_task"),
  },
  {
    row: 6,
    what: "an unmentioned reply in an open work's thread",
    case: { ...channel, work: "open", engaged: true, input: "reply" },
    expected: ["m1_to_task", "m1_to_task", "drop"],
  },
  {
    row: 7,
    what: "a mention in a closed work's thread",
    case: { ...channel, work: "closed", engaged: true, input: "mention" },
    expected: ["m2", "m2", "drop_with_off_notice"],
  },
  {
    row: 8,
    what: "an unmentioned reply in a closed work's thread",
    case: { ...channel, work: "closed", engaged: true, input: "reply" },
    expected: ["m1", "m1", "drop"],
  },
  {
    row: 9,
    what: "a web write to the channel, as row 1",
    case: { ...channel, work: "none", input: "web_write" },
    expected: ["m2", "m2", "reject_write"],
  },
  {
    row: 9,
    what: "a web write to an open work's thread, as row 5",
    case: { ...channel, work: "open", input: "web_write" },
    expected: ["to_task", "to_task", "reject_write"],
  },
  {
    row: 9,
    what: "a web write to a closed work's thread, as row 7",
    case: { ...channel, work: "closed", input: "web_write" },
    expected: ["m2", "m2", "reject_write"],
  },
  {
    row: 10,
    what: "a direct instruction to an open session",
    case: { ...channel, work: "open", input: "direct_instruction" },
    expected: same("to_task"),
  },
  {
    row: 10,
    what: "a direct instruction to an open session in a DM",
    case: {
      place: "dm",
      engaged: true,
      work: "open",
      input: "direct_instruction",
    },
    expected: same("to_task"),
  },
  {
    row: 11,
    what: "a direct instruction to a closed session",
    case: { ...channel, work: "closed", input: "direct_instruction" },
    expected: same("reject_closed_session"),
  },
  {
    row: 12,
    what: "the requester's stop in an open work's channel thread",
    case: { ...channel, work: "open", engaged: true, input: "stop_request" },
    expected: same("stop_session"),
  },
  {
    row: 12,
    what: "the requester's stop in an open work's DM thread",
    case: { place: "dm", engaged: true, work: "open", input: "stop_request" },
    expected: same("stop_session"),
  },
  {
    row: 13,
    what: "the start button",
    case: { ...channel, work: "none", input: "start_button" },
    expected: ["start_task", "start_task", "expire_start"],
  },
  {
    row: 14,
    what: "a DM message with no work",
    case: { place: "dm", engaged: false, work: "none", input: "top_level" },
    expected: same("m2"),
  },
  {
    row: 14,
    what: "a DM reply in a closed work's thread",
    case: { place: "dm", engaged: true, work: "closed", input: "reply" },
    expected: same("m2"),
  },
  {
    row: 15,
    what: "a message in an open work's DM thread",
    case: { place: "dm", engaged: true, work: "open", input: "reply" },
    expected: same("to_task"),
  },
  {
    row: 16,
    what: "an allowed bot's direct mention",
    case: { ...channel, work: "none", input: "allowed_bot_mention" },
    expected: same("outside_layer"),
  },
  {
    row: 17,
    what: "another bot's message",
    case: { ...channel, work: "none", input: "other_bot" },
    expected: same("drop"),
  },
  {
    row: 17,
    what: "another bot's message in a DM",
    case: { place: "dm", engaged: false, work: "none", input: "other_bot" },
    expected: same("drop"),
  },
  {
    row: 18,
    what: "an open work's report to its thread",
    case: { ...channel, work: "open", engaged: true, input: "report" },
    expected: same("post_report"),
  },
];

const on = (
  inboundCase: InboundCase,
  listen: BindingListen,
  extra: Partial<InboundContext> = {},
): InboundContext => ({
  ...inboundCase,
  listen,
  rollout: "on",
  mode: "on",
  lifecycleStop: null,
  ...extra,
});

describe("the handling table (v2.4 5-6)", () => {
  for (const entry of ROWS) {
    BINDING_LISTEN_VALUES.forEach((listen) => {
      const expected =
        entry.expected[(["mention", "free", "off"] as const).indexOf(listen)];
      test(`row ${entry.row} · ${listen}: ${entry.what} → ${expected}`, () => {
        expect(inboundHandling(on(entry.case, listen))).toEqual({
          kind: "table",
          handling: expected as TableHandling,
        });
      });
    });
  }

  test("every one of the 18 rows is covered", () => {
    expect([...new Set(ROWS.map((entry) => entry.row))]).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1),
    );
  });

  test("row 4 changed by decision 48: free buffers a reply outside the agent's threads, mention drops it", () => {
    const reply = { ...channel, work: "none", input: "reply" } as const;
    expect(
      tableHandling({ ...reply, listen: "free", lifecycleStop: null }),
    ).toBe("buffer_m1");
    expect(
      tableHandling({ ...reply, listen: "mention", lifecycleStop: null }),
    ).toBe("drop");
  });
});

describe("what is checked first", () => {
  test("1. a lifecycle stop comes before a direct instruction, a stop and a bound thread", () => {
    for (const lifecycleStop of LIFECYCLE_STOP_VALUES) {
      for (const input of [
        "direct_instruction",
        "stop_request",
        "mention",
      ] as const) {
        expect(
          inboundHandling(
            on({ ...channel, work: "open", input }, "free", { lifecycleStop }),
          ),
        ).toEqual({ kind: "table", handling: "lifecycle_stopped" });
      }
    }
  });

  test("2. a direct instruction and a stop come before the listen setting", () => {
    for (const listen of BINDING_LISTEN_VALUES) {
      expect(
        tableHandling({
          ...channel,
          work: "open",
          input: "direct_instruction",
          listen,
          lifecycleStop: null,
        }),
      ).toBe("to_task");
      expect(
        tableHandling({
          ...channel,
          work: "open",
          input: "stop_request",
          listen,
          lifecycleStop: null,
        }),
      ).toBe("stop_session");
    }
  });

  test("3. a bound thread takes a mention before the listen setting drops it", () => {
    const mention = { ...channel, work: "open", input: "mention" } as const;
    expect(
      tableHandling({ ...mention, listen: "off", lifecycleStop: null }),
    ).toBe("to_task");
    expect(
      tableHandling({
        ...mention,
        work: "none",
        listen: "off",
        lifecycleStop: null,
      }),
    ).toBe("drop_with_off_notice");
  });

  test("4. a stop with no open work is a plain reply, for the listen setting", () => {
    const stop = { ...channel, work: "none", input: "stop_request" } as const;
    expect(
      tableHandling({ ...stop, listen: "free", lifecycleStop: null }),
    ).toBe("buffer_m1");
    expect(
      tableHandling({ ...stop, listen: "mention", lifecycleStop: null }),
    ).toBe("drop");
  });
});

describe("narrowing the listen setting", () => {
  test("free → mention → off changes the answer", () => {
    const topLevel = { ...channel, work: "none", input: "top_level" } as const;
    const mention = { ...channel, work: "none", input: "mention" } as const;
    const answers = BINDING_LISTEN_VALUES.map((listen) => [
      inboundHandling(on(topLevel, listen)),
      inboundHandling(on(mention, listen)),
    ]);
    expect(answers).toEqual([
      [
        { kind: "table", handling: "buffer_m1" },
        { kind: "table", handling: "m2" },
      ],
      [
        { kind: "table", handling: "drop" },
        { kind: "table", handling: "m2" },
      ],
      [
        { kind: "table", handling: "drop" },
        { kind: "table", handling: "drop_with_off_notice" },
      ],
    ]);
  });
});

describe("the agent's switch", () => {
  test("off: every case takes the current path, whatever the listen setting", () => {
    for (const entry of ROWS) {
      for (const listen of BINDING_LISTEN_VALUES) {
        expect(
          inboundHandling(on(entry.case, listen, { rollout: "off" })),
        ).toEqual({ kind: "current_path", shadow: null });
      }
    }
  });

  test("shadow: the current path, with the table's answer for the record", () => {
    const topLevel = { ...channel, work: "none", input: "top_level" } as const;
    expect(
      inboundHandling(on(topLevel, "free", { rollout: "shadow" })),
    ).toEqual({ kind: "current_path", shadow: "buffer_m1" });
    expect(
      inboundHandling(on(topLevel, "mention", { rollout: "shadow" })),
    ).toEqual({ kind: "current_path", shadow: "drop" });
  });
});

describe("a binding whose mode is off", () => {
  const slackInputs = ROWS.filter(
    (entry) =>
      !["web_write", "direct_instruction", "report"].includes(entry.case.input),
  );

  test("receives no Slack input, whatever the listen setting and the switch", () => {
    for (const entry of slackInputs) {
      for (const listen of BINDING_LISTEN_VALUES) {
        for (const rollout of ["off", "shadow", "on"] as const) {
          expect(
            inboundHandling(on(entry.case, listen, { mode: "off", rollout })),
          ).toEqual({ kind: "table", handling: "not_received" });
        }
      }
    }
  });

  test("still takes a direct instruction and posts the work's report", () => {
    for (const input of ["direct_instruction", "report"] as const) {
      const answer = inboundHandling(
        on({ ...channel, work: "open", input }, "free", { mode: "off" }),
      );
      expect(answer).toEqual({
        kind: "table",
        handling: input === "report" ? "post_report" : "to_task",
      });
    }
  });
});
