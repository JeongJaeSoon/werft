import * as schema from "@werft-ai/db";
import { createPostgresSettingsDocumentStore } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import type { CatalogProviderConfig } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  DEMO_ACCOUNTS,
  DEMO_PASSWORD,
  demoAccountsRefusal,
  demoDatabaseUrl,
  previewDatabaseRefusal,
} from "./demo-accounts.ts";

// Agents, sessions and their outputs for the demo accounts to look at
// (docs/quickstart.md "웹 콘솔 데모 계정"). Everything goes through the
// public API as the demo owner and member would, against the fake model.

// compose.local.yml's fake-messages service: the only provider a demo
// session may call.
export const FAKE_MESSAGES_ENDPOINT = "http://fake-messages:4010";
// The fake model's connection, which --fake-model imports.
const CONNECTION_ID = "fake-messages";
const REPOSITORY_ID = "sample-app";
const MODEL = "claude-sonnet-5";

/**
 * Why this process must not seed demo data, or null: every refusal of the
 * demo accounts, and any connection that would reach a provider other than
 * the fake one. A release runs only on a connection, so no agent the seed
 * makes can reach one either.
 */
export function demoDataRefusal(
  env: Record<string, string | undefined>,
  connections: Readonly<Record<string, Pick<CatalogProviderConfig, "endpoint">>>,
): string | null {
  const refusal = demoAccountsRefusal(env);
  if (refusal) return refusal;
  const ids = Object.keys(connections);
  if (ids.length === 0) {
    return "the database holds no connection; start the stack with --fake-model";
  }
  for (const id of ids) {
    if (connections[id]?.endpoint !== FAKE_MESSAGES_ENDPOINT) {
      return `connection ${id} does not call the fake model at ${FAKE_MESSAGES_ENDPOINT}; start the stack with --fake-model`;
    }
  }
  return null;
}

type Role = (typeof DEMO_ACCOUNTS)[number]["role"];

type DemoAgent = {
  slug: string;
  name: string;
  role: string;
  instructions: string;
  /** The release's repository, which its sessions work on. */
  repositoryId?: string;
};

export const DEMO_AGENTS: readonly DemoAgent[] = [
  {
    slug: "release-notes",
    name: "릴리스 노트 작성",
    role: "변경 내역을 읽고 릴리스 노트 초안을 쓴다",
    instructions:
      "저장소의 최근 변경을 읽고 사용자에게 보이는 변화만 골라 릴리스 노트 초안을 out/ 아래에 쓴다.",
    repositoryId: REPOSITORY_ID,
  },
  {
    slug: "code-review",
    name: "코드 리뷰",
    role: "변경을 읽고 위험한 부분을 짚는다",
    instructions:
      "변경된 파일을 읽고 버그·회귀 가능성이 있는 곳을 근거와 함께 정리한다. 명령을 돌리기 전에 확인을 받는다.",
    repositoryId: REPOSITORY_ID,
  },
  {
    slug: "support-triage",
    name: "문의 분류",
    role: "들어온 문의를 분류하고 담당을 제안한다",
    instructions:
      "문의 내용을 읽고 유형·긴급도·담당 팀을 제안한다. 판단이 갈리면 사람에게 묻는다.",
  },
];

type Step = {
  tool: string;
  input: Record<string, unknown>;
  delayMs?: number;
};

function scripted(
  id: string,
  steps: Step[],
  final: string,
  finalDelayMs?: number,
) {
  return `GATE-SPEC ${JSON.stringify({ id, steps, final, ...(finalDelayMs === undefined ? {} : { finalDelayMs }) })}`;
}

// What the seed waits for after creating a session, and what it does then.
type Outcome =
  | "idle" // the script ends
  | "approve-then-idle" // every permission request is allowed
  | "permission" // left waiting on a permission request
  | "question" // left waiting on a question
  | "running" // the fake's last answer is held back
  | "stopped"; // the script ends, then the session is terminated

type DemoSession = {
  creator: Role;
  // Null: the first message has no text, so the session has no title.
  title: string | null;
  agent: string | null;
  repository: boolean;
  // Private to its creator, else the workspace default.
  private: boolean;
  message: string;
  outcome: Outcome;
};

// The running session reads in steps whose answers the fake holds back.
// One call held for hours was cut off within minutes; together the steps
// stay under the worker's one-hour turn limit (WORKER_MAX_TURN_SEC).
const RUNNING_STEP_DELAY_MS = 200_000;
const RUNNING_STEPS = 17;

export const DEMO_SESSIONS: readonly DemoSession[] = [
  {
    creator: "owner",
    title: "결제 모듈 릴리스 노트 초안",
    agent: "release-notes",
    repository: true,
    private: false,
    message: `지난주 결제 모듈 변경으로 릴리스 노트 초안을 써 주세요.\n\n${scripted(
      "demo-release-notes",
      [
        {
          tool: "Write",
          input: {
            file_path: "out/release-notes.md",
            content:
              "# 결제 모듈 릴리스 노트\n\n- 카드 결제 실패 시 재시도 안내를 보여 준다.\n- 영수증 메일에 주문 번호를 넣는다.\n",
          },
        },
      ],
      "out/release-notes.md에 초안을 썼습니다. 사용자에게 보이는 변경 두 가지를 정리했습니다.",
    )}`,
    outcome: "approve-then-idle",
  },
  {
    creator: "owner",
    title: "API 응답 시간 회귀 원인 찾기",
    agent: "code-review",
    repository: true,
    private: true,
    message: `어제 배포 뒤 API 응답이 느려진 원인을 찾아 주세요.\n\n${scripted(
      "demo-running",
      Array.from({ length: RUNNING_STEPS }, () => ({
        tool: "Read",
        input: { file_path: "README.md" },
        delayMs: RUNNING_STEP_DELAY_MS,
      })),
      "원인 후보를 정리했습니다.",
    )}`,
    outcome: "running",
  },
  {
    creator: "owner",
    title: "의존성 업데이트 영향 확인",
    agent: "code-review",
    repository: true,
    private: true,
    message: `의존성 업데이트가 테스트를 깨는지 확인해 주세요.\n\n${scripted(
      "demo-permission",
      [
        {
          tool: "Bash",
          // Not `npm test`: tests under the session workspace are
          // pre-approved, and this session has to stop on a permission card.
          input: { command: "npm install", description: "의존성 설치" },
        },
      ],
      "테스트에 영향을 주는 변경은 없었습니다.",
    )}`,
    outcome: "permission",
  },
  {
    creator: "owner",
    title: "지난주 문의 분류",
    agent: "support-triage",
    repository: false,
    private: false,
    message: `지난주 들어온 문의를 유형별로 나눠 주세요.\n\n${scripted(
      "demo-stopped",
      [],
      "결제 3건, 로그인 2건, 기타 1건으로 나눴습니다.",
    )}`,
    outcome: "stopped",
  },
  {
    creator: "member",
    title: "온보딩 문서 번역 범위 확인",
    agent: "support-triage",
    repository: false,
    private: false,
    message: `온보딩 문서를 번역하려고 합니다. 범위를 정해 주세요.\n\n${scripted(
      "demo-question",
      [
        {
          tool: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "어느 언어로 번역할까요?",
                header: "언어",
                multiSelect: false,
                options: [
                  { label: "영어", description: "해외 지사용" },
                  { label: "일본어", description: "도쿄 팀용" },
                ],
              },
            ],
          },
        },
      ],
      "선택한 언어로 번역 범위를 정리했습니다.",
    )}`,
    outcome: "question",
  },
  {
    creator: "member",
    title: "README 오타 수정",
    agent: null,
    repository: true,
    private: false,
    message: `README의 오타를 찾아 주세요.\n\n${scripted(
      "demo-idle",
      [{ tool: "Read", input: { file_path: "README.md" } }],
      "README에서 고칠 오타를 찾지 못했습니다.",
    )}`,
    outcome: "idle",
  },
  {
    creator: "member",
    title: null,
    agent: null,
    repository: false,
    private: false,
    // Whitespace alone: the title derived from it is empty, so none is kept.
    message: " ",
    outcome: "idle",
  },
];

type Response<T> = { status: number; body: T; headers: Headers };

export class DemoClient {
  constructor(
    private readonly base: string,
    private cookie = "",
  ) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<Response<T>> {
    const headers: Record<string, string> = {
      "x-requested-with": "werft-web",
    };
    if (this.cookie !== "") headers.cookie = this.cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined)
      headers["idempotency-key"] = idempotencyKey;
    // A GET, or a POST under one Idempotency-Key, is safe to send again.
    const retries = method === "GET" || idempotencyKey !== undefined ? 5 : 0;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await response.text();
      const parsed = (text === "" ? null : JSON.parse(text)) as T;
      const retryable =
        response.status === 503 &&
        (parsed as { error?: { retryable?: boolean } } | null)?.error
          ?.retryable === true;
      if (!retryable || attempt >= retries) {
        return {
          status: response.status,
          headers: response.headers,
          body: parsed,
        };
      }
      await Bun.sleep(1_000);
    }
  }

  async expect<T>(
    status: number,
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await this.request<T>(method, path, body, idempotencyKey);
    if (response.status !== status) {
      throw new Error(
        `${method} ${path} answered ${response.status}, expected ${status}: ${JSON.stringify(response.body)}`,
      );
    }
    return response.body;
  }

  async login(email: string) {
    const response = await this.request("POST", "/v1/auth/login", {
      email,
      password: DEMO_PASSWORD,
    });
    if (response.status !== 200) {
      throw new Error(`signing in as ${email} answered ${response.status}`);
    }
    this.cookie =
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Host-werft_session="))
        ?.split(";")[0] ?? "";
  }

  // Ends the web session login made: left behind, each run's would push a
  // person's own sign-in past the per-user limit. Signing out twice is
  // harmless, so a failed attempt is sent again.
  async logout() {
    if (this.cookie === "") return;
    let last = "";
    for (let attempt = 0; attempt < LOGOUT_ATTEMPTS; attempt++) {
      if (attempt > 0) await Bun.sleep(LOGOUT_RETRY_MS);
      try {
        const response = await this.request("POST", "/v1/auth/logout");
        if (response.status >= 200 && response.status < 300) {
          this.cookie = "";
          return;
        }
        last = `answered ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`signing out failed: ${last}`);
  }
}

const LOGOUT_ATTEMPTS = 5;
const LOGOUT_RETRY_MS = 1_000;

type AgentRow = {
  id: string;
  slug: string;
  active_release_id: string | null;
  activation_revision: number;
};

async function workspaceAgents(client: DemoClient): Promise<AgentRow[]> {
  const rows: AgentRow[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor
      ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "?limit=100";
    const page = await client.expect<{
      items: AgentRow[];
      next_cursor: string | null;
    }>(200, "GET", `/v1/agents${query}`);
    rows.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return rows;
}

const DEMO_TEAM = "데모 팀";

/**
 * The team that manages the demo agents, holding the demo member so the
 * owner's sessions on them stay visible to the member.
 */
async function ensureDemoTeam(
  owner: DemoClient,
  member: DemoClient,
): Promise<string> {
  let teamId: string | undefined;
  let cursor: string | null = null;
  do {
    const query: string = cursor
      ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "?limit=100";
    const page = await owner.expect<{
      items: { id: string; name: string }[];
      next_cursor: string | null;
    }>(200, "GET", `/v1/teams${query}`);
    teamId = page.items.find((team) => team.name === DEMO_TEAM)?.id;
    cursor = teamId === undefined ? page.next_cursor : null;
  } while (cursor !== null);
  if (teamId === undefined) {
    teamId = (
      await owner.expect<{ team: { id: string } }>(201, "POST", "/v1/teams", {
        name: DEMO_TEAM,
      })
    ).team.id;
  }
  const me = await member.expect<{ user: { id: string } }>(
    200,
    "GET",
    "/v1/auth/me",
  );
  // Adding someone already in the team writes nothing.
  await owner.expect(200, "POST", `/v1/teams/${teamId}/members`, {
    user_id: me.user.id,
  });
  return teamId;
}

async function ensureAgent(
  owner: DemoClient,
  agent: DemoAgent,
  teamId: string,
): Promise<{ releaseId: string; created: boolean }> {
  const existing = (await workspaceAgents(owner)).find(
    (row) => row.slug === agent.slug,
  );
  if (existing?.active_release_id) {
    return { releaseId: existing.active_release_id, created: false };
  }
  let agentId = existing?.id;
  let versionId: string | undefined;
  if (agentId === undefined) {
    const made = await owner.expect<{
      agent: { id: string };
      versions: { id: string }[];
    }>(201, "POST", "/v1/agents", {
      slug: agent.slug,
      name: agent.name,
      managing_team_id: teamId,
      card: {
        role: agent.role,
        instructions: agent.instructions,
        language: "ko",
        model: MODEL,
        capabilities: { mcp: null, forbidden: [] },
        rules: [],
      },
    });
    agentId = made.agent.id;
    versionId = made.versions[0]?.id;
  } else {
    // Made by an earlier run that stopped before activating it.
    const detail = await owner.expect<{ versions: { id: string }[] }>(
      200,
      "GET",
      `/v1/agents/${agentId}`,
    );
    versionId = detail.versions[0]?.id;
  }
  const released = await owner.expect<{ release: { id: string } }>(
    200,
    "POST",
    `/v1/agents/${agentId}/releases`,
    {
      version_id: versionId,
      connection_id: CONNECTION_ID,
      ...(agent.repositoryId ? { repository_id: agent.repositoryId } : {}),
    },
  );
  await owner.expect(200, "POST", `/v1/agents/${agentId}/activate`, {
    release_id: released.release.id,
    expected_revision: existing?.activation_revision ?? -1,
  });
  return { releaseId: released.release.id, created: existing === undefined };
}

type SessionRow = {
  id: string;
  title: string | null;
  status: string;
  revision: number;
  pending_request_count: number;
};

async function visibleSessions(client: DemoClient): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor
      ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
      : "?limit=100";
    const page = await client.expect<{
      items: SessionRow[];
      next_cursor: string | null;
    }>(200, "GET", `/v1/sessions${query}`);
    rows.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return rows;
}

async function alreadySeeded(
  client: DemoClient,
  rows: readonly SessionRow[],
  session: DemoSession,
): Promise<SessionRow | null> {
  if (session.title !== null) {
    return rows.find((row) => row.title === session.title) ?? null;
  }
  for (const row of rows.filter((candidate) => candidate.title === null)) {
    const turn = await client.request<{ message?: string }>(
      "GET",
      `/v1/sessions/${row.id}/turns/1`,
    );
    if (turn.body?.message === session.message) return row;
  }
  return null;
}

const SETTLE_TIMEOUT_MS = 180_000;

async function until<T>(
  what: string,
  check: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await Bun.sleep(2_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type PendingRow = { request_id: string; kind: string };

async function pendingOf(client: DemoClient, sessionId: string) {
  const body = await client.expect<{ items: PendingRow[] }>(
    200,
    "GET",
    `/v1/sessions/${sessionId}/pending-requests`,
  );
  return body.items;
}

async function drive(
  client: DemoClient,
  sessionId: string,
  session: DemoSession,
) {
  const detail = () =>
    client.expect<SessionRow>(200, "GET", `/v1/sessions/${sessionId}`);
  const settledIdle = () =>
    until(`${sessionId} to go idle`, async () => {
      const row = await detail();
      if (row.status === "failed") {
        throw new Error(`demo session ${sessionId} failed`);
      }
      return row.status === "idle" ? row : null;
    });
  switch (session.outcome) {
    case "idle":
      await settledIdle();
      return;
    case "approve-then-idle":
      await until(`${sessionId} to go idle`, async () => {
        const row = await detail();
        if (row.status === "idle") return row;
        for (const request of await pendingOf(client, sessionId)) {
          await client.expect(
            202,
            "POST",
            `/v1/sessions/${sessionId}/answers`,
            {
              request_id: request.request_id,
              kind: "permission",
              action: "allow",
            },
            crypto.randomUUID(),
          );
        }
        return null;
      });
      return;
    case "permission":
    case "question": {
      const kind = session.outcome;
      await until(`${sessionId} to ask for a ${kind}`, async () => {
        const pending = await pendingOf(client, sessionId);
        return pending.some((request) => request.kind === kind) ? true : null;
      });
      return;
    }
    case "running":
      await until(`${sessionId} to run`, async () => {
        const row = await detail();
        return row.status === "running" ? row : null;
      });
      return;
    case "stopped": {
      const row = await settledIdle();
      await client.expect(
        202,
        "POST",
        `/v1/sessions/${sessionId}/terminate`,
        { expected_revision: row.revision, reason: "demo" },
        crypto.randomUUID(),
      );
      await until(`${sessionId} to stop`, async () => {
        const after = await detail();
        return after.status === "stopped" ? after : null;
      });
      return;
    }
  }
}

/**
 * Whether an earlier run got through what it does to a session after making
 * it: the share, the allowed write's output, the terminate. Idle, waiting and
 * running are left out: they change on their own once seeded.
 */
export async function finished(
  client: DemoClient,
  sessionId: string,
  session: DemoSession,
): Promise<boolean> {
  if (session.private) {
    const share = await client.expect<{ scope: string }>(
      200,
      "GET",
      `/v1/sessions/${sessionId}/share`,
    );
    if (share.scope !== "private") return false;
  }
  if (session.outcome === "approve-then-idle") {
    const outputs = await client.request<{
      items: unknown[];
      error?: { code?: string };
    }>("GET", `/v1/sessions/${sessionId}/outputs`);
    // Lost checkpoints require an operator's recovery decision; reseeding
    // must leave that session alone while continuing with the other demos.
    if (
      outputs.status === 409 &&
      outputs.body?.error?.code === "CHECKPOINT_UNAVAILABLE"
    ) {
      console.warn(
        `awaiting-recovery session ${sessionId}: CHECKPOINT_UNAVAILABLE; existing demo left unchanged`,
      );
      return true;
    }
    if (outputs.status !== 200) {
      throw new Error(
        `GET /v1/sessions/${sessionId}/outputs answered ${outputs.status}, expected 200: ${JSON.stringify(outputs.body)}`,
      );
    }
    return outputs.body.items.length > 0;
  }
  if (session.outcome === "stopped") {
    const row = await client.expect<SessionRow>(
      200,
      "GET",
      `/v1/sessions/${sessionId}`,
    );
    return row.status === "stopped";
  }
  return true;
}

export type DemoDataOutcome = {
  kind: "agent" | "session";
  name: string;
  // incomplete: an earlier run made the session and failed before finishing
  // it (see finished); a rerun leaves it alone, so only a reset repairs it.
  outcome: "created" | "exists" | "incomplete";
};

/**
 * Adds whichever demo agent or session is missing, found by agent slug and
 * session title (an untitled one by its first message), and leaves every
 * existing row alone. The demo accounts must exist already.
 */
export async function seedDemoData(base: string): Promise<DemoDataOutcome[]> {
  const clients = {} as Record<Role, DemoClient>;
  for (const account of DEMO_ACCOUNTS) {
    clients[account.role] = new DemoClient(base);
  }
  let outcomes: DemoDataOutcome[] = [];
  let failure: { error: unknown } | null = null;
  try {
    for (const account of DEMO_ACCOUNTS) {
      await clients[account.role].login(account.email);
    }
    outcomes = await seedAs(clients);
  } catch (error) {
    failure = { error };
  }
  const signOut = await signOutAll(Object.values(clients)).then(
    () => null,
    (error: unknown) => error,
  );
  if (failure) {
    if (signOut) console.error(String(signOut));
    throw failure.error;
  }
  if (signOut) throw signOut;
  return outcomes;
}

/** Signs every client out, each whatever the others did, then fails once. */
export async function signOutAll(clients: readonly DemoClient[]) {
  const results = await Promise.allSettled(
    clients.map((client) => client.logout()),
  );
  const failed = results.flatMap((result) =>
    result.status === "rejected" ? [String(result.reason)] : [],
  );
  if (failed.length > 0) throw new Error(failed.join("; "));
}

async function seedAs(
  clients: Record<Role, DemoClient>,
): Promise<DemoDataOutcome[]> {
  const outcomes: DemoDataOutcome[] = [];
  const releases = new Map<string, string>();
  const teamId = await ensureDemoTeam(clients.owner, clients.member);
  for (const agent of DEMO_AGENTS) {
    const { releaseId, created } = await ensureAgent(
      clients.owner,
      agent,
      teamId,
    );
    releases.set(agent.slug, releaseId);
    outcomes.push({
      kind: "agent",
      name: agent.slug,
      outcome: created ? "created" : "exists",
    });
  }
  const visible = {
    owner: await visibleSessions(clients.owner),
    member: await visibleSessions(clients.member),
  };
  // One at a time: several sessions starting and polled at once held the
  // api's database pool long enough for running workers' heartbeats to fail.
  for (const session of DEMO_SESSIONS) {
    const name = session.title ?? "(제목 없음)";
    const client = clients[session.creator];
    const existing = await alreadySeeded(
      client,
      visible[session.creator],
      session,
    );
    if (existing) {
      outcomes.push({
        kind: "session",
        name,
        outcome: (await finished(client, existing.id, session))
          ? "exists"
          : "incomplete",
      });
      continue;
    }
    // Every session runs an agent release; one the script names none for
    // runs the agent that fits its repository.
    const agent =
      DEMO_AGENTS.find((row) => row.slug === session.agent) ??
      DEMO_AGENTS.find((row) =>
        session.repository
          ? row.repositoryId !== undefined
          : row.repositoryId === undefined,
      );
    const created = await client.expect<{ session_id: string }>(
      201,
      "POST",
      "/v1/sessions",
      {
        ...(session.title === null ? {} : { title: session.title }),
        ...(session.repository ? { repository_id: REPOSITORY_ID } : {}),
        ...(agent ? { agent_release_id: releases.get(agent.slug) } : {}),
        message: session.message,
      },
      crypto.randomUUID(),
    );
    if (session.private) {
      await client.expect(
        200,
        "POST",
        `/v1/sessions/${created.session_id}/share`,
        { scope: "private" },
        crypto.randomUUID(),
      );
    }
    await drive(client, created.session_id, session);
    outcomes.push({ kind: "session", name, outcome: "created" });
  }
  return outcomes;
}

async function storedConnections(): Promise<
  Record<string, CatalogProviderConfig>
> {
  const pool = createEnforcedPool(
    demoDatabaseUrl(process.env),
    createLogger(),
    "demo-data",
    JOB_POOL_TIMEOUTS,
  );
  try {
    const rows = await createPostgresSettingsDocumentStore(
      drizzle(pool, { schema }),
    ).listRows("connection");
    return Object.fromEntries(
      rows
        .filter((row) => row.disabledAt === null)
        .map((row) => [row.id, row.entry as CatalogProviderConfig]),
    );
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  // The installation is checked before anything of it is read.
  let refusal =
    demoAccountsRefusal(process.env) ??
    (await previewDatabaseRefusal(process.env));
  if (refusal === null) {
    try {
      refusal = demoDataRefusal(process.env, await storedConnections());
    } catch (error) {
      refusal = `cannot read the connections: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (refusal) {
    console.error(`demo data refused: ${refusal}`);
    process.exitCode = 2;
    return;
  }
  const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const outcomes = await seedDemoData(base);
  for (const { kind, name, outcome } of outcomes) {
    console.log(`${outcome} ${kind} ${name}`);
  }
  if (outcomes.some(({ outcome }) => outcome === "incomplete")) {
    console.error(
      "demo data incomplete: a session above was left as an earlier run failed; `scripts/local.sh reset --fake-model` seeds it again",
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
