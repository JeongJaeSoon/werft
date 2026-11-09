import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { AgentSlackTab } from "./agent-slack-parts.tsx";
import { MOBILE } from "./screen-kit.tsx";

/*
 * apps/web routes/agent-detail/slack.tsx, drawn by agent-slack-parts.tsx.
 */

const meta = {
  title: "Screens/Agent Slack tab",
  component: AgentSlackTab,
  parameters: { layout: "fullscreen" },
  args: { state: "connected" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["connected", "pending", "none"],
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The workspace screen's sections, under its names and in its order.
    const shared = canvas
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent)
      .filter((title) =>
        [
          "Slack 앱 생성",
          "Slack 앱에 넣을 주소",
          "자동으로 만든 Slack 앱",
        ].includes(title ?? ""),
      );
    expect(shared).toEqual([
      "Slack 앱 생성",
      "Slack 앱에 넣을 주소",
      "자동으로 만든 Slack 앱",
    ]);
    if (args.state === "none")
      expect(
        canvas.getByRole("button", { name: "Slack 앱 만들고 설치" }),
      ).toBeTruthy();
  },
} satisfies Meta<typeof AgentSlackTab>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" };

export const SlackConnected: Story = { name: "연결됨" };
export const SlackConnectedDark: Story = {
  name: "연결됨 (dark)",
  globals: DARK,
};
export const SlackConnectedMobile: Story = {
  name: "연결됨 (390px)",
  globals: MOBILE,
};
export const SlackEventsPending: Story = {
  name: "Request URL 확인 전",
  args: { state: "pending" },
};
export const SlackEventsPendingMobile: Story = {
  ...SlackEventsPending,
  name: "Request URL 확인 전 (390px)",
  globals: MOBILE,
};
export const SlackNoApp: Story = {
  name: "앱 만들기 전",
  args: { state: "none" },
};
export const SlackNoAppMobile: Story = {
  ...SlackNoApp,
  name: "앱 만들기 전 (390px)",
  globals: MOBILE,
};
