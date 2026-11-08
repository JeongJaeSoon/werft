import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Heading,
  RowAction,
  RowList,
  SettingRow,
  Switch,
  Text,
} from "@werft-ai/ui";
import { expect, within } from "storybook/test";

import { MOBILE } from "./screen-kit.tsx";

/*
 * apps/web routes/agent-detail/slack/channels.tsx: the connected-channel list
 * and the add-channel picker rows. The public/private tag sits in the row's
 * right column, on the name's line, in both.
 */

type Visibility = "public" | "private";
type Channel = { readonly name: string; readonly visibility: Visibility };

const CHANNELS: readonly Channel[] = [
  { name: "release-notes", visibility: "public" },
  { name: "incident-room", visibility: "private" },
  // Slack allows 80 characters and no break point inside a name.
  {
    name: "platform-quarterly-review-and-release-planning-for-the-whole-team",
    visibility: "public",
  },
];

const LABEL: Record<Visibility, string> = {
  public: "공개",
  private: "비공개",
};

function Tag({ visibility }: { readonly visibility: Visibility }) {
  return (
    <Badge variant={visibility === "private" ? "gray" : "green"}>
      {LABEL[visibility]}
    </Badge>
  );
}

// Mirrors channels.tsx: a name with no break point must wrap, not run under the tag.
function ChannelName({ name }: { readonly name: string }) {
  return (
    <Text as="span" className="[overflow-wrap:anywhere]">
      {`#${name}`}
    </Text>
  );
}

function SlackChannels() {
  return (
    <div className="flex flex-col gap-8 p-4">
      <section className="flex flex-col gap-[var(--werft-space-block)]">
        <Heading level={2}>연결된 채널</Heading>
        <RowList variant="joined" aria-label="연결된 채널">
          {CHANNELS.map((channel) => (
            <SettingRow
              key={channel.name}
              title={<ChannelName name={channel.name} />}
              actions={
                <div className="flex items-center gap-2">
                  <Tag visibility={channel.visibility} />
                  <Text as="span" aria-hidden="true">
                    사용 중
                  </Text>
                  <Switch
                    aria-label={`#${channel.name} 사용 중`}
                    checked
                    onCheckedChange={() => {}}
                  />
                </div>
              }
            />
          ))}
        </RowList>
      </section>
      <section className="flex flex-col gap-[var(--werft-space-block)]">
        <Heading level={2}>채널 추가</Heading>
        <RowList variant="joined" aria-label="추가할 채널">
          {CHANNELS.map((channel) => (
            <SettingRow
              key={channel.name}
              title={<ChannelName name={channel.name} />}
              actions={
                <div className="flex items-center gap-2">
                  <Tag visibility={channel.visibility} />
                  <RowAction aria-label={`#${channel.name} 연결`}>
                    연결
                  </RowAction>
                </div>
              }
            />
          ))}
        </RowList>
      </section>
    </div>
  );
}

const meta = {
  title: "Screens/Slack channels",
  component: SlackChannels,
  parameters: { layout: "fullscreen" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Each tag is text in the same row as its control.
    for (const list of ["연결된 채널", "추가할 채널"]) {
      const rows = within(canvas.getByRole("list", { name: list }));
      expect(rows.getByText("공개")).toBeDefined();
      expect(rows.getByText("비공개")).toBeDefined();
    }
  },
} satisfies Meta<typeof SlackChannels>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SlackChannelTags: Story = { name: "공개·비공개 태그" };
export const SlackChannelTagsDark: Story = {
  name: "공개·비공개 태그 (dark)",
  globals: { theme: "dark" },
};
export const SlackChannelTagsMobile: Story = {
  name: "공개·비공개 태그 (390px)",
  globals: MOBILE,
};
