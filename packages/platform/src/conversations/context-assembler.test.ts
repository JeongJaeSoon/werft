import { describe, expect, test } from "bun:test";
import {
  channelSummaryLineIdSchema,
  conversationInputIdSchema,
  engagementKindSchema,
  type ScopeKey,
  scopeKeyOf,
} from "@werft-ai/contracts";
import type {
  ContextFragment,
  ContextFragmentSource,
} from "../ports/context-fragment-source.ts";
import type { ConversationKey } from "../ports/conversation-store.ts";
import {
  assembleCallContext,
  assembleContext,
  CONTEXT_CAP_BYTES,
  type CurrentPost,
  fitContext,
  fragmentText,
  PIECE_OVERHEAD_BYTES,
  POST_CHAR_LIMIT,
  readableScopes,
  truncatePost,
} from "./context-assembler.ts";
import type { SourceKey } from "./source-sets.ts";

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

const sourceOf = (
  fragments: ContextFragment[],
  unreadable = 0,
): ContextFragmentSource => ({
  read: async () => ({ fragments, unreadable }),
  conversationOf: async () => null,
  recordsDeletedAt: async () => null,
  anyDeleted: async () => false,
});

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
      sourceOf([own, otherChannel, person]),
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
        const result = await assembleContext(sourceOf(fragments), conversation);
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

const CHANNEL: ConversationKey = {
  kind: "channel",
  workspaceId: W,
  agentId: A,
  teamId: "T1",
  channelId: "C1",
};
const OWN = readableScopes(CHANNEL)[0] as ScopeKey;
const at = (n: number) => new Date(Date.UTC(2026, 10, 24, 0, n));
const key = (ts: string): SourceKey => ({
  inputId: null,
  slack: { teamId: "T1", channelId: "C1", ts },
});

function summaryLine(n: number, text: string): ContextFragment {
  return {
    kind: "channel_summary_line",
    scope: OWN,
    sources: [key(`1.${n}`)],
    lineId: channelSummaryLineIdSchema.parse(uuid("d", n)),
    text,
    writtenByAgentId: A,
    writtenAt: at(n),
  };
}
function engagement(n: number): ContextFragment {
  return {
    kind: "engagement",
    scope: OWN,
    sources: [key(`2.${n}`)],
    engagementKind: engagementKindSchema.parse("reply"),
    target: { kind: "session", sessionId: uuid("e", n) },
    at: at(n),
  };
}
function buffered(n: number, body: string): ContextFragment {
  return {
    kind: "buffered_message",
    scope: OWN,
    sources: [key(`3.${n}`)],
    inputId: conversationInputIdSchema.parse(uuid("f", n)),
    body,
    poster: { kind: "slack_user", id: "U0POSTER" },
    receivedAt: at(n),
  };
}
function post(n: number, body: string): CurrentPost {
  return {
    inputId: conversationInputIdSchema.parse(uuid("9", n)),
    body,
    sources: [key(`4.${n}`)],
    receivedAt: at(n),
  };
}
const size = (text: string) =>
  PIECE_OVERHEAD_BYTES + new TextEncoder().encode(text).length;
const cost = (...fs: ContextFragment[]) =>
  fs.reduce((sum, f) => sum + size(fragmentText(f)), 0);
const ids = (fs: ContextFragment[]) =>
  fs.map((f) =>
    f.kind === "channel_summary_line"
      ? f.lineId
      : f.kind === "engagement"
        ? f.target.kind === "session"
          ? f.target.sessionId
          : f.target.turnId
        : f.kind === "conversation_turn"
          ? f.turnId
          : f.inputId,
  );
const fitted = (result: ReturnType<typeof fitContext>) => {
  if (result.outcome !== "fitted") throw new Error(result.outcome);
  return result;
};

describe("fitContext", () => {
  const x = (n: number) => "x".repeat(n);
  const line1 = summaryLine(1, x(100));
  const line2 = summaryLine(2, x(100));
  const eng1 = engagement(3);
  const eng2 = engagement(4);
  const buf1 = buffered(5, x(100));
  const buf2 = buffered(6, x(100));
  const all = [buf2, eng2, line1, buf1, line2, eng1];
  const now = post(9, x(100));
  const base = size("rules") + size(now.body);

  test("under the cap every fragment goes in, laid out by kind and time", () => {
    const result = fitted(
      fitContext({ instructions: "rules", current: [now], fragments: all }),
    );
    expect(ids(result.fragments)).toEqual(
      ids([line1, line2, eng1, eng2, buf1, buf2]),
    );
    expect(result.current).toEqual([now]);
    expect(result.left).toEqual([]);
    expect(result.sources.keys).toHaveLength(7);
  });

  test("over the cap the back of the channel summary goes first", () => {
    const cap = base + cost(line1, eng1, eng2, buf1, buf2);
    const result = fitted(
      fitContext({
        instructions: "rules",
        current: [now],
        fragments: all,
        capBytes: cap,
      }),
    );
    expect(ids(result.fragments)).toEqual(ids([line1, eng1, eng2, buf1, buf2]));
  });

  test("then the oldest engagement records", () => {
    const cap = base + cost(eng2, buf1, buf2);
    const result = fitted(
      fitContext({
        instructions: "rules",
        current: [now],
        fragments: all,
        capBytes: cap,
      }),
    );
    expect(ids(result.fragments)).toEqual(ids([eng2, buf1, buf2]));
  });

  test("then the oldest buffered posts", () => {
    const cap = base + cost(buf2);
    const result = fitted(
      fitContext({
        instructions: "rules",
        current: [now],
        fragments: all,
        capBytes: cap,
      }),
    );
    expect(ids(result.fragments)).toEqual(ids([buf2]));
  });

  test("a cut piece's sources are not in the source set", () => {
    const result = fitted(
      fitContext({
        instructions: "rules",
        current: [now],
        fragments: all,
        capBytes: base + cost(buf2),
      }),
    );
    expect(result.sources).toEqual({
      keys: [...buf2.sources, ...now.sources],
      overflow: false,
    });
  });

  test("the instructions and current posts stay when every fragment is cut", () => {
    const result = fitted(
      fitContext({
        instructions: "rules",
        current: [now],
        fragments: all,
        capBytes: base,
      }),
    );
    expect(result.fragments).toEqual([]);
    expect(result.instructions).toBe("rules");
    expect(result.current).toEqual([now]);
    expect(result.bytes).toBe(base);
  });

  test("too_large says whether the instructions alone pass the cap", () => {
    expect(
      fitContext({
        instructions: x(200),
        current: [now],
        fragments: all,
        capBytes: 200,
      }),
    ).toEqual({
      outcome: "too_large",
      reason: "instructions",
      bytes: size(x(200)) + size(now.body),
      capBytes: 200,
    });
    expect(
      fitContext({
        instructions: "rules",
        current: [now],
        fragments: [],
        capBytes: base - 1,
      }),
    ).toMatchObject({ outcome: "too_large", reason: "current_post" });
  });

  test("a post past the batch's half of the cap is left for a later call, oldest first", () => {
    const posts = [post(1, x(100)), post(2, x(100)), post(3, x(100))];
    const result = fitted(
      fitContext({
        instructions: "",
        current: [posts[2], posts[0], posts[1]] as CurrentPost[],
        fragments: [],
        capBytes: 2 * (2 * 132) + 1,
      }),
    );
    expect(result.current).toEqual([posts[1], posts[2]] as CurrentPost[]);
    expect(result.left).toEqual([posts[0]] as CurrentPost[]);
    expect(result.sources.keys).not.toContainEqual(
      (posts[0] as CurrentPost).sources[0],
    );
  });

  test("long instructions leave the older posts of a batch for later rather than refuse", () => {
    const older = post(1, x(100));
    const newer = post(2, x(100));
    const result = fitted(
      fitContext({
        instructions: x(800),
        current: [older, newer],
        fragments: [],
        capBytes: 1000,
      }),
    );
    expect(result.current).toEqual([newer]);
    expect(result.left).toEqual([older]);
  });

  test("past the first post that does not fit, every older post waits, small or not", () => {
    const small = post(1, x(10));
    const big = post(2, x(300));
    const newest = post(3, x(100));
    const result = fitted(
      fitContext({
        instructions: "",
        current: [small, big, newest],
        fragments: [],
        capBytes: 2 * (size(x(100)) + size(x(10))),
      }),
    );
    expect(result.current).toEqual([newest]);
    expect(result.left).toEqual([small, big]);
  });

  test("a post left for a later call is not read as a buffered fragment either", () => {
    const own = buffered(1, x(100));
    const older = {
      ...post(1, x(100)),
      inputId: conversationInputIdSchema.parse(uuid("f", 1)),
    };
    const newer = post(2, x(100));
    const result = fitted(
      fitContext({
        instructions: "",
        current: [older, newer],
        fragments: [own],
        capBytes: 2 * size(x(100)) + 1,
      }),
    );
    expect(result.left).toEqual([older]);
    expect(result.fragments).toEqual([]);
  });

  test("the back of the summary is its last lines, whatever their time", () => {
    const first = summaryLine(9, x(100));
    const last = summaryLine(1, x(100));
    const result = fitted(
      fitContext({
        instructions: "",
        current: [now],
        fragments: [first, last],
        capBytes: size(now.body) + size("") + cost(first),
      }),
    );
    expect(ids(result.fragments)).toEqual(ids([first]));
  });

  test("a buffered post that is a current post goes in once, as current", () => {
    const own = buffered(7, "same");
    const current = {
      ...post(7, "same"),
      inputId: conversationInputIdSchema.parse(uuid("f", 7)),
    };
    const result = fitted(
      fitContext({ instructions: "", current: [current], fragments: [own] }),
    );
    expect(result.fragments).toEqual([]);
    expect(result.current).toEqual([current]);
  });

  test("a post past 2k characters is cut to 2k, never inside a character", () => {
    const korean = "한글".repeat(POST_CHAR_LIMIT);
    const cut = truncatePost(korean);
    expect([...cut]).toHaveLength(POST_CHAR_LIMIT);
    expect(korean.startsWith(cut)).toBe(true);
    // A grapheme of several code points stays whole.
    const thumbs = "👍🏽".repeat(POST_CHAR_LIMIT + 1);
    expect(truncatePost(thumbs)).toBe("👍🏽".repeat(POST_CHAR_LIMIT));
    expect(truncatePost("짧은 글")).toBe("짧은 글");

    const result = fitted(
      fitContext({
        instructions: "",
        current: [post(1, korean)],
        fragments: [buffered(2, korean)],
      }),
    );
    expect(result.current[0]?.body).toBe(cut);
    expect(result.fragments[0]).toMatchObject({ body: cut });
  });

  test("property: the fitted context never passes the cap the call reserves on", () => {
    const draw = random(20261124);
    const text = () =>
      (draw() < 0.5 ? "가" : "a").repeat(Math.floor(draw() * 3000));
    let cuts = 0;
    let refused = 0;
    let leftOut = 0;
    for (let world = 0; world < 600; world += 1) {
      const fragments = Array.from(
        { length: Math.floor(draw() * 30) },
        (_, n) => {
          const kind = Math.floor(draw() * 3);
          return kind === 0
            ? summaryLine(n, text().slice(0, 400))
            : kind === 1
              ? engagement(n)
              : buffered(n, text());
        },
      );
      const current = Array.from(
        { length: 1 + Math.floor(draw() * 4) },
        (_, n) => post(100 + n, text()),
      );
      const instructions = "지침".repeat(Math.floor(draw() * 2000));
      const capBytes =
        draw() < 0.5
          ? CONTEXT_CAP_BYTES
          : 500 + Math.floor(draw() * CONTEXT_CAP_BYTES);
      const result = fitContext({ instructions, current, fragments, capBytes });
      const newest = current.at(-1) as CurrentPost;
      const floor = size(instructions) + size(truncatePost(newest.body));
      if (result.outcome === "too_large") {
        // Refused only when nothing it may leave out would make it fit.
        expect(floor).toBeGreaterThan(capBytes);
        refused += 1;
        continue;
      }
      const recount =
        size(result.instructions) +
        result.current.reduce((sum, p) => sum + size(p.body), 0) +
        cost(...result.fragments);
      expect(recount).toBe(result.bytes);
      expect(result.bytes).toBeLessThanOrEqual(capBytes);
      expect(result.current.at(-1)?.inputId).toBe(newest.inputId);
      expect(result.current.length + result.left.length).toBe(current.length);
      if (result.fragments.length < fragments.length) cuts += 1;
      if (result.left.length > 0) leftOut += 1;
    }
    // Each branch is reached, so none of the checks is vacuous.
    expect(cuts).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(leftOut).toBeGreaterThan(0);
  });

  test("assembleCallContext still drops another scope's fragment (G1)", async () => {
    const other = {
      ...buffered(8, "other channel"),
      scope: scopeKeyOf({
        kind: "channel",
        workspaceId: W,
        teamId: "T1",
        channelId: "C2",
      }),
    } as ContextFragment;
    const assembled = await assembleCallContext(
      sourceOf([buf1, other], 2),
      CHANNEL,
      { instructions: "rules", current: [now] },
    );
    expect(ids(fitted(assembled).fragments)).toEqual(ids([buf1]));
    // What the source could not read again is counted, not hidden.
    expect(assembled.unreadable).toBe(2);
  });
});
