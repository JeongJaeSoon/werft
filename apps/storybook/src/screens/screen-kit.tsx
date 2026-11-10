import {
  Avatar,
  Button,
  cn,
  DisabledReason,
  IconTile,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  PageFrame,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
  Text,
  type TileHue,
  type TileIcon,
} from "@werft-ai/ui";
import {
  Bell,
  Bot,
  ChevronDown,
  Gauge,
  Globe,
  House,
  KeyRound,
  Link as LinkIcon,
  List,
  LogOut,
  Monitor,
  Settings,
  Trophy,
  Users,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";

/*
 * Stand-in for apps/web's authed shell (routes/layout.tsx,
 * components/app-sidebar.tsx): the workspace line, the work and workspace
 * groups, the account menu with the personal settings, the top bar's trail
 * and, on a settings page, the settings nav beside the page
 * (components/settings-nav.tsx). Words are apps/web's Korean catalog; the
 * kit has no messages of its own.
 */

export type NavKey =
  | "home"
  | "sessions"
  | "agents"
  | "operations"
  | "achievements"
  | "members"
  | "settings";

export type Role = "owner" | "admin" | "member";

interface NavEntry {
  readonly key: NavKey;
  readonly label: string;
  readonly icon: TileIcon;
  readonly hue: TileHue;
}

const WORK_NAV: readonly NavEntry[] = [
  { key: "home", label: "홈", icon: House, hue: "blue" },
  { key: "sessions", label: "세션", icon: List, hue: "violet" },
  { key: "agents", label: "에이전트", icon: Bot, hue: "orange" },
];
const WORKSPACE_NAV: readonly NavEntry[] = [
  { key: "operations", label: "사용량·한도", icon: Gauge, hue: "pink" },
  { key: "achievements", label: "성과", icon: Trophy, hue: "sky" },
  { key: "members", label: "구성원", icon: Users, hue: "green" },
  { key: "settings", label: "설정", icon: Settings, hue: "slate" },
];

/** The signed-in person every screen story shares, as `/v1/auth/me` names them. */
export const VIEWER = {
  id: "0b5f8a52-6f0e-4b1a-9d0e-2c1e7c3f4a11",
  name: "Verify Viewer",
  email: "viewer@example.test",
} as const;

const ROLE_LABEL: Record<Role, string> = {
  owner: "소유자",
  admin: "관리자",
  member: "구성원",
};

// Members and settings are the managers' (useNavGroups).
function workspaceNav(role: Role) {
  return role === "member"
    ? WORKSPACE_NAV.filter(
        (entry) => entry.key !== "members" && entry.key !== "settings",
      )
    : WORKSPACE_NAV;
}

function NavLink({
  entry,
  current,
}: {
  readonly entry: NavEntry;
  readonly current: boolean;
}) {
  return (
    <a
      href="#nav"
      aria-current={current ? "page" : undefined}
      className="flex h-8 items-center gap-2 rounded-control px-2 font-medium text-control text-foreground no-underline hover:bg-sidebar-hover aria-[current=page]:bg-sidebar-accent"
    >
      <IconTile icon={entry.icon} hue={entry.hue} />
      <Text as="span" truncate className="min-w-0 flex-1">
        {entry.label}
      </Text>
    </a>
  );
}

function NavGroup({
  label,
  entries,
  current,
  headingHidden = false,
}: {
  readonly label: string;
  readonly entries: readonly NavEntry[];
  readonly current: NavKey;
  readonly headingHidden?: boolean;
}) {
  const itemsId = useId();
  const [open, setOpen] = useState(true);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, these are links
    <div role="group" aria-label={label} className="flex flex-col">
      {headingHidden ? null : (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={itemsId}
          onClick={() => setOpen((value) => !value)}
          className="mt-2 mb-0.5 flex h-6 w-fit items-center gap-1 rounded-control px-2 text-caption text-subtle-foreground hover:text-foreground"
        >
          {label}
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 shrink-0", !open && "-rotate-90")}
          />
        </button>
      )}
      <div id={itemsId} hidden={!open} className={open ? "flex flex-col" : ""}>
        {entries.map((entry) => (
          <NavLink
            key={entry.key}
            entry={entry}
            current={current === entry.key}
          />
        ))}
      </div>
    </div>
  );
}

const MENU_ITEM =
  "flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-control text-popover-foreground no-underline hover:bg-muted";
const MENU_ICON = "size-4 shrink-0 text-muted-foreground";

/** The account pill and its menu: the personal settings live here. */
function UserBar({ role }: { readonly role: Role }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t pt-2">
      <Popover>
        <PopoverTrigger asChild>
          {/* No aria-label: the name begins with the visible text (WCAG 2.5.3). */}
          <button
            type="button"
            className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full px-2 py-1 text-left hover:bg-sidebar-hover aria-expanded:bg-sidebar-accent"
          >
            <Avatar
              initials={VIEWER.name.charAt(0)}
              className="bg-sidebar-accent text-foreground"
            />
            <Text as="span" className="flex min-w-0 flex-col">
              <Text as="span" weight="medium" truncate>
                {VIEWER.name}
              </Text>{" "}
              <Text as="span" variant="meta" truncate>
                {VIEWER.email}
              </Text>
            </Text>
            <Text as="span" className="sr-only">
              {" "}
              · {ROLE_LABEL[role]}
            </Text>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1">
          <a href="#nav" className={MENU_ITEM}>
            <LinkIcon aria-hidden="true" className={MENU_ICON} />
            연동 계정
          </a>
          <button type="button" className={MENU_ITEM}>
            <Globe aria-hidden="true" className={MENU_ICON} />
            언어
            <Text as="span" variant="meta" className="ml-auto">
              한국어
            </Text>
          </button>
          <button type="button" className={MENU_ITEM}>
            <Monitor aria-hidden="true" className={MENU_ICON} />
            테마
            <Text as="span" variant="meta" className="ml-auto">
              시스템 설정
            </Text>
          </button>
          <a href="#nav" className={MENU_ITEM}>
            <KeyRound aria-hidden="true" className={MENU_ICON} />
            API 키
          </a>
          <hr className="-mx-1 my-1 border-0 border-t" />
          <button type="button" className={MENU_ITEM}>
            <LogOut aria-hidden="true" className={MENU_ICON} />
            로그아웃
          </button>
        </PopoverContent>
      </Popover>
      <a
        href="#nav"
        aria-label="답변 대기 없음"
        className="grid size-8 shrink-0 place-items-center rounded-control text-muted-foreground hover:bg-sidebar-hover"
      >
        <Bell aria-hidden="true" className="size-4" />
      </a>
    </div>
  );
}

export type SettingsKey =
  | "general"
  | "slack"
  | "workspaceApiKeys"
  | "linkedAccounts"
  | "apiKeys"
  | "preferences";

const SETTINGS_LABEL: Record<SettingsKey, string> = {
  general: "일반",
  slack: "연동",
  workspaceApiKeys: "조직 관리 키",
  linkedAccounts: "연동 계정",
  apiKeys: "API 키",
  preferences: "언어·테마",
};
const WORKSPACE_SETTINGS: readonly SettingsKey[] = [
  "general",
  "slack",
  "workspaceApiKeys",
];
const PERSONAL_SETTINGS: readonly SettingsKey[] = [
  "linkedAccounts",
  "apiKeys",
  "preferences",
];

/** components/settings-nav.tsx: the settings nav beside a settings page. */
function SettingsLayout({
  current,
  role,
  children,
}: {
  readonly current: SettingsKey;
  readonly role: Role;
  readonly children: ReactNode;
}) {
  const groups = settingsGroups(role);
  const listed = settingsListed(role, current);
  return (
    <SideNavLayout
      nav={
        <SideNav
          aria-label="설정"
          current={listed ? SETTINGS_LABEL[current] : undefined}
        >
          {groups
            .filter(([, keys]) => keys.length > 0)
            .map(([label, keys]) => (
              <SideNavGroup key={label} label={label}>
                {keys.map((key) => (
                  <SideNavLink key={key} href="#nav" current={key === current}>
                    {SETTINGS_LABEL[key]}
                  </SideNavLink>
                ))}
              </SideNavGroup>
            ))}
        </SideNav>
      }
    >
      {children}
    </SideNavLayout>
  );
}

function settingsGroups(
  role: Role,
): readonly (readonly [string, readonly SettingsKey[]])[] {
  return [
    ["워크스페이스", role === "member" ? [] : WORKSPACE_SETTINGS],
    ["내 설정", PERSONAL_SETTINGS],
  ];
}

// A page the reader has no settings item for (a member on 일반) marks none
// in the settings nav, and the top bar falls back to the sidebar's 설정.
function settingsListed(role: Role, key: SettingsKey) {
  return settingsGroups(role).some(([, keys]) => keys.includes(key));
}

/**
 * The top bar's trail (layout.tsx): a screen under a sidebar item leads with
 * the item as a link back to its list.
 */
function Trail({ crumb }: { readonly crumb: readonly string[] }) {
  const leaf = crumb.at(-1) ?? "";
  const parents = crumb.slice(0, -1);
  return (
    <PageBreadcrumb label="메뉴 위치">
      {parents.map((label) => (
        <PageBreadcrumbLink key={label} href="#nav">
          {label}
        </PageBreadcrumbLink>
      ))}
      <PageBreadcrumbCurrent className="wrap-anywhere">
        {leaf}
      </PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );
}

/**
 * Every screen sits in the console's `PageFrame` (V4-PAGE-FRAME) except a
 * session's detail, which lays out its rail and body itself: `flush`. A
 * settings page names its item in `settings` and gets the settings nav.
 */
export function ScreenShell({
  current,
  crumb,
  role = "owner",
  flush = false,
  settings,
  children,
}: {
  readonly current: NavKey;
  readonly crumb: readonly string[];
  readonly role?: Role;
  readonly flush?: boolean;
  readonly settings?: SettingsKey | undefined;
  readonly children: ReactNode;
}) {
  const sidebarId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    // apps/web styles.css breaks Korean between words on the body.
    <div className="flex min-h-screen flex-col break-keep text-body wrap-break-word md:grid md:grid-cols-[var(--werft-layout-sidebar-width)_minmax(0,1fr)] md:grid-rows-[auto_1fr]">
      <header className="flex min-h-[var(--werft-topbar-h)] items-center gap-3 border-b bg-surface px-4 md:col-start-2 md:row-start-1 md:px-6">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="md:hidden"
          aria-expanded={menuOpen}
          aria-controls={sidebarId}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? "메뉴 닫기" : "메뉴 열기"}
        </Button>
        <Trail
          crumb={
            settings !== undefined && !settingsListed(role, settings)
              ? ["설정"]
              : crumb
          }
        />
      </header>
      <div
        id={sidebarId}
        data-open={menuOpen}
        className="hidden max-h-[calc(100dvh-var(--werft-topbar-h))] flex-col gap-2 border-b bg-sidebar px-2 py-3 text-foreground data-[open=true]:flex md:sticky md:top-0 md:col-start-1 md:row-span-2 md:row-start-1 md:flex md:h-dvh md:max-h-none md:border-r md:border-b-0 md:pt-0"
      >
        <div className="-mx-2 hidden h-[var(--werft-topbar-h)] shrink-0 items-center gap-2 border-b px-4 md:flex">
          <Avatar
            initials="A"
            shape="square"
            className="bg-primary text-primary-foreground"
          />
          <Text truncate>
            <Text as="span" className="sr-only">
              워크스페이스:{" "}
            </Text>
            <Text as="span" weight="medium" className="font-semibold">
              Acme
            </Text>
            <Text as="span" variant="sub">
              {" · "}Werft
            </Text>
          </Text>
        </div>
        <nav
          aria-label="주요 메뉴"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
        >
          <NavGroup
            label="업무"
            entries={WORK_NAV}
            current={current}
            headingHidden
          />
          <NavGroup
            label="워크스페이스"
            entries={workspaceNav(role)}
            current={current}
          />
        </nav>
        <UserBar role={role} />
      </div>
      {flush ? (
        <main className="flex w-full min-w-0 flex-1 flex-col bg-surface md:col-start-2 md:row-start-2">
          <div
            data-slot="page-flush"
            className="flex w-full min-w-0 flex-1 flex-col"
          >
            {children}
          </div>
        </main>
      ) : (
        <main className="flex w-full min-w-0 flex-1 flex-col bg-surface md:col-start-2 md:row-start-2">
          <PageFrame className="flex-1">
            {settings === undefined ? (
              children
            ) : (
              <SettingsLayout current={settings} role={role}>
                {children}
              </SettingsLayout>
            )}
          </PageFrame>
        </main>
      )}
    </div>
  );
}

/**
 * A withheld action: the disabled button stays in line with its row and says
 * why on hover or focus, above it, as the members table does.
 */
export function LockedButton({
  label,
  reason,
  size = "sm",
}: {
  readonly label: string;
  readonly reason: string;
  readonly size?: "sm" | "default";
}) {
  return (
    <DisabledReason reason={reason} label={label}>
      <Button type="button" variant="outline" size={size} disabled={true}>
        {label}
      </Button>
    </DisabledReason>
  );
}

export const MOBILE = { viewport: { value: "mobile390", isRotated: false } };
