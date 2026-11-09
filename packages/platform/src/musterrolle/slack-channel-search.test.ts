import { describe, expect, test } from "bun:test";
import {
  type PutSlackBindingResponse,
  type SearchSlackChannelsQuery,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  createFakeSlackWebApi,
  type SeedSlackChannel,
} from "@werft-ai/testkit/fake-slack-api";
import { SessionServiceError } from "../sessions/session-service.ts";
import {
  createMemorySecretStore,
  createMemorySlackAppStore,
  fakeSlackValue,
} from "../testing/slack-fakes.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "./policy.ts";
import {
  createSlackChannelCache,
  createSlackChannelSearchService,
  forgettingChannelsOnBindingPut,
  SLACK_CHANNEL_CACHE_MAX_APPS,
  SLACK_CHANNEL_CACHE_MAX_CHANNELS,
  SLACK_CHANNEL_CACHE_TTL_MS,
} from "./slack-channel-search.ts";
import {
  createSlackBotApi,
  SlackApiError,
  SlackRateLimitedError,
} from "./slack-config-api.ts";
import type { SlackTokenRevoked } from "./slack-token-gone.ts";
import type { SurfaceBindingService } from "./surface-binding-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const BARE_AGENT = "019a0000-0000-7000-8000-0000000000c2";
const APP_ROW = "019a0000-0000-7000-8000-0000000000d1";
const APP_ID = "A0SEARCH1";
const NOW = new Date("2026-10-24T10:00:00.000Z");

function user(role: WorkspaceRole): Caller {
  return callerFor(
    {
      kind: "user",
      id: crypto.randomUUID(),
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    crypto.randomUUID(),
  );
}

const agentAuthority: AgentAuthority = {
  agentOf: async (_workspace, resource) =>
    resource.kind === "agent" && [AGENT, BARE_AGENT].includes(resource.id)
      ? resource.id
      : null,
  isAdmin: async () => false,
};

const owner = user("owner");
const query = (
  q: string,
  more: Partial<SearchSlackChannelsQuery> = {},
): SearchSlackChannelsQuery => ({ q, limit: 20, ...more });

const SEEDS: SeedSlackChannel[] = [
  { name: "general" },
  { name: "dev-ops" },
  { name: "deploy" },
  { name: "design" },
  { name: "dev" },
  { name: "dev-secret", isPrivate: true },
  { name: "dev-private", isPrivate: true, members: [APP_ID] },
  { name: "dev-archived", isArchived: true },
  { name: "random", members: [APP_ID] },
];

function world(
  options: {
    botToken?: boolean;
    /** Every Slack call is answered `ok: false` with this code. */
    slackError?: string;
    tokenRevoked?: SlackTokenRevoked;
  } = {},
) {
  let clock = NOW.getTime();
  const slack = createFakeSlackWebApi();
  const botToken = fakeSlackValue("xoxb");
  slack.apps.set(APP_ID, {
    appId: APP_ID,
    clientId: "1.1",
    clientSecret: fakeSlackValue("client"),
    signingSecret: fakeSlackValue("signing"),
    manifest: {},
    botTokens: [botToken],
  });
  slack.seedChannels(SEEDS);
  const secrets = createMemorySecretStore();
  const apps = createMemorySlackAppStore({
    secrets,
    agents: new Map(
      [AGENT, BARE_AGENT].map((id) => [
        id,
        {
          id,
          workspaceId: WORKSPACE,
          name: "Ops",
          slug: "ops",
          role: "Runs ops",
          active: true,
        },
      ]),
    ),
  });
  apps.seed({
    id: APP_ROW,
    workspaceId: WORKSPACE,
    kind: "agent",
    agentId: AGENT,
    state: "created",
    appId: APP_ID,
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
    createdByTokenUser: "U0ISSUER",
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (options.botToken !== false) {
    secrets.write(
      {
        workspaceId: WORKSPACE,
        owner: { kind: "slack_app", id: APP_ROW },
        purpose: "slack_bot_token",
      },
      botToken,
    );
  }
  const cache = createSlackChannelCache({ now: () => clock });
  const service = createSlackChannelSearchService({
    authorization: createAuthorizationPolicy({ agents: agentAuthority }),
    agents: agentAuthority,
    apps: apps.store,
    secrets: secrets.store,
    api: createSlackBotApi({
      apiUrl: "http://slack.test/api",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        options.slackError === undefined
          ? ((await slack.handle(new Request(input, init))) ??
            new Response("not found", { status: 404 }))
          : Response.json({
              ok: false,
              error: options.slackError,
            })) as typeof fetch,
    }),
    cache,
    ...(options.tokenRevoked ? { tokenRevoked: options.tokenRevoked } : {}),
  });
  const listCalls = () =>
    slack.calls.filter((call) => call.method === "conversations.list").length;
  return {
    slack,
    botToken,
    service,
    lookup: (ids: string[]) =>
      service.lookupSlackChannels(owner, AGENT, { ids }),
    cache,
    listCalls,
    search: (q: string, more: Partial<SearchSlackChannelsQuery> = {}) =>
      service.searchSlackChannels(owner, AGENT, query(q, more)),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function refusal(work: Promise<unknown>) {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SessionServiceError);
  return error as SessionServiceError;
}

const names = (result: { page: { items: { name: string }[] } }) =>
  result.page.items.map((item) => item.name);

describe("searching an agent's Slack channels", () => {
  test("the cache limits are the agreed constants", () => {
    expect(SLACK_CHANNEL_CACHE_TTL_MS).toBe(60_000);
    expect(SLACK_CHANNEL_CACHE_MAX_CHANNELS).toBe(10_000);
    expect(SLACK_CHANNEL_CACHE_MAX_APPS).toBe(500);
  });

  test("keeps channels whose name starts with q, by name, ignoring case and a leading #", async () => {
    const { search } = world();
    const found = await search("#DE");
    expect(names(found)).toEqual([
      "deploy",
      "design",
      "dev",
      "dev-ops",
      "dev-private",
    ]);
    expect(found.page).toMatchObject({
      next_cursor: null,
      truncated: false,
      stale: false,
    });
    expect(names(await search(""))).toEqual([
      "deploy",
      "design",
      "dev",
      "dev-ops",
      "dev-private",
      "general",
      "random",
    ]);
  });

  test("a private channel shows only when the bot is in it", async () => {
    const { search } = world();
    const found = await search("dev-");
    expect(
      found.page.items.map(({ name, is_private, is_member }) => [
        name,
        is_private,
        is_member,
      ]),
    ).toEqual([
      ["dev-ops", false, false],
      ["dev-private", true, true],
    ]);
    expect((await search("random")).page.items[0]?.is_member).toBe(true);
  });

  test("pages with our cursor to the end, and refuses a cursor for another search", async () => {
    const { search, listCalls } = world();
    const first = await search("de", { limit: 2 });
    expect(names(first)).toEqual(["deploy", "design"]);
    const cursor = first.page.next_cursor;
    expect(cursor).toBeString();
    const second = await search("de", { limit: 2, cursor: cursor ?? "" });
    expect(names(second)).toEqual(["dev", "dev-ops"]);
    const last = await search("de", {
      limit: 2,
      cursor: second.page.next_cursor ?? "",
    });
    expect(names(last)).toEqual(["dev-private"]);
    expect(last.page.next_cursor).toBeNull();
    expect(listCalls()).toBe(1);

    const other = await refusal(
      search("ge", { limit: 2, cursor: cursor ?? "" }),
    );
    expect(other.code).toBe("BAD_REQUEST");
    const garbled = await refusal(search("de", { cursor: "not-ours" }));
    expect(garbled.code).toBe("BAD_REQUEST");
  });

  test("a cursor into a list that was read again answers CURSOR_EXPIRED", async () => {
    const { search, advance } = world();
    const first = await search("de", { limit: 2 });
    advance(SLACK_CHANNEL_CACHE_TTL_MS);
    await search("de", { limit: 2 });
    const expired = await refusal(
      search("de", { limit: 2, cursor: first.page.next_cursor ?? "" }),
    );
    expect(expired.code).toBe("CURSOR_EXPIRED");
    expect(expired.message).toContain("다시 검색");
  });

  test("a cursor still pages its list after the TTL while nothing replaced it", async () => {
    const { search, advance, listCalls } = world();
    const first = await search("de", { limit: 2 });
    advance(SLACK_CHANNEL_CACHE_TTL_MS * 2);
    const next = await search("de", {
      limit: 2,
      cursor: first.page.next_cursor ?? "",
    });
    expect(names(next)).toEqual(["dev", "dev-ops"]);
    expect(next.cache).toBe("hit");
    expect(listCalls()).toBe(1);
  });

  test("within the TTL a second search calls Slack 0 times; after it, again", async () => {
    const { search, advance, listCalls } = world();
    expect((await search("de")).cache).toBe("miss");
    advance(SLACK_CHANNEL_CACHE_TTL_MS - 1);
    expect((await search("ge")).cache).toBe("hit");
    expect(listCalls()).toBe(1);
    advance(1);
    expect((await search("de")).cache).toBe("miss");
    expect(listCalls()).toBe(2);
  });

  test("two searches at once share one Slack read", async () => {
    const { search, listCalls } = world();
    const [a, b] = await Promise.all([search("de"), search("ge")]);
    expect(names(a)).toHaveLength(5);
    expect(names(b)).toEqual(["general"]);
    expect(listCalls()).toBe(1);
  });

  test("reads every Slack page and marks the list truncated past 10,000 channels", async () => {
    const { slack, search, listCalls } = world();
    slack.seedChannels(
      Array.from({ length: SLACK_CHANNEL_CACHE_MAX_CHANNELS }, (_, i) => ({
        name: `bulk-${String(i).padStart(5, "0")}`,
      })),
    );
    const found = await search("bulk-", { limit: 50 });
    expect(found.page.truncated).toBe(true);
    expect(found.page.items).toHaveLength(50);
    // 10,009 channels at 200 a page: 51 pages.
    expect(listCalls()).toBe(51);
  });

  test("exactly the channel cap is not truncated", async () => {
    const { slack, search } = world();
    slack.seedChannels(
      Array.from(
        { length: SLACK_CHANNEL_CACHE_MAX_CHANNELS - SEEDS.length + 2 },
        (_, i) => ({ name: `bulk-${i}` }),
      ),
    );
    // dev-secret and dev-archived are hidden, so the bot sees exactly the cap.
    expect((await search("")).page.truncated).toBe(false);
  });

  test("the 501st app pushes out the one used least recently", async () => {
    let reads = 0;
    const cache = createSlackChannelCache();
    const listPage = async () => async () => {
      reads += 1;
      return { channels: [], nextCursor: null };
    };
    for (let i = 0; i < SLACK_CHANNEL_CACHE_MAX_APPS; i += 1) {
      await cache.lookup(`app-${i}`, listPage);
    }
    await cache.lookup("app-0", listPage); // app-1 is now the oldest
    expect(reads).toBe(SLACK_CHANNEL_CACHE_MAX_APPS);
    await cache.lookup("app-new", listPage);
    expect(cache.size()).toBe(SLACK_CHANNEL_CACHE_MAX_APPS);
    expect((await cache.lookup("app-0", listPage)).cache).toBe("hit");
    expect((await cache.lookup("app-1", listPage)).cache).toBe("miss");
  });

  test("a key pushed out of the LRU mid-read still shares that read", async () => {
    let clock = 0;
    let reads = 0;
    let release: () => void = () => {};
    const cache = createSlackChannelCache({ maxApps: 2, now: () => clock });
    const quick = async () => async () => {
      reads += 1;
      return { channels: [], nextCursor: null };
    };
    const slow = async () => async () => {
      reads += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { channels: [], nextCursor: null };
    };
    await cache.lookup("a", quick);
    clock = SLACK_CHANNEL_CACHE_TTL_MS;
    const first = cache.lookup("a", slow);
    await Bun.sleep(0);
    await cache.lookup("b", quick);
    await cache.lookup("c", quick); // pushes "a" out
    const second = cache.lookup("a", slow);
    await Bun.sleep(0);
    release();
    await Promise.all([first, second]);
    expect(reads).toBe(4);
    expect((await cache.lookup("a", quick)).cache).toBe("hit");
  });

  test("an invalidate mid-read keeps sharing the read but not its result", async () => {
    let reads = 0;
    let release: () => void = () => {};
    const cache = createSlackChannelCache();
    const slow = async () => async () => {
      reads += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { channels: [], nextCursor: null };
    };
    const first = cache.lookup("a", slow);
    await Bun.sleep(0);
    cache.invalidate("a");
    const second = cache.lookup("a", slow);
    await Bun.sleep(0);
    release();
    await Promise.all([first, second]);
    expect(reads).toBe(1);
    const third = cache.lookup("a", slow);
    await Bun.sleep(0);
    release();
    expect((await third).cache).toBe("miss");
    expect(reads).toBe(2);
  });

  test("a rate limit outlives the LRU pushing its app out", async () => {
    let reads = 0;
    const cache = createSlackChannelCache({ maxApps: 2 });
    const limited = async () => async () => {
      reads += 1;
      throw new SlackRateLimitedError("conversations.list", 7_200);
    };
    const quick = async () => async () => ({ channels: [], nextCursor: null });
    await cache.lookup("a", limited).catch(() => null);
    for (const key of ["b", "c", "d"]) await cache.lookup(key, quick);
    const again = await cache.lookup("a", limited).then(
      () => null,
      (error: unknown) => error,
    );
    expect(again).toBeInstanceOf(SlackRateLimitedError);
    expect(reads).toBe(1);
  });

  test("after a 429 mid-list, the next read resumes at Slack's cursor", async () => {
    let clock = 0;
    const asked: (string | null)[] = [];
    let limitOnce = true;
    const channel = (name: string) => ({
      id: `C0${name.toUpperCase()}`,
      name,
      is_private: false,
      is_member: false,
    });
    const pages: Record<string, { channels: string[]; next: string | null }> = {
      start: { channels: ["a1", "a2"], next: "p2" },
      p2: { channels: ["b1", "b2"], next: "p3" },
      p3: { channels: ["c1"], next: null },
    };
    const cache = createSlackChannelCache({ now: () => clock });
    const listPage = async () => async (cursor: string | null) => {
      asked.push(cursor);
      if (cursor === "p2" && limitOnce) {
        limitOnce = false;
        throw new SlackRateLimitedError("conversations.list", 7);
      }
      const page = pages[cursor ?? "start"];
      if (!page) throw new Error(`unknown cursor ${cursor}`);
      return {
        channels: page.channels.map(channel),
        nextCursor: page.next,
      };
    };
    expect(
      await cache.lookup("a", listPage).then(
        () => null,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(SlackRateLimitedError);
    clock = 7_000;
    const found = await cache.lookup("a", listPage);
    expect(found.snapshot.channels.map((c) => c.name)).toEqual([
      "a1",
      "a2",
      "b1",
      "b2",
      "c1",
    ]);
    expect(asked).toEqual([null, "p2", "p2", "p3"]);
  });

  test("a resumed read whose cursor Slack no longer takes starts over once", async () => {
    let clock = 0;
    const asked: (string | null)[] = [];
    let calls = 0;
    let expired = true;
    const cache = createSlackChannelCache({ now: () => clock });
    const channel = (name: string) => ({
      id: `C0${name.toUpperCase()}`,
      name,
      is_private: false,
      is_member: false,
    });
    const listPage = async () => async (cursor: string | null) => {
      asked.push(cursor);
      calls += 1;
      if (calls === 2) throw new SlackRateLimitedError("conversations.list", 1);
      if (cursor === "p2" && calls > 2 && expired) {
        expired = false;
        throw new SlackApiError("conversations.list", "invalid_cursor", true);
      }
      return cursor === null
        ? { channels: [channel("a1")], nextCursor: "p2" }
        : { channels: [channel("b1")], nextCursor: null };
    };
    await cache.lookup("a", listPage).catch(() => null);
    clock = 1_000;
    const found = await cache.lookup("a", listPage);
    // a1 is read twice but kept once: the cut read's part was dropped.
    expect(found.snapshot.channels.map((c) => c.name)).toEqual(["a1", "b1"]);
    expect(asked).toEqual([null, "p2", "p2", null, "p2"]);
  });

  test("an invalidate drops what a cut read had collected", async () => {
    let clock = 0;
    const asked: (string | null)[] = [];
    let limited = true;
    const cache = createSlackChannelCache({ now: () => clock });
    const listPage = async () => async (cursor: string | null) => {
      asked.push(cursor);
      if (cursor === "p2" && limited) {
        limited = false;
        throw new SlackRateLimitedError("conversations.list", 1);
      }
      return { channels: [], nextCursor: cursor === null ? "p2" : null };
    };
    await cache.lookup("a", listPage).catch(() => null);
    cache.invalidate("a");
    clock = 1_000;
    await cache.lookup("a", listPage);
    expect(asked).toEqual([null, "p2", null, "p2"]);
  });

  test("a binding PUT in this process drops the agent's cached channels", async () => {
    const { service, search, listCalls } = world();
    const set = { receipt_id: "r" } as unknown as PutSlackBindingResponse;
    const bindings = forgettingChannelsOnBindingPut(
      {
        putSlackBinding: async () => set,
        approveSlackBinding: async () => {
          throw new Error("not asked");
        },
        rejectSlackBinding: async () => {
          throw new Error("not asked");
        },
        listSlackBindings: async () => ({ items: [] }),
      } as SurfaceBindingService,
      service,
    );
    await search("de");
    expect(
      await bindings.putSlackBinding(owner, AGENT, {
        channel_id: "C0X",
        channel_kind: "public_channel",
        mode: "on",
        home: false,
      }),
    ).toBe(set);
    expect((await search("de")).cache).toBe("miss");
    expect(listCalls()).toBe(2);
  });

  test("429 with no list read answers 503 with Slack's Retry-After, and Slack is not asked again before it", async () => {
    const { slack, search, advance, listCalls } = world();
    slack.rateLimit("conversations.list", 7);
    const limited = await refusal(search("de"));
    expect(limited.code).toBe("BACKEND_UNAVAILABLE");
    expect(limited.retry).toEqual({ afterSeconds: 7 });
    advance(6_000);
    const still = await refusal(search("de"));
    expect(still.retry).toEqual({ afterSeconds: 1 });
    expect(listCalls()).toBe(1);
    advance(1_000);
    expect(names(await search("de"))).toHaveLength(5);
    expect(listCalls()).toBe(2);
  });

  test("429 with a list read answers it as stale until Retry-After passes", async () => {
    const { slack, search, advance, listCalls } = world();
    await search("de");
    advance(SLACK_CHANNEL_CACHE_TTL_MS);
    slack.rateLimit("conversations.list", 7);
    const stale = await search("de");
    expect(stale.page.stale).toBe(true);
    expect(stale.cache).toBe("stale");
    expect(names(stale)).toHaveLength(5);
    advance(6_999);
    expect((await search("ge")).page.stale).toBe(true);
    expect(listCalls()).toBe(2);
    advance(1);
    const fresh = await search("de");
    expect(fresh.page.stale).toBe(false);
    expect(listCalls()).toBe(3);
  });

  test("the next page of a stale list is stale too", async () => {
    const { slack, search, advance } = world();
    await search("de");
    advance(SLACK_CHANNEL_CACHE_TTL_MS);
    slack.rateLimit("conversations.list", 7);
    const first = await search("de", { limit: 2 });
    expect(first.page.stale).toBe(true);
    const next = await search("de", {
      limit: 2,
      cursor: first.page.next_cursor ?? "",
    });
    expect(names(next)).toEqual(["dev", "dev-ops"]);
    expect(next.page.stale).toBe(true);
    advance(7_000);
    const after = await search("de", {
      limit: 2,
      cursor: first.page.next_cursor ?? "",
    });
    expect(after.page.stale).toBe(false);
  });

  test("a long Retry-After is kept as Slack sent it", async () => {
    const { slack, search, advance, listCalls } = world();
    slack.rateLimit("conversations.list", 7_200);
    expect((await refusal(search("de"))).retry).toEqual({
      afterSeconds: 7_200,
    });
    advance(3_600_000);
    expect((await refusal(search("de"))).retry).toEqual({
      afterSeconds: 3_600,
    });
    expect(listCalls()).toBe(1);
  });

  test("no app, no bot token or a token Slack refuses answers SLACK_NOT_INSTALLED", async () => {
    const { service } = world();
    expect(
      (await refusal(service.searchSlackChannels(owner, BARE_AGENT, query(""))))
        .code,
    ).toBe("SLACK_NOT_INSTALLED");
    const tokenless = world({ botToken: false });
    expect((await refusal(tokenless.search(""))).code).toBe(
      "SLACK_NOT_INSTALLED",
    );
    const revoked = world();
    revoked.slack.apps.get(APP_ID)?.botTokens.splice(0);
    expect((await refusal(revoked.search(""))).code).toBe(
      "SLACK_NOT_INSTALLED",
    );
  });

  describe("a token Slack says was revoked (94S-1359)", () => {
    const calls = () => {
      const seen: Parameters<SlackTokenRevoked>[0][] = [];
      const tokenRevoked: SlackTokenRevoked = async (input) => {
        seen.push(input);
      };
      return { seen, tokenRevoked };
    };

    for (const code of ["token_revoked", "account_inactive"]) {
      test(`${code} revokes the install once per failed call, with the token that failed`, async () => {
        const { seen, tokenRevoked } = calls();
        const w = world({ slackError: code, tokenRevoked });
        expect((await refusal(w.search(""))).code).toBe("SLACK_NOT_INSTALLED");
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          workspaceId: WORKSPACE,
          agentId: AGENT,
          slackAppId: APP_ROW,
          failedToken: w.botToken,
        });
        const named = await refusal(w.lookup(["C0A"]));
        expect(named.code).toBe("SLACK_NOT_INSTALLED");
        expect(seen).toHaveLength(2);
      });
    }

    for (const code of [
      "invalid_auth",
      "not_authed",
      "token_expired",
      "ratelimited",
      "internal_error",
    ]) {
      test(`${code} answers the same 409 or a retry but changes no state`, async () => {
        const { seen, tokenRevoked } = calls();
        const w = world({ slackError: code, tokenRevoked });
        await refusal(w.search(""));
        await refusal(w.lookup(["C0A"]));
        expect(seen).toEqual([]);
      });
    }
  });

  test("an agent not in the caller's workspace is not found", async () => {
    const { service } = world();
    const missing = await refusal(
      service.searchSlackChannels(owner, crypto.randomUUID(), query("")),
    );
    expect(missing.code).toBe("NOT_FOUND");
  });

  test("a member without binding.manage is refused before Slack is asked", async () => {
    const { service, listCalls } = world();
    const refused = await refusal(
      service.searchSlackChannels(user("member"), AGENT, query("")),
    );
    expect(refused.code).toBe("FORBIDDEN");
    expect(listCalls()).toBe(0);
  });

  test("the bot token appears in no answer or refusal", async () => {
    const seen: unknown[] = [];
    const { slack, search, botToken, advance } = world();
    seen.push(await search(""));
    advance(SLACK_CHANNEL_CACHE_TTL_MS);
    slack.rateLimit("conversations.list", 7);
    seen.push(await search(""));
    const tokenless = world();
    tokenless.slack.apps.get(APP_ID)?.botTokens.splice(0);
    const refused = await refusal(tokenless.search(""));
    seen.push({ message: refused.message, details: refused.details });
    seen.push(slack.calls, tokenless.slack.calls);
    const text = JSON.stringify(seen);
    expect(text).not.toContain(botToken);
    expect(text).not.toContain(tokenless.botToken);
  });
});
