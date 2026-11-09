import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Card,
  CardContent,
  Page,
  SecretField,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * The one page frame (V4-PAGE-FRAME): lists, settings, forms and details
 * all grow to 1620px beside the sidebar, then centre; narrower, only the
 * gutters remain. The settings pages put their SideNav
 * beside the page only once both it and the sidebar leave the body room.
 */

const SETTINGS_PAGES = ["일반", "연동", "조직 관리 key", "멤버"];

function SettingsFrame() {
  return (
    <ScreenShell current="settings" crumb={["워크스페이스 설정", "일반"]}>
      <SideNavLayout
        nav={
          <SideNav aria-label="설정" current="일반">
            <SideNavGroup label="워크스페이스">
              {SETTINGS_PAGES.map((label, index) => (
                <SideNavLink key={label} href="#nav" current={index === 0}>
                  {label}
                </SideNavLink>
              ))}
            </SideNavGroup>
          </SideNav>
        }
      >
        <Page
          title="일반"
          description="워크스페이스 전체에 적용되는 설정입니다."
        >
          <Card>
            <CardContent className="flex flex-col gap-2 py-6">
              <p className="m-0 font-medium text-sm leading-snug">
                워크스페이스 ID
              </p>
              <SecretField
                className="max-w-105"
                value="ws_01JZ8K4M2Q7R9T3V5X6Y8A0B1C"
                copyLabel="복사"
                copiedMessage="워크스페이스 ID를 복사했습니다."
                copyFailedMessage="복사하지 못했습니다."
              />
            </CardContent>
          </Card>
        </Page>
      </SideNavLayout>
    </ScreenShell>
  );
}

function Frame({ kind }: { readonly kind: "list" | "settings" }) {
  return (
    <ScreenShell
      current={kind === "list" ? "home" : "settings"}
      crumb={[kind === "list" ? "홈" : "워크스페이스 설정"]}
    >
      <Page
        title={kind === "list" ? "목록 화면" : "설정 화면"}
        description={
          kind === "list"
            ? "모든 화면이 같은 틀에서 최대 1620px까지 넓어진 뒤 가운데에 놓입니다."
            : "설정 화면도 머리와 섹션이 같은 1620px 틀을 다 씁니다."
        }
        actions={
          kind === "list" ? (
            <Button type="button">
              <Plus aria-hidden="true" className="size-4" />
              새로 만들기
            </Button>
          ) : undefined
        }
      >
        <Card>
          <CardContent className="py-6 text-muted-foreground">
            {kind === "list"
              ? "콘텐츠 영역"
              : "카드는 틀 끝까지, 입력칸은 제 폭까지"}
          </CardContent>
        </Card>
      </Page>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/AppShell page frame (v4)",
  component: Frame,
  parameters: { layout: "fullscreen" },
  args: { kind: "list" },
  argTypes: {
    kind: { control: "inline-radio", options: ["list", "settings"] },
  },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = { name: "List" };
export const Settings: Story = { name: "Settings", args: { kind: "settings" } };
export const ListDark: Story = {
  name: "List (dark)",
  globals: { theme: "dark" },
};
export const Mobile: Story = { name: "List (390px)", globals: MOBILE };
export const SettingsSideNav: Story = {
  name: "Settings with side nav",
  render: () => <SettingsFrame />,
};
