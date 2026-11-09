import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  PageHeader,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
} from "@werft-ai/ui";
import { type MouseEvent, useState } from "react";
import { expect, userEvent, within } from "storybook/test";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    settings: "설정",
    workspace: "워크스페이스",
    mine: "내 설정",
    pages: ["일반", "연동", "조직 관리 key"],
    myPages: ["연동 계정", "API key", "언어·테마"],
    slack: "Slack",
    manage: "관리",
    sections: ["앱", "채널", "반응"],
    manageSections: ["고급", "위험"],
  },
  ja: {
    settings: "設定",
    workspace: "ワークスペース",
    mine: "自分の設定",
    pages: ["一般", "Slack 連携設定", "組織管理キー"],
    myPages: ["連携アカウント", "API キー", "言語・テーマ"],
    slack: "Slack",
    manage: "管理",
    sections: ["アプリ", "チャンネル", "反応"],
    manageSections: ["詳細", "危険"],
  },
  en: {
    settings: "Settings",
    workspace: "Workspace",
    mine: "My settings",
    pages: ["General", "Integrations", "Organization admin keys"],
    myPages: ["Linked accounts", "API keys", "Language & theme"],
    slack: "Slack",
    manage: "Manage",
    sections: ["App", "Channels", "Reactions"],
    manageSections: ["Advanced", "Danger zone"],
  },
} as const;

type Locale = keyof typeof COPY;
type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  const locale: Locale =
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko";
  return COPY[locale];
}

/*
 * The app decides which item is current from its route or its scroll; here a
 * click stands in for that so the story's own iframe URL is left alone.
 */
function useCurrent(initial: string) {
  const [current, setCurrent] = useState(initial);
  const select = (id: string) => (event: MouseEvent) => {
    event.preventDefault();
    setCurrent(id);
  };
  return [current, select] as const;
}

/** Settings pages: two groups, each item its own page. */
function Settings(context: Globals) {
  const copy = copyFor(context);
  const [current, select] = useCurrent("w1");
  const groups = [
    { id: "w", label: copy.workspace, items: copy.pages },
    { id: "m", label: copy.mine, items: copy.myPages },
  ];
  const label = groups
    .flatMap((group) =>
      group.items.map((item, index) => [`${group.id}${index}`, item] as const),
    )
    .find(([id]) => id === current)?.[1];
  return (
    <SideNavLayout
      nav={
        <SideNav aria-label={copy.settings} current={label}>
          {groups.map((group) => (
            <SideNavGroup key={group.id} label={group.label}>
              {group.items.map((item, index) => {
                const id = `${group.id}${index}`;
                return (
                  <SideNavLink
                    key={id}
                    href={`#${id}`}
                    current={current === id}
                    onClick={select(id)}
                  >
                    {item}
                  </SideNavLink>
                );
              })}
            </SideNavGroup>
          ))}
        </SideNav>
      }
    >
      <PageHeader title={label ?? ""} />
    </SideNavLayout>
  );
}

/** Sections of one long page: the item scrolled to is a location. */
function Sections(context: Globals) {
  const copy = copyFor(context);
  const [current, select] = useCurrent("s0");
  const link = (id: string, item: string) => (
    <SideNavLink
      key={id}
      href={`#${id}`}
      current={current === id ? "location" : false}
      onClick={select(id)}
    >
      {item}
    </SideNavLink>
  );
  const all = [
    ...copy.sections.map((item, index) => [`s${index}`, item] as const),
    ...copy.manageSections.map((item, index) => [`m${index}`, item] as const),
  ];
  return (
    <SideNavLayout
      nav={
        <SideNav
          aria-label={copy.slack}
          current={all.find(([id]) => id === current)?.[1]}
        >
          <SideNavGroup>
            {copy.sections.map((item, index) => link(`s${index}`, item))}
          </SideNavGroup>
          <SideNavGroup label={copy.manage}>
            {copy.manageSections.map((item, index) => link(`m${index}`, item))}
          </SideNavGroup>
        </SideNav>
      }
    >
      <PageHeader title={copy.slack} />
    </SideNavLayout>
  );
}

const meta = {
  title: "Patterns/SideNav",
  component: SideNav,
  args: { "aria-label": COPY.ko.settings, children: null },
  // Only the globals: the whole context would send the docs source snippet
  // into its circular references.
  render: (_args, { globals }) => <Settings globals={globals} />,
} satisfies Meta<typeof SideNav>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Follows the toolbar's Language; the stories below pin each one. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole("navigation", { name: "설정" });
    const link = within(nav).getByRole("link", { name: "조직 관리 key" });
    await userEvent.click(link);
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(
      within(nav)
        .getByRole("link", { name: "연동" })
        .getAttribute("aria-current"),
    ).toBeNull();
    // A group's heading must not read as one more link.
    const group = within(nav).getAllByRole("group")[0];
    const heading = canvasElement.ownerDocument.getElementById(
      group?.getAttribute("aria-labelledby") ?? "",
    );
    const other = within(nav).getByRole("link", { name: "연동" });
    expect(heading).not.toBeNull();
    expect(getComputedStyle(heading as Element).color).not.toBe(
      getComputedStyle(other).color,
    );
  },
};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultEnglish: Story = {
  name: "Default (en)",
  globals: { locale: "en" },
};

/** Below lg the list folds behind one button that names where you are. */
export const Mobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const MobileDark: Story = {
  name: "Default (390px, dark)",
  globals: {
    theme: "dark",
    viewport: { value: "mobile390", isRotated: false },
  },
};

/** One page's sections: `current="location"`, one group with a heading. */
export const PageSections: Story = {
  render: (_args, { globals }) => <Sections globals={globals} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole("navigation", { name: "Slack" });
    const link = within(nav).getByRole("link", { name: "위험" });
    await userEvent.click(link);
    expect(link.getAttribute("aria-current")).toBe("location");
    expect(within(nav).getAllByRole("group")).toHaveLength(2);
  },
};

export const PageSectionsDark: Story = {
  ...PageSections,
  name: "PageSections (dark)",
  globals: { theme: "dark" },
};
