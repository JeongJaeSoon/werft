import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TurnSummary } from "@werft-ai/contracts";
import { PANEL_STORAGE_KEY, SessionDetail } from "@werft-ai/react/blocks";
import { Button, EmptyState, Section, Text } from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
import { expect, within } from "storybook/test";
import { I18nProvider } from "../../../web/src/i18n/i18n.tsx";
import { SessionWorkspaceLimit } from "../../../web/src/routes/session-workspace-limit.tsx";

import { type FakeRoutes, json } from "../../.storybook/fake-client.ts";
import {
  accepted,
  base,
  DETAIL,
  eventStream,
  eventStreamOf,
  hostFor,
  PENDING,
  pending,
  shared,
  USAGE,
} from "../blocks/block-fixtures.tsx";
import { SESSION } from "../domain/session/session-fixtures.ts";
import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * Console v4 session detail (Console.dc.html, user feedback 2026-10-24) as
 * apps/web mounts the real block: the title and status, the meta line with
 * the design's icons, the commands top right with the way back at the end
 * of their row, the
 * composer under the timeline and, from 1280px, the right rail (V4-RAIL)
 * from the top bar to the bottom of the screen, which the head's panel
 * button folds away; narrower, the same button opens it as a sheet over the
 * body. What the API does not carry yet (agent, who started it, branch)
 * says so.
 */

const TITLED = { ...DETAIL, title: "hello.txt 만들고 commit" };

const WRITE_REQUEST = {
  ...PENDING,
  items: [
    {
      ...PENDING.items[0],
      tool: "Write",
      input: { path: "hello.txt", content: "hello" },
    },
  ],
};

// apps/web routes/session-share.tsx: GET /v1/sessions/{id}/share, read only.
const SHARE_TEXT = {
  workspace: "워크스페이스",
  limited: "워크스페이스(담당 팀 밖 사람은 보지 못함, 워크스페이스 설정)",
  private: "세션을 가진 사람만",
} as const;

function SessionDetailPage({
  locale,
  scoped = true,
  share = "workspace",
}: {
  readonly locale?: string | undefined;
  /** False: a key without the session scopes, every action disabled. */
  readonly scoped?: boolean | undefined;
  /** The share the console reads: `limited` is `audience_limited: true`. */
  readonly share?: keyof typeof SHARE_TEXT | undefined;
}) {
  const host = hostFor({ globals: locale === undefined ? {} : { locale } });
  return (
    <ScreenShell
      current="sessions"
      crumb={["세션", "hello.txt 만들고 commit"]}
      flush
    >
      <SessionDetail
        id={SESSION.id}
        {...shared(host)}
        unavailable={scoped ? undefined : host.unavailable}
        controls={(session) => (
          <>
            <I18nProvider
              locale={locale === "en" ? "en" : locale === "ja" ? "ja" : "ko"}
            >
              <SessionWorkspaceLimit mode={session.workspace_limit_mode} />
            </I18nProvider>
            <Section titleAs="h3" title="공유 범위">
              <Text as="div" className="text-body">
                {SHARE_TEXT[share]}
              </Text>
            </Section>
          </>
        )}
        back={
          <Button asChild variant="outline">
            <a href="#sessions">
              <ArrowLeft strokeWidth={1.5} aria-hidden="true" />
              세션 목록
            </a>
          </Button>
        }
        tabs={() => [
          {
            value: "outputs",
            label: "성과물",
            count: 0,
            content: <EmptyState title="아직 성과물이 없습니다." />,
          },
        ]}
      />
    </ScreenShell>
  );
}

const routes = ({
  detail = TITLED,
  requests = WRITE_REQUEST,
}: {
  readonly detail?: unknown;
  readonly requests?: unknown;
} = {}): FakeRoutes => ({
  [`GET ${base}`]: () => json(200, detail),
  [`GET ${base}/usage`]: () => json(200, USAGE),
  [`GET ${base}/pending-requests`]: () => json(200, requests),
  [`GET ${base}/events`]: eventStream,
  [`POST ${base}/answers`]: accepted,
  [`POST ${base}/interrupt`]: accepted,
  [`POST ${base}/pause`]: accepted,
  [`POST ${base}/terminate`]: accepted,
});

const meta = {
  title: "Screens/Session detail (v4)",
  component: SessionDetailPage,
  parameters: { layout: "fullscreen", api: routes() },
  render: (args, context) => (
    <SessionDetailPage
      {...args}
      locale={context.globals.locale as string | undefined}
    />
  ),
} satisfies Meta<typeof SessionDetailPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Owner: Story = { name: "시작한 사람: 권한 요청 대기" };

export const WorkspaceHard: Story = {
  parameters: {
    api: routes({
      detail: {
        ...TITLED,
        workspace_limit_mode: {
          bytes: "hard",
          inodes: "hard",
          reason: "local_quota_preflight",
        },
      },
    }),
  },
};

export const OwnerIdle: Story = {
  name: "시작한 사람: 기다리는 요청 없음",
  parameters: {
    api: routes({
      detail: { ...TITLED, status: "idle", pending_request_count: 0 },
      requests: { answerable: true, items: [] },
    }),
  },
};

/** A member the session was shared with sees the request but may not answer. */
export const Member: Story = {
  name: "공유받은 구성원: 볼 수만 있음",
  parameters: {
    api: routes({ requests: { ...WRITE_REQUEST, answerable: false } }),
  },
};

/** Axis B is managing_team: the share line says who still cannot see it. */
export const ShareLimited: Story = {
  name: "공유 범위: 워크스페이스(담당 팀 밖 제외)",
  args: { share: "limited" },
};

export const SharePrivate: Story = {
  name: "공유 범위: 세션을 가진 사람만",
  args: { share: "private" },
};

export const ShareLimitedMobileDark: Story = {
  ...ShareLimited,
  name: "공유 범위: 워크스페이스(담당 팀 밖 제외) (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

/** The operations card when the key may neither answer nor control. */
export const Unscoped: Story = {
  name: "운영: 권한 없는 key",
  args: { scoped: false },
};

/** Until the pending requests arrive the card states only the rule. */
export const PendingLoading: Story = {
  name: "운영: 요청 불러오는 중",
  parameters: {
    api: { ...routes(), [`GET ${base}/pending-requests`]: pending },
  },
};

/** An archived session takes no command; the card says so. */
export const Closed: Story = {
  name: "운영: 할 수 있는 조치 없음",
  parameters: {
    api: routes({
      detail: {
        ...TITLED,
        status: "stopped",
        admission_state: "closed",
        current_turn_id: null,
        pending_request_count: 0,
      },
      requests: { answerable: true, items: [] },
    }),
  },
};

export const Untitled: Story = {
  name: "제목 없는 세션: 짧은 ID",
  parameters: { api: routes({ detail: DETAIL }) },
};

export const Loading: Story = {
  name: "불러오는 중",
  parameters: { api: { ...routes(), [`GET ${base}`]: pending } },
};

export const LoadError: Story = {
  name: "불러오지 못함",
  parameters: {
    api: {
      ...routes(),
      [`GET ${base}`]: () =>
        json(500, {
          error: { code: "INTERNAL_ERROR", message: "detail failed" },
        }),
    },
  },
};

export const OwnerDark: Story = {
  ...Owner,
  name: "시작한 사람 (dark)",
  globals: { theme: "dark" },
};

export const OwnerMobile: Story = {
  ...Owner,
  name: "시작한 사람 (390px)",
  globals: MOBILE,
};

export const OwnerMobileDark: Story = {
  ...Owner,
  name: "시작한 사람 (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

export const MemberMobile: Story = {
  ...Member,
  name: "공유받은 구성원 (390px)",
  globals: MOBILE,
};

/*
 * The panel button. From 1280px it folds the rail (remembered in this
 * browser); narrower it opens the rail as a sheet. Either way the requests
 * waiting for an answer show as a count on the button.
 */

const folded = () => {
  localStorage.setItem(PANEL_STORAGE_KEY, "folded");
  return () => localStorage.removeItem(PANEL_STORAGE_KEY);
};

type Canvas = Parameters<NonNullable<Story["play"]>>[0]["canvas"];
const panelButton = (canvas: Canvas) =>
  canvas.findByRole("button", { name: /^세션 요약/ });

/** Folded with one request waiting: the count stays on the button. */
export const PanelFoldedWaiting: Story = {
  name: "패널 접힘: 답변 대기 1건",
  beforeEach: folded,
  play: async ({ canvas }) => {
    const button = await panelButton(canvas);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(
      await canvas.findByRole("button", { name: /답변 대기 1건/ }),
    ).toBe(button);
    await expect(canvas.queryByRole("button", { name: "허용" })).toBeNull();
  },
};

/** Folded with nothing waiting: the button carries no count. */
export const PanelFoldedIdle: Story = {
  ...OwnerIdle,
  name: "패널 접힘: 기다리는 요청 없음",
  beforeEach: folded,
  play: async ({ canvas }) => {
    const button = await panelButton(canvas);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(button).toHaveAccessibleName("세션 요약");
  },
};

/** Open again from the folded state: one click brings back the answer. */
export const PanelReopened: Story = {
  name: "패널 접힘에서 다시 펼침: 허용까지 두 번",
  beforeEach: folded,
  play: async ({ canvas, userEvent }) => {
    const button = await panelButton(canvas);
    await userEvent.click(button);
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(
      await canvas.findByRole("button", { name: "허용" }),
    ).toBeVisible();
  },
};

/** 390px: the rail opens as a sheet over the body and takes focus. */
export const PanelSheetMobile: Story = {
  name: "패널 시트 열림 (390px)",
  globals: MOBILE,
  play: async ({ canvas, userEvent }) => {
    const button = await panelButton(canvas);
    if (button.getAttribute("aria-expanded") === "false") {
      await userEvent.click(button);
    }
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(
      await canvas.findByRole("button", { name: "허용" }),
    ).toBeVisible();
  },
};

export const PanelSheetMobileDark: Story = {
  ...PanelSheetMobile,
  name: "패널 시트 열림 (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

export const PanelSheetIdleMobile: Story = {
  ...PanelSheetMobile,
  ...OwnerIdle,
  name: "패널 시트 열림: 기다리는 요청 없음 (390px)",
  play: async ({ canvas, userEvent }) => {
    const button = await panelButton(canvas);
    if (button.getAttribute("aria-expanded") === "false") {
      await userEvent.click(button);
    }
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(await canvas.findByText("기다리는 요청 없음")).toBeVisible();
  },
};

const PUSHED_AT = "2026-10-21T01:00:00.000Z";

const pushRequest = (fields: Record<string, unknown>) => ({
  id: "019a0000-0000-7000-8000-0000000000a1",
  session_id: SESSION.id,
  repository_id: "api",
  checkpoint_revision: 2,
  git_commit: "a".repeat(40),
  target_branch: "agent/session-1",
  state: "pushed",
  requested_by: {
    principal: { kind: "api_key", id: "key-1" },
    actor_user_id: null,
    agent_id: null,
  },
  requested_at: PUSHED_AT,
  resolved_by: null,
  resolved_at: null,
  resolution_reason: null,
  request_receipt_id: "019a0000-0000-7000-8000-0000000000b1",
  resolution_receipt_id: null,
  finished_at: PUSHED_AT,
  push_receipt_id: null,
  origin: "direct",
  flow: "actions",
  pr_state: "opened",
  pr_error: null,
  pr_number: 12,
  pr_url: "https://github.com/acme/api/pull/12",
  ...fields,
});

const infoRoutes = (
  repositories: { id: string; full_name: string | null }[],
  work: { items: unknown[]; intents: unknown[] },
  own: boolean,
): FakeRoutes => ({
  ...routes({
    detail: {
      ...TITLED,
      repository: own ? TITLED.repository : null,
      repository_id: own ? TITLED.repository_id : null,
      attached_repository_ids: repositories.map((item) => item.id),
      attached_repositories: repositories,
    },
  }),
  [`GET ${base}/push-requests`]: () => json(200, work),
});

const openInfo: Story["play"] = async ({ canvas, userEvent }) => {
  await userEvent.click(await canvas.findByRole("tab", { name: /^정보/ }));
  await expect(await canvas.findByRole("tabpanel")).toBeVisible();
};

/** Zero repositories: the list says none and asks nothing of GitHub. */
export const InfoRepositoriesNone: Story = {
  name: "정보 탭: 저장소 0개",
  parameters: { api: infoRoutes([], { items: [], intents: [] }, false) },
  play: openInfo,
};

/** One repository, the session's own, with no push asked for yet. */
export const InfoRepositoriesOne: Story = {
  name: "정보 탭: 저장소 1개",
  parameters: { api: infoRoutes([], { items: [], intents: [] }, true) },
  play: openInfo,
};

/**
 * Three: a pushed branch with its pull request, a newer failed ask hiding
 * behind an older push (the newer one shows), and one never asked for.
 */
export const InfoRepositoriesThree: Story = {
  name: "정보 탭: 저장소 3개",
  parameters: {
    api: infoRoutes(
      [
        { id: "api", full_name: "acme/api" },
        { id: "docs", full_name: "acme/docs" },
      ],
      {
        items: [
          pushRequest({}),
          pushRequest({
            id: "019a0000-0000-7000-8000-0000000000a2",
            repository_id: "docs",
            pr_state: null,
            pr_number: null,
            pr_url: null,
          }),
        ],
        intents: [
          {
            id: "019a0000-0000-7000-8000-0000000000c1",
            session_id: SESSION.id,
            repository_id: "docs",
            target_branch: "agent/session-1-fix",
            status: "failed",
            refusal_code: null,
            push_request_id: null,
            created_at: "2026-10-21T01:00:30.000Z",
          },
        ],
      },
      true,
    ),
  },
  play: openInfo,
};

export const InfoRepositoriesNoneMobile: Story = {
  ...InfoRepositoriesNone,
  name: "정보 탭: 저장소 0개 (390px)",
  globals: MOBILE,
};

export const InfoRepositoriesOneMobile: Story = {
  ...InfoRepositoriesOne,
  name: "정보 탭: 저장소 1개 (390px)",
  globals: MOBILE,
};

export const InfoRepositoriesThreeMobile: Story = {
  ...InfoRepositoriesThree,
  name: "정보 탭: 저장소 3개 (390px)",
  globals: MOBILE,
};

/*
 * Focus view (Claude Code's focus mode): the instruction, replies, the
 * failed test run, the permission request still waiting and the latest
 * status stay open; each run of tool calls, thinking and internal events
 * between them folds into one line that counts what it did. The events are
 * the shapes of the fake model's GATE-SPEC script (control-host demo-data).
 */
const FOCUS_TITLE = "의존성 업데이트 영향 확인";
const call = (
  id: string,
  name: string,
  input: Record<string, unknown>,
): [string, unknown] => ["tool_use", { tool_call: { id, name, input } }];
const done = (id: string, text: string, isError = false): [string, unknown] => [
  "tool_result",
  { tool_result: { tool_call_id: id, is_error: isError, text } },
];
const INSTALL_LOG = Array.from(
  { length: 40 },
  (_, line) =>
    `added @scope/package-${line + 1}@2.${line}.0 from https://registry.npmjs.org/@scope/package-${line + 1}/-/package-${line + 1}-2.${line}.0.tgz`,
).join("\n");
const RELEASE_NOTES = [
  "# 릴리스 노트 초안",
  "",
  "## 사용자에게 보이는 변경",
  "- 세션 상세의 타임라인이 기본으로 사람이 볼 것만 펼칩니다.",
  "- 로그인 화면에서 Slack 계정 연결이 한 번에 끝납니다.",
  "",
  "## 내부 변경",
  ...Array.from(
    { length: 20 },
    (_, line) => `- 의존성 ${line + 1}: 마이너 버전 올림, 공개 API 변경 없음`,
  ),
].join("\n");
const FOCUS_EVENTS: readonly [string, unknown][] = [
  ["status", { phase: "running" }],
  ["system", { engine_event: { name: "init", category: "started" } }],
  [
    "system",
    { engine_event: { name: "thinking_tokens", category: "thinking" } },
  ],
  [
    "system",
    { engine_event: { name: "thinking_tokens", category: "thinking" } },
  ],
  [
    "system",
    { engine_event: { name: "rate_limit_event", category: "internal" } },
  ],
  call("tu_1", "Bash", { command: "npm install", description: "의존성 설치" }),
  done("tu_1", INSTALL_LOG),
  call("tu_2", "Read", { file_path: "package.json" }),
  done("tu_2", '{\n  "name": "werft-sandbox",\n  "version": "1.4.0"\n}'),
  call("tu_3", "Read", { file_path: "CHANGELOG.md" }),
  done("tu_3", "## 1.4.0\n- 첫 공개"),
  call("tu_4", "Write", {
    file_path: "out/release-notes.md",
    content: RELEASE_NOTES,
  }),
  done("tu_4", RELEASE_NOTES),
  [
    "assistant",
    {
      text: "out/release-notes.md에 초안을 썼습니다. 사용자에게 보이는 변경 두 가지를 정리했습니다. 이어서 테스트를 돌립니다.",
    },
  ],
  call("tu_5", "Bash", { command: "npm test", description: "테스트 실행" }),
  done(
    "tu_5",
    "FAIL src/login.test.ts\n  ● Slack 연결 › 콜백이 state를 확인한다\n    expected 302, received 500",
    true,
  ),
  [
    "system",
    { engine_event: { name: "thinking_tokens", category: "thinking" } },
  ],
  call("tu_6", "Grep", { pattern: "verifyState" }),
  done("tu_6", "src/login.ts:42"),
  call("tu_7", "Edit", { file_path: "src/login.ts" }),
  done("tu_7", "The file src/login.ts has been updated."),
  call("tu_8", "Bash", {
    command: "npm test",
    description: "테스트 다시 실행",
  }),
  done("tu_8", "Tests: 48 passed, 48 total"),
  [
    "assistant",
    {
      text: "state 확인이 빠진 곳을 고쳐 테스트 48개가 모두 통과합니다. 브랜치를 올리려면 권한이 필요합니다.",
    },
  ],
  call("tu_9", "Bash", {
    command: "git push origin agent/deps-update",
    description: "브랜치 올리기",
  }),
  [
    "question",
    {
      request_id: "req_1",
      tool_use_id: "tu_9",
      kind: "permission",
      tool: "Bash",
      input: {
        command: "git push origin agent/deps-update",
        description: "브랜치 올리기",
      },
    },
  ],
  ["status", { phase: "needs_input" }],
];
const FOCUS_REQUESTS = {
  ...PENDING,
  items: [
    {
      ...PENDING.items[0],
      input: {
        command: "git push origin agent/deps-update",
        description: "브랜치 올리기",
      },
    },
  ],
};
const FOCUS_TURN: TurnSummary = {
  turn_id: "turn_1",
  session_id: SESSION.id,
  status: "needs_input",
  message:
    "의존성 업데이트가 테스트를 깨는지 확인하고, 릴리스 노트 초안을 out/release-notes.md에 써 주세요.",
  channel: "web",
  created_by: {
    user_id: "0192f0c4-7d3a-7b4e-9f00-00000000c001",
    display_name: "김민아",
  },
  slack_permalink: null,
  terminal_reason: null,
  checkpoint_revision: null,
  created_at: SESSION.created_at,
  started_at: SESSION.created_at,
  ended_at: null,
};
const focusRoutes = (): FakeRoutes => ({
  ...routes({
    detail: { ...TITLED, title: FOCUS_TITLE },
    requests: FOCUS_REQUESTS,
  }),
  [`GET ${base}/events`]: () => eventStreamOf(FOCUS_EVENTS, 1500),
  [`GET ${base}/turns`]: () =>
    json(200, { items: [FOCUS_TURN], next_cursor: null }),
});
// The view is remembered per browser; each story starts from focus.
const forgetView = () => {
  globalThis.localStorage?.removeItem("werft.session.timeline.view");
};
const showAll: Story["play"] = async ({ canvas, userEvent }) => {
  const view = await canvas.findByRole("group", { name: "타임라인 보기" });
  await userEvent.click(within(view).getByRole("button", { name: "전체" }));
  await expect(
    within(view).getByRole("button", { name: "전체" }),
  ).toHaveAttribute("aria-pressed", "true");
};

/** Focus, the default: four folded runs between what a person reads. */
export const TimelineFocus: Story = {
  name: "타임라인: 집중 보기",
  parameters: { api: focusRoutes() },
  beforeEach: forgetView,
  play: async ({ canvas }) => {
    const fold = await canvas.findByRole("button", {
      name: "실행한 명령 1개 · 읽은 파일 2개 · 쓴 파일 1개 · 이벤트 4개",
    });
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(await canvas.findByText("권한 요청")).toBeVisible();
  },
};

/** A fold opened: its calls and their long results, folded under each. */
export const TimelineFocusOpen: Story = {
  name: "타임라인: 집중 보기, 묶음 펼침",
  parameters: { api: focusRoutes() },
  beforeEach: forgetView,
  play: async ({ canvas, userEvent }) => {
    const fold = await canvas.findByRole("button", {
      name: /^실행한 명령 1개 · 읽은 파일 2개/,
    });
    await userEvent.click(fold);
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(
      await canvas.findByText("Write: out/release-notes.md"),
    ).toBeVisible();
  },
};

/** Every event open, internal ones included, as before focus. */
export const TimelineAll: Story = {
  name: "타임라인: 전체 보기",
  parameters: { api: focusRoutes() },
  beforeEach: forgetView,
  play: showAll,
};

export const TimelineFocusMobile: Story = {
  ...TimelineFocus,
  name: "타임라인: 집중 보기 (390px)",
  globals: MOBILE,
};

export const TimelineFocusDark: Story = {
  ...TimelineFocus,
  name: "타임라인: 집중 보기 (dark)",
  globals: { theme: "dark" },
};

export const TimelineAllMobileDark: Story = {
  ...TimelineAll,
  name: "타임라인: 전체 보기 (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};
