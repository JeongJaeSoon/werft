import { describe, expect, test } from "bun:test";
import type { ConversationInputId } from "@werft-ai/contracts";
import {
  EMPTY_SOURCE_SET,
  mergeSources,
  SOURCE_SET_LIMIT,
  type SourceKey,
  slackSource,
  sourceSetOf,
  storedSourceSet,
  turnSources,
} from "./source-sets.ts";

const place = (ts: string) => ({ teamId: "T1", channelId: "C1", ts });
const input = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as ConversationInputId;
const a = slackSource(place("1.1"));
const b = slackSource(place("2.2"));

describe("mergeSources", () => {
  test("is the union in first-seen order, each input once", () => {
    expect(mergeSources([[a, b], [b, a], [a]])).toEqual({
      keys: [a, b],
      overflow: false,
    });
  });

  test("one input by place or by row; a known part fills the gap", () => {
    const withRow: SourceKey = { inputId: input(1), slack: null };
    const both: SourceKey = { inputId: input(1), slack: place("1.1") };
    expect(mergeSources([[a], [both]]).keys).toEqual([both]);
    expect(mergeSources([[withRow], [a], [both]]).keys).toEqual([both]);
    // Different rows at different places stay two.
    expect(mergeSources([[withRow], [b]]).keys).toHaveLength(2);
  });

  test("past the limit keeps the first keys and says overflow", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      slackSource(place(`${i + 1}.0`)),
    );
    const merged = mergeSources([many], 3);
    expect(merged.keys).toEqual(many.slice(0, 3));
    expect(merged.overflow).toBe(true);
    // At the limit exactly is no overflow; a repeat past it is none either.
    expect(mergeSources([many.slice(0, 3), [many[0] as SourceKey]], 3)).toEqual(
      { keys: many.slice(0, 3), overflow: false },
    );
    expect(SOURCE_SET_LIMIT).toBe(256);
  });
});

describe("turnSources", () => {
  test("a later turn inherits every earlier turn's keys, not as direct", () => {
    const first = turnSources({ direct: [a], earlier: [] });
    expect(first).toEqual({ direct: [a], inherited: [], overflow: false });
    const second = turnSources({ direct: [], earlier: [first] });
    expect(second).toEqual({ direct: [], inherited: [a], overflow: false });
    const third = turnSources({ direct: [b], earlier: [first, second] });
    expect(third).toEqual({ direct: [b], inherited: [a], overflow: false });
  });

  test("a session with no sources gives its turns none", () => {
    expect(turnSources({ direct: [], earlier: [EMPTY_SOURCE_SET] })).toEqual(
      EMPTY_SOURCE_SET,
    );
  });

  test("past the limit the direct keys stay and the oldest inherited ones fill the rest", () => {
    const old = Array.from({ length: 4 }, (_, i) =>
      slackSource(place(`${i + 1}.0`)),
    );
    const set = turnSources({
      direct: [b],
      earlier: [{ direct: old, inherited: [], overflow: false }],
      limit: 3,
    });
    expect(set).toEqual({
      direct: [b],
      inherited: old.slice(0, 2),
      overflow: true,
    });
  });

  test("an overflowed earlier set overflows every later one", () => {
    const set = turnSources({
      direct: [],
      earlier: [{ direct: [a], inherited: [], overflow: true }],
    });
    expect(set.overflow).toBe(true);
  });
});

describe("stored shape", () => {
  test("round-trips, holds places and ids only, and stores no empty set", () => {
    const set = {
      direct: [{ inputId: input(7), slack: place("1.1") }],
      inherited: [b],
      overflow: false,
    };
    const stored = storedSourceSet(set);
    expect(stored).toEqual({
      direct: [
        { input_id: input(7), team_id: "T1", channel_id: "C1", ts: "1.1" },
      ],
      inherited: [{ team_id: "T1", channel_id: "C1", ts: "2.2" }],
    });
    expect(sourceSetOf(stored)).toEqual(set);
    expect(storedSourceSet(EMPTY_SOURCE_SET)).toBeNull();
    expect(
      storedSourceSet({ direct: [], inherited: [a], overflow: true }),
    ).toEqual({
      direct: [],
      inherited: [{ team_id: "T1", channel_id: "C1", ts: "1.1" }],
      overflow: true,
    });
  });

  test("null and shapes it cannot read are the empty set", () => {
    expect(sourceSetOf(null)).toEqual(EMPTY_SOURCE_SET);
    expect(sourceSetOf({ direct: [{ text: "hi" }], inherited: [] })).toEqual(
      EMPTY_SOURCE_SET,
    );
    expect(
      sourceSetOf({ direct: [{ team_id: "T1", ts: "1.1" }], inherited: [] }),
    ).toEqual(EMPTY_SOURCE_SET);
  });
});
