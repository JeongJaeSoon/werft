import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@werft-ai/ui";

const meta = {
  title: "Primitives/Tabs",
  component: Tabs,
  args: { defaultValue: "overview" },
  argTypes: {
    orientation: { control: "select", options: ["horizontal", "vertical"] },
  },
  render: (args) => (
    <div className="flex flex-col gap-8">
      <Tabs {...args}>
        <TabsList>
          <TabsTrigger value="overview">개요</TabsTrigger>
          <TabsTrigger value="sessions">세션</TabsTrigger>
          <TabsTrigger value="settings" disabled={true}>
            설정
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">에이전트가 하는 일과 상태</TabsContent>
        <TabsContent value="sessions">최근 세션 목록</TabsContent>
        <TabsContent value="settings">설정</TabsContent>
      </Tabs>
      <Tabs {...args}>
        <TabsList variant="line">
          <TabsTrigger value="overview">개요</TabsTrigger>
          <TabsTrigger value="sessions">세션</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">밑줄 모양 탭</TabsContent>
        <TabsContent value="sessions">최근 세션 목록</TabsContent>
      </Tabs>
    </div>
  ),
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Both list variants; the third tab is disabled. */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultMobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

/**
 * Session detail tabs (v4 L597): a count after the label, 0 included. The
 * bottom rule is the screen's, on a wrapper that can hold controls beside the
 * tabs; the current tab's underline covers it.
 */
export const LineWithCounts: Story = {
  render: (args) => (
    <Tabs {...args} defaultValue="timeline">
      <div className="border-b">
        <TabsList variant="line" aria-label="세션 보기">
          <TabsTrigger value="timeline">타임라인</TabsTrigger>
          <TabsTrigger value="artifacts" count={4}>
            성과물
          </TabsTrigger>
          <TabsTrigger value="requests" count={0} countLabel="열린 요청 없음">
            요청
          </TabsTrigger>
          <TabsTrigger value="info">정보</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="timeline">이벤트 목록</TabsContent>
      <TabsContent value="artifacts">성과물 목록</TabsContent>
      <TabsContent value="requests">요청 목록</TabsContent>
      <TabsContent value="info">세션 정보</TabsContent>
    </Tabs>
  ),
};

export const LineWithCountsDark: Story = {
  ...LineWithCounts,
  name: "LineWithCounts (dark)",
  globals: { theme: "dark" },
};

export const LineWithCountsMobile: Story = {
  ...LineWithCounts,
  name: "LineWithCounts (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
