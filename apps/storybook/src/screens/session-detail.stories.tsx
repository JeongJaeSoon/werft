import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionDetail } from "@werft-ai/react/blocks";
import { Button, EmptyState, Section, Text } from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
import { expect } from "storybook/test";
import { I18nProvider } from "../../../web/src/i18n/i18n.tsx";
import { SessionWorkspaceLimit } from "../../../web/src/routes/session-workspace-limit.tsx";

import { type FakeRoutes, json } from "../../.storybook/fake-client.ts";
import {
  accepted,
  base,
  DETAIL,
  eventStream,
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
 * from the top bar to the bottom of the screen; narrower, the rail follows
 * the body. What the API does not carry yet (agent, who started it, branch)
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
