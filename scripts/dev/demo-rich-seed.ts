// A demo installation with many display states, layered on the local demo
// data (apps/control-host/src/api/demo-data.ts). Runs inside the api
// container of a --fake-model stack started with the mock Slack overlay:
//   scripts/dev/demo-rich-seed.sh <verify run dir> [--keep-running]
// Public API first; the states no route can make (archived and paused
// agents, an expired key or invite, a stale link, past usage, a second
// workspace) are written to the database afterwards. Every step looks for
// its row first, so a rerun only adds what is missing.
// GitHub is never called: the author App row points its API base at a fake
// GitHub this process serves inside the container, so the App, its
// installation and the agent's repositories read as connected only while
// this script (or its --keep-running keeper) runs.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as schema from "@werft-ai/db";
import { createPostgresGitHubAppStore } from "@werft-ai/db";
import { SecretKey } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { DEMO_PASSWORD } from "../../apps/control-host/src/api/demo-accounts.ts";
import { FAKE_MESSAGES_ENDPOINT } from "../../apps/control-host/src/api/demo-data.ts";

const BASE = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const MOCK_SLACK = "http://mock-slack:4020";
const CREDS = process.env.DEMO_CREDS_FILE ?? "/tmp/demo-rich-creds.json";
const MODEL = "claude-sonnet-5";
// The fake-model stack's connection every release here runs on.
const CONNECTION = "fake-messages";
// A session that names no agent runs this one's release: every session runs
// an agent release.
const DEFAULT_AGENT = "deploy-helper";
const SETTLE_MS = 420_000;

const results: string[] = [];
function note(line: string) {
  results.push(line);
  console.log(line);
}
async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    note(
      `FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

type Reply<T> = { status: number; body: T; headers: Headers };

// The parts of each API response this script reads.
type ErrorBody = {
  error?: { code?: string; message?: string; retryable?: boolean };
};
type NewInvite = { invite_token: string };
type Team = { id: string; name: string };
type AgentRow = { id: string; slug: string; active_release_id: string | null };
type NewAgent = { agent: { id: string } };
type NewRelease = { release: { id: string } };
type AgentDetail = {
  agent: { active_release_id: string | null; activation_revision: number };
  versions: { id: string; version_no: number }[];
  releases: { id: string; version_id: string }[];
  active_release: { policy_pins: { github?: unknown } } | null;
};
// Loose on purpose: a key just made is kept under whichever name the create
// response carried it, down to a bare id.
type ApiKeyRow = {
  id?: string | undefined;
  name?: string | null;
  revoked_at?: string | null;
};
type NewApiKey = {
  secret: string;
  api_key?: ApiKeyRow;
  key?: ApiKeyRow;
  id?: string;
};
type SessionRow = {
  id: string;
  title: string | null;
  status: string;
  revision: number;
};
type NewSession = { session_id: string };
type PendingRequests = { items: { request_id: string; kind: string }[] };
type Limits = {
  limits: { session_cost_limit_usd: string; storage_limit_bytes?: number };
  usage?: unknown;
};

class Web {
  cookie = "";
  extra = "";
  bearer = "";
  constructor(readonly who: string) {}

  async req<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply<T>> {
    const headers: Record<string, string> = {
      "x-requested-with": "werft-web",
    };
    const cookies = [this.cookie, this.extra].filter(Boolean).join("; ");
    if (cookies) headers.cookie = cookies;
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await response.text();
      const parsed = (text === "" ? null : JSON.parse(text)) as T;
      const retryable =
        response.status === 503 &&
        (parsed as ErrorBody | null)?.error?.retryable === true;
      if (!retryable || attempt >= 5) {
        return {
          status: response.status,
          body: parsed,
          headers: response.headers,
        };
      }
      await Bun.sleep(1_000);
    }
  }

  async ok<T = unknown>(
    want: number | number[],
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const reply = await this.req<T>(method, path, body);
    const wanted = Array.isArray(want) ? want : [want];
    if (!wanted.includes(reply.status)) {
      // Bodies here never carry secrets: key and invite responses are read
      // by their callers, not through this message.
      const error = (reply.body as ErrorBody | null)?.error;
      throw new Error(
        `${this.who} ${method} ${path} -> ${reply.status} ${error?.code ?? ""} ${error?.message ?? ""}`.trim(),
      );
    }
    return reply.body;
  }

  async login(email: string, password: string) {
    const reply = await this.req("POST", "/v1/auth/login", { email, password });
    if (reply.status !== 200)
      throw new Error(`login ${email} -> ${reply.status}`);
    this.cookie =
      reply.headers
        .getSetCookie()
        .find((v) => v.startsWith("__Host-werft_session="))
        ?.split(";")[0] ?? "";
  }

  async logout() {
    if (this.cookie) await this.req("POST", "/v1/auth/logout").catch(() => {});
    this.cookie = "";
  }

  async all<T = unknown>(path: string): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page: { items: T[]; next_cursor?: string | null } = await this.ok(
        200,
        "GET",
        `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      rows.push(...page.items);
      cursor = page.next_cursor ?? null;
    } while (cursor);
    return rows;
  }
}

// ---------------------------------------------------------------- people

type Role = "owner" | "admin" | "member";
type Person = {
  key: string;
  email: string;
  name: string;
  role: Role;
  disabled?: boolean;
  emptyWorkspace?: boolean;
  slackUser?: string;
  link?: "active" | "stale" | "unlinked" | "offboarded";
};

const PEOPLE: Person[] = [
  {
    key: "owner",
    email: "demo-owner@example.test",
    name: "Demo Owner",
    role: "owner",
    slackUser: "U0OWNER",
    link: "active",
  },
  {
    key: "member",
    email: "demo-member@example.test",
    name: "Demo Member",
    role: "member",
    slackUser: "U0MEMBER",
    link: "stale",
  },
  {
    key: "admin",
    email: "seoyeon.park@example.test",
    name: "박서연",
    role: "admin",
    slackUser: "U0SEOYEON",
    link: "active",
  },
  {
    key: "owner2",
    email: "hana.jung@example.test",
    name: "정하나",
    role: "owner",
  },
  {
    key: "alex",
    email: "alex.kim@example.test",
    name: "Alex Kim",
    role: "member",
    slackUser: "U0ALEX",
    link: "active",
  },
  {
    key: "junho",
    email: "junho.lee@example.test",
    name: "이준호",
    role: "member",
  },
  {
    key: "fox",
    email: "fox@example.test",
    name: "🦊 여우 (Fox)",
    role: "member",
    slackUser: "U0FOX",
    link: "unlinked",
  },
  {
    key: "longname",
    email: "maximilian.von.schwarzenberg-hohenlohe.consulting@example.test",
    name: "Maximilian Alexander von Schwarzenberg-Hohenlohe (외부 컨설턴트)",
    role: "member",
  },
  {
    key: "minji",
    email: "minji.choi@example.test",
    name: "최민지",
    role: "member",
    disabled: true,
    slackUser: "U0MINJI",
    link: "offboarded",
  },
  {
    key: "empty",
    email: "empty.owner@example.test",
    name: "빈 워크스페이스 관리자",
    role: "owner",
    emptyWorkspace: true,
  },
];

const PENDING_INVITES: {
  email: string;
  role: Role;
  state: "pending" | "expired" | "revoked";
}[] = [
  { email: "newbie@example.test", role: "member", state: "pending" },
  { email: "contractor.admin@example.test", role: "admin", state: "pending" },
  { email: "late.joiner@example.test", role: "member", state: "expired" },
  { email: "wrong.address@example.test", role: "member", state: "revoked" },
];

type Creds = Record<
  string,
  { email: string; password: string; name: string; role: Role; note?: string }
>;
const creds: Creds = existsSync(CREDS)
  ? JSON.parse(readFileSync(CREDS, "utf8"))
  : {};
function saveCreds() {
  writeFileSync(CREDS, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

const db = new Pool({ connectionString: process.env["DATABASE_URL"] });
const q = async (text: string, values: unknown[] = []) =>
  (await db.query(text, values)).rows;

const ids: Record<string, string> = {};
const web: Record<string, Web> = {};

async function ensurePeople(owner: Web) {
  const members = await owner.all("/v1/members");
  for (const person of PEOPLE) {
    if (person.key === "owner" || person.key === "member") {
      creds[person.key] = {
        email: person.email,
        password: DEMO_PASSWORD,
        name: person.name,
        role: person.role,
        note: "local demo account",
      };
      continue;
    }
    await step(`person ${person.key}`, async () => {
      const [existing] = await q("select id from users where email = $1", [
        person.email,
      ]);
      if (existing) {
        note(`exists person ${person.key}`);
        return;
      }
      const password = randomBytes(12).toString("base64url");
      const invite = await owner.ok<NewInvite>(201, "POST", "/v1/invites", {
        email: person.email,
        role: person.role,
      });
      const accepted = await new Web(person.key).ok<{ role: string }>(
        200,
        "POST",
        "/v1/invites/accept",
        {
          token: invite.invite_token,
          password,
          display_name: person.name,
        },
      );
      creds[person.key] = {
        email: person.email,
        password,
        name: person.name,
        role: person.role,
      };
      saveCreds();
      note(`created person ${person.key} (${accepted.role})`);
    });
  }
  void members;
  for (const person of PEOPLE) {
    const [row] = await q("select id from users where email = $1", [
      person.email,
    ]);
    if (row) ids[`user:${person.key}`] = row.id;
  }
}

async function loginAll() {
  for (const person of PEOPLE) {
    if (person.disabled || person.emptyWorkspace) continue;
    const c = creds[person.key];
    if (!c) continue;
    const client = new Web(person.key);
    await step(`login ${person.key}`, () => client.login(c.email, c.password));
    if (client.cookie) web[person.key] = client;
  }
}

async function ensureInvites(owner: Web) {
  const invites = await owner.ok<{ items: { email: string }[] }>(
    200,
    "GET",
    "/v1/invites",
  );
  for (const invite of PENDING_INVITES) {
    await step(`invite ${invite.email}`, async () => {
      if (!invites.items.some((row) => row.email === invite.email)) {
        await owner.ok(201, "POST", "/v1/invites", {
          email: invite.email,
          role: invite.role,
        });
        note(`created invite ${invite.email}`);
      }
      if (invite.state === "expired") {
        await q(
          "update invites set expires_at = now() - interval '2 days' where email = $1 and accepted_at is null",
          [invite.email],
        );
      }
      if (invite.state === "revoked") {
        await q(
          "update invites set revoked_at = coalesce(revoked_at, now() - interval '1 day') where email = $1 and accepted_at is null",
          [invite.email],
        );
      }
    });
  }
}

// ----------------------------------------------------------------- teams

const TEAMS: { name: string; members: string[] }[] = [
  {
    name: "플랫폼팀",
    members: [
      "admin",
      "alex",
      "junho",
      "owner",
      "owner2",
      "member",
      "longname",
    ],
  },
  { name: "Customer Support", members: ["fox", "junho", "member", "owner2"] },
  {
    name: "디자인 시스템 🎨 · Design System Guild (cross-functional)",
    members: ["longname", "alex", "fox"],
  },
  { name: "빈 팀", members: [] },
];
const MANAGING_TEAM = "플랫폼팀";

async function ensureTeams(owner: Web) {
  const teams = await owner.all<Team>("/v1/teams");
  for (const team of TEAMS) {
    await step(`team ${team.name}`, async () => {
      let row = teams.find((t) => t.name === team.name);
      if (!row) {
        row = (
          await owner.ok<{ team: Team }>(201, "POST", "/v1/teams", {
            name: team.name,
          })
        ).team;
        note(`created team ${team.name}`);
      }
      ids[`team:${team.name}`] = row.id;
      for (const key of team.members) {
        const userId = ids[`user:${key}`];
        if (userId)
          await owner.ok(
            [200, 201, 409],
            "POST",
            `/v1/teams/${row.id}/members`,
            { user_id: userId },
          );
      }
    });
  }
}

// ---------------------------------------------------------------- agents

type Card = {
  role: string;
  instructions: string;
  language?: "ko" | "en";
  tone?: string;
  rules?: { id: string; text: string; source: "user" | "correction" }[];
};
type AgentSpec = {
  slug: string;
  name: string;
  /** Its releases name the sample repository. */
  repository?: true;
  versions: Card[];
  // Indexes into versions that get a release, in order; the last one in
  // active is activated.
  release: number[];
  active: number | null;
  status?: "paused" | "archived";
  admins?: { user?: string; team?: string }[];
};

const card = (c: Card) => ({
  role: c.role,
  instructions: c.instructions,
  language: c.language ?? "ko",
  model: MODEL,
  capabilities: { mcp: null, forbidden: [] },
  rules: c.rules ?? [],
});

const AGENTS: AgentSpec[] = [
  {
    slug: "deploy-helper",
    name: "배포 도우미",
    repository: true,
    versions: [
      {
        role: "배포 전 점검 목록을 확인한다",
        instructions:
          "배포 전에 마이그레이션·환경 변수·롤백 절차를 확인하고 빠진 항목을 알려 준다.",
      },
      {
        role: "배포 전 점검과 릴리스 노트 초안을 맡는다",
        instructions:
          "배포 전 점검 목록을 확인하고, 통과하면 릴리스 노트 초안을 out/ 아래에 쓴다.",
        rules: [
          {
            id: "r1",
            text: "프로덕션 명령은 실행 전에 반드시 확인을 받는다",
            source: "user",
          },
        ],
      },
      {
        role: "배포 전 점검·릴리스 노트·배포 후 확인까지 맡는다",
        instructions:
          "배포 전 점검, 릴리스 노트 초안, 배포 후 헬스체크 결과 요약까지 한 번에 정리한다.",
        rules: [
          {
            id: "r1",
            text: "프로덕션 명령은 실행 전에 반드시 확인을 받는다",
            source: "user",
          },
          {
            id: "r2",
            text: "금요일 오후에는 배포를 제안하지 않는다",
            source: "correction",
          },
        ],
      },
    ],
    release: [0, 1, 2],
    active: 1,
    admins: [{ team: "플랫폼팀" }, { user: "alex" }],
  },
  {
    slug: "readonly-reviewer",
    name: "읽기 전용 리뷰어",
    versions: [
      {
        role: "문서와 코드를 읽고 검토 의견만 낸다",
        instructions:
          "파일을 고치지 않고 읽기만 한다. 의견은 근거 파일 경로와 함께 목록으로 낸다.",
      },
      {
        role: "문서와 코드를 읽고 검토 의견을 내며, 모호하면 묻는다",
        instructions:
          "파일을 고치지 않고 읽기만 한다. 판단이 갈리면 선택지를 들어 사람에게 묻는다.",
        rules: [
          {
            id: "r1",
            text: "고쳐 달라는 요청에도 수정안만 제시하고 파일은 쓰지 않는다",
            source: "user",
          },
        ],
      },
    ],
    release: [0, 1],
    active: 1,
    admins: [{ team: "플랫폼팀" }],
  },
  {
    slug: "translator-en",
    name: "Translator (EN)",
    versions: [
      {
        role: "Translates Korean docs into natural English",
        instructions:
          "Translate the given Korean text into concise, natural English. Keep product terms as they are.",
        language: "en",
      },
    ],
    release: [0],
    active: 0,
    admins: [{ user: "fox" }],
  },
  {
    slug: "legacy-summarizer",
    name: "구 문서 요약기 (보관됨)",
    versions: [
      {
        role: "오래된 위키 문서를 요약한다",
        instructions: "위키 문서를 세 줄로 요약한다.",
      },
    ],
    release: [0],
    active: 0,
    status: "archived",
  },
  {
    slug: "nightly-check",
    name: "야간 배치 점검 (일시 중지)",
    repository: true,
    versions: [
      {
        role: "야간 배치 결과를 점검한다",
        instructions: "배치 로그를 읽고 실패한 작업과 원인을 정리한다.",
      },
    ],
    release: [0],
    active: 0,
    status: "paused",
  },
  {
    slug: "draft-no-release",
    name: "초안 에이전트 (배포 안 함)",
    versions: [
      {
        role: "아직 다듬는 중인 에이전트",
        instructions: "아직 배포하지 않은 초안이다.",
      },
    ],
    release: [],
    active: null,
  },
  {
    slug: "long-name-triage",
    name: "고객 문의 자동 분류 및 우선순위 지정 · 담당자 추천 에이전트 (실험 버전, 내부 전용)",
    versions: [
      {
        role: "문의를 분류하고 우선순위와 담당자를 추천한다",
        instructions:
          "문의 본문을 읽고 유형·우선순위·담당 팀을 표로 정리한다. 확신이 없으면 사람에게 묻는다.",
      },
    ],
    release: [0],
    active: 0,
    admins: [{ team: "Customer Support" }, { user: "junho" }],
  },
];

const releaseOf: Record<string, string> = {};
const agentId: Record<string, string> = {};

async function ensureAgents(owner: Web) {
  const existing = await owner.all<AgentRow>("/v1/agents");
  for (const row of existing) {
    agentId[row.slug] = row.id;
    if (row.active_release_id) releaseOf[row.slug] = row.active_release_id;
  }
  for (const spec of AGENTS) {
    await step(`agent ${spec.slug}`, async () => {
      let id = agentId[spec.slug];
      if (!id) {
        // Managed by its first admin team, else the platform team.
        const team =
          spec.admins?.find((admin) => admin.team)?.team ?? MANAGING_TEAM;
        const made = await owner.ok<NewAgent>(201, "POST", "/v1/agents", {
          slug: spec.slug,
          name: spec.name,
          managing_team_id: ids[`team:${team}`],
          card: card(spec.versions[0]!),
        });
        id = made.agent.id as string;
        agentId[spec.slug] = id;
        note(`created agent ${spec.slug}`);
      }
      let detail = await owner.ok<AgentDetail>(200, "GET", `/v1/agents/${id}`);
      for (let at = detail.versions.length; at < spec.versions.length; at++) {
        await owner.ok(200, "PATCH", `/v1/agents/${id}`, {
          card: card(spec.versions[at]!),
        });
      }
      detail = await owner.ok<AgentDetail>(200, "GET", `/v1/agents/${id}`);
      const versions = [...detail.versions].sort(
        (a, b) => a.version_no - b.version_no,
      );
      const releaseFor: Record<number, string> = {};
      for (const index of spec.release) {
        const version = versions[index]!;
        const found = detail.releases.find((r) => r.version_id === version.id);
        releaseFor[index] =
          found?.id ??
          (
            await owner.ok<NewRelease>(
              200,
              "POST",
              `/v1/agents/${id}/releases`,
              {
                version_id: version.id,
                connection_id: CONNECTION,
                ...(spec.repository ? { repository_id: "sample-app" } : {}),
              },
            )
          ).release.id;
      }
      if (spec.active !== null) {
        const want = releaseFor[spec.active]!;
        detail = await owner.ok<AgentDetail>(200, "GET", `/v1/agents/${id}`);
        if (detail.agent.active_release_id !== want) {
          // Walk through each release so the history shows every activation.
          for (const index of spec.release) {
            const current = await owner.ok<AgentDetail>(
              200,
              "GET",
              `/v1/agents/${id}`,
            );
            await owner.ok(200, "POST", `/v1/agents/${id}/activate`, {
              release_id: releaseFor[index],
              expected_revision: current.agent.activation_revision,
            });
          }
          const current = await owner.ok<AgentDetail>(
            200,
            "GET",
            `/v1/agents/${id}`,
          );
          if (current.agent.active_release_id !== want) {
            await owner.ok(200, "POST", `/v1/agents/${id}/activate`, {
              release_id: want,
              expected_revision: current.agent.activation_revision,
            });
          }
        }
        releaseOf[spec.slug] = want;
      }
      for (const admin of spec.admins ?? []) {
        const body = admin.user
          ? { user_id: ids[`user:${admin.user}`] }
          : { team_id: ids[`team:${admin.team}`] };
        await owner.ok(
          [200, 201, 409],
          "POST",
          `/v1/agents/${id}/admins`,
          body,
        );
      }
    });
  }
  // The local demo's code-review agent gets the admin as its admin, so the
  // admin tab has a person and a team on more than one agent.
  if (agentId["code-review"] && ids["user:admin"]) {
    await step("agent code-review admins", () =>
      owner.ok(
        [200, 201, 409],
        "POST",
        `/v1/agents/${agentId["code-review"]}/admins`,
        { user_id: ids["user:admin"] },
      ),
    );
  }
}

async function agentStatuses() {
  for (const spec of AGENTS) {
    if (!spec.status || !agentId[spec.slug]) continue;
    await q(
      "update agents set status = $1, updated_at = now() where id = $2 and status <> $1",
      [spec.status, agentId[spec.slug]],
    );
  }
}

// ----------------------------------------------------------------- slack

async function mockJson(path: string, init?: RequestInit) {
  const response = await fetch(`${MOCK_SLACK}${path}`, init);
  if (!response.ok)
    throw new Error(`mock ${path.split("?")[0]} -> ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function ensureSlack(owner: Web, workspaceId: string) {
  await step("slack config token", async () => {
    const current = await owner.ok<{ configured: boolean }>(
      200,
      "GET",
      `/v1/workspaces/${workspaceId}/slack/config-token`,
    );
    if (current.configured) return;
    const issued = await mockJson("/fake/config-tokens", { method: "POST" });
    await owner.ok(
      200,
      "PUT",
      `/v1/workspaces/${workspaceId}/slack/config-token`,
      { value: issued["refresh_" + "token"] },
    );
    note("created slack config token");
  });
  // support-triage: installed with several channel bindings; code-review:
  // app made but never installed.
  for (const slug of ["support-triage", "code-review"]) {
    const id = agentId[slug];
    if (!id) continue;
    await step(`slack app ${slug}`, async () => {
      const app = await owner.req<{ slack_app?: unknown }>(
        "GET",
        `/v1/agents/${id}/slack/app`,
      );
      if (app.status !== 200 || !app.body?.slack_app) {
        await owner.ok(200, "POST", `/v1/agents/${id}/slack/app`, {});
        note(`created slack app ${slug}`);
      }
    });
  }
  const support = agentId["support-triage"];
  if (!support) return;
  await step("slack install support-triage", async () => {
    const identities = await owner.ok<{ items: { status: string }[] }>(
      200,
      "GET",
      `/v1/agents/${support}/identities`,
    );
    if ((identities.items ?? []).some((row) => row.status === "active")) return;
    const start = await owner.ok<{ authorize_url: string }>(
      200,
      "POST",
      `/v1/agents/${support}/slack/install/start`,
    );
    const grant = await mockJson(
      `/fake/oauth/authorize${new URL(start.authorize_url).search}`,
    );
    await owner.ok(200, "POST", "/v1/slack/install/complete", {
      agent_id: support,
      state: grant.state,
      code: grant.code,
    });
    note("installed slack app support-triage");
  });
  const bindings = [
    {
      channel_id: "C0SUPPORT",
      channel_kind: "public_channel",
      mode: "on",
      home: true,
    },
    { channel_id: "C0ALERTS", channel_kind: "public_channel", mode: "off" },
    {
      channel_id: "G0VIPDESK",
      channel_kind: "private_channel",
      mode: "on",
      ceiling: {
        actions: ["session.read", "session.submit"],
        disclosure: "summary",
      },
    },
    { channel_id: null, channel_kind: "dm", mode: "on" },
  ];
  for (const binding of bindings) {
    await step(`slack binding ${binding.channel_id ?? "dm"}`, () =>
      owner.ok(
        [200, 201],
        "PUT",
        `/v1/agents/${support}/slack-bindings`,
        binding,
      ),
    );
  }
}

async function ensureLinks() {
  for (const person of PEOPLE) {
    if (!person.link || !person.slackUser) continue;
    await step(`link ${person.key}`, async () => {
      const userId = ids[`user:${person.key}`];
      const rows = await q(
        "select status from linked_accounts where user_id = $1",
        [userId],
      );
      if (rows.length > 0) return;
      let client = web[person.key];
      if (!client) {
        // The disabled person links first, then is disabled below.
        const c = creds[person.key];
        client = new Web(person.key);
        await client.login(c!.email, c!.password);
        web[person.key] = client;
      }
      const start = await client.req<ErrorBody & { authorize_url: string }>(
        "POST",
        "/v1/linked-accounts/slack/start",
      );
      if (start.status !== 200)
        throw new Error(
          `start -> ${start.status} ${start.body?.error?.code ?? ""}`,
        );
      client.extra =
        start.headers
          .getSetCookie()
          .find((v) => v.startsWith("werft_slack_link="))
          ?.split(";")[0] ?? "";
      const consent = await fetch(
        `${start.body.authorize_url}&mock_user=${person.slackUser}`,
        { redirect: "manual" },
      );
      const location = consent.headers.get("location");
      if (consent.status !== 302 || !location)
        throw new Error(`mock consent -> ${consent.status}`);
      const query = new URL(location).searchParams;
      await client.ok(201, "POST", "/v1/linked-accounts/slack/callback", {
        code: query.get("code"),
        state: query.get("state"),
      });
      client.extra = "";
      note(`linked slack ${person.key}`);
    });
  }
  for (const person of PEOPLE) {
    if (person.link === "stale") {
      await q(
        "update linked_accounts set status = 'stale', updated_at = now(), revision = revision + 1 where user_id = $1 and status = 'active'",
        [ids[`user:${person.key}`]],
      );
    }
    if (person.link === "unlinked" && web[person.key]) {
      await step(`unlink ${person.key}`, async () => {
        const list = await web[person.key]!.ok<{
          items: { id: string; status: string }[];
        }>(200, "GET", "/v1/linked-accounts");
        for (const row of list.items.filter((r) => r.status === "active")) {
          await web[person.key]!.ok(
            200,
            "DELETE",
            `/v1/linked-accounts/${row.id}`,
          );
        }
      });
    }
  }
}

async function disablePeople(owner: Web) {
  for (const person of PEOPLE.filter((p) => p.disabled)) {
    await step(`disable ${person.key}`, async () => {
      const [row] = await q(
        "select disabled_at from memberships where user_id = $1",
        [ids[`user:${person.key}`]],
      );
      if (row?.disabled_at) return;
      await web[person.key]?.logout();
      delete web[person.key];
      await owner.ok(
        200,
        "POST",
        `/v1/members/${ids[`user:${person.key}`]}/disable`,
        { reason: "퇴사 (데모)" },
      );
      note(`disabled ${person.key}`);
    });
  }
}

// ---------------------------------------------------------------- github

// Every name here is made up; nothing reaches github.com.
const FAKE_GITHUB_PORT = 4790;
const FAKE_GITHUB = `http://127.0.0.1:${FAKE_GITHUB_PORT}`;
const GH_ORG = "example-org";
const GH_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  actions: "write",
  checks: "write",
  issues: "write",
  workflows: "write",
} as const;
const GH_APP = {
  id: 4_200_001,
  slug: "example-agent-app",
  name: "Example Agent App",
  html_url: "https://github.com/apps/example-agent-app",
  client_id: "Iv1.exampleclient00",
  owner: { login: GH_ORG, type: "Organization" },
  permissions: GH_PERMISSIONS,
};
const GH_INSTALLATION = {
  id: 51_000_001,
  app_id: GH_APP.id,
  account: { login: GH_ORG, id: 91_000_001, type: "Organization" },
  repository_selection: "selected",
  html_url: `https://github.com/organizations/${GH_ORG}/settings/installations/51000001`,
  permissions: GH_PERMISSIONS,
  created_at: "2026-10-01T00:00:00Z",
  suspended_at: null,
};
const GH_REPOS = ["storefront-web", "payments-api", "design-tokens"].map(
  (name, i) => ({
    id: 810_000_001 + i,
    name,
    full_name: `${GH_ORG}/${name}`,
    owner: {
      login: GH_ORG,
      id: GH_INSTALLATION.account.id,
      type: "Organization",
    },
    html_url: `https://github.com/${GH_ORG}/${name}`,
    default_branch: "main",
    private: true,
  }),
);
// The agent's GitHub tab: two of the installation's three repositories.
const GH_PICKED = GH_REPOS.slice(0, 2);

function startFakeGitHub() {
  try {
    return Bun.serve({
      hostname: "127.0.0.1",
      port: FAKE_GITHUB_PORT,
      fetch(request) {
        const { pathname, searchParams } = new URL(request.url);
        const path = pathname.replace(/^\/api\/v3/, "");
        if (path === "/app") return Response.json(GH_APP);
        if (path === "/app/installations")
          return Response.json([GH_INSTALLATION]);
        if (/^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
          return Response.json(
            {
              token: `demo-installation-${randomBytes(8).toString("hex")}`,
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              permissions: GH_PERMISSIONS,
              repository_selection: "selected",
            },
            { status: 201 },
          );
        }
        if (path === "/installation/repositories") {
          const perPage = Number(searchParams.get("per_page") ?? 30);
          const page = Number(searchParams.get("page") ?? 1);
          return Response.json({
            total_count: GH_REPOS.length,
            repositories: GH_REPOS.slice((page - 1) * perPage, page * perPage),
          });
        }
        const byId = /^\/repositories\/(\d+)$/.exec(path);
        const found = byId
          ? GH_REPOS.find((repo) => repo.id === Number(byId[1]))
          : undefined;
        if (found) return Response.json(found);
        const installed = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(
          path,
        );
        if (
          installed &&
          GH_REPOS.some(
            (repo) => repo.full_name === `${installed[1]}/${installed[2]}`,
          )
        )
          return Response.json(GH_INSTALLATION);
        console.log(`fake github: no answer for ${request.method} ${path}`);
        return Response.json({ message: "Not Found" }, { status: 404 });
      },
    });
  } catch (error) {
    // Another run of this script already serves it.
    note(
      `fake github not started: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

// The API checks a key against github.com before it keeps one, so the row
// is written through the API's own store, sealed under the master key.
async function ensureGitHubApp(workspaceId: string) {
  const [held] = await q(
    "select id from github_apps where workspace_id = $1 and role = 'author'",
    [workspaceId],
  );
  if (held) return;
  const value = process.env["PLATFORM_SECRET_KEY"];
  if (!value)
    throw new Error(
      "the api runs without PLATFORM_SECRET_KEY; start the stack with one",
    );
  const store = createPostgresGitHubAppStore(
    drizzle(db, { schema }),
    SecretKey.fromHex(value, "PLATFORM_SECRET_KEY"),
  );
  const userId = ids["user:owner"]!;
  // A throwaway key: the fake never checks the App's signature.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const result = await store.put(
    workspaceId,
    { kind: "role", role: "author" },
    {
      appId: GH_APP.id,
      slug: GH_APP.slug,
      name: GH_APP.name,
      htmlUrl: GH_APP.html_url,
      permissions: GH_PERMISSIONS,
      clientId: GH_APP.client_id,
      apiBase: FAKE_GITHUB,
    },
    privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    {
      principal: {
        ownerId: workspaceId,
        actor: {
          principal: { kind: "user", id: userId },
          userId,
          workspaceId,
          apiKeyId: null,
        },
      },
      receiptId: crypto.randomUUID(),
      roles: ["owner"],
    },
  );
  if (result.outcome !== "stored")
    throw new Error(`github app store -> ${result.outcome}`);
  note("created github app (author)");
}

const GITHUB_AGENT = "github-helper";

async function ensureGitHub(owner: Web, workspaceId: string) {
  await step("github app", () => ensureGitHubApp(workspaceId));
  await step("github ceiling", async () => {
    const settings = await owner.ok<{
      ceiling: Record<string, boolean>;
      revision: number;
    }>(200, "GET", `/v1/workspaces/${workspaceId}/github-settings`);
    const ceiling = {
      workflows: true,
      actions: true,
      checks: true,
      issues: true,
      review: false,
    };
    if (Object.entries(ceiling).every(([k, v]) => settings.ceiling?.[k] === v))
      return;
    await owner.ok(
      200,
      "PUT",
      `/v1/workspaces/${workspaceId}/github-settings`,
      { ceiling, revision: settings.revision },
    );
  });
  await step(`agent ${GITHUB_AGENT}`, async () => {
    let id = agentId[GITHUB_AGENT];
    const spec = {
      role: "GitHub 저장소에서 이슈를 고치고 pull request를 연다",
      instructions:
        "이슈를 읽고 고칠 범위를 정한 뒤 브랜치에 커밋하고 pull request를 연다. push 전에는 사람의 승인을 받는다.",
      rules: [
        {
          id: "r1",
          text: "main에 직접 push하지 않는다",
          source: "user" as const,
        },
      ],
    };
    if (!id) {
      id = (
        await owner.ok<NewAgent>(201, "POST", "/v1/agents", {
          slug: GITHUB_AGENT,
          name: "GitHub 작업 도우미",
          managing_team_id: ids[`team:${MANAGING_TEAM}`],
          card: card(spec),
        })
      ).agent.id;
      agentId[GITHUB_AGENT] = id;
      note(`created agent ${GITHUB_AGENT}`);
    }
    const activate = async (releaseId: string) => {
      const current = await owner.ok<AgentDetail>(
        200,
        "GET",
        `/v1/agents/${id}`,
      );
      if (current.agent.active_release_id === releaseId) return;
      await owner.ok(200, "POST", `/v1/agents/${id}/activate`, {
        release_id: releaseId,
        expected_revision: current.agent.activation_revision,
      });
    };
    let detail = await owner.ok<AgentDetail>(200, "GET", `/v1/agents/${id}`);
    const versionId = detail.versions[0]!.id;
    // The pick needs an active release.
    if (!detail.agent.active_release_id) {
      const first = await owner.ok<NewRelease>(
        200,
        "POST",
        `/v1/agents/${id}/releases`,
        {
          version_id: versionId,
          connection_id: CONNECTION,
        },
      );
      await activate(first.release.id);
    }
    const picked: string[] = [];
    for (const repo of GH_PICKED) {
      const made = await owner.ok<{ catalog_id: string }>(
        200,
        "POST",
        `/v1/agents/${id}/github/repositories`,
        { installation_id: GH_INSTALLATION.id, github_repository_id: repo.id },
      );
      picked.push(made.catalog_id);
    }
    detail = await owner.ok<AgentDetail>(200, "GET", `/v1/agents/${id}`);
    if (!detail.active_release?.policy_pins?.github) {
      const release = await owner.ok<NewRelease>(
        200,
        "POST",
        `/v1/agents/${id}/releases`,
        {
          version_id: versionId,
          connection_id: CONNECTION,
          repository_id: picked[0],
          github: {
            repositories: picked,
            push_approval: true,
            features: {
              workflows: false,
              actions: true,
              checks: true,
              issues: true,
              review: false,
            },
            actions_allow: [],
          },
        },
      );
      await activate(release.release.id);
    }
    await owner.ok(200, "PUT", `/v1/agents/${id}/github/enabled`, {
      enabled: true,
    });
    note(`github agent ${GITHUB_AGENT}: ${picked.join(", ")}`);
  });
}

// ------------------------------------------------------------------ keys

type KeySpec = {
  who: string;
  name: string;
  kind: "personal" | "agent";
  agent?: string;
  scopes: string[];
  state: "active" | "soon" | "expired" | "revoked" | "used";
};
const KEYS: KeySpec[] = [
  {
    who: "owner",
    name: "CI 배포 봇",
    kind: "personal",
    scopes: ["sessions:read", "sessions:write"],
    state: "used",
  },
  {
    who: "owner",
    name: "임시 점검용 (곧 만료)",
    kind: "personal",
    scopes: ["sessions:read"],
    state: "soon",
  },
  {
    who: "owner",
    name: "작년 감사용 key",
    kind: "personal",
    scopes: ["sessions:read"],
    state: "expired",
  },
  {
    who: "owner",
    name: "유출 의심으로 폐기",
    kind: "personal",
    scopes: [
      "sessions:read",
      "sessions:write",
      "sessions:approve",
      "sessions:control",
    ],
    state: "revoked",
  },
  {
    who: "owner",
    name: "deploy-helper 운영",
    kind: "agent",
    agent: "deploy-helper",
    scopes: ["sessions:read", "sessions:write"],
    state: "active",
  },
  {
    who: "owner",
    name: "deploy-helper 예전 key",
    kind: "agent",
    agent: "deploy-helper",
    scopes: ["sessions:read"],
    state: "revoked",
  },
  {
    who: "member",
    name: "개인 스크립트",
    kind: "personal",
    scopes: ["sessions:read", "sessions:write"],
    state: "active",
  },
  {
    who: "member",
    name: "지난 분기 실험",
    kind: "personal",
    scopes: ["sessions:read"],
    state: "expired",
  },
  {
    who: "alex",
    name: "deploy-helper (Alex)",
    kind: "agent",
    agent: "deploy-helper",
    scopes: ["sessions:read"],
    state: "active",
  },
];

let ownerApiKey = "";

async function ensureKeys() {
  for (const spec of KEYS) {
    const client = web[spec.who];
    if (!client) continue;
    await step(`key ${spec.name}`, async () => {
      const list = await client.all<ApiKeyRow>("/v1/api-keys");
      let row = list.find((k) => k.name === spec.name);
      if (!row) {
        const expires =
          spec.state === "soon"
            ? new Date(Date.now() + 3 * 86_400_000)
            : spec.state === "expired"
              ? new Date(Date.now() + 86_400_000)
              : null;
        const made = await client.ok<NewApiKey>(201, "POST", "/v1/api-keys", {
          kind: spec.kind,
          name: spec.name,
          scopes: spec.scopes,
          ...(spec.agent ? { agent_id: agentId[spec.agent] } : {}),
          ...(expires ? { expires_at: expires.toISOString() } : {}),
        });
        // Held in memory for one API-made session; never written or printed.
        if (spec.state === "used") ownerApiKey = made.secret;
        row = made.api_key ?? made.key ?? { id: made.id };
        note(`created key ${spec.name}`);
      }
      const keyId =
        row.id ??
        (await client.all<ApiKeyRow>("/v1/api-keys")).find(
          (k) => k.name === spec.name,
        )?.id;
      if (spec.state === "expired")
        await q(
          "update api_keys set expires_at = now() - interval '20 days' where id = $1",
          [keyId],
        );
      if (spec.state === "revoked" && !row.revoked_at)
        await client.ok(200, "DELETE", `/v1/api-keys/${keyId}`);
    });
  }
}

// -------------------------------------------------------------- sessions

type Step = { tool: string; input: Record<string, unknown>; delayMs?: number };
let specSeq = 0;
function scripted(id: string, steps: Step[], final: string) {
  specSeq++;
  return `GATE-SPEC ${JSON.stringify({ id: `${id}-${Date.now()}-${specSeq}`, steps, final })}`;
}

type Outcome =
  | "idle"
  | "approve-then-idle"
  | "permission"
  | "question"
  | "running"
  | "stopped"
  | "cancel-running"
  | "close"
  | "pause"
  | "failed";
type SessionSpec = {
  creator: string;
  title: string;
  agent?: string;
  repository?: boolean;
  turns: string[];
  outcome: Outcome;
  share?: {
    scope: "private" | "people" | "team" | "workspace";
    users?: string[];
    teams?: string[];
  };
  viaKey?: boolean;
  history?: { daysAgo: number; costUsd: number; tokens: number };
  parkNow?: boolean;
  keep?: () => string;
  // Made without a title so the API names it after the first turn. The fake
  // model names every session "ok"; `rename` then stands in for a real
  // model's name (title_source stays 'generated'). `title` is only the key.
  autoTitle?: { rename?: string };
};

const read = (file: string): Step => ({
  tool: "Read",
  input: { file_path: file },
});
const RUNNING = (): string =>
  `계속 분석해 주세요.\n\n${scripted(
    "keep-running",
    Array.from({ length: 17 }, () => ({
      ...read("README.md"),
      delayMs: 200_000,
    })),
    "분석을 마쳤습니다.",
  )}`;
const permissionTurn = (command: string, description: string) => () =>
  `다시 확인해 주세요.\n\n${scripted("keep-permission", [{ tool: "Bash", input: { command, description } }], "확인했습니다.")}`;
const questionTurn = (question: string, options: string[]) => () =>
  `다시 여쭤봅니다.\n\n${scripted(
    "keep-question",
    [
      {
        tool: "AskUserQuestion",
        input: {
          questions: [
            {
              question,
              header: "선택",
              multiSelect: false,
              options: options.map((label) => ({
                label,
                description: `${label}로 진행`,
              })),
            },
          ],
        },
      },
    ],
    "선택한 방향으로 정리했습니다.",
  )}`;

const manyTools: Step[] = Array.from({ length: 42 }, (_, i) =>
  i % 3 === 0
    ? read("README.md")
    : i % 3 === 1
      ? {
          tool: "Glob",
          input: { pattern: `**/*.${["ts", "md", "json", "yml"][i % 4]}` },
        }
      : {
          tool: "Grep",
          input: {
            pattern: ["TODO", "FIXME", "XXX", "HACK"][i % 4],
            output_mode: "count",
          },
        },
);

const HISTORY: SessionSpec[] = Array.from({ length: 12 }, (_, i) => {
  const daysAgo = [1, 3, 6, 9, 14, 20, 27, 35, 41, 52, 68, 95][i]!;
  const who = ["owner", "member", "alex", "admin", "junho", "fox"][i % 6]!;
  return {
    creator: who,
    title: `일일 점검 리포트 #${String(i + 1).padStart(2, "0")} (${daysAgo}일 전)`,
    agent: i % 2 === 0 ? "deploy-helper" : "support-triage",
    turns: [
      `점검 리포트를 만들어 주세요.\n\n${scripted("history", [read("README.md")], "점검 결과 이상 없습니다.")}`,
    ],
    outcome: "close",
    history: {
      daysAgo,
      costUsd: [
        0.42, 1.87, 0.09, 3.6, 0.77, 12.4, 0.31, 5.05, 2.2, 0.66, 8.9, 1.1,
      ][i]!,
      tokens: [
        42_000, 188_000, 9_500, 360_000, 77_000, 1_240_000, 31_000, 505_000,
        220_000, 66_000, 890_000, 110_000,
      ][i]!,
    },
  };
});

const SESSIONS: SessionSpec[] = [
  ...HISTORY,
  {
    creator: "owner",
    title: "모노레포 전체 TODO·FIXME 주석 조사 (도구 호출 많음)",
    agent: "code-review",
    repository: true,
    turns: [
      `저장소 전체에서 TODO 주석을 찾아 분류해 주세요.\n\n${scripted("many-tools", manyTools, "TODO 31건, FIXME 7건, HACK 2건을 찾았습니다. 파일별 표는 아래와 같습니다.")}`,
    ],
    outcome: "close",
  },
  {
    creator: "alex",
    title: "Investigate flaky checkout test on CI",
    repository: true,
    turns: [
      `The checkout e2e test fails about once in ten runs. Find out why.\n\n${scripted("english", [read("README.md"), { tool: "Grep", input: { pattern: "retry", output_mode: "files_with_matches" } }], "The test races the payment mock's warm-up. Waiting for the readiness probe fixes it.")}`,
    ],
    outcome: "idle",
    share: { scope: "workspace" },
  },
  {
    creator: "owner",
    title:
      "결제·정산·환불 흐름 전체에서 통화 단위 반올림이 일관되게 적용되는지 확인하고 차이가 나는 곳을 표로 정리",
    agent: "code-review",
    repository: true,
    turns: [
      `반올림 규칙이 흐름마다 같은지 확인해 주세요.\n\n${scripted("long-title", [read("README.md")], "정산에서만 내림을 씁니다. 나머지는 반올림입니다.")}`,
    ],
    outcome: "close",
  },
  {
    creator: "fox",
    title: "🚀 출시 체크리스트 점검 ✅🔥",
    agent: "deploy-helper",
    repository: true,
    turns: [
      `출시 전에 체크리스트를 봐 주세요 🙏\n\n${scripted("emoji", [read("README.md")], "체크리스트 12개 중 11개 완료 ✅, 남은 1개는 롤백 문서입니다 📄")}`,
    ],
    outcome: "idle",
    share: { scope: "team", teams: ["Customer Support"] },
  },
  {
    creator: "junho",
    title: "Q4 OKR 초안 review — 한/영 혼합 📈",
    turns: [
      `Q4 OKR 초안을 review 해 주세요. KR wording도 봐 주세요.\n\n${scripted("mixed", [], "Objective는 좋습니다. KR 2는 측정 기준(metric)이 빠져 있어요.")}`,
    ],
    outcome: "close",
  },
  {
    creator: "owner",
    title: "주간 회의록 정리 — 여러 번 이어서 묻기 (긴 대화)",
    turns: [
      `이번 주 회의록을 정리해 주세요.\n\n${scripted("long-1", [], "월요일·수요일·금요일 회의의 결정 사항을 정리했습니다.")}`,
      `결정 사항만 다시 한 줄씩 뽑아 주세요.\n\n${scripted("long-2", [], "1) 출시일 11/3 확정 2) 결제 재시도 UI 추가 3) 온콜 순번 변경")}`,
      `담당자도 붙여 주세요.\n\n${scripted("long-3", [], "1) 정하나 2) Alex Kim 3) 박서연")}`,
      `영어로도 한 번 써 주세요.\n\n${scripted("long-4", [], "1) Launch date fixed to Nov 3 (Hana) 2) Add payment retry UI (Alex) 3) On-call rotation change (Seoyeon)")}`,
      `마감일이 없는 항목이 있나요?\n\n${scripted("long-5", [], "3번 온콜 순번 변경에 마감일이 없습니다.")}`,
      `그럼 다음 주 금요일로 넣어 주세요.\n\n${scripted("long-6", [], "3번 마감일을 다음 주 금요일로 넣었습니다. 최종본은 위와 같습니다.")}`,
    ],
    outcome: "idle",
  },
  {
    creator: "owner",
    title: "릴리스 산출물 3종 생성 (결과물 여러 개)",
    agent: "deploy-helper",
    repository: true,
    turns: [
      `릴리스 산출물을 만들어 주세요.\n\n${scripted(
        "outputs",
        [
          {
            tool: "Write",
            input: {
              file_path: "out/release-notes.md",
              content:
                "# 릴리스 노트\n\n- 결제 재시도 안내\n- 영수증 주문 번호\n",
            },
          },
          {
            tool: "Write",
            input: {
              file_path: "out/checklist.csv",
              content: "항목,상태\n마이그레이션,완료\n롤백 문서,진행 중\n",
            },
          },
          {
            tool: "Write",
            input: {
              file_path: "out/summary.json",
              content: '{"version":"2.4.0","changes":2}\n',
            },
          },
        ],
        "산출물 3개를 out/에 썼습니다.",
      )}`,
    ],
    outcome: "approve-then-idle",
  },
  {
    creator: "member",
    title: "실패하는 빌드 스크립트 실행",
    repository: true,
    // Unterminated on purpose: the fake model cannot read its script.
    turns: ['빌드를 돌려 주세요.\n\nGATE-SPEC {"id":"broken","steps":['],
    outcome: "failed",
  },
  {
    creator: "member",
    title: "취소한 대량 메일 초안 작성",
    turns: [
      `고객 2,000명에게 보낼 메일 초안을 써 주세요.\n\n${scripted(
        "cancel",
        Array.from({ length: 6 }, () => ({
          ...read("README.md"),
          delayMs: 60_000,
        })),
        "초안을 썼습니다.",
      )}`,
    ],
    outcome: "cancel-running",
  },
  {
    creator: "admin",
    title: "데이터 마이그레이션 계획 (일시 중지)",
    agent: "deploy-helper",
    repository: true,
    turns: [
      `users 테이블 분할 계획을 세워 주세요.\n\n${scripted("pause", [read("README.md")], "3단계 계획을 세웠습니다.")}`,
    ],
    outcome: "pause",
  },
  {
    creator: "owner",
    title: "API key로 만든 야간 export 세션",
    viaKey: true,
    turns: [
      `어제 자 사용량을 CSV로 정리해 주세요.\n\n${scripted("via-key", [], "CSV 정리를 마쳤습니다.")}`,
    ],
    outcome: "close",
  },
  {
    creator: "member",
    title: "비공개 세션 — 인사 평가 메모 정리",
    turns: [
      `평가 메모를 항목별로 정리해 주세요.\n\n${scripted("private", [], "항목별로 정리했습니다.")}`,
    ],
    outcome: "close",
    share: { scope: "private" },
  },
  {
    creator: "alex",
    title: "Alex가 서연에게만 공유한 세션",
    turns: [
      `검토 부탁드립니다.\n\n${scripted("people", [], "검토 의견을 정리했습니다.")}`,
    ],
    outcome: "close",
    share: { scope: "people", users: ["admin"] },
  },
  ...[2, 5, 6].map(
    (daysAgo, i): SessionSpec => ({
      creator: ["alex", "owner", "junho"][i]!,
      title: `문서 검토 의견 정리 #${i + 1} (읽기 전용 에이전트)`,
      agent: "readonly-reviewer",
      turns: [
        `이 문서를 검토해 주세요.\n\n${scripted("readonly", [read("README.md")], "검토 의견 4건을 근거 경로와 함께 정리했습니다.")}`,
      ],
      outcome: "close",
      history: {
        daysAgo,
        costUsd: [0.84, 2.31, 0.27][i]!,
        tokens: [84_000, 231_000, 27_000][i]!,
      },
    }),
  ),
  {
    creator: "admin",
    title: "Bash 없이 설정 파일 고치기 (coding-no-bash 판)",
    repository: true,
    turns: [
      `설정 파일의 오타를 찾아 주세요.\n\n${scripted("no-bash", [read("README.md"), { tool: "Grep", input: { pattern: "TODO", output_mode: "count" } }], "오타 2곳을 찾았습니다. Bash 없이 읽기 도구로만 확인했습니다.")}`,
    ],
    outcome: "close",
    history: { daysAgo: 4, costUsd: 1.46, tokens: 146_000 },
  },
  {
    creator: "member",
    title: "(자동 제목) 배포 체크리스트",
    turns: [
      `다음 주 배포 전에 확인할 체크리스트를 만들어 주세요. 마이그레이션, 환경 변수, 롤백 순서를 포함해 주세요.\n\n${scripted("auto-title", [], "체크리스트 12개 항목을 정리했습니다.")}`,
    ],
    outcome: "idle",
    autoTitle: { rename: "배포 전 체크리스트 정리" },
  },
  {
    creator: "fox",
    title: "(자동 제목) fake 모델 그대로",
    turns: [
      `Please summarize the onboarding doc in three bullets.\n\n${scripted("auto-title-raw", [], "Here are the three bullets.")}`,
    ],
    outcome: "idle",
    autoTitle: { rename: "Onboarding doc in three bullets" },
  },
  // Held states last: each keeps its worker.
  {
    creator: "admin",
    title: "프로덕션 로그 확인 (권한 요청 대기)",
    agent: "deploy-helper",
    repository: true,
    turns: [
      permissionTurn(
        "kubectl logs deploy/api --since=1h",
        "프로덕션 API 로그 읽기",
      )(),
    ],
    outcome: "permission",
    // Parked at once: a waiting session then holds no worker, so a slow
    // database pass cannot fail it through a missed heartbeat.
    parkNow: true,
    keep: permissionTurn(
      "kubectl logs deploy/api --since=1h",
      "프로덕션 API 로그 읽기",
    ),
  },
  {
    creator: "alex",
    title: "Run DB migration on staging (permission)",
    agent: "deploy-helper",
    repository: true,
    turns: [
      permissionTurn(
        "psql --file migrations/staging.sql",
        "Apply pending migrations to staging",
      )(),
    ],
    outcome: "permission",
    // Parked at once: a waiting session then holds no worker, so a slow
    // database pass cannot fail it through a missed heartbeat.
    parkNow: true,
    share: { scope: "workspace" },
    keep: permissionTurn(
      "psql --file migrations/staging.sql",
      "Apply pending migrations to staging",
    ),
  },
  {
    creator: "junho",
    title: "디자인 토큰 이름 정하기 (질문 대기)",
    turns: [
      questionTurn("토큰 이름은 어떤 규칙으로 할까요?", [
        "역할 기반 (surface/raised)",
        "색상 기반 (gray-100)",
        "혼합",
      ])(),
    ],
    outcome: "question",
    parkNow: true,
    share: { scope: "workspace" },
    keep: questionTurn("토큰 이름은 어떤 규칙으로 할까요?", [
      "역할 기반 (surface/raised)",
      "색상 기반 (gray-100)",
      "혼합",
    ]),
  },
  {
    creator: "owner",
    title: "문의 태그 체계 확정 (질문, worker 반납됨)",
    agent: "support-triage",
    turns: [
      questionTurn("태그를 몇 단계로 둘까요?", ["1단계", "2단계", "3단계"])(),
    ],
    outcome: "question",
    parkNow: true,
    keep: questionTurn("태그를 몇 단계로 둘까요?", ["1단계", "2단계", "3단계"]),
  },
  {
    creator: "owner",
    title: "릴리스 태그 v2.4.0 붙이기 (권한 요청 대기)",
    agent: "deploy-helper",
    repository: true,
    turns: [
      permissionTurn(
        "git tag v2.4.0 && git push origin v2.4.0",
        "릴리스 태그 만들고 올리기",
      )(),
    ],
    outcome: "permission",
    parkNow: true,
    keep: permissionTurn(
      "git tag v2.4.0 && git push origin v2.4.0",
      "릴리스 태그 만들고 올리기",
    ),
  },
  {
    creator: "owner",
    title: "릴리스 노트 문체 고르기 (질문 대기)",
    turns: [
      questionTurn("이번 릴리스 노트는 어떤 문체로 쓸까요?", [
        "짧은 요약",
        "변경별 상세",
        "고객 공지용",
      ])(),
    ],
    outcome: "question",
    parkNow: true,
    keep: questionTurn("이번 릴리스 노트는 어떤 문체로 쓸까요?", [
      "짧은 요약",
      "변경별 상세",
      "고객 공지용",
    ]),
  },
  {
    creator: "alex",
    title: "대규모 리팩터링 영향 분석 (진행 중)",
    agent: "code-review",
    repository: true,
    turns: [RUNNING()],
    outcome: "running",
    share: { scope: "workspace" },
    keep: RUNNING,
  },
];

async function visible(client: Web) {
  return client.all<SessionRow>("/v1/sessions");
}

async function until<T>(
  what: string,
  check: () => Promise<T | null>,
  ms = SETTLE_MS,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await Bun.sleep(2_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Each tool call raises its own permission request, so approve until idle.
async function approveUntilIdle(client: Web, id: string, title: string) {
  await until(`${title} idle`, async () => {
    const row = await client.ok<SessionRow>(200, "GET", `/v1/sessions/${id}`);
    if (row.status === "idle") return row;
    const pending = await client.ok<PendingRequests>(
      200,
      "GET",
      `/v1/sessions/${id}/pending-requests`,
    );
    for (const request of pending.items) {
      await client.ok(202, "POST", `/v1/sessions/${id}/answers`, {
        request_id: request.request_id,
        kind: "permission",
        action: "allow",
      });
    }
    return null;
  });
}

async function drive(client: Web, id: string, spec: SessionSpec) {
  const detail = () => client.ok<SessionRow>(200, "GET", `/v1/sessions/${id}`);
  const pending = async () =>
    (
      await client.ok<PendingRequests>(
        200,
        "GET",
        `/v1/sessions/${id}/pending-requests`,
      )
    ).items;
  const idle = () =>
    until(`${spec.title} idle`, async () => {
      const row = await detail();
      if (row.status === "failed") throw new Error("session failed");
      return row.status === "idle" ? row : null;
    });
  // Later turns of a long conversation.
  for (const message of spec.turns.slice(1)) {
    await idle();
    await client.ok(202, "POST", `/v1/sessions/${id}/messages`, { message });
  }
  switch (spec.outcome) {
    case "idle":
      await idle();
      return "idle";
    case "approve-then-idle":
      await approveUntilIdle(client, id, spec.title);
      return "idle";
    case "permission":
    case "question":
      await until(`${spec.title} ${spec.outcome}`, async () =>
        (await pending()).some((r) => r.kind === spec.outcome) ? true : null,
      );
      return "needs_input";
    case "running":
      await until(`${spec.title} running`, async () =>
        (await detail()).status === "running" ? true : null,
      );
      return "running";
    case "cancel-running": {
      const row = await until(`${spec.title} running`, async () => {
        const r = await detail();
        return r.status === "running" ? r : null;
      });
      await client.ok(202, "POST", `/v1/sessions/${id}/terminate`, {
        expected_revision: row.revision,
        reason: "사용자가 취소",
      });
      return "stopped";
    }
    case "stopped":
    case "close":
    case "pause": {
      const row = await idle();
      const path =
        spec.outcome === "pause"
          ? "pause"
          : spec.outcome === "close"
            ? "close"
            : "terminate";
      await client.ok(202, "POST", `/v1/sessions/${id}/${path}`, {
        expected_revision: row.revision,
        reason: "데모",
      });
      return spec.outcome;
    }
    case "failed": {
      const row = await until(`${spec.title} settled`, async () => {
        const r = await detail();
        return ["failed", "idle", "needs_input"].includes(r.status) ? r : null;
      });
      return row.status;
    }
  }
}

// A run cut short (a timeout, a lost worker) leaves a session short of its
// outcome; a rerun takes the last step instead of skipping it.
async function finish(client: Web, existing: SessionRow, spec: SessionSpec) {
  const id = existing.id;
  const row = await client.ok<SessionRow>(200, "GET", `/v1/sessions/${id}`);
  if (spec.outcome === "approve-then-idle") {
    if (row.status !== "needs_input" && row.status !== "running") return;
    await approveUntilIdle(client, id, spec.title);
    note(`finished session ${spec.title}: approved`);
    return;
  }
  const path = { close: "close", pause: "pause", stopped: "terminate" }[
    spec.outcome as string
  ];
  if (!path || row.status !== "idle") return;
  const reply = await client.req<ErrorBody | null>(
    "POST",
    `/v1/sessions/${id}/${path}`,
    {
      expected_revision: row.revision,
      reason: "데모",
    },
  );
  // A paused session still reads idle.
  if (reply.status === 409 && reply.body?.error?.code === "SESSION_PAUSED")
    return;
  if (reply.status !== 202)
    throw new Error(
      `${path} -> ${reply.status} ${reply.body?.error?.code ?? ""}`,
    );
  note(`finished session ${spec.title} -> ${spec.outcome}`);
}

async function ensureSessions() {
  const seen: Record<string, SessionRow[]> = {};
  for (const spec of SESSIONS) {
    const client = web[spec.creator];
    if (!client) {
      note(`skip session ${spec.title}: no login for ${spec.creator}`);
      continue;
    }
    await step(`session ${spec.title}`, async () => {
      seen[spec.creator] ??= await visible(client);
      if (spec.autoTitle) {
        // Every other seeded session carries a user title, so a creator's
        // untitled one is this spec's.
        const [row] = await q(
          "select s.id from sessions s join users u on u.id::text = s.owner_id where u.email = $1 and s.title_source <> 'user' limit 1",
          [PEOPLE.find((p) => p.key === spec.creator)?.email ?? ""],
        );
        if (row) {
          ids[`session:${spec.title}`] = row.id;
          note(`exists session ${spec.title}`);
          return;
        }
      }
      const existing = seen[spec.creator]!.find(
        (row) => row.title === spec.title,
      );
      if (existing) {
        ids[`session:${spec.title}`] = existing.id;
        note(`exists session ${spec.title} (${existing.status})`);
        await finish(client, existing, spec);
        return;
      }
      await createSession(client, spec);
    });
  }
}

async function createSession(client: Web, spec: SessionSpec) {
  const author =
    spec.viaKey && ownerApiKey
      ? Object.assign(new Web("owner-key"), { bearer: ownerApiKey })
      : client;
  const agent = spec.agent
    ? AGENTS.find((a) => a.slug === spec.agent)
    : undefined;
  const release =
    (spec.agent ? releaseOf[spec.agent] : undefined) ??
    releaseOf[DEFAULT_AGENT];
  if (!release)
    throw new Error(`no release for ${spec.agent ?? DEFAULT_AGENT}`);
  const created = await author.ok<NewSession>(201, "POST", "/v1/sessions", {
    agent_release_id: release,
    ...(spec.autoTitle ? {} : { title: spec.title }),
    ...(spec.repository || agent?.repository
      ? { repository_id: "sample-app" }
      : {}),
    ...(spec.parkNow ? { permission_wait: { park_after_seconds: 0 } } : {}),
    message: spec.turns[0],
  });
  const id = created.session_id;
  ids[`session:${spec.title}`] = id;
  if (spec.share) {
    await client.ok(200, "POST", `/v1/sessions/${id}/share`, {
      scope: spec.share.scope,
      ...(spec.share.users
        ? { user_ids: spec.share.users.map((k) => ids[`user:${k}`]) }
        : {}),
      ...(spec.share.teams
        ? { team_ids: spec.share.teams.map((t) => ids[`team:${t}`]) }
        : {}),
    });
  }
  const ended = await drive(client, id, spec);
  if (spec.autoTitle) {
    const named = await until(
      `${spec.title} generated title`,
      async () => {
        const [row] = await q(
          "select title from sessions where id = $1 and title_source = 'generated'",
          [id],
        );
        return row ?? null;
      },
      90_000,
    ).catch(() => null);
    note(
      `auto title ${spec.title}: ${named ? JSON.stringify(named.title) : "not generated"}`,
    );
    if (named && spec.autoTitle.rename)
      await q("update sessions set title = $2 where id = $1", [
        id,
        spec.autoTitle.rename,
      ]);
  }
  note(`created session ${spec.title} -> ${ended}`);
}

// --------------------------------------------------------- database-only

async function usageHistory(limits: Limits | null) {
  for (const spec of SESSIONS) {
    const id = ids[`session:${spec.title}`];
    if (!id || !spec.history) continue;
    const { daysAgo, costUsd, tokens } = spec.history;
    await q(
      `update sessions set created_at = date_trunc('hour', now()) - make_interval(days => $2::int) + interval '9 hours',
         last_turn_at = date_trunc('hour', now()) - make_interval(days => $2::int) + interval '9 hours 20 minutes',
         cost_usd = $3, provider_tokens = $4 where id = $1`,
      [id, daysAgo, costUsd, tokens],
    );
  }
  // Session cost against the per-session limit: one near it, one over.
  const sessionLimit = Number(limits?.limits?.session_cost_limit_usd ?? 0);
  const near =
    ids["session:모노레포 전체 TODO·FIXME 주석 조사 (도구 호출 많음)"];
  const over = ids["session:주간 회의록 정리 — 여러 번 이어서 묻기 (긴 대화)"];
  if (sessionLimit > 0) {
    if (near)
      await q(
        "update sessions set cost_usd = $2, provider_tokens = 2400000 where id = $1",
        [near, (sessionLimit * 0.92).toFixed(4)],
      );
    if (over)
      await q(
        "update sessions set cost_usd = $2, provider_tokens = 3100000 where id = $1",
        [over, (sessionLimit * 1.08).toFixed(4)],
      );
    note(
      `session cost limit ${sessionLimit}: near ${Boolean(near)}, over ${Boolean(over)}`,
    );
  }
  // Per-model rows follow the session totals (input three parts to one output).
  await q(
    `
    insert into session_model_usage (session_id, model, session_created_at, agent_id, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd)
    select s.id, coalesce(s.model, $1), s.created_at, v.agent_id,
           (s.provider_tokens * 0.6)::bigint, (s.provider_tokens * 0.2)::bigint, (s.provider_tokens * 0.15)::bigint, (s.provider_tokens * 0.05)::bigint, s.cost_usd
    from sessions s left join agent_releases v on v.id = s.agent_release_id
    where s.id = any($2::uuid[])
    on conflict (session_id, model) do update set session_created_at = excluded.session_created_at,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read_input_tokens = excluded.cache_read_input_tokens, cache_creation_input_tokens = excluded.cache_creation_input_tokens,
      cost_usd = excluded.cost_usd`,
    [
      MODEL,
      [
        ...SESSIONS.filter((s) => s.history).map(
          (s) => ids[`session:${s.title}`],
        ),
        near,
        over,
      ].filter(Boolean),
    ],
  );
  const storageLimit = Number(limits?.limits?.storage_limit_bytes ?? 0);
  if (storageLimit > 0) {
    await q(
      "insert into storage_usage (scope, bytes, updated_at) values ('installation', $1, now()) on conflict (scope) do update set bytes = greatest(storage_usage.bytes, excluded.bytes), updated_at = now()",
      [Math.floor(storageLimit * 0.93)],
    );
    note(`storage set to 93% of ${storageLimit}`);
  }
}

async function emptyWorkspace() {
  const person = PEOPLE.find((p) => p.emptyWorkspace)!;
  const userId = ids[`user:${person.key}`];
  if (!userId) return;
  const [settings] = await q(
    "select settings from workspaces order by created_at limit 1",
  );
  await q(
    "insert into workspaces (id, slug, name, settings, created_at) values (gen_random_uuid(), 'empty-demo', '빈 워크스페이스', $1, now()) on conflict do nothing",
    [settings?.settings ?? {}],
  );
  const [target] = await q(
    "select id from workspaces where slug = 'empty-demo'",
  );
  await q(
    "update memberships set workspace_id = $1 where user_id = $2 and workspace_id <> $1",
    [target.id, userId],
  );
  await q("delete from web_sessions where user_id = $1", [userId]).catch(
    () => {},
  );
  note("empty workspace ready");
}

// ------------------------------------------------------------ keep alive

// The held sessions drift overnight: a running script ends, a request
// expires, a lost worker fails the session. Idle ones get their script
// again; a failed or stopped one is renamed (kept as a failure case) and
// made anew under its own title.
async function keepAlive() {
  // Killing the host's `compose exec` leaves this process running; stop it
  // with: compose exec -T api sh -c 'kill $(cat /tmp/demo-rich-keeper.pid)'
  writeFileSync("/tmp/demo-rich-keeper.pid", String(process.pid));
  for (;;) {
    await loginAll();
    const owner = web.owner;
    if (owner) {
      for (const row of await q("select id, email from users")) {
        const person = PEOPLE.find((p) => p.email === row.email);
        if (person) ids[`user:${person.key}`] = row.id;
      }
      for (const team of await owner.all<Team>("/v1/teams"))
        ids[`team:${team.name}`] = team.id;
      for (const agent of await owner.all<AgentRow>("/v1/agents")) {
        agentId[agent.slug] = agent.id;
        if (agent.active_release_id)
          releaseOf[agent.slug] = agent.active_release_id;
      }
    }
    for (const spec of SESSIONS.filter((s) => s.keep)) {
      const client = web[spec.creator];
      if (!client) continue;
      await step(`keep ${spec.title}`, async () => {
        const row = (await visible(client)).find((r) => r.title === spec.title);
        if (row?.status === "idle") {
          await client.ok(202, "POST", `/v1/sessions/${row.id}/messages`, {
            message: spec.keep!(),
          });
          note(`${new Date().toISOString()} refreshed ${spec.title}`);
          return;
        }
        if (row && row.status !== "failed" && row.status !== "stopped") return;
        if (row) {
          // A recording wants a handful of failed sessions, not one per lost
          // worker: abandon the unknown turn (failed → stopped), then sink the
          // copy under the list's older rows.
          const [turn] = await q(
            "select sequence from turns where session_id = $1 and outcome_unknown order by sequence desc limit 1",
            [row.id],
          );
          if (row.status === "failed" && turn) {
            await client.ok(
              202,
              "POST",
              `/v1/sessions/${row.id}/recovery-decisions`,
              {
                decision: "abandon",
                target_turn_id: String(turn.sequence),
                expected_revision: row.revision,
                reason: "demo keeper: replaced",
              },
            );
          }
          const at = new Date().toISOString().slice(11, 16);
          await client.ok(200, "PATCH", `/v1/sessions/${row.id}`, {
            title: `${spec.title} — 교체 ${at}Z`,
          });
          await q(
            "update sessions set created_at = created_at - interval '120 days', updated_at = now() - interval '120 days', last_turn_at = last_turn_at - interval '120 days' where id = $1",
            [row.id],
          );
        }
        await createSession(client, { ...spec, turns: [spec.keep!()] });
        note(`${new Date().toISOString()} recreated ${spec.title}`);
      });
    }
    for (const client of Object.values(web)) await client.logout();
    await Bun.sleep(5 * 60_000);
  }
}

// The public demo shows prompts and titles as people wrote them: the script
// the fake model reads rides at the end of each prompt, and a session the
// API named itself carries the fake model's fallback answer as its title.
// Queued turns keep their script; the worker has yet to read it.
async function polish() {
  const turns = await q(
    "update turns set message = regexp_replace(message, '\\s*GATE-SPEC .*$', '') where message like '%GATE-SPEC %' and status <> 'queued' returning id",
  );
  const titles = await q(`
    update sessions s set title = coalesce(nullif(btrim(first.line), ''), '빈 지시로 시작한 세션')
    from (
      select distinct on (session_id) session_id, split_part(message, E'\\n', 1) as line
      from turns order by session_id, id
    ) first
    where first.session_id = s.id and (s.title like 'Hello from the local fake Messages API%' or btrim(s.title) = '')
    returning s.id`);
  // Until it names itself, a session's title is its first prompt.
  const drafts = await q(
    "update sessions set title = regexp_replace(title, '\\s*GATE-SPEC .*$', '') where title like '%GATE-SPEC %' returning id",
  );
  // The status event that announced a title replays it to the timeline.
  const announced = await q(`
    update events e set payload = jsonb_set(e.payload, '{title}', to_jsonb(s.title))
    from sessions s
    where s.id = e.session_id and e.payload ? 'title' and e.payload->>'title' is distinct from s.title
      and (e.payload->>'title' like 'Hello from the local fake Messages API%' or e.payload->>'title' like '%GATE-SPEC %')
    returning e.id`);
  note(
    `polished ${turns.length} prompts, ${titles.length + drafts.length} titles, ${announced.length} title events`,
  );
}

// ------------------------------------------------------------------ main

async function main() {
  const ready = await (await fetch(`${BASE}/readyz`)).json();
  if ((ready as { status?: unknown }).status !== "ready")
    throw new Error("api not ready");
  const github = startFakeGitHub();
  if (process.argv.includes("--keep-running")) {
    await keepAlive();
    return;
  }
  const owner = new Web("owner");
  await owner.login("demo-owner@example.test", DEMO_PASSWORD);
  const connections = await owner.ok<{ items: { endpoint: string }[] }>(
    200,
    "GET",
    "/v1/installation/settings/connections",
  );
  if (
    connections.items.length === 0 ||
    connections.items.some((item) => item.endpoint !== FAKE_MESSAGES_ENDPOINT)
  )
    throw new Error("this api does not run the fake-model connections");
  // workspace is null only for a legacy API key; this is a cookie session.
  const me = await owner.ok<{ workspace: { id: string } }>(
    200,
    "GET",
    "/v1/auth/me",
  );
  const workspaceId = me.workspace.id;
  const offered = await owner.ok<{ items: { id: string; models: string[] }[] }>(
    200,
    "GET",
    "/v1/connections",
  );
  note(
    `connections: ${JSON.stringify((offered.items ?? []).map((c) => [c.id, c.models]))}`,
  );

  await ensurePeople(owner);
  saveCreds();
  await loginAll();
  web.owner?.logout();
  web.owner = owner;
  await ensureInvites(owner);
  await ensureTeams(owner);
  await step("audit retention", () =>
    owner.ok(200, "POST", `/v1/workspaces/${workspaceId}/audit-retention`, {
      audit_retention_days: 90,
    }),
  );
  await step("slack guest", () =>
    owner.ok(200, "POST", `/v1/workspaces/${workspaceId}/slack-guest`, {
      slack_guest_enabled: true,
    }),
  );
  await ensureAgents(owner);
  await ensureGitHub(owner, workspaceId);
  await ensureSlack(owner, workspaceId);
  await ensureLinks();
  await ensureKeys();
  await ensureSessions();
  await disablePeople(owner);
  await agentStatuses();
  const limits = await step("limits", () =>
    owner.ok<Limits>(200, "GET", "/v1/limits"),
  );
  note(
    `limits: ${JSON.stringify(limits?.limits ?? null)} usage: ${JSON.stringify(limits?.usage ?? null)}`,
  );
  await step("usage history", () => usageHistory(limits));
  // An owner reading a private session leaves an audit trail.
  const privateId = ids["session:비공개 세션 — 인사 평가 메모 정리"];
  if (privateId)
    await step("audit read", () =>
      owner.ok(200, "POST", `/v1/sessions/${privateId}/audit-read`, {
        justification: "분기 감사 표본 점검 (데모)",
      }),
    );
  await step("empty workspace", emptyWorkspace);
  await step("readable prompts and titles", polish);
  saveCreds();
  for (const client of Object.values(web)) await client.logout();
  const failed = results.filter((line) => line.startsWith("FAIL"));
  console.log(
    `done: ${results.length - failed.length} ok, ${failed.length} failed`,
  );
  github?.stop(true);
  await db.end();
}

await main();
