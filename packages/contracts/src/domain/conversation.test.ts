import { describe, expect, test } from "bun:test";
import { conversationScopeKey, scopeKeyOf } from "./conversation.ts";

const W = "019a0000-0000-7000-8000-0000000000f1";
const W2 = "019a0000-0000-7000-8000-0000000000f2";
const USER = "019a0000-0000-7000-8000-0000000000f3";
const AGENT = "019a0000-0000-7000-8000-0000000000f4";

const channel = (channelId: string, workspaceId = W) =>
  ({ kind: "channel", workspaceId, teamId: "T01", channelId }) as const;

describe("conversationScopeKey", () => {
  test("two agents in one channel read one channel key", () => {
    // The place carries no agent: a channel's key cannot depend on who asks.
    expect(conversationScopeKey(channel("C01"))).toBe(
      conversationScopeKey(channel("C01")),
    );
    expect(conversationScopeKey(channel("C01"))).toBe(
      "channel:019a0000-0000-7000-8000-0000000000f1:T01:C01" as never,
    );
  });

  test("another channel, team or workspace is another key", () => {
    const base = conversationScopeKey(channel("C01"));
    expect(conversationScopeKey(channel("C02"))).not.toBe(base);
    expect(conversationScopeKey({ ...channel("C01"), teamId: "T02" })).not.toBe(
      base,
    );
    expect(conversationScopeKey(channel("C01", W2))).not.toBe(base);
  });

  test("a DM reads the person's key, not a channel's", () => {
    expect(
      conversationScopeKey({ kind: "dm", workspaceId: W, personUserId: USER }),
    ).toBe(`person:${W}:${USER}` as never);
  });
});

describe("scopeKeyOf", () => {
  test("an agent's own scope", () => {
    expect(scopeKeyOf({ kind: "agent", workspaceId: W, agentId: AGENT })).toBe(
      `agent:${W}:${AGENT}` as never,
    );
  });

  test("a uuid in upper case gives the same key", () => {
    expect(
      scopeKeyOf({
        kind: "person",
        workspaceId: W.toUpperCase(),
        userId: USER.toUpperCase(),
      }),
    ).toBe(scopeKeyOf({ kind: "person", workspaceId: W, userId: USER }));
  });

  test("a segment that could split the key is refused", () => {
    // "T01:C01" + "X" and "T01" + "C01:X" would otherwise share a key.
    expect(() => scopeKeyOf(channel("C01:X"))).toThrow();
    expect(() =>
      scopeKeyOf({ ...channel("C01"), teamId: "T01:C01" }),
    ).toThrow();
    expect(() => scopeKeyOf(channel(""))).toThrow();
  });
});
