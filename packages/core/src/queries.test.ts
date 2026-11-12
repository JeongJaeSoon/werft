import { expect, test } from "bun:test";
import type { ApiClient } from "@werft-ai/client";
import * as queries from "./index.ts";

// Pins every key and option a factory hands the cache, and the request its
// query function makes, so moving the factories cannot change them.

const SCOPE = { actor: "user:u-1", workspace: "w-1" };

function scoped(client: unknown) {
  return queries.withQueryScope(client as ApiClient, SCOPE);
}

function recordingClient() {
  const calls: unknown[][] = [];
  const client = scoped({
    GET: (...args: unknown[]) => {
      calls.push(args);
      // An empty last page, so a query that reads every page stops.
      return Promise.resolve({
        data: { items: [], next_cursor: null },
        response: new Response(null),
      });
    },
  });
  return { client, calls };
}

const UNSCOPED_QUERIES = ["loginMethodsQuery", "meQuery", "viewerQuery"];

test("query keys", () => {
  const keys = queries.queryKeysOf(scoped({}));
  expect({
    ...queries.queryKeys,
    ...keys,
    memberPages: keys.memberPages("kim"),
    memberSummaries: keys.memberSummaries(["id-2", "id-1"]),
    teamPages: keys.teamPages("ops"),
    agentPages: keys.agentPages("notes"),
    agentsOnConnection: keys.agentsOnConnection("coding"),
    agentSummaries: keys.agentSummaries(["id-2", "id-1"]),
    agent: keys.agent("id-1"),
    agentAdmins: keys.agentAdmins("id-1"),
    team: keys.team("id-1"),
    session: keys.session("id-1"),
    agentSessions: keys.agentSessions("id-1"),
    sessionUsage: keys.sessionUsage("id-1"),
    pendingRequests: keys.pendingRequests("id-1"),
    sessionTurns: keys.sessionTurns("id-1"),
    sessionGithubWork: keys.sessionGithubWork("id-1"),
    usageSeries: keys.usageSeries("installation", "2026-07-26", "2026-10-24"),
    waitingSessionsBy: keys.waitingSessionsBy("shared"),
    usageBreakdown: keys.usageBreakdown("me", "2026-07-26", null, "model"),
  }).toMatchSnapshot();
});

test("a query outside the sign-in check refuses a client with no scope", () => {
  expect(() => queries.agentsQuery({} as ApiClient)).toThrow(
    "This query needs a client from withQueryScope",
  );
  expect<unknown>(queries.meQuery({} as ApiClient).queryKey).toEqual(["me"]);
});

test("the scope is the principal and its workspace", () => {
  const me = {
    principal: { kind: "user", id: "u-1", workspace_id: "w-1" },
    workspace: { id: "w-1" },
  } as unknown as Parameters<typeof queries.queryScopeOf>[0];
  expect(queries.queryScopeOf(me)).toEqual(SCOPE);
  expect(
    queries.queryScopeOf({
      ...me,
      principal: { ...me.principal, workspace_id: null },
      workspace: null,
    } as unknown as typeof me),
  ).toBeNull();
});

test("query options and the request each query makes", async () => {
  const factories = Object.entries(queries as Record<string, unknown>).filter(
    (entry): entry is [string, (client: ApiClient, id: string) => object] =>
      typeof entry[1] === "function" && entry[0].endsWith("Query"),
  );
  expect(factories.length).toBe(33);
  const out: Record<string, unknown> = {};
  for (const [name, factory] of factories.sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const { client, calls } = recordingClient();
    const { queryFn, ...options } = factory(client, "id-1") as {
      queryFn: (context: { pageParam: null }) => Promise<unknown>;
    };
    // The first page of a paged list; other queries take no page.
    await queryFn({ pageParam: null });
    out[name] = { options, calls };
    const first = (options as { queryKey: readonly unknown[] }).queryKey[0];
    if (UNSCOPED_QUERIES.includes(name)) expect(first).not.toEqual(SCOPE);
    else expect(first).toEqual(SCOPE);
  }
  expect(out).toMatchSnapshot();
});

test("the session list asks for the next page by the last page's cursor", async () => {
  const { client, calls } = recordingClient();
  const { queryFn, getNextPageParam } = queries.sessionsQuery(client);
  await queryFn({ pageParam: "cursor-2" } as Parameters<typeof queryFn>[0]);
  expect(calls).toEqual([
    ["/v1/sessions", { params: { query: { cursor: "cursor-2" } } }],
  ]);
  const page = { items: [], next_cursor: "cursor-3" };
  expect(getNextPageParam(page, [page], null, [null])).toBe("cursor-3");
});

test("a member page asks the server for one page, the search going with it", async () => {
  const { client, calls } = recordingClient();
  const all = queries.memberPagesQuery(client);
  await all.queryFn({ pageParam: null } as Parameters<typeof all.queryFn>[0]);
  const found = queries.memberPagesQuery(client, "kim");
  await found.queryFn({
    pageParam: "cursor-2",
  } as Parameters<typeof found.queryFn>[0]);
  expect(calls).toEqual([
    ["/v1/members", { params: { query: {} } }],
    ["/v1/members", { params: { query: { q: "kim", cursor: "cursor-2" } } }],
  ]);
  expect(all.queryKey as unknown).toEqual([
    SCOPE,
    "members",
    "pages",
    { q: null },
  ]);
  expect(found.queryKey as unknown).toEqual([
    SCOPE,
    "members",
    "pages",
    { q: "kim" },
  ]);
  const page = { items: [], next_cursor: "cursor-3", assignable_roles: [] };
  expect(found.getNextPageParam(page, [page], null, [null])).toBe("cursor-3");
});

test("the agent list reads every page, 100 at a time with summaries, and hands back all of them", async () => {
  const pages: Record<
    string,
    { items: { id: string }[]; next_cursor: string | null }
  > = {
    first: { items: [{ id: "a" }, { id: "b" }], next_cursor: "c2" },
    c2: { items: [{ id: "c" }], next_cursor: "c3" },
    c3: { items: [], next_cursor: null },
  };
  const calls: unknown[] = [];
  const client = scoped({
    GET: (_path: string, init: { params: { query: { cursor?: string } } }) => {
      calls.push(init.params.query);
      const data = pages[init.params.query.cursor ?? "first"];
      return Promise.resolve({ data, response: new Response(null) });
    },
  });
  const { queryFn } = queries.agentsQuery(client);
  const all = await queryFn({} as Parameters<typeof queryFn>[0]);
  expect(all.items.map((agent) => agent.id)).toEqual(["a", "b", "c"]);
  expect(all.next_cursor).toBeNull();
  expect(calls).toEqual([
    { include: "summary", limit: 100 },
    { include: "summary", cursor: "c2", limit: 100 },
    { include: "summary", cursor: "c3", limit: 100 },
  ]);
});

test("an agent page asks for one page with summaries, the search going with it, and named agents are one read", async () => {
  const { client, calls } = recordingClient();
  const all = queries.agentPagesQuery(client);
  await all.queryFn({ pageParam: null } as Parameters<typeof all.queryFn>[0]);
  const found = queries.agentPagesQuery(client, "notes");
  await found.queryFn({
    pageParam: "cursor-2",
  } as Parameters<typeof found.queryFn>[0]);
  const named = queries.agentSummariesQuery(client, ["id-2", "id-1"]);
  await named.queryFn({} as Parameters<typeof named.queryFn>[0]);
  expect(calls).toEqual([
    ["/v1/agents", { params: { query: { include: "summary" } } }],
    [
      "/v1/agents",
      {
        params: {
          query: { include: "summary", q: "notes", cursor: "cursor-2" },
        },
      },
    ],
    [
      "/v1/agents",
      {
        params: {
          query: { include: "summary", ids: "id-1,id-2", limit: 100 },
        },
      },
    ],
  ]);
  // Every agent change refreshes these: they sit under the agents key.
  for (const key of [all.queryKey, found.queryKey, named.queryKey]) {
    expect((key as readonly unknown[]).slice(0, 2)).toEqual([SCOPE, "agents"]);
  }
  expect(named.queryKey).toEqual(
    queries.agentSummariesQuery(client, ["id-1", "id-2"]).queryKey,
  );
});

test("named agents past a page are read 100 at a time", async () => {
  const { client, calls } = recordingClient();
  const ids = Array.from(
    { length: 150 },
    (_, i) => `id-${String(i).padStart(3, "0")}`,
  );
  const named = queries.agentSummariesQuery(client, ids);
  await named.queryFn({} as Parameters<typeof named.queryFn>[0]);
  expect(
    calls.map(([, init]) => {
      const query = (init as { params: { query: Record<string, unknown> } })
        .params.query;
      return typeof query.ids === "string"
        ? query.ids.split(",").length
        : query;
    }),
  ).toEqual([100, 50]);
});

test("named members are read 100 at a time and handed back as one list", async () => {
  const ids = Array.from(
    { length: 150 },
    (_, n) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
  );
  const calls: string[] = [];
  const client = scoped({
    GET: (_path: string, init: { params: { query: { user_ids: string } } }) => {
      const asked = init.params.query.user_ids.split(",");
      calls.push(`${asked.length}`);
      return Promise.resolve({
        data: {
          items: asked.map((user_id) => ({ user_id })),
          next_cursor: null,
          assignable_roles: ["member"],
        },
        response: new Response(null),
      });
    },
  });
  // Given twice and out of order: asked once each, in order.
  const named = queries.memberSummariesQuery(client, [
    ...[...ids].reverse(),
    ids[0] as string,
  ]);
  const read = (await named.queryFn(
    {} as Parameters<typeof named.queryFn>[0],
  )) as { items: { user_id: string }[]; next_cursor: null };
  expect(calls).toEqual(["100", "50"]);
  expect(read.items.map((member) => member.user_id)).toEqual(ids);
  expect(read.next_cursor).toBeNull();
  // Under "members", so every member change refreshes it.
  expect((named.queryKey as readonly unknown[]).slice(0, 2)).toEqual([
    SCOPE,
    "members",
  ]);
});

test("a team page asks for one page, the search going with it", async () => {
  const { client, calls } = recordingClient();
  const found = queries.teamPagesQuery(client, "ops");
  await found.queryFn({
    pageParam: "cursor-2",
  } as Parameters<typeof found.queryFn>[0]);
  expect(calls).toEqual([
    ["/v1/teams", { params: { query: { q: "ops", cursor: "cursor-2" } } }],
  ]);
  expect((found.queryKey as readonly unknown[]).slice(0, 2)).toEqual([
    SCOPE,
    "teams",
  ]);
});

test("the agent lists filter takes every list, page, count and summary but no agent's detail", () => {
  const client = scoped({});
  const keys = queries.queryKeysOf(client);
  const { queryKey, predicate } = queries.agentListsFilter(client);
  expect(queryKey).toEqual(keys.agents);
  const matched = (key: readonly unknown[]) => predicate({ queryKey: key });
  expect(
    [
      keys.agents,
      keys.agentPages(undefined),
      keys.agentPages("notes"),
      keys.agentCounts,
      keys.agentSummaries(["id-1"]),
      keys.agentSlackActions,
    ].map(matched),
  ).toEqual([true, true, true, true, true, true]);
  expect([keys.agent("id-1"), keys.agentAdmins("id-1")].map(matched)).toEqual([
    false,
    false,
  ]);
});

for (const [list, path, query] of [
  ["API key", "/v1/api-keys", queries.apiKeysQuery],
  ["team", "/v1/teams", queries.teamsQuery],
  ["own team", "/v1/my-teams", queries.myTeamsQuery],
] as const) {
  test(`the ${list} list reads every page, 100 at a time, and hands back all of them`, async () => {
    const pages: Record<
      string,
      { items: { id: string }[]; next_cursor: string | null }
    > = {
      first: { items: [{ id: "a" }, { id: "b" }], next_cursor: "c2" },
      c2: { items: [{ id: "c" }], next_cursor: null },
    };
    const calls: unknown[] = [];
    const client = scoped({
      GET: (path: string, init: { params: { query: { cursor?: string } } }) => {
        calls.push([path, init.params.query]);
        const data = pages[init.params.query.cursor ?? "first"];
        return Promise.resolve({ data, response: new Response(null) });
      },
    });
    const read = query(client).queryFn as unknown as () => Promise<{
      items: { id: string }[];
      next_cursor: string | null;
    }>;
    const all = await read();
    expect(all.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(all.next_cursor).toBeNull();
    expect(calls).toEqual([
      [path, { limit: 100 }],
      [path, { cursor: "c2", limit: 100 }],
    ]);
  });
}

// A push is asked for after its turn ended and no event says so, so the list
// is read often even while nothing is open.
test("sessionGithubWorkQuery reads every 10 s while a push waits and every 15 s otherwise", () => {
  const { client } = recordingClient();
  const interval = queries.sessionGithubWorkQuery(client, "s-1")
    .refetchInterval as unknown as (query: {
    state: { data: unknown };
  }) => number;
  const request = (state: string) => ({ state, pr_state: null });
  const at = (data: unknown) => interval({ state: { data } });
  expect(at({ items: [request("requested")], intents: [] })).toBe(10_000);
  expect(at({ items: [request("pushed")], intents: [] })).toBe(15_000);
  expect(at({ items: [], intents: [] })).toBe(15_000);
  expect(at(undefined)).toBe(15_000);
});
