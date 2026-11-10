import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, EmptyState } from "@werft-ai/ui";
import { Inbox } from "lucide-react";

const meta = {
  title: "Patterns/EmptyState",
  component: EmptyState,
  args: {
    title: "아직 세션이 없습니다",
    description: "에이전트에게 첫 지시를 보내면 여기에 쌓입니다.",
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const TitleOnly: Story = { args: { description: undefined } };

export const WithActions: Story = {
  args: {
    action: <Button type="button">새 세션</Button>,
    secondaryAction: (
      <Button type="button" variant="ghost">
        에이전트 보기
      </Button>
    ),
  },
};

export const WithActionsDark: Story = {
  ...WithActions,
  name: "With actions (dark)",
  globals: { theme: "dark" },
};

/** Console v4 `.empty-ic`: a 40px quiet box above the title. */
export const WithIcon: Story = {
  args: {
    icon: <Inbox size={16} strokeWidth={1.5} />,
    action: (
      <Button type="button" size="sm">
        새 세션
      </Button>
    ),
  },
};

/**
 * `framed` + `size="sm"`: an empty list standing in a card's or a framed
 * table's place, as the home's waiting list and the settings tables.
 */
export const SmallFramed: Story = {
  args: {
    icon: <Inbox size={16} strokeWidth={1.5} />,
    size: "sm",
    framed: true,
  },
};

export const SmallFramedDark: Story = {
  ...SmallFramed,
  name: "Small framed (dark)",
  globals: { theme: "dark" },
};

export const SmallFramedMobile: Story = {
  ...SmallFramed,
  name: "Small framed (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const FramedEnglish: Story = {
  name: "Framed (en)",
  args: {
    framed: true,
    size: "sm",
    title: "No sessions yet",
    description: "Send an agent its first instruction and it shows up here.",
  },
  globals: { locale: "en" },
};

export const FramedJapanese: Story = {
  name: "Framed (日本語)",
  args: {
    framed: true,
    size: "sm",
    title: "まだセッションがありません",
    description: "エージェントに最初の指示を送るとここに表示されます。",
  },
  globals: { locale: "ja" },
};

export const FramedJapaneseDark: Story = {
  ...FramedJapanese,
  name: "Framed (日本語, dark)",
  globals: { locale: "ja", theme: "dark" },
};
