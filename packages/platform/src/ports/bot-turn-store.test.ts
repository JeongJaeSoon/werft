import { describe, expect, test } from "bun:test";
import {
  type BotTurnState,
  claimBotTurn,
  releaseBotTurn,
  resetBotTurns,
} from "./bot-turn-store.ts";

const EMPTY: BotTurnState = { counted: [], humanTs: null, stop: null };
const A = "agent-a";
const B = "agent-b";

function run(
  start: BotTurnState,
  turns: [string, string][],
  limit = 2,
): { state: BotTurnState; outcomes: string[] } {
  let state = start;
  const outcomes: string[] = [];
  for (const [messageTs, agentId] of turns) {
    const { next, claim } = claimBotTurn(state, { messageTs, agentId }, limit);
    state = next;
    outcomes.push(
      claim.outcome === "limit"
        ? `limit${claim.first ? " first" : ""}`
        : claim.outcome,
    );
  }
  return { state, outcomes };
}

describe("bot turns in a row in one thread", () => {
  test("one message to one agent twice counts once; two agents on one message count twice", () => {
    expect(
      run(EMPTY, [
        ["1.000001", A],
        ["1.000001", A],
        ["1.000001", B],
        ["1.000002", A],
      ]).outcomes,
    ).toEqual(["counted", "counted", "counted", "limit first"]);
  });

  test("only the turn that met the limit first says so, again on a retry", () => {
    const { outcomes, state } = run(EMPTY, [
      ["1.1", A],
      ["1.2", A],
      ["1.3", A],
      ["1.4", B],
      ["1.3", A],
    ]);
    expect(outcomes).toEqual([
      "counted",
      "counted",
      "limit first",
      "limit",
      "limit first",
    ]);
    expect(state.stop).toBe("1.3 agent-a");
  });

  test("a person's message keeps only later turns, and a late or repeated one changes nothing", () => {
    const counted = run(EMPTY, [
      ["10.000001", A],
      ["10.000003", A],
    ]).state;
    const reset = resetBotTurns(counted, "10.000002");
    expect(reset).toEqual({
      counted: ["10.000003 agent-a"],
      humanTs: "10.000002",
      stop: null,
    });
    expect(resetBotTurns(reset, "10.000002")).toBe(reset);
    expect(resetBotTurns(reset, "9.999999")).toBe(reset);
    // A bot message older than the person's is not part of the run.
    expect(run(reset, [["10.000001", B]]).state).toBe(reset);
  });

  test("a person lifts the stop, even one read late, and the next stop speaks again", () => {
    const stopped = run(EMPTY, [
      ["5.1", A],
      ["5.2", A],
      ["5.3", A],
    ]).state;
    expect(resetBotTurns(stopped, "5.4")).toEqual({
      counted: [],
      humanTs: "5.4",
      stop: null,
    });
    // The person wrote before the stopped message but was read after it.
    const late = resetBotTurns(stopped, "5.25");
    expect(late.stop).toBe(null);
    expect(
      run(late, [
        ["5.5", A],
        ["5.6", A],
        ["5.7", A],
      ]).outcomes,
    ).toEqual(["counted", "counted", "limit first"]);
  });

  test("ts compare as numbers, whatever their width", () => {
    const reset = resetBotTurns(EMPTY, "999.9");
    expect(run(reset, [["1000.1", A]]).state.counted).toEqual([
      "1000.1 agent-a",
    ]);
    expect(run(reset, [["999.10", A]]).state.counted).toEqual([]);
  });

  test("a released turn frees its place; releasing an unknown turn is a no-op", () => {
    const { state } = run(EMPTY, [
      ["1.1", A],
      ["1.2", A],
    ]);
    const released = releaseBotTurn(state, { messageTs: "1.2", agentId: A });
    expect(released.counted).toEqual(["1.1 agent-a"]);
    expect(releaseBotTurn(released, { messageTs: "1.9", agentId: B })).toBe(
      released,
    );
    expect(run(released, [["1.3", A]]).outcomes).toEqual(["counted"]);
  });
});
