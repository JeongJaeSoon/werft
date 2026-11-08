import type {
  DataTag,
  DefaultError,
  InfiniteData,
  InfiniteQueryObserverOptions,
  QueryFunction,
  QueryKey,
  QueryObserverOptions,
} from "@tanstack/query-core";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  AgentAdminsView,
  AgentDetail,
  AuthMeResponse,
  CountAgentsResponse,
  ListAdministeredAgentsResponse,
  ListAgentsResponse,
  ListApiKeysResponse,
  ListInvitesResponse,
  ListLinkedAccountsResponse,
  ListMembersResponse,
  ListMyTeamsResponse,
  ListPendingRequestsResponse,
  ListProfilesResponse,
  ListPushRequestsResponse,
  ListSessionsResponse,
  ListTeamsResponse,
  ListTurnsResponse,
  LoginMethodsResponse,
  SessionDetail,
  SessionRelation,
  SessionUsageResponse,
  TeamDetail,
  UsageBreakdownBy,
  UsageBreakdownResponse,
  UsageSeriesResponse,
  UsageSummaryScope,
} from "@werft-ai/contracts";

type Options<T, K extends QueryKey> = QueryObserverOptions<
  T,
  DefaultError,
  T,
  T,
  K
> & { queryKey: K; queryFn: QueryFunction<T, K> };

/**
 * What react-query's `queryOptions` does, on query-core types: the key is
 * tagged with the data type, so `getQueryData(key)` and `setQueryData(key)`
 * know what the cache holds there.
 */
function queryOptions<T, K extends QueryKey>(
  options: Options<T, K>,
): Options<T, K> & { queryKey: DataTag<K, T, DefaultError> } {
  return options as Options<T, K> & { queryKey: DataTag<K, T, DefaultError> };
}

type InfiniteOptions<T, K extends QueryKey, P> = InfiniteQueryObserverOptions<
  T,
  DefaultError,
  InfiniteData<T, P>,
  K,
  P
> & { queryKey: K; queryFn: QueryFunction<T, K, P>; initialPageParam: P };

/** `queryOptions` for a paged list, as react-query's `infiniteQueryOptions`. */
function infiniteQueryOptions<T, K extends QueryKey, P>(
  options: InfiniteOptions<T, K, P>,
): InfiniteOptions<T, K, P> & {
  queryKey: DataTag<K, InfiniteData<T, P>, DefaultError>;
} {
  return options as InfiniteOptions<T, K, P> & {
    queryKey: DataTag<K, InfiniteData<T, P>, DefaultError>;
  };
}

// Detail, cost and pending requests change while a turn runs; the event
// stream is live, the rest is read again on this beat.
const LIVE_REFETCH_MS = 5_000;

/**
 * Who a cached answer belongs to: the principal that read it, in its
 * workspace. Every key but the ones that find out who is signed in starts
 * with it, so one cache can hold several principals' data without mixing
 * them, and one principal's entries can be dropped by prefix.
 */
export interface QueryScope {
  /** `<principal kind>:<principal id>`. */
  readonly actor: string;
  readonly workspace: string;
}

/** The scope `/v1/auth/me` describes; null outside any workspace. */
export function queryScopeOf(me: AuthMeResponse): QueryScope | null {
  const workspace = me.principal.workspace_id ?? me.workspace?.id ?? null;
  if (workspace === null) return null;
  return { actor: `${me.principal.kind}:${me.principal.id}`, workspace };
}

const clientScopes = new WeakMap<ApiClient, QueryScope>();

/** The same client, whose queries are cached under `scope`. */
export function withQueryScope(
  client: ApiClient,
  scope: QueryScope,
): ApiClient {
  const scoped = Object.create(client) as ApiClient;
  clientScopes.set(scoped, scope);
  return scoped;
}

function scopeOf(client: ApiClient): QueryScope {
  const scope = clientScopes.get(client);
  if (!scope) {
    throw new Error("This query needs a client from withQueryScope");
  }
  return scope;
}

/** A key of the client's scope, for a query no factory here covers. */
export function scopedKey<const K extends readonly unknown[]>(
  client: ApiClient,
  ...key: K
) {
  const scope = scopeOf(client);
  return [{ actor: scope.actor, workspace: scope.workspace }, ...key] as const;
}

/** Matches every entry of `scope`, to drop them all at once. */
export function queryScopeFilter(scope: QueryScope) {
  return {
    queryKey: [{ actor: scope.actor, workspace: scope.workspace }],
  } as const;
}

/**
 * The keys that find out who is signed in, and so cannot depend on it. A
 * change of who is signed in clears the whole cache.
 */
export const queryKeys = {
  me: ["me"] as const,
  viewer: ["me", "optional"] as const,
  loginMethods: ["login-methods"] as const,
};

/** Every other query key: the cache's public names, in the client's scope. */
export function queryKeysOf(client: ApiClient) {
  const s = scopedKey(client)[0];
  return {
    members: [s, "members"] as const,
    // Under "members", so every member change refreshes the loaded pages too.
    memberPages: (q: string | undefined) =>
      [s, "members", "pages", { q: q ?? null }] as const,
    firstMembers: [s, "members", "first"] as const,
    memberSummaries: (userIds: readonly string[]) =>
      [s, "members", { ids: [...userIds].sort() }] as const,
    invites: [s, "invites"] as const,
    agents: [s, "agents"] as const,
    // Object segments under "agents", so they never read as an agent id and
    // every agent change refreshes them too.
    agentPages: (q: string | undefined) =>
      [s, "agents", { pages: q ?? null }] as const,
    agentsOnProfile: (profileId: string) =>
      [s, "agents", { profile: profileId }] as const,
    agentCounts: [s, "agents", { counts: true }] as const,
    agentSummaries: (ids: readonly string[]) =>
      [s, "agents", { ids: [...ids].sort() }] as const,
    agentSlackActions: [s, "agents", { slackActions: true }] as const,
    agent: (id: string) => [s, "agents", id] as const,
    agentAdmins: (id: string) => [s, "agents", id, "admins"] as const,
    administeredAgents: [s, "administered-agents"] as const,
    teams: [s, "teams"] as const,
    // Under "teams", so every team change refreshes it too.
    myTeams: [s, "teams", "mine"] as const,
    teamPages: (q: string | undefined) =>
      [s, "teams", { pages: q ?? null }] as const,
    linkedAccounts: [s, "linked-accounts"] as const,
    apiKeys: [s, "api-keys"] as const,
    profiles: [s, "profiles"] as const,
    team: (id: string) => [s, "teams", id] as const,
    sessions: [s, "sessions"] as const,
    // An object segment, so it never reads as a session id.
    waitingSessions: [s, "sessions", { status: "needs_input" }] as const,
    waitingSessionsBy: (relation: SessionRelation) =>
      [s, "sessions", { status: "needs_input", relation }] as const,
    // Every agent's list matches agentSessionLists, so a session change
    // refreshes them all without knowing which agent it belongs to.
    agentSessionLists: [s, "sessions", { list: "agent" }] as const,
    agentSessions: (agentId: string) =>
      [s, "sessions", { list: "agent", agent_id: agentId }] as const,
    session: (id: string) => [s, "sessions", id] as const,
    sessionUsage: (id: string) => [s, "sessions", id, "usage"] as const,
    pendingRequests: (id: string) =>
      [s, "sessions", id, "pending-requests"] as const,
    sessionTurns: (id: string) => [s, "sessions", id, "turns"] as const,
    /** A session's push requests and intents, as the web's GitHub work list. */
    sessionGithubWork: (id: string) =>
      [s, "sessions", id, "github-work"] as const,
    usageSeries: (
      scope: UsageSummaryScope,
      since: string,
      until: string | null,
    ) => [s, "usage-series", scope, since, until] as const,
    usageBreakdown: (
      scope: UsageSummaryScope,
      since: string,
      until: string | null,
      by: UsageBreakdownBy,
    ) => [s, "usage-breakdown", scope, since, until, by] as const,
  };
}

export function meQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.me,
    queryFn: () => unwrap(client.GET("/v1/auth/me")) as Promise<AuthMeResponse>,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * Who is signed in on a page that works either way (the invite link): no
 * session is an answer here, not a reason to send the reader to /login.
 */
export function viewerQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.viewer,
    queryFn: async (): Promise<AuthMeResponse | null> => {
      try {
        return (await unwrap(client.GET("/v1/auth/me"))) as AuthMeResponse;
      } catch (error) {
        if (isApiError(error, "UNAUTHORIZED")) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export function loginMethodsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.loginMethods,
    queryFn: () =>
      unwrap(
        client.GET("/v1/auth/login-methods"),
      ) as Promise<LoginMethodsResponse>,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** Ceilings change rarely, so the list seldom moves under a page. */
export function profilesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).profiles,
    queryFn: () =>
      unwrap(client.GET("/v1/profiles")) as Promise<ListProfilesResponse>,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

// PAGE_LIMIT_MAX, for the lists read to the end; this entry point imports no
// contracts values.
const READ_ALL_PAGE_LIMIT = 100;

/** Distinct ids, sorted, in requests of at most a page's worth each. */
function idChunks(ids: readonly string[]): string[][] {
  const sorted = [...new Set(ids)].sort();
  const chunks: string[][] = [];
  for (let at = 0; at < sorted.length; at += READ_ALL_PAGE_LIMIT) {
    chunks.push(sorted.slice(at, at + READ_ALL_PAGE_LIMIT));
  }
  return chunks;
}

/** Every item of a paged list, and its last page for any page-level fields. */
async function readEveryPage<
  Page extends { items: unknown[]; next_cursor: string | null },
>(
  read: (query: { cursor?: string; limit: number }) => Promise<Page>,
): Promise<{ items: Page["items"]; last: Page }> {
  const items: Page["items"] = [];
  let cursor: string | null = null;
  let last: Page;
  do {
    last = await read(
      cursor
        ? { cursor, limit: READ_ALL_PAGE_LIMIT }
        : { limit: READ_ALL_PAGE_LIMIT },
    );
    items.push(...last.items);
    cursor = last.next_cursor;
  } while (cursor);
  return { items, last };
}

/** Every member of the workspace, every page read, oldest first. */
export function membersQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).members,
    queryFn: async (): Promise<ListMembersResponse> => {
      const { items, last } = await readEveryPage(
        (query) =>
          unwrap(
            client.GET("/v1/members", { params: { query } }),
          ) as Promise<ListMembersResponse>,
      );
      return {
        items,
        next_cursor: null,
        assignable_roles: last.assignable_roles,
      };
    },
    retry: false,
  });
}

/**
 * The workspace's two oldest members, one small read: enough to tell whether
 * anyone joined after the first, and to learn whether the caller may list
 * members at all.
 */
export function firstMembersQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).firstMembers,
    queryFn: () =>
      unwrap(
        client.GET("/v1/members", { params: { query: { limit: 2 } } }),
      ) as Promise<ListMembersResponse>,
    retry: false,
  });
}

/**
 * The workspace's members a page at a time, oldest first: those whose name
 * or email contains `q` when one is given.
 */
export function memberPagesQuery(client: ApiClient, q?: string) {
  return infiniteQueryOptions({
    queryKey: queryKeysOf(client).memberPages(q),
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/members", {
          params: {
            query: {
              ...(q ? { q } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<ListMembersResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    // A list left behind (another search, another tab) is dropped, so coming
    // back reads its first page instead of every page it had.
    gcTime: 0,
    retry: false,
  });
}

/**
 * The members among these users, read 100 at a time: for a screen that
 * already holds the ids (a team's people, a release's authors) and needs
 * their names or roles.
 */
export function memberSummariesQuery(
  client: ApiClient,
  userIds: readonly string[],
) {
  return queryOptions({
    queryKey: queryKeysOf(client).memberSummaries(userIds),
    queryFn: async (): Promise<ListMembersResponse> => {
      const pages = (await Promise.all(
        idChunks(userIds).map((chunk) =>
          unwrap(
            client.GET("/v1/members", {
              params: {
                query: {
                  user_ids: chunk.join(","),
                  limit: READ_ALL_PAGE_LIMIT,
                },
              },
            }),
          ),
        ),
      )) as ListMembersResponse[];
      return {
        items: pages.flatMap((page) => page.items),
        next_cursor: null,
        assignable_roles: pages.at(-1)?.assignable_roles ?? [],
      };
    },
    retry: false,
  });
}

export function invitesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).invites,
    queryFn: () =>
      unwrap(client.GET("/v1/invites")) as Promise<ListInvitesResponse>,
    retry: false,
  });
}

/**
 * Every agent of the workspace, every page read, oldest first, each with the
 * summary its card shows, so a list of cards does not read each agent.
 */
export function agentsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).agents,
    queryFn: async (): Promise<ListAgentsResponse> => {
      const { items } = await readEveryPage(
        (query) =>
          unwrap(
            client.GET("/v1/agents", {
              params: { query: { include: "summary", ...query } },
            }),
          ) as Promise<ListAgentsResponse>,
      );
      return { items, next_cursor: null };
    },
    retry: false,
  });
}

/**
 * The workspace's agents a page at a time, oldest first, with their card
 * summaries: those whose name or slug contains `q` when one is given.
 */
export function agentPagesQuery(client: ApiClient, q?: string) {
  return infiniteQueryOptions({
    queryKey: queryKeysOf(client).agentPages(q),
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/agents", {
          params: {
            query: {
              include: "summary",
              ...(q ? { q } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<ListAgentsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    // As memberPagesQuery: coming back reads the first page, not every page.
    gcTime: 0,
    retry: false,
  });
}

/** The agents whose active release runs on a profile, a page at a time. */
export function agentsOnProfileQuery(client: ApiClient, profileId: string) {
  return infiniteQueryOptions({
    queryKey: queryKeysOf(client).agentsOnProfile(profileId),
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/agents", {
          params: {
            query: {
              include: "summary",
              runtime_profile_id: profileId,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<ListAgentsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    gcTime: 0,
    retry: false,
  });
}

/**
 * The agents whose Slack tab asks a person for something, from the first
 * page of the list; `more` says the list went on past it.
 */
export function agentSlackActionsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).agentSlackActions,
    queryFn: async () => {
      const page = (await unwrap(
        client.GET("/v1/agents", {
          params: {
            query: { include: "summary", limit: READ_ALL_PAGE_LIMIT },
          },
        }),
      )) as ListAgentsResponse;
      return {
        items: page.items.filter((agent) => agent.summary?.slack_action),
        more: page.next_cursor !== null,
      };
    },
    retry: false,
  });
}

/** How many agents there are by state, without reading them. */
export function agentCountsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).agentCounts,
    queryFn: () =>
      unwrap(client.GET("/v1/agents/counts")) as Promise<CountAgentsResponse>,
    retry: false,
  });
}

/**
 * The named agents with their card summaries, one read for up to a page of
 * ids; an id of no agent in the workspace is left out.
 */
export function agentSummariesQuery(client: ApiClient, ids: readonly string[]) {
  return queryOptions({
    queryKey: queryKeysOf(client).agentSummaries(ids),
    queryFn: async (): Promise<ListAgentsResponse> => {
      const pages = (await Promise.all(
        idChunks(ids).map((chunk) =>
          unwrap(
            client.GET("/v1/agents", {
              params: {
                query: {
                  include: "summary",
                  ids: chunk.join(","),
                  limit: READ_ALL_PAGE_LIMIT,
                },
              },
            }),
          ),
        ),
      )) as ListAgentsResponse[];
      return { items: pages.flatMap((page) => page.items), next_cursor: null };
    },
    retry: false,
  });
}

export function agentQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeysOf(client).agent(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}", { params: { path: { id } } }),
      ) as Promise<AgentDetail>,
    retry: false,
  });
}

/** Every team of the workspace, every page read, by name. */
/** One page of the workspace's teams, the search going with it. */
export function teamPagesQuery(client: ApiClient, q?: string) {
  return infiniteQueryOptions({
    queryKey: queryKeysOf(client).teamPages(q),
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/teams", {
          params: {
            query: {
              ...(q ? { q } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ) as Promise<ListTeamsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    gcTime: 0,
    retry: false,
  });
}

export function teamsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).teams,
    queryFn: async (): Promise<ListTeamsResponse> => {
      const { items } = await readEveryPage(
        (query) =>
          unwrap(
            client.GET("/v1/teams", { params: { query } }),
          ) as Promise<ListTeamsResponse>,
      );
      return { items, next_cursor: null };
    },
    retry: false,
  });
}

export function teamQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeysOf(client).team(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/teams/{team_id}", {
          params: { path: { team_id: id } },
        }),
      ) as Promise<TeamDetail>,
    retry: false,
  });
}

export function agentAdminsQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeysOf(client).agentAdmins(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/admins", { params: { path: { id } } }),
      ) as Promise<AgentAdminsView>,
    retry: false,
  });
}

/** The agents the caller administers now, directly or through a team. */
export function administeredAgentsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).administeredAgents,
    queryFn: () =>
      unwrap(
        client.GET("/v1/administered-agents"),
      ) as Promise<ListAdministeredAgentsResponse>,
    retry: false,
  });
}

/** The teams the caller is in now, names only. */
/** Every team the caller belongs to, every page read, by name. */
export function myTeamsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).myTeams,
    queryFn: async (): Promise<ListMyTeamsResponse> => {
      const { items } = await readEveryPage(
        (query) =>
          unwrap(
            client.GET("/v1/my-teams", { params: { query } }),
          ) as Promise<ListMyTeamsResponse>,
      );
      return { items, next_cursor: null };
    },
    retry: false,
  });
}

export function linkedAccountsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).linkedAccounts,
    queryFn: () =>
      unwrap(
        client.GET("/v1/linked-accounts"),
      ) as Promise<ListLinkedAccountsResponse>,
    retry: false,
  });
}

/**
 * The caller's personal keys and the agent keys they may revoke, every page
 * read, newest first.
 */
export function apiKeysQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).apiKeys,
    queryFn: async (): Promise<ListApiKeysResponse> => {
      const { items } = await readEveryPage(
        (query) =>
          unwrap(
            client.GET("/v1/api-keys", { params: { query } }),
          ) as Promise<ListApiKeysResponse>,
      );
      return { items, next_cursor: null };
    },
    retry: false,
    // The key tabs share this list; issuing and revoking invalidate it.
    staleTime: 30_000,
  });
}

export function sessionsQuery(client: ApiClient) {
  return infiniteQueryOptions({
    queryKey: queryKeysOf(client).sessions,
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/sessions", {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      ) as Promise<ListSessionsResponse>,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    retry: false,
  });
}

/** The first page of sessions waiting on an answer, for the sidebar's badge. */
export function waitingSessionsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeysOf(client).waitingSessions,
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions", {
          params: { query: { status: "needs_input" } },
        }),
      ) as Promise<ListSessionsResponse>,
    retry: false,
    refetchInterval: 30_000,
  });
}

/** The first page of waiting sessions that came to the caller by `relation`. */
export function waitingSessionsByQuery(
  client: ApiClient,
  relation: SessionRelation,
) {
  return queryOptions({
    queryKey: queryKeysOf(client).waitingSessionsBy(relation),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions", {
          params: { query: { status: "needs_input", relation } },
        }),
      ) as Promise<ListSessionsResponse>,
    retry: false,
  });
}

/**
 * Matches the agent list reads (every list, page, count and summary under
 * "agents") but no single agent's detail, so a mutation that just wrote
 * that detail into the cache refreshes the lists without reading it again.
 */
export function agentListsFilter(client: ApiClient) {
  return {
    queryKey: queryKeysOf(client).agents,
    predicate: (query: { queryKey: readonly unknown[] }) =>
      query.queryKey.length === 2 ||
      (query.queryKey.length === 3 && typeof query.queryKey[2] === "object"),
  } as const;
}

/** Matches every agentSessionsQuery, whichever agent, to mark them stale. */
export function agentSessionListsFilter(client: ApiClient) {
  return { queryKey: queryKeysOf(client).agentSessionLists } as const;
}

/** The newest sessions of one agent the caller can read, for its overview. */
export function agentSessionsQuery(client: ApiClient, agentId: string) {
  return queryOptions({
    queryKey: queryKeysOf(client).agentSessions(agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions", {
          params: { query: { agent_id: agentId, limit: 5 } },
        }),
      ) as Promise<ListSessionsResponse>,
    retry: false,
  });
}

export function sessionQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeysOf(client).session(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}", { params: { path: { id } } }),
      ) as Promise<SessionDetail>,
    retry: false,
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/** Every turn of a session, oldest first: what each one was asked. */
export function sessionTurnsQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeysOf(client).sessionTurns(id),
    queryFn: async (): Promise<ListTurnsResponse> => {
      const { items } = await readEveryPage(
        (query) =>
          unwrap(
            client.GET("/v1/sessions/{id}/turns", {
              params: { path: { id }, query },
            }),
          ) as Promise<ListTurnsResponse>,
      );
      return { items, next_cursor: null };
    },
    retry: false,
  });
}

// Something is moving (waiting for approval, a turn to end, a pull request to
// open): look often; otherwise at the pace GitHub outcomes are read.
const GITHUB_WORK_ACTIVE_MS = 10_000;
const GITHUB_WORK_IDLE_MS = 60_000;
const OPEN_PUSH_STATES = new Set(["requested", "approved", "pushing"]);
const OPEN_PR_STAGES = new Set(["due", "opening"]);
const WAITING_INTENTS = new Set(["deferred", "pinned"]);

/** A session's push requests and the pushes its turns asked for. */
export function sessionGithubWorkQuery(
  client: ApiClient,
  id: string,
  options: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: queryKeysOf(client).sessionGithubWork(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/push-requests", {
          params: { path: { id } },
        }),
      ) as Promise<ListPushRequestsResponse>,
    retry: false,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    refetchInterval: (query) => {
      const data = query.state.data;
      const active =
        data !== undefined &&
        (data.items.some(
          (request) =>
            OPEN_PUSH_STATES.has(request.state) ||
            (request.pr_state !== null && OPEN_PR_STAGES.has(request.pr_state)),
        ) ||
          (data.intents ?? []).some((intent) =>
            WAITING_INTENTS.has(intent.status),
          ));
      return active ? GITHUB_WORK_ACTIVE_MS : GITHUB_WORK_IDLE_MS;
    },
  });
}

export function sessionUsageQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeysOf(client).sessionUsage(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/usage", { params: { path: { id } } }),
      ) as Promise<SessionUsageResponse>,
    retry: false,
    refetchInterval: LIVE_REFETCH_MS,
  });
}

/**
 * Day buckets of a period. A fixed `until` lets a screen read 90 days once
 * and cut the 7- and 30-day views from the same answer.
 */
export function usageSeriesQuery(
  client: ApiClient,
  scope: UsageSummaryScope,
  since: string,
  until: string | null = null,
) {
  return queryOptions({
    queryKey: queryKeysOf(client).usageSeries(scope, since, until),
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/series", {
          params: {
            query: { scope, since, ...(until === null ? {} : { until }) },
          },
        }),
      ) as Promise<UsageSeriesResponse>,
    retry: false,
  });
}

export function usageBreakdownQuery(
  client: ApiClient,
  scope: UsageSummaryScope,
  since: string,
  by: UsageBreakdownBy,
  until: string | null = null,
) {
  return queryOptions({
    queryKey: queryKeysOf(client).usageBreakdown(scope, since, until, by),
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/breakdown", {
          params: {
            query: { scope, since, by, ...(until === null ? {} : { until }) },
          },
        }),
      ) as Promise<UsageBreakdownResponse>,
    retry: false,
  });
}

export function pendingRequestsQuery(client: ApiClient, id: string) {
  return queryOptions({
    queryKey: queryKeysOf(client).pendingRequests(id),
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/pending-requests", {
          params: { path: { id } },
        }),
      ) as Promise<ListPendingRequestsResponse>,
    retry: false,
    refetchInterval: LIVE_REFETCH_MS,
  });
}
