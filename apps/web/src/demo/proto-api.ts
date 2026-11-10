/**
 * The prototype build's whole backend: a stateful in-page fake of the /v1
 * routes the console reads. Writes change only this page's memory, nothing
 * leaves the page, and a reload starts over. Data only mimics the shape of a
 * real workspace.
 */
import type {
  AgentDetail,
  AgentListItem,
  Invite,
  MemberView,
  PendingRequest,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  TeamView,
  TurnSummary,
} from "@werft-ai/contracts";
import { agentServer } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberPage,
  USER_ID,
  WORKSPACE_ID,
  workspaceEngineSettings,
} from "../test-support/fake-api.ts";
import {
  achievementCategories,
  achievementFigures,
  achievementTypes,
  usageSeries,
  usageSummary,
  usageTools,
} from "./proto-usage.ts";

type Handler = (
  request: Request,
  params: Record<string, string>,
) => Response | Promise<Response>;

const MIN = 60_000;
const uuid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const iso = (ms: number) => new Date(ms).toISOString();

export interface ProtoOptions {
  readonly now?: () => number;
  /** Told about every call, for the network-free check. */
  readonly onCall?: (method: string, path: string, handled: boolean) => void;
}

export function createProtoFetch(options: ProtoOptions = {}): typeof fetch {
  const now = options.now ?? Date.now;
  const t0 = now();
  const owner = me();
  if (owner.user) {
    owner.user.display_name = "Demo Owner";
    owner.user.email = "owner@example.test";
  }
  if (owner.workspace) owner.workspace.name = "Demo · Werft";

  // ---- teams, members, invites ----
  const teamNames = ["재무", "플랫폼", "고객 지원", "보안"];
  const teams: TeamView[] = teamNames.map((name, i) => ({
    id: uuid(3, i + 1),
    workspace_id: WORKSPACE_ID,
    name,
    member_count: 0,
    created_by: USER_ID,
    created_at: iso(t0 - (40 - i) * 86_400_000),
    revision: 1,
  }));
  const people = [
    ["Demo Owner", "owner@example.test", "owner"],
    ["김하늘", "haneul.kim@example.test", "admin"],
    ["이도윤", "doyun.lee@example.test", "admin"],
    ["박서연", "seoyeon.park@example.test", "member"],
    ["최민준", "minjun.choi@example.test", "member"],
    ["정유진", "yujin.jung@example.test", "member"],
    ["한지우", "jiwoo.han@example.test", "member"],
    ["오세훈", "sehun.oh@example.test", "member"],
    ["윤가은", "gaeun.yoon@example.test", "member"],
    ["강태오", "taeoh.kang@example.test", "member"],
    ["송지민", "jimin.song@example.test", "member"],
    ["임하린", "harin.im@example.test", "member"],
  ] as const;
  const members: MemberView[] = people.map(([name, email, role], i) => ({
    user_id: i === 0 ? USER_ID : uuid(2, i + 1),
    email,
    display_name: name,
    role,
    disabled_at: i === 11 ? iso(t0 - 3 * 86_400_000) : null,
    created_at: iso(t0 - (60 - i * 3) * 86_400_000),
  }));
  const teamMembers = new Map<string, { id: string; lead: boolean }[]>();
  teams.forEach((team, ti) => {
    const rows = members
      .slice(ti, ti + 3 + (ti % 2))
      .map((m, mi) => ({ id: m.user_id, lead: mi === 0 }));
    teamMembers.set(team.id, rows);
    team.member_count = rows.length;
  });
  const invites: Invite[] = [
    ["new.hire@example.test", "member", "pending"],
    ["partner@example.test", "member", "pending"],
    ["ops.lead@example.test", "admin", "accepted"],
  ].map(([email, role, status], i) => ({
    id: uuid(4, i + 1),
    workspace_id: WORKSPACE_ID,
    email: email as string,
    role: role as "member" | "admin",
    invited_by: USER_ID,
    status: status as "pending" | "accepted",
    expires_at: iso(t0 + (5 - i) * 86_400_000),
    accepted_at: status === "accepted" ? iso(t0 - 86_400_000) : null,
    revoked_at: null,
    created_at: iso(t0 - (2 + i) * 86_400_000),
  }));

  // ---- agents ----
  const primary = agentServer({ description: "결제 요청을 검토합니다." });
  const agentRows: {
    id: string;
    name: string;
    slug: string;
    team: TeamView;
    status: "active" | "archived";
    released: boolean;
    needs: number;
    running: number;
  }[] = [
    ["결제 담당", "billing", 0, "active", true],
    ["코드 리뷰", "code-review", 1, "active", true],
    ["릴리스 노트 작성", "release-notes", 1, "active", true],
    ["문의 분류", "support-triage", 2, "active", true],
    ["배포 도우미", "deploy-helper", 1, "active", true],
    ["읽기 전용 리뷰어", "readonly-reviewer", 3, "active", true],
    ["Translator (EN)", "translator-en", 2, "active", true],
    ["야간 배치 점검", "nightly-check", 1, "active", false],
    ["구 문서 요약기", "legacy-summarizer", 2, "archived", true],
  ].map(([name, slug, ti, status, released], i) => ({
    id: i === 0 ? primary.detail().agent.id : uuid(5, i + 1),
    name: name as string,
    slug: slug as string,
    team: teams[ti as number] as TeamView,
    status: status as "active" | "archived",
    released: released as boolean,
    needs: 0,
    running: 0,
  }));
  const agentItem = (row: (typeof agentRows)[number]): AgentListItem => {
    const base = primary.detail().agent;
    return {
      ...base,
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: `${row.name}이(가) 맡는 일을 처리합니다.`,
      managing_team_id: row.team.id,
      managing_team_name: row.team.name,
      status: row.status,
      active_release_id: row.released
        ? (base.active_release_id ?? "rel-1")
        : null,
      activation_revision: row.released ? 0 : -1,
      summary: {
        version: {
          version_no: 1,
          role: null,
          instructions: `${row.name}의 지침입니다.`,
          mcp_servers: [],
          credential_refs: [],
        },
        runtime_profile_id: row.released ? "claude-coding-local" : null,
        release_label: row.released ? "2026-11-09_07:58:00" : null,
        release_model: row.released ? "claude-sonnet-5" : null,
        bound_credential_refs: [],
        admins: [row.team.name],
        needs_input_count: row.needs,
        running_count: row.running,
        slack_action: null,
      },
    } as AgentListItem;
  };

  // ---- sessions ----
  const STATUS_MIX: SessionStatus[] = [
    "idle",
    "idle",
    "running",
    "idle",
    "stopped",
    "idle",
    "failed",
    "idle",
    "running",
    "idle",
  ];
  const TITLES = [
    "Restore check for 6c and 6d",
    "lang-verify-follow",
    "awr-v2-s3-attach",
    "지난주 문의 분류",
    "결제 승인 요청 검토",
    "Make one small change in the sandbox repository",
    "배포 체크리스트 점검",
    "릴리스 노트 초안 작성",
    "This is a test in the sandbox repo. Run `git status` and report",
    "야간 배치 결과 요약",
  ];
  const CHANNELS = ["web", "slack", "api"] as const;
  interface SessionState {
    summary: SessionSummary;
    turns: TurnSummary[];
    pending: PendingRequest[];
    frames: string[];
    seq: number;
    streams: Set<(text: string) => void>;
  }
  const sessions: SessionState[] = [];
  const AT = (i: number) => t0 - (20 + i * 47) * MIN;
  const agentFor = (i: number) => agentRows[i % agentRows.length]!;

  function frameText(
    s: SessionState,
    event: string,
    data: unknown,
    turn: string | null,
    at: number,
  ) {
    s.seq += 1;
    const id = String(s.seq).padStart(6, "0");
    return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify({
      schema_version: 1,
      session_id: s.summary.id,
      turn_id: turn,
      attempt_id: null,
      occurred_at: iso(at),
      data,
    })}\n\n`;
  }
  const emit = (
    s: SessionState,
    event: string,
    data: unknown,
    turn: string | null,
    at = now(),
  ) => {
    const text = frameText(s, event, data, turn, at);
    s.frames.push(text);
    for (const push of s.streams) push(text);
  };

  const makeTurn = (
    s: SessionState,
    message: string,
    at: number,
    status: TurnSummary["status"] = "completed",
  ): TurnSummary => {
    const turn: TurnSummary = {
      turn_id: String(s.turns.length + 1),
      session_id: s.summary.id,
      status,
      message,
      channel: s.summary.channel,
      created_by: s.summary.created_by,
      slack_permalink: null,
      terminal_reason: null,
      checkpoint_revision: null,
      created_at: iso(at),
      started_at: iso(at + 1000),
      ended_at: status === "completed" ? iso(at + 9000) : null,
    };
    s.turns.push(turn);
    return turn;
  };

  const TOTAL = 87;
  for (let i = 0; i < TOTAL; i += 1) {
    const agent = agentFor(i);
    const waiting = i === 0 || i === 9;
    const status: SessionStatus = waiting
      ? "needs_input"
      : (STATUS_MIX[i % STATUS_MIX.length] as SessionStatus);
    const created = AT(i);
    const title =
      i < TITLES.length
        ? (TITLES[i] as string)
        : `${TITLES[i % TITLES.length]} #${i}`;
    const id = uuid(1, i + 1);
    const summary: SessionSummary = {
      id,
      title,
      agent: {
        id: agent.id,
        name: agent.name,
        release_version_no: 1,
        release_label: "2026-11-09_07:58:00",
        release_is_active: true,
      },
      created_by: { user_id: USER_ID, display_name: "Demo Owner" },
      channel: i % 5 === 1 ? "slack" : CHANNELS[i % 3 === 2 ? 2 : 0]!,
      slack_permalink: null,
      revision: 1,
      admission_state: status === "stopped" ? "stopped" : "active",
      status,
      input_wait: waiting ? { state: "waiting" } : null,
      runtime: {
        kind: "claude_agent_sdk",
        version: "0.3.270",
        profile_id: "claude-coding-local",
        model: "claude-sonnet-5",
        permission_mode: "default",
      },
      model: "claude-sonnet-5",
      repository_id: "sample-app",
      repository: {
        id: "sample-app",
        full_name: "acme/sample-app",
        branch: "main",
      },
      attached_repository_ids: [],
      attached_repositories: [],
      extensions: [],
      current_turn_id: status === "running" || waiting ? "1" : null,
      queued_turn_count: 0,
      last_event_at: iso(created + 6 * MIN),
      created_at: iso(created),
      updated_at: iso(created + (3 + (i % 9) * 4) * MIN),
    };
    const s: SessionState = {
      summary,
      turns: [],
      pending: [],
      frames: [],
      seq: 0,
      streams: new Set(),
    };
    const turn = makeTurn(
      s,
      `${title}을(를) 처리해 주세요.`,
      created,
      waiting || status === "running" ? "running" : "completed",
    );
    emit(s, "status", { phase: "running" }, turn.turn_id, created + 500);
    emit(
      s,
      "assistant",
      {
        type: "assistant",
        text: "요청을 확인했습니다. 저장소 상태부터 살펴보겠습니다.",
      },
      turn.turn_id,
      created + 2000,
    );
    emit(
      s,
      "tool_use",
      {
        type: "assistant",
        tool_call: {
          id: `c${i}a`,
          name: "Bash",
          input: { command: "git status --short" },
        },
      },
      turn.turn_id,
      created + 3000,
    );
    emit(
      s,
      "tool_result",
      {
        tool_result: {
          tool_call_id: `c${i}a`,
          is_error: false,
          text: "nothing to commit, working tree clean",
        },
      },
      turn.turn_id,
      created + 4000,
    );
    emit(
      s,
      "tool_use",
      {
        type: "assistant",
        tool_call: {
          id: `c${i}b`,
          name: "Read",
          input: { file_path: "docs/check.md" },
        },
      },
      turn.turn_id,
      created + 5000,
    );
    emit(
      s,
      "tool_result",
      {
        tool_result: {
          tool_call_id: `c${i}b`,
          is_error: false,
          text: "# Check\n\nAll steps listed.",
        },
      },
      turn.turn_id,
      created + 6000,
    );
    if (waiting) {
      const requestId = `req-${i}`;
      emit(
        s,
        "tool_use",
        {
          type: "assistant",
          tool_call: {
            id: `c${i}c`,
            name: "open_pull_request",
            input: {
              title: "awr v2 check (test, do not merge)",
              repository: "acme/sample-app",
            },
          },
        },
        turn.turn_id,
        created + 7000,
      );
      emit(
        s,
        "question",
        {
          request_id: requestId,
          tool_use_id: `c${i}c`,
          kind: "permission",
          tool: "open_pull_request",
          input: {
            title: "awr v2 check (test, do not merge)",
            repository: "acme/sample-app",
          },
          expires_at: iso(t0 + 6 * 3_600_000),
        },
        turn.turn_id,
        created + 7500,
      );
      emit(s, "status", { phase: "needs_input" }, turn.turn_id, created + 7600);
      s.pending.push({
        request_id: requestId,
        turn_id: turn.turn_id,
        attempt_id: uuid(6, i + 1),
        created_at: iso(created + 7500),
        expires_at: iso(t0 + 6 * 3_600_000),
        state: "waiting",
        park_at: null,
        kind: "permission",
        tool: "open_pull_request",
        input: {
          title: "awr v2 check (test, do not merge)",
          repository: "acme/sample-app",
        },
      } as PendingRequest);
      agent.needs += 1;
    } else if (status === "running") {
      agent.running += 1;
    } else {
      emit(
        s,
        "assistant",
        {
          type: "assistant",
          text: "확인을 마쳤습니다. 변경할 내용은 없고, 모든 단계가 정상입니다.",
        },
        turn.turn_id,
        created + 8000,
      );
      emit(
        s,
        "result",
        {
          type: "result",
          turn: {
            outcome: "success",
            is_error: false,
            terminal_reason: null,
            tokens: 1840,
          },
        },
        turn.turn_id,
        created + 9000,
      );
      emit(
        s,
        "status",
        { phase: status === "failed" ? "failed" : "idle" },
        turn.turn_id,
        created + 9100,
      );
    }
    sessions.push(s);
  }
  const byId = (id: string) => sessions.find((s) => s.summary.id === id);
  const detailOf = (s: SessionState): SessionDetail =>
    ({
      ...s.summary,
      workspace_limit_mode: { bytes: "soft", inodes: "soft", reason: "demo" },
      execution: null,
      checkpoint_revision: null,
      pause_reason: null,
      pending_request_count: s.pending.length,
      attention: null,
      durability: {
        last_transcript_persisted_at: null,
        checkpoint_committed_at: null,
        checkpoint_revision: null,
        last_completed_turn_id: null,
        last_checkpointed_turn_id: null,
        checkpoint_pending_reason: null,
        checkpoint_fallback_revision: null,
        context_reset_turn_id: null,
      },
      input_wait: s.pending.length
        ? {
            state: "waiting",
            since: s.pending[0]!.created_at,
            kinds: ["permission"],
            request_ids: s.pending.map((p) => p.request_id),
            park_at: null,
            expires_at: s.pending[0]!.expires_at,
          }
        : null,
    }) as SessionDetail;

  function setStatus(s: SessionState, next: SessionStatus) {
    s.summary = {
      ...s.summary,
      status: next,
      input_wait: next === "needs_input" ? { state: "waiting" } : null,
      admission_state:
        next === "stopped"
          ? "stopped"
          : s.summary.admission_state === "paused"
            ? "paused"
            : "active",
      updated_at: iso(now()),
    };
  }

  // ---- route table ----
  const page = <T>(items: readonly T[], url: URL, limitDefault = 50) => {
    const limit = Number(url.searchParams.get("limit") ?? limitDefault);
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const slice = items.slice(start, start + limit);
    return {
      items: slice,
      next_cursor: start + limit < items.length ? String(start + limit) : null,
    };
  };
  const listSessions = (url: URL) => {
    const status = url.searchParams.get("status");
    const q = url.searchParams.get("q")?.toLowerCase();
    return sessions
      .map((s) => s.summary)
      .filter((s) => !status || s.status === status)
      .filter(
        (s) =>
          !q || (s.title ?? "").toLowerCase().includes(q) || s.id.startsWith(q),
      );
  };
  const body = async (request: Request) =>
    (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const pagedMembers = (url: URL) => {
    const q = url.searchParams.get("q")?.toLowerCase();
    const rows = members.filter(
      (m) =>
        !q ||
        m.display_name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q),
    );
    const slice = page(rows, url);
    return json(200, memberPage(slice));
  };
  const teamDetail = (team: TeamView) => ({
    ...team,
    members: (teamMembers.get(team.id) ?? []).map((row) => {
      const m = members.find((x) => x.user_id === row.id)!;
      return {
        user_id: m.user_id,
        email: m.email,
        display_name: m.display_name,
        role: row.lead ? "lead" : "member",
        added_by: USER_ID,
        added_at: iso(t0 - 20 * 86_400_000),
        disabled_at: m.disabled_at,
      };
    }),
  });

  const routes: [string, RegExp, Handler][] = [];
  const on = (method: string, path: string, handler: Handler) => {
    const pattern = new RegExp(
      `^${path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`,
    );
    routes.push([method, pattern, handler]);
  };
  const ok = (value: unknown) => () => json(200, value);

  on("GET", "/v1/auth/me", ok(owner));
  on("PATCH", "/v1/auth/me", ok(owner));
  on("POST", "/v1/auth/logout", () => new Response(null, { status: 204 }));
  on("GET", "/v1/profiles", (r) => primaryRoute("GET /v1/profiles", r));
  on("GET", "/v1/my-teams", () =>
    json(200, {
      items: teams.map((t) => ({ id: t.id, name: t.name, role: "lead" })),
      next_cursor: null,
    }),
  );

  // sessions
  on("GET", "/v1/sessions", (r) => {
    const url = new URL(r.url);
    return json(200, page(listSessions(url), url));
  });
  on("GET", "/v1/sessions/counts", (r) => {
    const rows = listSessions(new URL(r.url));
    const counts = {
      queued: 0,
      running: 0,
      needs_input: 0,
      idle: 0,
      failed: 0,
      stopped: 0,
    };
    for (const row of rows) counts[row.status] += 1;
    return json(200, { counts, total: rows.length });
  });
  on("GET", "/v1/sessions/waiting", (r) => {
    const url = new URL(r.url);
    return json(
      200,
      page(
        sessions.filter((s) => s.pending.length).map((s) => s.summary),
        url,
      ),
    );
  });
  on("GET", "/v1/sessions/{id}", (_r, p) => {
    const s = byId(p.id!);
    return s ? json(200, detailOf(s)) : apiError(404, "NOT_FOUND", "Not found");
  });
  on("GET", "/v1/sessions/{id}/pending-requests", (_r, p) => {
    const s = byId(p.id!);
    return s
      ? json(200, { items: s.pending, answerable: true })
      : apiError(404, "NOT_FOUND", "Not found");
  });
  on("GET", "/v1/sessions/{id}/turns", (r, p) => {
    const s = byId(p.id!);
    return s
      ? json(200, page(s.turns, new URL(r.url), 100))
      : apiError(404, "NOT_FOUND", "Not found");
  });
  on("GET", "/v1/sessions/{id}/usage", (_r, p) =>
    json(200, {
      session_id: p.id,
      period: "session_lifetime",
      refreshed_at: iso(now()),
      cost: {
        amount_usd: 0.06,
        kind: "estimated",
        source: "provider_usage",
        completeness_scope: "turn_reports",
        complete: true,
        reported_turn_count: 1,
        unreported_turn_count: 0,
        open_turn_count: 0,
      },
      cost_limit_usd: 5,
      token_count: 18_400,
      token_limit: null,
      budget_exceeded: false,
    }),
  );
  on("GET", "/v1/sessions/{id}/outputs", (_r, p) =>
    json(200, {
      session_id: p.id,
      checkpoint_revision: 1,
      items: [
        {
          path: "out/report.md",
          bytes: 2048,
          sha256: "a".repeat(64),
          omitted: null,
        },
      ],
    }),
  );
  on("GET", "/v1/sessions/{id}/github/work", (_r, p) =>
    json(200, { session_id: p.id, items: [], intents: [] }),
  );
  // A session that ran to a stop left one pull request behind.
  on("GET", "/v1/sessions/{id}/outcomes", (_r, p) => {
    const s = byId(p.id!);
    if (!s) return apiError(404, "NOT_FOUND", "Not found");
    if (s.summary.status !== "idle") return json(200, { items: [] });
    const at = s.summary.updated_at;
    const number = 100 + sessions.indexOf(s);
    return json(200, {
      items: [
        {
          id: uuid(9, number),
          type: "github_pull_request",
          url: `https://github.com/acme/sample-app/pull/${number}`,
          repository_id: null,
          external_id: String(number),
          state: number % 3 === 0 ? "merged" : "open",
          state_changed_at: at,
          merged_at: number % 3 === 0 ? at : null,
          closed_at: null,
          state_checked_at: at,
          check_error: null,
          created_at: at,
          metadata: {
            title: s.summary.title,
            head: `agent/${s.summary.id.slice(0, 8)}`,
            base: "main",
            adopted: false,
            merge_commit_sha: null,
            additions: 42,
            deletions: 7,
            changed_files: 3,
            commits: 2,
          },
        },
      ],
    });
  });
  on("GET", "/v1/sessions/{id}/events", (r, p) => {
    const s = byId(p.id!);
    if (!s) return apiError(404, "NOT_FOUND", "Not found");
    const encoder = new TextEncoder();
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let push: ((text: string) => void) | undefined;
    const last = r.headers.get("last-event-id");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const from = last
          ? s.frames.findIndex((f) => f.startsWith(`id: ${last}\n`)) + 1
          : 0;
        const replay = s.frames.slice(from).join("");
        if (replay) controller.enqueue(encoder.encode(replay));
        push = (text) => controller.enqueue(encoder.encode(text));
        s.streams.add(push);
        keepalive = setInterval(
          () => controller.enqueue(encoder.encode(": keepalive\n\n")),
          15_000,
        );
        r.signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          if (push) s.streams.delete(push);
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        clearInterval(keepalive);
        if (push) s.streams.delete(push);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const receipt = (extra: object = {}) =>
    json(202, {
      receipt_id: uuid(7, Math.floor(now() % 1e9)),
      receipt_status: "accepted",
      ...extra,
    });
  on("POST", "/v1/sessions/{id}/messages", async (r, p) => {
    const s = byId(p.id!);
    if (!s) return apiError(404, "NOT_FOUND", "Not found");
    const text = String((await body(r)).message ?? "");
    const turn = makeTurn(s, text, now(), "running");
    // A session waiting for an answer only queues the message.
    if (s.pending.length) {
      emit(s, "status", { phase: "needs_input" }, turn.turn_id);
      return json(202, {
        turn_id: turn.turn_id,
        receipt_id: uuid(7, Math.floor(now() % 1e9)),
        receipt_status: "accepted",
      });
    }
    setStatus(s, "running");
    emit(s, "status", { phase: "running" }, turn.turn_id);
    setTimeout(() => {
      emit(
        s,
        "assistant",
        {
          type: "assistant",
          text: `“${text.slice(0, 60)}” 요청을 받았습니다. 확인한 뒤 알려 드리겠습니다.`,
        },
        turn.turn_id,
      );
      emit(
        s,
        "result",
        {
          type: "result",
          turn: {
            outcome: "success",
            is_error: false,
            terminal_reason: null,
            tokens: 900,
          },
        },
        turn.turn_id,
      );
      turn.status = "completed";
      turn.ended_at = iso(now());
      setStatus(s, "idle");
      emit(s, "status", { phase: "idle" }, turn.turn_id);
    }, 900);
    return json(202, {
      turn_id: turn.turn_id,
      receipt_id: uuid(7, Math.floor(now() % 1e9)),
      receipt_status: "accepted",
    });
  });
  on("POST", "/v1/sessions/{id}/answers", async (r, p) => {
    const s = byId(p.id!);
    if (!s) return apiError(404, "NOT_FOUND", "Not found");
    const answer = await body(r);
    const requestId = String(
      answer.request_id ?? s.pending[0]?.request_id ?? "",
    );
    const approved = JSON.stringify(answer).includes("deny")
      ? false
      : !JSON.stringify(answer).includes('"allow":false');
    const turnId = s.pending[0]?.turn_id ?? "1";
    s.pending = s.pending.filter((x) => x.request_id !== requestId);
    const agent = agentRows.find((a) => a.id === s.summary.agent?.id);
    if (agent && agent.needs > 0) agent.needs -= 1;
    emit(
      s,
      "tool_result",
      {
        tool_result: {
          tool_call_id: `c${sessions.indexOf(s)}c`,
          is_error: !approved,
          text: approved
            ? "Pull request #153 opened."
            : "The request was declined.",
        },
      },
      turnId,
    );
    emit(
      s,
      "assistant",
      {
        type: "assistant",
        text: approved
          ? "승인되어 PR #153을 열었습니다."
          : "요청이 거절되어 PR을 열지 않았습니다.",
      },
      turnId,
    );
    setStatus(s, "idle");
    emit(s, "status", { phase: "idle" }, turnId);
    return receipt();
  });
  const control =
    (next: SessionStatus, admission?: SessionSummary["admission_state"]) =>
    (_r: Request, p: Record<string, string>) => {
      const s = byId(p.id!);
      if (!s) return apiError(404, "NOT_FOUND", "Not found");
      setStatus(s, next);
      if (admission) s.summary = { ...s.summary, admission_state: admission };
      emit(
        s,
        "status",
        { phase: next, admission_state: s.summary.admission_state },
        null,
      );
      return receipt({ status: next });
    };
  on("POST", "/v1/sessions/{id}/pause", control("idle", "paused"));
  on("POST", "/v1/sessions/{id}/resume", control("running", "active"));
  on("POST", "/v1/sessions/{id}/interrupt", control("idle"));
  on("POST", "/v1/sessions/{id}/terminate", control("stopped", "stopped"));
  on("GET", "/v1/sessions/{id}/share", (_r, p) =>
    json(200, { session_id: p.id, workspace: false, users: [], teams: [] }),
  );

  // agents
  on("GET", "/v1/agents", (r) => {
    const url = new URL(r.url);
    const q = url.searchParams.get("q")?.toLowerCase();
    const rows = agentRows
      .filter(
        (a) => !q || a.name.toLowerCase().includes(q) || a.slug.includes(q),
      )
      .map(agentItem);
    return json(200, page(rows, url));
  });
  on("GET", "/v1/agents/counts", () =>
    json(200, {
      counts: {
        all: agentRows.length,
        administered: agentRows.length,
        active: agentRows.filter((a) => a.status === "active" && a.released)
          .length,
        draft: agentRows.filter((a) => a.status !== "archived" && !a.released)
          .length,
      },
    }),
  );
  on("GET", "/v1/administered-agents", () =>
    json(200, { items: agentRows.map(agentItem), next_cursor: null }),
  );
  on("GET", "/v1/agents/{id}", (_r, p) => {
    const row = agentRows.find((a) => a.id === p.id);
    if (!row) return apiError(404, "NOT_FOUND", "Not found");
    const base = primary.detail() as AgentDetail;
    return json(200, {
      ...base,
      agent: { ...base.agent, ...agentItem(row), summary: undefined },
    });
  });
  const sub = (suffix: string) => `/v1/agents/{id}/${suffix}`;
  on("GET", sub("admins"), ok({ users: [], teams: [] }));
  on("GET", sub("engine-settings"), (r, p) =>
    primaryRoute(
      `GET /v1/agents/${primary.detail().agent.id}/engine-settings`,
      r,
      p,
    ),
  );
  on("GET", sub("mcp/settings"), (r) =>
    primaryRoute(`GET /v1/agents/${primary.detail().agent.id}/mcp/settings`, r),
  );
  on("GET", sub("credential-bindings"), (r) =>
    primaryRoute(
      `GET /v1/agents/${primary.detail().agent.id}/credential-bindings`,
      r,
    ),
  );
  on("GET", sub("github/activity"), ok({ items: [] }));
  on("GET", sub("slack-bindings"), ok({ items: [] }));

  // members, teams, invites
  on("GET", "/v1/members", (r) => pagedMembers(new URL(r.url)));
  on("PATCH", "/v1/members/{user_id}", async (r, p) => {
    const m = members.find((x) => x.user_id === p.user_id);
    if (!m) return apiError(404, "NOT_FOUND", "Not found");
    const role = (await body(r)).role;
    if (role === "owner" || role === "admin" || role === "member")
      m.role = role;
    return json(200, m);
  });
  on("POST", "/v1/members/{user_id}/disable", (_r, p) => {
    const m = members.find((x) => x.user_id === p.user_id);
    if (!m) return apiError(404, "NOT_FOUND", "Not found");
    m.disabled_at = iso(now());
    return json(200, m);
  });
  on("POST", "/v1/members/{user_id}/enable", (_r, p) => {
    const m = members.find((x) => x.user_id === p.user_id);
    if (!m) return apiError(404, "NOT_FOUND", "Not found");
    m.disabled_at = null;
    return json(200, m);
  });
  on("GET", "/v1/invites", () => json(200, { items: [...invites].reverse() }));
  on("POST", "/v1/invites", async (r) => {
    const data = await body(r);
    const invite: Invite = {
      id: uuid(4, invites.length + 1),
      workspace_id: WORKSPACE_ID,
      email: String(data.email ?? "new@example.test"),
      role: (data.role as Invite["role"]) ?? "member",
      invited_by: USER_ID,
      status: "pending",
      expires_at: iso(now() + 7 * 86_400_000),
      accepted_at: null,
      revoked_at: null,
      created_at: iso(now()),
    };
    invites.push(invite);
    return json(201, {
      invite_id: invite.id,
      invite_token: "demo-token-".padEnd(48, "x"),
      expires_at: invite.expires_at,
    });
  });
  on("DELETE", "/v1/invites/{id}", (_r, p) => {
    const invite = invites.find((x) => x.id === p.id);
    if (invite) {
      invite.status = "revoked";
      invite.revoked_at = iso(now());
    }
    return new Response(null, { status: 204 });
  });
  on("GET", "/v1/teams", (r) => {
    const url = new URL(r.url);
    const q = url.searchParams.get("q")?.toLowerCase();
    return json(
      200,
      page(
        teams.filter((t) => !q || t.name.toLowerCase().includes(q)),
        url,
      ),
    );
  });
  on("POST", "/v1/teams", async (r) => {
    const name = String((await body(r)).name ?? "새 팀");
    const team: TeamView = {
      id: uuid(3, teams.length + 1),
      workspace_id: WORKSPACE_ID,
      name,
      member_count: 1,
      created_by: USER_ID,
      created_at: iso(now()),
      revision: 1,
    };
    teams.push(team);
    teamMembers.set(team.id, [{ id: USER_ID, lead: true }]);
    return json(201, teamDetail(team));
  });
  on("GET", "/v1/teams/{team_id}", (_r, p) => {
    const team = teams.find((t) => t.id === p.team_id);
    return team
      ? json(200, teamDetail(team))
      : apiError(404, "NOT_FOUND", "Not found");
  });

  // workspace
  on(
    "GET",
    "/v1/workspaces/{id}/engine-settings",
    ok(workspaceEngineSettings()),
  );
  on("GET", "/v1/workspaces/{id}/agent-access", ok(owner.workspace?.settings));
  on("GET", "/v1/limits", ok({ items: [] }));
  on("GET", "/v1/agents/{id}/identities", ok({ items: [] }));
  const queryOf = (r: Request) => new URL(r.url).searchParams;
  const daysOf = (r: Request) => {
    const q = queryOf(r);
    const since = Date.parse(q.get("since") ?? "");
    const until = Date.parse(q.get("until") ?? "") || now();
    return Number.isFinite(since)
      ? Math.max(1, Math.round((until - since) / 86_400_000))
      : 30;
  };
  on("GET", "/v1/usage/series", (r) =>
    json(200, usageSeries(now(), daysOf(r))),
  );
  on("GET", "/v1/usage/summary", (r) =>
    json(200, usageSummary(now(), queryOf(r).get("scope") ?? "me", daysOf(r))),
  );
  on("GET", "/v1/usage/tools", ok(usageTools));
  on("GET", "/v1/usage/achievements", () =>
    json(200, achievementFigures(now(), agentRows)),
  );
  on("GET", "/v1/achievement-types", ok(achievementTypes));
  on("GET", "/v1/achievement-categories", ok(achievementCategories));
  on("GET", "/v1/installation/settings/connections", () =>
    apiError(404, "NOT_FOUND", "Not found"),
  );
  // No Slack app or GitHub setup yet: the screens show their empty states.
  on("GET", "/v1/agents/{id}/slack/app", () =>
    apiError(404, "NOT_FOUND", "Not found"),
  );
  on("GET", "/v1/agents/{id}/github", () =>
    apiError(404, "NOT_FOUND", "Not found"),
  );
  on("GET", "/v1/usage/breakdown", () => {
    const rows = agentRows.map((a, i) => {
      const sessionCount = 40 - i * 4;
      const input = sessionCount * 12_000;
      const output = sessionCount * 3_500;
      return {
        key: a.id,
        label: a.name,
        session_count: sessionCount,
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: input * 2,
        cache_creation_input_tokens: Math.round(input / 4),
        token_count: input + output + input * 2 + Math.round(input / 4),
        cost_usd: (sessionCount * 0.42).toFixed(2),
      };
    });
    const sum = (
      k:
        | "session_count"
        | "input_tokens"
        | "output_tokens"
        | "cache_read_input_tokens"
        | "cache_creation_input_tokens"
        | "token_count",
    ) => rows.reduce((n, r) => n + r[k], 0);
    return json(200, {
      rows,
      totals: {
        session_count: sum("session_count"),
        input_tokens: sum("input_tokens"),
        output_tokens: sum("output_tokens"),
        cache_read_input_tokens: sum("cache_read_input_tokens"),
        cache_creation_input_tokens: sum("cache_creation_input_tokens"),
        token_count: sum("token_count"),
        cost_usd: rows.reduce((n, r) => n + Number(r.cost_usd), 0).toFixed(2),
      },
    });
  });
  on("GET", "/v1/api-keys", ok({ items: [], next_cursor: null }));
  on("GET", "/v1/linked-accounts", ok({ items: [] }));

  function primaryRoute(key: string, request: Request, _p?: unknown) {
    const handler = (
      primary.routes as Record<
        string,
        (r: Request) => Response | Promise<Response>
      >
    )[key];
    return handler
      ? handler(request)
      : apiError(404, "NOT_FOUND", `no fake for ${key}`);
  }

  const protoFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    for (const [method, pattern, handler] of routes) {
      if (method !== request.method) continue;
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      options.onCall?.(request.method, url.pathname, true);
      return handler(request, { ...match.groups });
    }
    options.onCall?.(request.method, url.pathname, false);
    return apiError(404, "NOT_FOUND", `Not part of the demo: ${url.pathname}`);
  };
  return protoFetch as typeof fetch;
}
