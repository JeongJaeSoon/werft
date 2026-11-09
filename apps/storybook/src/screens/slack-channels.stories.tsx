import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
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
 * apps/web routes/agent-detail/slack/channels.tsx: the connected-channel
 * table and the add-channel picker rows. In the table the public/private tag
 * sits on the name's line; in the picker, beside the row's action.
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
        <GridTable
          aria-label="연결된 채널"
          columns="minmax(0,1fr) 136px"
          framed
        >
          <GridTableHeader>
            <GridTableColumnHeader>채널</GridTableColumnHeader>
            <GridTableColumnHeader align="end">사용</GridTableColumnHeader>
          </GridTableHeader>
          {CHANNELS.map((channel) => (
            <GridTableRow key={channel.name}>
              <GridTableCell className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ChannelName name={channel.name} />
                  <Tag visibility={channel.visibility} />
                </div>
              </GridTableCell>
              <GridTableCell align="end">
                <Switch
                  aria-label={`#${channel.name}에서 사용`}
                  checked
                  onCheckedChange={() => {}}
                />
              </GridTableCell>
            </GridTableRow>
          ))}
        </GridTable>
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
    for (const [role, name] of [
      ["table", "연결된 채널"],
      ["list", "추가할 채널"],
    ] as const) {
      const rows = within(canvas.getByRole(role, { name }));
      expect(rows.getAllByText("공개")).toHaveLength(2);
      expect(rows.getAllByText("비공개")).toHaveLength(1);
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
