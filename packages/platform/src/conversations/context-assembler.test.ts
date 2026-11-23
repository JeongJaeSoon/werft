import { describe, expect, test } from "bun:test";
import { type ScopeKey, scopeKeyOf } from "@werft-ai/contracts";
import type { ContextFragment } from "../ports/context-fragment-source.ts";
import type { ConversationKey } from "../ports/conversation-store.ts";
import { assembleContext, readableScopes } from "./context-assembler.ts";

const W = "00000000-0000-4000-8000-0000000000a1";
const A = "00000000-0000-4000-8000-0000000000b1";
const U = "00000000-0000-4000-8000-0000000000c1";

/** mulberry32: the same seed draws the same worlds, so a failure replays. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuid = (prefix: string, n: number) =>
  `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;

function fragment(scope: ScopeKey, n: number): ContextFragment {
  return {
    kind: "buffered_message",
    scope,
    sources: [],
    inputId: uuid("f", n) as never,
    body: `message ${n}`,
    poster: { kind: "slack_user", id: "U0POSTER" },
    receivedAt: new Date(0),
  };
}

describe("readableScopes", () => {
  test("a channel conversation reads its channel and its agent, nothing else", () => {
    expect(
      readableScopes({
        kind: "channel",
        workspaceId: W,
        agentId: A,
        teamId: "T1",
        channelId: "C1",
      }),
    ).toEqual([
      scopeKeyOf({
        kind: "channel",
        workspaceId: W,
        teamId: "T1",
        channelId: "C1",
      }),
      scopeKeyOf({ kind: "agent", workspaceId: W, agentId: A }),
    ]);
  });

  test("a DM reads its person and its agent, nothing else", () => {
    expect(
      readableScopes({
        kind: "dm",
        workspaceId: W,
        agentId: A,
        personUserId: U,
      }),
    ).toEqual([
      scopeKeyOf({ kind: "person", workspaceId: W, userId: U }),
      scopeKeyOf({ kind: "agent", workspaceId: W, agentId: A }),
    ]);
  });
});

describe("assembleContext (G1)", () => {
  test("drops a fragment of another scope the source returned", async () => {
    const conversation: ConversationKey = {
      kind: "channel",
      workspaceId: W,
      agentId: A,
      teamId: "T1",
      channelId: "C1",
    };
    const own = fragment(readableScopes(conversation)[0] as ScopeKey, 1);
    const otherChannel = fragment(
      scopeKeyOf({
        kind: "channel",
        workspaceId: W,
        teamId: "T1",
        channelId: "C2",
      }),
      2,
    );
    const person = fragment(
      scopeKeyOf({ kind: "person", workspaceId: W, userId: U }),
      3,
    );
    const result = await assembleContext(
      { fragmentsOf: async () => [own, otherChannel, person] },
      conversation,
    );
    expect(result).toEqual([own]);
  });

  test("property: over random conversations and fragments, every fragment kept is in the conversation's readable scopes, and every readable one is kept", async () => {
    const draw = random(20151123);
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(draw() * items.length)] as T;
    const workspaces = [uuid("a", 1), uuid("a", 2)];
    const agents = [uuid("b", 1), uuid("b", 2), uuid("b", 3)];
    const people = [uuid("c", 1), uuid("c", 2), uuid("c", 3)];
    const teams = ["T1", "T2"];
    const channels = ["C1", "C2", "C3", "G1"];
    const anyConversation = (): ConversationKey =>
      draw() < 0.5
        ? {
            kind: "channel",
            workspaceId: pick(workspaces),
            agentId: pick(agents),
            teamId: pick(teams),
            channelId: pick(channels),
          }
        : {
            kind: "dm",
            workspaceId: pick(workspaces),
            agentId: pick(agents),
            personUserId: pick(people),
          };
    const anyScope = (): ScopeKey => {
      const kind = pick(["channel", "person", "agent"] as const);
      const workspaceId = pick(workspaces);
      return kind === "channel"
        ? scopeKeyOf({
            kind,
            workspaceId,
            teamId: pick(teams),
            channelId: pick(channels),
          })
        : kind === "person"
          ? scopeKeyOf({ kind, workspaceId, userId: pick(people) })
          : scopeKeyOf({ kind, workspaceId, agentId: pick(agents) });
    };
    let checked = 0;
    let kept = 0;
    let dropped = 0;
    for (let world = 0; world < 300; world += 1) {
      const fragments = Array.from(
        { length: Math.floor(draw() * 40) },
        (_, n) => fragment(anyScope(), world * 100 + n),
      );
      const conversations = Array.from(
        { length: 1 + Math.floor(draw() * 6) },
        anyConversation,
      );
      for (const conversation of conversations) {
        const readable = new Set<string>(readableScopes(conversation));
        const result = await assembleContext(
          { fragmentsOf: async () => fragments },
          conversation,
        );
        for (const piece of result)
          expect(readable.has(piece.scope)).toBe(true);
        expect(result).toEqual(
          fragments.filter((piece) => readable.has(piece.scope)),
        );
        checked += 1;
        kept += result.length;
        dropped += fragments.length - result.length;
      }
    }
    // The draws reach both sides of the check, so neither half is vacuous.
    expect(kept).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
    console.info(
      `G1 property: ${checked} conversations, ${kept} fragments kept, ${dropped} dropped`,
    );
  });
});
