import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, Button, Heading, Skeleton, Text } from "@werft-ai/ui";
import { expect, userEvent, within } from "storybook/test";

import {
  AgentNotFound,
  AgentOverview,
  AgentPage,
  type AgentTab,
  CardSummary,
  DRAFT,
  LoadFailure,
  RELEASED,
  SESSIONS,
  type SessionFixture,
  VersionHistory,
  type Viewer,
} from "./agent-detail-parts.tsx";
import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * apps/web routes/agent-detail.tsx: the overview and card tabs, the Slack
 * tab before an app exists, and the page's loading, failure and not-found
 * states. The GitHub tab is agent-github.stories.tsx.
 */

type ScreenState = "released" | "draft" | "loading" | "error" | "not-found";
const SLACK_SECTION = "slack-advanced";
const SLACK_TITLE = `${SLACK_SECTION}-title`;

type ShownTab = Extract<AgentTab, "overview" | "card" | "slack">;

function SlackNotConnected({ active }: { readonly active: boolean }) {
  return (
    <div className="flex flex-col gap-8">
      <section
        id={SLACK_SECTION}
        tabIndex={-1}
        className="flex scroll-mt-4 flex-col gap-[var(--werft-space-block)] outline-none"
        aria-labelledby={SLACK_TITLE}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Heading id={SLACK_TITLE}>Slack 앱</Heading>
          <Badge variant="gray">만들기 전</Badge>
        </div>
        <output tabIndex={-1} aria-live="polite" className="sr-only" />
        {active ? null : (
          <Text variant="sub">
            에이전트를 먼저 켠 뒤 Slack 앱을 만들 수 있습니다.
          </Text>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!active}>
            Slack 앱 만들고 설치
          </Button>
          <Button type="button" variant="outline">
            새로고침
          </Button>
        </div>
      </section>
    </div>
  );
}

function AgentDetailScreen({
  state,
  tab,
  viewer,
  bound,
  sessions,
}: {
  readonly state: ScreenState;
  readonly tab: ShownTab;
  readonly viewer: Viewer;
  readonly bound: readonly string[] | "unknown";
  readonly sessions: readonly SessionFixture[] | "loading" | "error";
}) {
  const detail = state === "draft" ? DRAFT : RELEASED;
  return (
    <ScreenShell
      current="agents"
      // The layout's leaf title waits for the agent; no data, no leaf.
      crumb={
        state === "released" || state === "draft"
          ? ["에이전트", detail.agent.name]
          : ["에이전트"]
      }
      role={viewer}
    >
      {state === "loading" ? (
        <Skeleton lines={3} label="불러오는 중입니다" />
      ) : state === "error" ? (
        <LoadFailure />
      ) : state === "not-found" ? (
        <AgentNotFound />
      ) : (
        <AgentPage detail={detail} tab={tab}>
          {tab === "overview" ? (
            <AgentOverview
              detail={detail}
              viewer={viewer}
              bound={bound}
              sessions={sessions}
            />
          ) : tab === "card" ? (
            <>
              <CardSummary detail={detail} />
              <VersionHistory detail={detail} />
            </>
          ) : (
            <SlackNotConnected
              active={detail.agent.active_release_id !== null}
            />
          )}
        </AgentPage>
      )}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Agent detail (v4)",
  component: AgentDetailScreen,
  parameters: { layout: "fullscreen" },
  args: {
    state: "released",
    tab: "overview",
    viewer: "owner",
    bound: ["BILLING_DB"],
    sessions: SESSIONS,
  },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["released", "draft", "loading", "error", "not-found"],
    },
    tab: { control: "inline-radio", options: ["overview", "card", "slack"] },
    viewer: { control: "inline-radio", options: ["owner", "admin", "member"] },
  },
} satisfies Meta<typeof AgentDetailScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentDetail: Story = {
  name: "Overview (owner, released)",
  play: async ({ canvas }) => {
    const tabs = canvas.getAllByRole("tab");
    await expect(tabs.map((tab) => tab.textContent)).toEqual([
      "개요",
      "상세 설정",
      "릴리스",
      "접근",
      "관리자",
      "Slack",
      "GitHub",
    ]);
    const start = canvas.getByRole("button", { name: "이 에이전트로 새 세션" });
    await expect(start).not.toHaveAttribute("aria-disabled");
  },
};
export const NewSessionDialog: Story = {
  name: "New session dialog",
  play: async ({ canvas }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "이 에이전트로 새 세션" }),
    );
    const dialog = within(document.body).getByRole("dialog");
    await expect(within(dialog).getByLabelText("첫 메시지")).toBeVisible();
    await expect(
      within(dialog).getByRole("button", { name: "세션 시작" }),
    ).toBeVisible();
  },
};
export const AgentDetailMemberDraft: Story = {
  name: "Overview (member, not released)",
  // A member lacks credential.bind, so the bindings read answers 403.
  args: { state: "draft", viewer: "member", bound: "unknown", sessions: [] },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("button", { name: "이 에이전트로 새 세션" }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
      canvas.getByText(
        "활성 릴리스가 없어 세션을 시작할 수 없습니다. 릴리스를 활성화하면 시작할 수 있습니다.",
        { ignore: "[hidden]" },
      ),
    ).toBeVisible();
    await expect(
      canvas.getByText("연결 상태를 불러오지 못했습니다."),
    ).toBeVisible();
    const credentials = canvas
      .getByText("자격 증명 연결")
      .closest("li") as HTMLElement;
    await expect(credentials).toHaveAttribute("data-state", "unknown");
    const release = canvas
      .getByText("릴리스 만들기")
      .closest("li") as HTMLElement;
    await expect(release).toContainElement(
      canvas.getByRole("button", { name: "릴리스 탭으로" }),
    );
  },
};
export const AgentDetailAdminDraft: Story = {
  name: "Overview (admin, not released)",
  args: { state: "draft", viewer: "admin", bound: [], sessions: [] },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("연결이 필요합니다: BILLING_DB"),
    ).toBeVisible();
    const credentials = canvas
      .getByText("자격 증명 연결")
      .closest("li") as HTMLElement;
    await expect(credentials).toContainElement(
      canvas.getByRole("button", { name: "릴리스 탭으로" }),
    );
  },
};
export const AgentDetailAdmin: Story = {
  name: "Overview (admin)",
  args: { viewer: "admin" },
};
export const AgentDetailSessionsLoading: Story = {
  name: "Overview (sessions loading)",
  args: { sessions: "loading" },
};
export const AgentDetailSessionsError: Story = {
  name: "Overview (sessions failed)",
  args: { sessions: "error" },
};
export const AgentDetailCard: Story = {
  name: "Card tab",
  args: { tab: "card" },
};
export const AgentDetailCardDraft: Story = {
  name: "Card tab (not released)",
  args: { tab: "card", state: "draft" },
};
export const AgentDetailSlack: Story = {
  name: "Slack tab (no app yet)",
  args: { tab: "slack" },
};
export const AgentDetailSlackInactive: Story = {
  name: "Slack tab (not released)",
  args: { tab: "slack", state: "draft" },
};
export const AgentDetailLoading: Story = { args: { state: "loading" } };
export const AgentDetailError: Story = { args: { state: "error" } };
export const AgentDetailNotFound: Story = { args: { state: "not-found" } };
export const AgentDetailDark: Story = {
  name: "Overview (dark)",
  globals: { theme: "dark" },
};
export const AgentDetailMobile: Story = {
  name: "Overview (390px)",
  globals: MOBILE,
};
export const AgentDetailCardMobileDark: Story = {
  name: "Card tab (390px, dark)",
  args: { tab: "card" },
  globals: { ...MOBILE, theme: "dark" },
};
