import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionDetail } from "@werft-ai/react/blocks";
import { Button, EmptyState, Section, Text } from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
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
