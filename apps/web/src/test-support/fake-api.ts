import type { ApiClient } from "@werft-ai/client";
import type {
  AuthMeResponse,
  GitHubInstallationDetail,
  GitHubOAuth,
  GitHubSettingsConnection,
  GitHubSettingsInstallation,
  GitHubSettingsResponse,
  MemberActions,
  MemberRefusal,
  MemberRow,
  MemberView,
  WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type QueryScope,
  queryKeysOf,
  queryScopeOf,
  scopedKey,
  withQueryScope,
} from "@werft-ai/core";

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Headers;
  readonly body: unknown;
}

type Handler = (request: Request) => Response | Promise<Response>;

/** Answers by "METHOD /path?query" when that route exists, else by "METHOD /path", and records each request. */
export function fakeApi(routes: Record<string, Handler>) {
  const calls: Recorded[] = [];
  const fetch = async (input: Request): Promise<Response> => {
    const url = new URL(input.url);
    const key = `${input.method} ${url.pathname}`;
    const text = await input.text();
    calls.push({
      method: input.method,
      path: url.pathname,
      search: url.search,
      headers: input.headers,
      body: text ? JSON.parse(text) : null,
    });
    const handler =
      routes[`${key}${url.search}`] ??
      routes[key] ??
      (key === "GET /v1/agents/counts" && routes["GET /v1/agents"]
        ? agentCountsFrom(
            routes["GET /v1/agents"],
            routes["GET /v1/administered-agents"],
            input,
          )
        : undefined) ??
      repositoriesFrom(routes, key, input);
    if (!handler) return apiError(404, "NOT_FOUND", `no fake for ${key}`);
    // The body was read for the record; a handler gets one it can read again.
    return handler(
      text
        ? new Request(input.url, {
            method: input.method,
            headers: input.headers,
            body: text,
          })
        : input,
    );
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

/**
 * The catalog list a test that fakes only the author App's read implies: its
 * repositories as catalog rows, as the server lists them, beside no page.
 */
function repositoriesFrom(
  routes: Record<string, Handler>,
  key: string,
  input: Request,
): Handler | undefined {
  const match = /^GET \/v1\/workspaces\/([^/]+)\/github-repositories$/.exec(
    key,
  );
  const app = match
    ? routes[`GET /v1/workspaces/${match[1]}/github-apps/author`]
    : undefined;
  if (!app) return undefined;
  return async () => {
    const answer = await app(input);
    if (!answer.ok) return answer;
    const read = (await answer.json()) as {
      check: { state: string } | null;
      repositories: {
        id: string;
        url: string;
        installation_id: number | null;
      }[];
    };
    return json(200, {
      installations: [],
      installation_id: null,
      page: 1,
      per_page: 30,
      total_count: 0,
      repositories: [],
      unavailable: "no_installation",
      catalog: read.repositories.map((repository) => ({
        id: repository.id,
        github_repository_id: null,
        full_name: new URL(repository.url).pathname
          .replace(/^\//, "")
          .replace(/\.git$/, ""),
        url: repository.url,
        branch: "main",
        source: "console",
        version: 1,
        installed:
          read.check?.state === "ok"
            ? repository.installation_id !== null
            : null,
        updated_at: null,
        agent_count: 0,
      })),
    });
  };
}

/**
 * Counts the agent list fake answers, the way the server counts its rows, so
 * a test that fakes only the lists also answers the counts. A refused list
 * refuses the counts too.
 */
function agentCountsFrom(
  list: Handler,
  administered: Handler | undefined,
  request: Request,
): Handler {
  const read = async (handler: Handler, path: string) =>
    handler(
      new Request(new URL(path, request.url), { headers: request.headers }),
    );
  return async () => {
    const response = await read(list, "/v1/agents");
    if (!response.ok) return response;
    const { items } = (await response.json()) as {
      items: {
        status: string;
        active_release_id: string | null;
        managing_team_id?: string | null;
      }[];
    };
    const mine = administered
      ? await read(administered, "/v1/administered-agents")
      : null;
    return json(200, {
      counts: {
        all: items.length,
        administered: mine?.ok
          ? ((await mine.json()) as { items: unknown[] }).items.length
          : 0,
        active: items.filter(
          (a) => a.status === "active" && a.active_release_id !== null,
        ).length,
        draft: items.filter(
          (a) => a.status !== "archived" && a.active_release_id === null,
        ).length,
      },
    });
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The `details` the server puts on a "secret store is off" answer. */
export const STORE_OFF = { reason_code: "secret_store_off" };

export function apiError(
  status: number,
  code: string,
  message: string,
  retryable = false,
  details: unknown = null,
) {
  return json(status, {
    error: {
      code,
      message,
      retryable,
      request_id: "req-1",
      details,
    },
  });
}

export const WORKSPACE_ID = "6d4c1f5e-4c39-4d7a-9a51-0f4f3c7a2b10";
export const USER_ID = "0b1d0c7e-1f27-4a3e-8a8e-9c1b2d3e4f50";
export const RECEIPT_ID = "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c";

const OWNER_SCOPES: AuthMeResponse["scopes"] = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
  "sessions:recover",
];

const MEMBER_PERMISSIONS: AuthMeResponse["permissions"] = [
  "api_key.manage_own",
  "account.link",
  "agent.create",
];
const ADMIN_PERMISSIONS: AuthMeResponse["permissions"] = [
  ...MEMBER_PERMISSIONS,
  "workspace.manage",
  "member.manage",
  "team.manage",
  "api_key.manage",
  "agent.manage",
  "agent.admin.manage",
  "credential.bind",
  "binding.manage",
  "binding.approve",
  "achievement_rule.manage",
  "achievement.review",
];
/** What the server's role table gives each role on its workspace. */
export const PERMISSIONS: Record<WorkspaceRole, AuthMeResponse["permissions"]> =
  {
    member: MEMBER_PERMISSIONS,
    admin: ADMIN_PERMISSIONS,
    owner: [
      ...ADMIN_PERMISSIONS,
      "audit_retention.manage",
      "agent.restore",
      "usage.installation_read",
      "profile.installation.manage",
      "installation.settings.manage",
    ],
  };

/** Only an owner may hold sessions:recover; the contract rejects it on others. */
export function me(
  scopes?: AuthMeResponse["scopes"],
  role: WorkspaceRole = "owner",
): AuthMeResponse {
  scopes ??=
    role === "owner"
      ? OWNER_SCOPES
      : OWNER_SCOPES.filter((scope) => scope !== "sessions:recover");
  return {
    principal: {
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      role,
      scopes,
    },
    user: {
      id: USER_ID,
      email: "owner@example.com",
      display_name: "Owner",
      locale: null,
    },
    workspace: {
      id: WORKSPACE_ID,
      slug: "acme",
      name: "Acme",
      settings: {
        dispatch_model: null,
        kill_switch: false,
        daily_cost_limit_usd: null,
        idle_pause_minutes: 30,
        audit_retention_days: 90,
        slack_guest_enabled: false,
        agent_outsider_access: "use",
        agent_outsider_session_visibility: "managing_team",
        achievement_judge: {
          connection_id: null,
          threshold: 0.9,
          on_evidence: true,
          every_n_turns: null,
          on_idle: false,
          transcript: "recent",
          daily_budget_usd: 1,
          max_per_session: 20,
        },
      },
      created_at: "2026-10-01T00:00:00.000Z",
    },
    scopes,
    permissions: PERMISSIONS[role],
  };
}

/** A signed-in member without management powers. */
export function memberMe(): AuthMeResponse {
  return me(undefined, "member");
}

export const GITHUB_SETTINGS = `/v1/workspaces/${WORKSPACE_ID}/github-settings`;

/** The workspace's GitHub settings; user linking is ready unless `oauth` says otherwise. */
export function githubSettings(
  oauth: Partial<GitHubOAuth> = {},
): GitHubSettingsResponse {
  return {
    ceiling: {
      workflows: false,
      actions: false,
      checks: false,
      issues: false,
      review: false,
      merge: false,
    },
    revision: 0,
    pull_request: {
      formatting: "on",
      default_template: null,
      template_mode: "repository_first",
      session_link: "url",
    },
    pull_request_revision: 0,
    agents_using: {
      workflows: 0,
      actions: 0,
      checks: 0,
      issues: 0,
      review: 0,
    },
    oauth: {
      client_id: "Iv23lifake",
      client_secret_set: true,
      callback_url: "http://console.test/settings/linked-accounts/github",
      ...oauth,
    },
    connections: [],
    apps: { author: null, reviewer: null },
  };
}

/** The App every author fixture asks for: what writing a PR needs. */
export const BASE_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
} as const;

export const AUTHOR_CONNECTION = "1a2b3c4d-0000-4000-8000-00000000000a";
export const REVIEWER_CONNECTION = "1a2b3c4d-0000-4000-8000-00000000000b";

/** An author App read from GitHub with its key taken, installed nowhere. */
export function githubConnection(
  over: Partial<GitHubSettingsConnection> = {},
): GitHubSettingsConnection {
  return {
    connection_id: AUTHOR_CONNECTION,
    role: "author",
    name: "werft-agent",
    app_id: 101,
    html_url: "https://github.com/apps/werft-agent",
    owner: { login: "acme", type: "organization" },
    permissions: { ...BASE_PERMISSIONS },
    key_status: "ok",
    installations: [],
    installations_read_at: "2026-11-01T00:00:00.000Z",
    check: { state: "ok", checked_at: "2026-11-01T00:00:00.000Z" },
    ...over,
  };
}

/** An active installation as owners read it; `detail: null` is a member's. */
export function githubInstallation(
  over: Partial<Omit<GitHubSettingsInstallation, "detail">> & {
    readonly detail?: Partial<GitHubInstallationDetail> | null;
  } = {},
): GitHubSettingsInstallation {
  const { detail, ...rest } = over;
  return {
    id: 1,
    account: "acme",
    account_type: "organization",
    status: "active",
    ...rest,
    detail:
      detail === null
        ? null
        : {
            connection_id: AUTHOR_CONNECTION,
            role: "author",
            account_id: 9001,
            permissions: { ...BASE_PERMISSIONS },
            approval: "approved",
            repository_count: 12,
            repository_selection: "selected",
            html_url:
              "https://github.com/organizations/acme/settings/installations/1",
            created_at: "2026-10-01T00:00:00.000Z",
            suspended_at: null,
            connected: null,
            ...detail,
          },
  };
}

/** The scope the fixture user's screens cache under, whatever its role. */
export const SCOPE = queryScopeOf(me()) as QueryScope;
const scopedClient = withQueryScope({} as ApiClient, SCOPE);
/** The fixture user's cache keys. */
export const keys = queryKeysOf(scopedClient);
export const keyOf = <const K extends readonly unknown[]>(...key: K) =>
  scopedKey(scopedClient, ...key);

/** What the server says when it refuses every action on a row for one reason. */
export function refusedActions(reason: MemberRefusal): MemberActions {
  const refused = { allowed: false, reason } as const;
  return {
    change_role: { owner: refused, admin: refused, member: refused },
    disable: refused,
    enable: refused,
  };
}

/**
 * Everything the server could allow on the row: no refusal but `unchanged`.
 * A test that needs the server to refuse something says so in the row.
 */
export function openActions(view: MemberView): MemberActions {
  const verdict = (allowed: boolean) =>
    allowed
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "unchanged" } as const);
  const off = view.disabled_at !== null;
  return {
    change_role: {
      owner: verdict(view.role !== "owner"),
      admin: verdict(view.role !== "admin"),
      member: verdict(view.role !== "member"),
    },
    disable: verdict(!off),
    enable: verdict(off),
  };
}

/**
 * A GET /v1/members page. A row without `actions` gets them: the signed-in
 * user's own is refused as `self_protected`, as the server always does, and
 * any other is open. Without `assignable_roles` an invite may carry any role,
 * as an owner's may. A row without `administered_agents` or
 * `last_active_at` administers nothing and has never signed in.
 */
export function memberPage(page: {
  items: readonly (
    | MemberView
    | (MemberView &
        Pick<MemberRow, "actions"> &
        Partial<Pick<MemberRow, "administered_agents" | "last_active_at">>)
  )[];
  next_cursor: string | null;
  assignable_roles?: readonly WorkspaceRole[];
}) {
  return {
    ...page,
    assignable_roles: page.assignable_roles ?? ["owner", "admin", "member"],
    items: page.items.map(
      (item): MemberRow => ({
        administered_agents: [],
        last_active_at: null,
        actions:
          item.user_id === USER_ID
            ? refusedActions("self_protected")
            : openActions(item),
        ...item,
      }),
    ),
  };
}

const NO_RULES = { permissions: {}, auto_mode: {} };

/** GET /v1/workspaces/{id}/engine-settings: nothing saved, saving open. */
export function workspaceEngineSettings(over: Record<string, unknown> = {}) {
  return {
    settings: NO_RULES,
    settings_revision: null,
    writes_open: true,
    ...over,
  };
}

/** GET /v1/agents/{id}/engine-settings: nothing saved anywhere, saving open. */
export function agentEngineSettings(over: Record<string, unknown> = {}) {
  return {
    settings: NO_RULES,
    settings_revision: null,
    workspace: { settings: NO_RULES, settings_revision: null },
    inherited: { entries: 0, rules: 0 },
    reach: {
      agent_allow_without_effect: {
        permissions: [],
        auto_mode_allow: [],
        auto_mode_environment: [],
      },
      workspace_allow_inactive: false,
    },
    writes_open: true,
    ...over,
  };
}
