import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  Invite as InviteRow,
  MemberView,
  TeamDetail as TeamDetailView,
} from "@werft-ai/contracts";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
  apiError,
  json,
  me,
  memberMe,
  memberPage,
  USER_ID,
  WORKSPACE_ID,
} from "../../../web/src/test-support/fake-api.ts";
import { pending } from "../blocks/block-fixtures.tsx";
import { MOBILE } from "./screen-kit.tsx";
import { type ConsoleRoutes, storyLocale, WebConsole } from "./web-console.tsx";

/*
 * The 구성원 area as apps/web ships it: the console itself, opened at each
 * tab's address against fake answers (web-console.tsx), so a story can never
 * drift from the screen. Each screen has its filled state in ko, en and ja,
 * light and dark, desktop and 390px, then its empty, loading and failed
 * states, and the failed refresh that keeps what was read last.
 */

const AT = "2026-10-11T00:00:00.000Z";
const TEAM_ID = "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";

function person(
  n: number,
  name: string,
  overrides: Partial<MemberView> = {},
): MemberView {
  return {
    user_id: `2c7e1d4a-5b6f-4a8e-9d0c-1e2f3a4b5c${String(n).padStart(2, "0")}`,
    email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
    display_name: name,
    role: "member",
    disabled_at: null,
    created_at: AT,
    ...overrides,
  };
}

const OWNER: MemberView = {
  user_id: USER_ID,
  email: "owner@example.com",
  display_name: "Owner",
  role: "owner",
  disabled_at: null,
  created_at: AT,
};
const PEOPLE: readonly MemberView[] = [
  OWNER,
  person(1, "Ada Admin", { role: "admin" }),
  person(2, "Mate"),
  person(3, "Kim Jiwoo"),
  // A long name and address: they wrap or clip, never push the page wide.
  person(4, "Maximiliane Konstantinopoulou-Wertheimer", {
    email: "maximiliane.konstantinopoulou-wertheimer@very-long-domain.example",
  }),
  person(5, "Gone", { disabled_at: "2026-10-05T00:00:00.000Z" }),
];

function team(name: string, members: readonly MemberView[]): TeamDetailView {
  return {
    id: TEAM_ID,
    workspace_id: WORKSPACE_ID,
    name,
    member_count: members.length,
    created_by: USER_ID,
    created_at: AT,
    revision: 1,
    members: members.map((m, index) => ({
      user_id: m.user_id,
      email: m.email,
      display_name: m.display_name,
      role: index === 0 ? "lead" : "member",
      added_by: USER_ID,
      added_at: AT,
      disabled_at: m.disabled_at,
    })),
  };
}

const PAYMENTS = team("결제팀", PEOPLE.slice(1));
const TEAMS = [
  PAYMENTS,
  team("운영팀", PEOPLE.slice(2, 4)),
  team("데이터 플랫폼 팀", PEOPLE.slice(1, 3)),
];
const view = ({ members: _members, ...rest }: TeamDetailView) => rest;

const invite = (n: number, email: string, status: InviteRow["status"]) =>
  ({
    id: `9e8d7c6b-5a49-4382-9170-6f5e4d3c2b${String(n).padStart(2, "0")}`,
    workspace_id: WORKSPACE_ID,
    email,
    role: n === 1 ? "admin" : "member",
    invited_by: USER_ID,
    status,
    expires_at: "2026-10-18T00:00:00.000Z",
    accepted_at: null,
    revoked_at: null,
    created_at: AT,
  }) as InviteRow;
const INVITES = [
  invite(1, "lead@example.com", "pending"),
  invite(2, "late@example.com", "pending"),
  invite(3, "old@example.com", "expired"),
];

const failed = () =>
  apiError(500, "INTERNAL_ERROR", "Storybook: the read failed");

/** The members read: searched by `q`, or the rows of `user_ids`. */
function members(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const q = params.get("q")?.toLowerCase();
  const ids = params.get("user_ids")?.split(",");
  const items = PEOPLE.filter(
    (m) =>
      (!q || `${m.display_name} ${m.email}`.toLowerCase().includes(q)) &&
      (!ids || ids.includes(m.user_id)),
  );
  return json(200, memberPage({ items, next_cursor: null }));
}

const FILLED: ConsoleRoutes = {
  "GET /v1/auth/me": () => json(200, me()),
  "GET /v1/members": members,
  "GET /v1/invites": () => json(200, { items: INVITES }),
  "GET /v1/teams": () =>
    json(200, { items: TEAMS.map(view), next_cursor: null }),
  [`GET /v1/teams/${TEAM_ID}`]: () => json(200, PAYMENTS),
  "GET /v1/my-teams": () =>
    json(200, {
      items: [{ ...view(PAYMENTS), role: "member" }],
      next_cursor: null,
    }),
};

/** Answers the first read and fails every one after it. */
function failsAfterFirst(answer: () => Response): () => Response {
  let reads = 0;
  return () => (reads++ === 0 ? answer() : failed());
}

type Args = {
  readonly path: string;
  readonly routes: ConsoleRoutes | (() => ConsoleRoutes);
  readonly refresh?: boolean;
};

function Console({ path, routes, refresh = false }: Args, locale: unknown) {
  return (
    <WebConsole
      // A new language is a new console, as a reload would be.
      key={String(locale)}
      path={path}
      routes={routes}
      locale={storyLocale(locale)}
      refresh={refresh}
    />
  );
}

const meta = {
  title: "Screens/Members",
  parameters: { layout: "fullscreen" },
  args: { path: "/members", routes: FILLED },
  render: (args, { globals }) => Console(args, globals.locale),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const EN = { locale: "en" };
const JA = { locale: "ja" };
const DARK = { theme: "dark" };

/** One screen's filled state in each language, theme and width. */
function variants(args: Args) {
  return {
    Ko: { args } as Story,
    En: { args, globals: EN } as Story,
    Ja: { args, globals: JA } as Story,
    Dark: { args, globals: DARK } as Story,
    EnDark: { args, globals: { ...EN, ...DARK } } as Story,
    JaDark: { args, globals: { ...JA, ...DARK } } as Story,
    Mobile: { args, globals: MOBILE } as Story,
    MobileDark: { args, globals: { ...MOBILE, ...DARK } } as Story,
  };
}

// 구성원 tab
const members$ = variants({ path: "/members", routes: FILLED });
export const Members = members$.Ko;
export const MembersEn = members$.En;
export const MembersJa = members$.Ja;
export const MembersDark = members$.Dark;
export const MembersEnDark = members$.EnDark;
export const MembersJaDark = members$.JaDark;
export const MembersMobile = members$.Mobile;
export const MembersMobileDark = members$.MobileDark;
export const MembersLoading: Story = {
  args: { path: "/members", routes: { ...FILLED, "GET /v1/members": pending } },
};
export const MembersEmpty: Story = {
  args: {
    path: "/members",
    routes: {
      ...FILLED,
      "GET /v1/members": () =>
        json(200, memberPage({ items: [], next_cursor: null })),
    },
  },
};
export const MembersError: Story = {
  args: { path: "/members", routes: { ...FILLED, "GET /v1/members": failed } },
};
export const MembersErrorDark: Story = { ...MembersError, globals: DARK };
export const MembersNoMatch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole("searchbox"), "nobody");
    await expect(
      await canvas.findByRole("button", { name: "검색어 지우기" }),
    ).toBeVisible();
  },
};

// 팀 tab
const teams$ = variants({ path: "/members/teams", routes: FILLED });
export const Teams = teams$.Ko;
export const TeamsEn = teams$.En;
export const TeamsJa = teams$.Ja;
export const TeamsDark = teams$.Dark;
export const TeamsEnDark = teams$.EnDark;
export const TeamsJaDark = teams$.JaDark;
export const TeamsMobile = teams$.Mobile;
export const TeamsMobileDark = teams$.MobileDark;
export const TeamsLoading: Story = {
  args: {
    path: "/members/teams",
    routes: { ...FILLED, "GET /v1/teams": pending },
  },
};
export const TeamsEmpty: Story = {
  args: {
    path: "/members/teams",
    routes: {
      ...FILLED,
      "GET /v1/teams": () => json(200, { items: [], next_cursor: null }),
    },
  },
};
export const TeamsError: Story = {
  args: {
    path: "/members/teams",
    routes: { ...FILLED, "GET /v1/teams": failed },
  },
};
/** A member sees only the teams they are in. */
export const TeamsAsMember: Story = {
  args: {
    path: "/members/teams",
    routes: { ...FILLED, "GET /v1/auth/me": () => json(200, memberMe()) },
  },
};

// A team's page
const detailPath = `/members/teams/${TEAM_ID}`;
const detail$ = variants({ path: detailPath, routes: FILLED });
export const TeamDetail = detail$.Ko;
export const TeamDetailEn = detail$.En;
export const TeamDetailJa = detail$.Ja;
export const TeamDetailDark = detail$.Dark;
export const TeamDetailEnDark = detail$.EnDark;
export const TeamDetailJaDark = detail$.JaDark;
export const TeamDetailMobile = detail$.Mobile;
export const TeamDetailMobileDark = detail$.MobileDark;
export const TeamDetailLoading: Story = {
  args: {
    path: detailPath,
    routes: { ...FILLED, [`GET /v1/teams/${TEAM_ID}`]: pending },
  },
};
export const TeamDetailEmpty: Story = {
  args: {
    path: detailPath,
    routes: {
      ...FILLED,
      [`GET /v1/teams/${TEAM_ID}`]: () => json(200, team("결제팀", [])),
    },
  },
};
export const TeamDetailError: Story = {
  args: {
    path: detailPath,
    routes: { ...FILLED, [`GET /v1/teams/${TEAM_ID}`]: failed },
  },
};
/** Read once, then a refresh fails: the team read last stays. */
export const TeamDetailRefreshFailed: Story = {
  args: {
    path: detailPath,
    refresh: true,
    routes: () => ({
      ...FILLED,
      [`GET /v1/teams/${TEAM_ID}`]: failsAfterFirst(() => json(200, PAYMENTS)),
    }),
  },
};
export const TeamDetailRefreshFailedDark: Story = {
  ...TeamDetailRefreshFailed,
  globals: DARK,
};
/** The workspace roles did not come: the column is left out, and why. */
export const TeamDetailRolesFailed: Story = {
  args: {
    path: detailPath,
    routes: { ...FILLED, "GET /v1/members": failed },
  },
};
export const TeamDetailNoMatch: Story = {
  args: { path: detailPath, routes: FILLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole("searchbox"), "nobody");
    await expect(
      await canvas.findByRole("button", { name: "검색어 지우기" }),
    ).toBeVisible();
  },
};
/** A team's own member reads it; nothing on it changes the team. */
export const TeamDetailAsMember: Story = {
  args: {
    path: detailPath,
    routes: { ...FILLED, "GET /v1/auth/me": () => json(200, memberMe()) },
  },
};

// 초대 tab
const invites$ = variants({ path: "/members/invites", routes: FILLED });
export const Invites = invites$.Ko;
export const InvitesEn = invites$.En;
export const InvitesJa = invites$.Ja;
export const InvitesDark = invites$.Dark;
export const InvitesEnDark = invites$.EnDark;
export const InvitesJaDark = invites$.JaDark;
export const InvitesMobile = invites$.Mobile;
export const InvitesMobileDark = invites$.MobileDark;
export const InvitesLoading: Story = {
  args: {
    path: "/members/invites",
    routes: { ...FILLED, "GET /v1/invites": pending },
  },
};
export const InvitesEmpty: Story = {
  args: {
    path: "/members/invites",
    routes: { ...FILLED, "GET /v1/invites": () => json(200, { items: [] }) },
  },
};
export const InvitesError: Story = {
  args: {
    path: "/members/invites",
    routes: { ...FILLED, "GET /v1/invites": failed },
  },
};
export const InvitesRefreshFailed: Story = {
  args: {
    path: "/members/invites",
    refresh: true,
    routes: () => ({
      ...FILLED,
      "GET /v1/invites": failsAfterFirst(() => json(200, { items: INVITES })),
    }),
  },
};
export const InvitesNoMatch: Story = {
  args: { path: "/members/invites", routes: FILLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole("searchbox"), "nobody");
    await expect(
      await canvas.findByRole("button", { name: "검색어 지우기" }),
    ).toBeVisible();
  },
};

// Dialogs, opened on the real screens. The plays name controls in Korean,
// the stories' default language.

/** Clicks the control named `name` once it is on screen. */
function opens(
  name: string,
  role: "button" | "link" = "button",
): NonNullable<Story["play"]> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const control = await canvas.findByRole(role, { name });
    // Some buttons wait on a read (the roles an invite may carry) first.
    await waitFor(() => {
      expect(control).toBeEnabled();
      expect(control.getAttribute("aria-disabled")).not.toBe("true");
    });
    await userEvent.click(control);
    // Dialogs portal to the body, outside the story's canvas.
    await within(document.body).findByRole("dialog");
  };
}

export const MemberEdit: Story = { play: opens("Mate 편집") };
export const MemberDisable: Story = { play: opens("Mate 비활성화") };
export const Invite: Story = { play: opens("구성원 초대") };
export const TeamCreate: Story = {
  args: { path: "/members/teams", routes: FILLED },
  play: opens("팀 만들기"),
};
export const TeamAddMembers: Story = {
  args: { path: detailPath, routes: FILLED },
  play: opens("구성원 추가"),
};
export const TeamAddMembersMobile: Story = {
  ...TeamAddMembers,
  globals: MOBILE,
};
export const TeamMemberRemove: Story = {
  args: { path: detailPath, routes: FILLED },
  play: opens("Mate님을 팀에서 제외"),
};
export const TeamRolePromote: Story = {
  args: { path: detailPath, routes: FILLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      await canvas.findByRole("combobox", { name: "Mate님의 팀 역할" }),
      "lead",
    );
    await within(document.body).findByRole("dialog");
  },
};
export const TeamDelete: Story = {
  args: { path: detailPath, routes: FILLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "팀 삭제" }),
    );
    await within(document.body).findByRole("dialog");
  },
};
export const InviteRevoke: Story = {
  args: { path: "/members/invites", routes: FILLED },
  play: opens("lead@example.com 초대 회수"),
};
