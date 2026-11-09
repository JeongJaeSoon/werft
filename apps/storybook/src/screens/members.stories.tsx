import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  Invite as InviteRow,
  ListMyTeamsResponse,
  MemberRefusal,
  MemberRow,
  MemberVerdict,
  MemberView as Person,
  TeamDetail as TeamDetailView,
  TeamMemberRole,
  TeamView,
  WorkspaceRole,
} from "@werft-ai/contracts";
import { ListToolbar } from "@werft-ai/react/components";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  DangerZone,
  DangerZoneRow,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DisabledReason,
  EmptyState,
  ErrorState,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  Heading,
  Input,
  LinkTab,
  LinkTabs,
  NativeSelect,
  NativeSelectOption,
  Page,
  RadioGroup,
  RadioGroupItem,
  RowAction,
  RowList,
  RowListItem,
  Section,
  Skeleton,
  Stepper,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { ArrowLeft, ChevronRight, Plus, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { MOBILE, ScreenShell, VIEWER } from "./screen-kit.tsx";

/*
 * apps/web routes/members.tsx (구성원 · 초대 tabs, 구성원 편집), teams.tsx
 * (팀 tab and a team's page), team-create-dialog.tsx and invite-dialog.tsx.
 */

type Viewer = "owner" | "admin" | "member";

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "소유자",
  admin: "관리자",
  member: "구성원",
};
const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member"];
const TEAM_ROLE: Record<
  TeamMemberRole,
  { readonly label: string; readonly help: string }
> = {
  lead: {
    label: "팀 관리자",
    help: "이 팀이 담당 팀인 에이전트를 관리합니다.",
  },
  member: {
    label: "구성원",
    help: "이 팀이 담당 팀인 에이전트의 설정을 보고 사용합니다. 관리하지는 않습니다.",
  },
};
const TEAM_ROLES: readonly TeamMemberRole[] = ["lead", "member"];
// The names GET /v1/agents?ids= reads back for a refused delete's agent_ids.
const MANAGED_AGENTS = ["결제 문의 봇", "정산 리포트"] as const;
const ROLE_HELP: Record<WorkspaceRole, string> = {
  owner: "워크스페이스 설정과 소유자까지 모두 바꿉니다.",
  admin: "구성원·팀·초대를 관리합니다.",
  member: "자기 세션과 맡은 에이전트만 다룹니다.",
};
const SEARCH_MAX = 200;

const SECTION = "flex flex-col gap-[var(--werft-space-block)]";
const MUTED = "m-0 text-muted-foreground";
const INLINE_FORM = "flex max-w-xl flex-wrap items-end gap-2";
const NAME_FIELD = "min-w-0 flex-[1_1_14rem]";
const OPENS_ROW = "relative cursor-pointer hover:bg-hover";
const ROW_LINK =
  "after:absolute after:inset-0 after:rounded-card focus-visible:outline-none! focus-visible:after:outline-2 focus-visible:after:outline-focus-ring focus-visible:after:outline-offset-2";

const MEMBER_COLUMNS =
  "minmax(0,1.6fr) 120px minmax(var(--werft-row-action-min-width),1fr)";
const MEMBER_NARROW_COLUMNS =
  "minmax(0,1fr) 72px var(--werft-row-action-min-width)";

const WORKSPACE = "7c0e7f43-3b5c-4f0e-9a51-0d4c2f1a6b10";
// The shell's signed-in user is the "나" row.
const ID = {
  owner: VIEWER.id,
  dana: "0b8f6a4e-1c2d-4e3f-8a9b-000000000002",
  minji: "0b8f6a4e-1c2d-4e3f-8a9b-000000000003",
  hoon: "0b8f6a4e-1c2d-4e3f-8a9b-000000000004",
  sora: "0b8f6a4e-1c2d-4e3f-8a9b-000000000005",
} as const;

const OK: MemberVerdict = { allowed: true };
const no = (reason: MemberRefusal): MemberVerdict => ({
  allowed: false,
  reason,
});

const PEOPLE: readonly Person[] = [
  {
    user_id: VIEWER.id,
    display_name: VIEWER.name,
    email: VIEWER.email,
    role: "owner",
    disabled_at: null,
    created_at: "2026-10-02T00:00:00Z",
  },
  {
    user_id: ID.dana,
    display_name: "Verify Dana",
    email: "dana@example.test",
    role: "admin",
    disabled_at: null,
    created_at: "2026-10-05T00:00:00Z",
  },
  {
    user_id: ID.minji,
    display_name: "Verify Minji",
    email: "minji@example.test",
    role: "member",
    disabled_at: null,
    created_at: "2026-10-12T00:00:00Z",
  },
  {
    user_id: ID.hoon,
    display_name: "Verify Hoon",
    email: "hoon@example.test",
    role: "member",
    disabled_at: null,
    created_at: "2026-10-15T00:00:00Z",
  },
  {
    user_id: ID.sora,
    display_name: "Verify Sora",
    email: "sora@example.test",
    role: "member",
    disabled_at: "2026-10-28T00:00:00Z",
    created_at: "2026-10-18T00:00:00Z",
  },
];

/**
 * The workspace as `viewer` sees it. The shell's user is always VIEWER, so
 * in an admin's view VIEWER is the admin and Dana holds the owner role.
 */
function peopleFor(viewer: "owner" | "admin"): readonly Person[] {
  if (viewer === "owner") return PEOPLE;
  return PEOPLE.map((person) =>
    person.user_id === VIEWER.id
      ? { ...person, role: "admin" }
      : person.user_id === ID.dana
        ? { ...person, role: "owner" }
        : person,
  );
}

const mayGrant = (actor: WorkspaceRole, role: WorkspaceRole) =>
  actor === "owner" || role !== "owner";

/**
 * As the server's memberVerdict (platform musterrolle/member-rules.ts)
 * decides: self, then owner protection, then disabled, then unchanged.
 * No fixture account is suspended, so account_disabled never comes up.
 */
function verdicts(person: Person, actor: WorkspaceRole): MemberRow["actions"] {
  const disabled = person.disabled_at !== null;
  const verdict = (to: WorkspaceRole | "disable" | "enable"): MemberVerdict => {
    if (person.user_id === VIEWER.id) return no("self_protected");
    if (
      !mayGrant(actor, person.role) ||
      (to !== "disable" && to !== "enable" && !mayGrant(actor, to))
    ) {
      return no("owner_protected");
    }
    if (to === "disable") return disabled ? no("unchanged") : OK;
    if (to === "enable") return disabled ? OK : no("unchanged");
    if (disabled) return no("member_disabled");
    return person.role === to ? no("unchanged") : OK;
  };
  return {
    change_role: {
      owner: verdict("owner"),
      admin: verdict("admin"),
      member: verdict("member"),
    },
    disable: verdict("disable"),
    enable: verdict("enable"),
  };
}

function rowsFor(viewer: "owner" | "admin"): readonly MemberRow[] {
  return peopleFor(viewer).map((person) => ({
    ...person,
    actions: verdicts(person, viewer),
    administered_agents: [],
    last_active_at: null,
  }));
}

const TEAMS: readonly TeamView[] = [
  ["a1d2c3b4-0000-4000-8000-000000000001", "플랫폼팀", 3, "2026-10-15"],
  ["a1d2c3b4-0000-4000-8000-000000000002", "리서치", 1, "2026-10-16"],
  ["a1d2c3b4-0000-4000-8000-000000000003", "디자인", 0, "2026-10-20"],
].map(([id, name, count, day]) => ({
  id: String(id),
  workspace_id: WORKSPACE,
  name: String(name),
  member_count: Number(count),
  created_by: ID.owner,
  created_at: `${day}T00:00:00Z`,
  revision: 1,
}));

const PLATFORM = TEAMS[0] as TeamView;
const TEAM: TeamDetailView = {
  ...PLATFORM,
  members: [
    {
      user_id: ID.dana,
      email: "dana@example.test",
      display_name: "Verify Dana",
      role: "lead",
      added_by: ID.owner,
      added_at: "2026-10-16T01:00:00Z",
      disabled_at: null,
    },
    {
      user_id: ID.minji,
      email: "minji@example.test",
      display_name: "Verify Minji",
      role: "member",
      added_by: ID.owner,
      added_at: "2026-10-17T02:30:00Z",
      disabled_at: null,
    },
    {
      // Switched off in the workspace: the team keeps the row, shown inactive.
      user_id: ID.sora,
      email: "sora@example.test",
      display_name: "Verify Sora",
      role: "member",
      added_by: ID.owner,
      added_at: "2026-10-18T03:00:00Z",
      disabled_at: "2026-10-28T00:00:00Z",
    },
  ],
};
const EMPTY_TEAM: TeamDetailView = {
  ...PLATFORM,
  member_count: 0,
  members: [],
};

const MY_TEAMS: ListMyTeamsResponse["items"] = [
  { id: PLATFORM.id, name: PLATFORM.name, role: "member" },
];

const INVITES: readonly InviteRow[] = [
  {
    id: "c0ffee00-0000-4000-8000-000000000001",
    workspace_id: WORKSPACE,
    email: "new@example.test",
    role: "member",
    invited_by: ID.owner,
    status: "pending",
    expires_at: "2026-11-09T00:00:00Z",
    accepted_at: null,
    revoked_at: null,
    created_at: "2026-11-02T00:00:00Z",
  },
  {
    id: "c0ffee00-0000-4000-8000-000000000002",
    workspace_id: WORKSPACE,
    email: "soon@example.test",
    role: "admin",
    invited_by: ID.dana,
    status: "pending",
    expires_at: "2026-11-04T00:00:00Z",
    accepted_at: null,
    revoked_at: null,
    created_at: "2026-10-28T00:00:00Z",
  },
  {
    id: "c0ffee00-0000-4000-8000-000000000003",
    workspace_id: WORKSPACE,
    email: "lapsed@example.test",
    role: "member",
    invited_by: ID.owner,
    status: "expired",
    expires_at: "2026-10-26T00:00:00Z",
    accepted_at: null,
    revoked_at: null,
    created_at: "2026-10-19T00:00:00Z",
  },
];

// Past ten, the 초대 tab shows its search box like the 구성원 tab.
const MANY_INVITES: readonly InviteRow[] = Array.from(
  { length: 12 },
  (_, index) => ({
    ...(INVITES[0] as InviteRow),
    id: `c0ffee00-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    email: `person${index + 1}@example.test`,
  }),
);

const ERROR = {
  title: "불러오지 못했습니다",
  message: "서버에 연결하지 못했습니다 — 네트워크 연결을 확인하세요.",
};

function matches(needle: string, ...texts: readonly (string | null)[]) {
  const term = needle.trim().normalize("NFKC").toLowerCase();
  return (
    term === "" ||
    texts.some((text) => text?.normalize("NFKC").toLowerCase().includes(term))
  );
}

function Loading() {
  return <Skeleton lines={3} label="불러오는 중입니다" />;
}

function LoadFailure() {
  return (
    <ErrorState
      title={ERROR.title}
      message={ERROR.message}
      retry={fn()}
      retryLabel="다시 시도"
    />
  );
}

function ClearSearch({ onClick }: { readonly onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      검색어 지우기
    </Button>
  );
}

/* ---- Page head and tabs (MembersLayout) ---- */

type Tab = "members" | "teams" | "invites";

function MembersLayout({
  manages,
  tab,
  onTeamList = false,
  action,
  children,
}: {
  readonly manages: boolean;
  readonly tab: Tab;
  /** The team list, not a team's page: its intro is the description. */
  readonly onTeamList?: boolean;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Page
      title="구성원"
      description={
        !manages
          ? "구성원 초대와 관리는 워크스페이스 소유자나 관리자가 합니다."
          : onTeamList
            ? TEAMS_INTRO
            : "워크스페이스에 속한 사람과 역할입니다."
      }
      actions={action}
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        <LinkTabs aria-label="구성원 보기">
          {manages ? (
            <LinkTab href="#members" current={tab === "members"}>
              구성원
            </LinkTab>
          ) : null}
          <LinkTab href="#teams" current={tab === "teams"}>
            팀
          </LinkTab>
          {manages ? (
            <LinkTab href="#invites" current={tab === "invites"}>
              초대
            </LinkTab>
          ) : null}
        </LinkTabs>
        {children}
      </div>
    </Page>
  );
}

/* ---- 초대 dialog (InviteDialog, its first step) ---- */

function InviteAction({
  viewer,
  initialOpen = false,
}: {
  readonly viewer: "owner" | "admin";
  readonly initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  // assignable_roles of GET /v1/members: an admin cannot grant owner.
  const grantable: readonly WorkspaceRole[] =
    viewer === "owner" ? ROLES : ["admin", "member"];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          구성원 초대
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>초대</DialogTitle>
          <DialogDescription>
            받는 사람의 이메일과 역할을 정하면 한 번만 보이는 초대 링크를
            만듭니다.
          </DialogDescription>
        </DialogHeader>
        <Stepper
          label="초대 단계"
          steps={[
            { id: "details", label: "받는 사람" },
            { id: "link", label: "초대 링크", disabled: true },
          ]}
          currentStepId="details"
        />
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => event.preventDefault()}
        >
          <Field>
            <FieldLabel>이메일</FieldLabel>
            <Input type="email" name="email" autoComplete="off" />
          </Field>
          <Field>
            <FieldLabel>역할</FieldLabel>
            <NativeSelect name="role" defaultValue="member">
              {ROLES.map((value) => (
                <NativeSelectOption
                  key={value}
                  value={value}
                  disabled={!grantable.includes(value)}
                >
                  {ROLE_LABEL[value]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {grantable.includes("owner") ? null : (
              <FieldDescription>
                소유자 역할은 소유자만 줄 수 있습니다.
              </FieldDescription>
            )}
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                취소
              </Button>
            </DialogClose>
            <Button type="submit">초대 링크 만들기</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---- 구성원 tab (MembersScreen, MemberTable) ---- */

type ListState = "ready" | "loading" | "error";

const DISABLE_REASON: Partial<Record<MemberRefusal, string>> = {
  self_protected: "자기 자신은 비활성화할 수 없습니다.",
  owner_protected: "소유자는 관리자가 비활성화할 수 없습니다.",
};
const ENABLE_REASON: Partial<Record<MemberRefusal, string>> = {
  owner_protected: "소유자는 관리자가 다시 활성화할 수 없습니다.",
};
const ROLE_REASON: Partial<Record<MemberRefusal, string>> = {
  self_protected: "자기 자신의 역할은 바꿀 수 없습니다.",
  owner_protected: "소유자의 역할은 관리자가 바꿀 수 없습니다.",
  member_disabled: "비활성 구성원의 역할은 다시 활성화한 뒤 바꿀 수 있습니다.",
};

function reasonOf(
  table: Partial<Record<MemberRefusal, string>>,
  verdict: MemberVerdict,
): string | undefined {
  if (verdict.allowed || verdict.reason === "unchanged") return undefined;
  return table[verdict.reason];
}

function MembersTab({
  viewer,
  state,
  initialQuery = "",
  initialEdit,
  initialDisable,
  initialRoleChange,
}: {
  readonly viewer: "owner" | "admin";
  readonly state: ListState;
  readonly initialQuery?: string;
  readonly initialEdit?: string | undefined;
  readonly initialDisable?: string | undefined;
  readonly initialRoleChange?:
    | { readonly id: string; readonly role: WorkspaceRole }
    | undefined;
}) {
  const [query, setQuery] = useState(initialQuery);
  const rows = rowsFor(viewer);
  const items = rows.filter((member) =>
    matches(query, member.display_name, member.email),
  );
  const find = (id: string | undefined) =>
    rows.find((member) => member.user_id === id) ?? null;
  const [editing, setEditing] = useState(
    find(initialRoleChange?.id ?? initialEdit),
  );
  const [confirming, setConfirming] = useState(find(initialDisable));

  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      <ListToolbar
        filter={null}
        search={{
          type: "search",
          "aria-label": "이름이나 이메일로 찾기",
          placeholder: "이름이나 이메일로 찾기",
          maxLength: SEARCH_MAX,
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }}
      />
      {state === "loading" ? (
        <Loading />
      ) : state === "error" ? (
        <LoadFailure />
      ) : items.length === 0 ? (
        <EmptyState
          className="w-full"
          title="검색어에 맞는 구성원이 없습니다"
          description="다른 이름이나 이메일로 찾아 보세요."
          action={<ClearSearch onClick={() => setQuery("")} />}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="-m-1 grid overflow-x-auto p-1">
            <GridTable
              aria-label="구성원 표"
              columns={MEMBER_COLUMNS}
              narrowAt={640}
              narrowColumns={MEMBER_NARROW_COLUMNS}
              framed={true}
              className="min-w-[322px]"
            >
              <GridTableHeader>
                <GridTableColumnHeader>구성원</GridTableColumnHeader>
                <GridTableColumnHeader>역할</GridTableColumnHeader>
                <GridTableColumnHeader action={true}>
                  관리
                </GridTableColumnHeader>
              </GridTableHeader>
              {items.map((member) => (
                <MemberTableRow
                  key={member.user_id}
                  member={member}
                  self={member.user_id === VIEWER.id}
                  onEdit={() => setEditing(member)}
                  onDisable={() => setConfirming(member)}
                />
              ))}
            </GridTable>
          </div>
        </div>
      )}
      {editing ? (
        <MemberEditDialog
          member={editing}
          initialRole={initialRoleChange?.role}
          onClose={() => setEditing(null)}
          onSave={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={`${confirming?.display_name ?? ""} 계정을 비활성화할까요?`}
        consequence="이 사람의 웹 로그인과 개인 API 키가 바로 끊기고, 이 사람이 시작한 세션은 소유자가 넘겨받을 때까지 멈춥니다. 다시 활성화해도 끊긴 로그인과 키는 돌아오지 않습니다."
        confirmLabel="비활성화"
        cancelLabel="취소"
        tone="danger"
        onConfirm={() => setConfirming(null)}
      />
    </div>
  );
}

// Same fill the web app gives an inactive member's row.
const INACTIVE_ROW =
  "bg-hover has-[[data-slot=grid-table-row-opener]]:hover:bg-active";

function MemberTableRow({
  member,
  self,
  onEdit,
  onDisable,
}: {
  readonly member: MemberRow;
  readonly self: boolean;
  readonly onEdit: () => void;
  readonly onDisable: () => void;
}) {
  const disabled = member.disabled_at !== null;
  const name = member.display_name;
  const keepWhy = disabled
    ? reasonOf(ENABLE_REASON, member.actions.enable)
    : reasonOf(DISABLE_REASON, member.actions.disable);
  const button = disabled ? (
    <RowAction
      disabled={keepWhy !== undefined}
      aria-label={`${name} 다시 활성화`}
    >
      다시 활성화
    </RowAction>
  ) : (
    <RowAction
      disabled={keepWhy !== undefined}
      aria-label={`${name} 비활성화`}
      onClick={onDisable}
    >
      비활성화
    </RowAction>
  );
  return (
    <GridTableRow
      inactive={disabled}
      className={disabled ? INACTIVE_ROW : undefined}
      data-disabled={disabled}
    >
      <GridTableCell lines={true}>
        <GridTableRowOpener
          aria-label={disabled ? `${name} 편집 (비활성)` : `${name} 편집`}
          onClick={onEdit}
        />
        <Text
          as="span"
          weight="medium"
          className="grid max-w-full grid-cols-[minmax(0,auto)_auto] items-center gap-y-[var(--werft-row-line-gap)] @max-md:grid-cols-[minmax(0,auto)]"
        >
          <Text as="span" weight="medium" truncate>
            {name}
          </Text>
          {disabled ? (
            <Badge
              variant="gray"
              className="ms-1.5 @max-md:col-start-1 @max-md:row-start-2 @max-md:ms-0"
            >
              비활성
            </Badge>
          ) : null}
          {self ? (
            <Badge
              variant="gray"
              className="ms-1.5 @max-md:col-start-1 @max-md:row-start-2 @max-md:ms-0"
            >
              나
            </Badge>
          ) : null}
        </Text>
        <Text as="span" variant="meta" title={member.email}>
          {member.email}
        </Text>
      </GridTableCell>
      <GridTableCell>
        <Badge variant={member.role === "member" ? "gray" : "blue"}>
          {ROLE_LABEL[member.role]}
        </Badge>
      </GridTableCell>
      <GridTableCell raised={true} align="end" className="gap-1">
        {keepWhy ? (
          <DisabledReason
            reason={keepWhy}
            label={disabled ? `${name} 다시 활성화` : `${name} 비활성화`}
          >
            {button}
          </DisabledReason>
        ) : (
          button
        )}
      </GridTableCell>
    </GridTableRow>
  );
}

/** 구성원 편집: the server's verdicts decide which roles can be picked. */
function MemberEditDialog({
  member,
  initialRole,
  onClose,
  onSave,
}: {
  readonly member: MemberRow;
  readonly initialRole?: WorkspaceRole | undefined;
  readonly onClose: () => void;
  readonly onSave: (role: WorkspaceRole) => void;
}) {
  const [role, setRole] = useState<WorkspaceRole>(initialRole ?? member.role);
  const changed = role !== member.role;
  const legendId = useId();
  const reasonId = useId();
  const roleReasonId = useId();
  const verdictOf = member.actions.change_role;
  const refusals = ROLES.filter((value) => value !== member.role).map(
    (value) => verdictOf[value],
  );
  const rowRefusal = refusals.every((verdict) => !verdict.allowed)
    ? (refusals.find(
        (verdict) => !verdict.allowed && verdict.reason !== "owner_protected",
      ) ?? refusals[0])
    : undefined;
  const reason = rowRefusal ? reasonOf(ROLE_REASON, rowRefusal) : undefined;
  const blocked = reason !== undefined;
  const withheld = (value: WorkspaceRole) => {
    const verdict = verdictOf[value];
    if (blocked || verdict.allowed) return undefined;
    return verdict.reason === "owner_protected"
      ? "소유자 역할은 소유자만 줄 수 있습니다."
      : reasonOf(ROLE_REASON, verdict);
  };
  const withheldIds = ROLES.filter((value) => withheld(value) !== undefined)
    .map((value) => `${roleReasonId}-${value}`)
    .join(" ");
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>구성원 편집</DialogTitle>
          <DialogDescription>
            {member.display_name} · {member.email}
          </DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend id={legendId} variant="label">
            역할
          </FieldLegend>
          {blocked ? (
            <FieldDescription id={reasonId}>{reason}</FieldDescription>
          ) : null}
          <RadioGroup
            value={role}
            onValueChange={(value) => setRole(value as WorkspaceRole)}
            disabled={blocked}
            aria-labelledby={legendId}
            aria-describedby={blocked ? reasonId : withheldIds || undefined}
          >
            {ROLES.map((value) => {
              const why = withheld(value);
              return (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem value={value} disabled={why !== undefined} />
                  <FieldLabel>{ROLE_LABEL[value]}</FieldLabel>
                  <FieldDescription
                    id={why ? `${roleReasonId}-${value}` : undefined}
                  >
                    {why ?? ROLE_HELP[value]}
                  </FieldDescription>
                </Field>
              );
            })}
          </RadioGroup>
        </FieldSet>
        {changed && !blocked ? (
          <FieldDescription role="status">
            {`바꾸면 ${member.display_name}의 역할은 ${ROLE_LABEL[role]}입니다.`}{" "}
            {role === "owner"
              ? "소유자는 워크스페이스 설정과 다른 소유자의 역할까지 바꿀 수 있습니다. 소유자 역할은 소유자만 다시 거둘 수 있습니다."
              : "바꾸는 즉시 이 사람이 할 수 있는 일이 새 역할에 맞게 바뀝니다."}
          </FieldDescription>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button
            type="button"
            disabled={blocked || !changed || !verdictOf[role].allowed}
            onClick={() => onSave(role)}
          >
            역할 바꾸기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- 초대 tab (InvitesScreen, InviteList) ---- */

function InvitesTab({
  invites,
  initialRevoke,
  initialQuery = "",
}: {
  readonly invites: readonly InviteRow[];
  readonly initialRevoke?: string | undefined;
  readonly initialQuery?: string;
}) {
  const [revoking, setRevoking] = useState(
    invites.find((invite) => invite.id === initialRevoke) ?? null,
  );
  const [query, setQuery] = useState(initialQuery);
  // Revoked and accepted invites are history; waiting and lapsed ones stay.
  const listed = invites.filter(
    (invite) => invite.status === "pending" || invite.status === "expired",
  );
  const pending = listed.filter((invite) => matches(query, invite.email));
  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      {listed.length > 10 || query !== "" ? (
        <ListToolbar
          filter={null}
          search={{
            type: "search",
            "aria-label": "이메일로 찾기",
            placeholder: "이메일로 찾기",
            maxLength: SEARCH_MAX,
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }}
        />
      ) : null}
      {listed.length === 0 ? (
        <EmptyState title="남아 있는 초대가 없습니다." />
      ) : pending.length === 0 ? (
        <EmptyState
          className="w-full"
          title="검색어에 맞는 초대가 없습니다"
          description="다른 이메일로 찾아 보세요."
          action={<ClearSearch onClick={() => setQuery("")} />}
        />
      ) : (
        <div className="-m-1 grid overflow-x-auto p-1">
          <GridTable
            aria-label="초대 표"
            columns={MEMBER_COLUMNS}
            narrowAt={640}
            narrowColumns={MEMBER_NARROW_COLUMNS}
            framed={true}
            className="min-w-[322px]"
          >
            <GridTableHeader>
              <GridTableColumnHeader>초대</GridTableColumnHeader>
              <GridTableColumnHeader>역할</GridTableColumnHeader>
              <GridTableColumnHeader action={true}>관리</GridTableColumnHeader>
            </GridTableHeader>
            {pending.map((invite) => {
              const lapsed = invite.status === "expired";
              return (
                <GridTableRow
                  key={invite.id}
                  inactive={lapsed}
                  className={lapsed ? INACTIVE_ROW : undefined}
                  data-expired={lapsed}
                >
                  <GridTableCell lines={true}>
                    <span className="grid max-w-full grid-cols-[minmax(0,auto)_auto] items-center gap-y-[var(--werft-row-line-gap)] @max-md:grid-cols-[minmax(0,auto)]">
                      <Text
                        as="span"
                        weight="medium"
                        truncate
                        title={invite.email}
                      >
                        {invite.email}
                      </Text>
                      {lapsed ? (
                        <Badge
                          variant="gray"
                          className="ms-1.5 @max-md:col-start-1 @max-md:row-start-2 @max-md:ms-0"
                        >
                          만료
                        </Badge>
                      ) : null}
                    </span>
                    <Text as="span" variant="meta">
                      {lapsed
                        ? `${formatTimestamp(invite.expires_at, "ko")}에 만료됨`
                        : `${formatTimestamp(invite.expires_at, "ko")}까지`}
                    </Text>
                  </GridTableCell>
                  <GridTableCell>
                    <Badge variant={invite.role === "member" ? "gray" : "blue"}>
                      {ROLE_LABEL[invite.role]}
                    </Badge>
                  </GridTableCell>
                  <GridTableCell align="end">
                    {lapsed ? null : (
                      <RowAction
                        aria-label={`${invite.email} 초대 회수`}
                        onClick={() => setRevoking(invite)}
                      >
                        회수
                      </RowAction>
                    )}
                  </GridTableCell>
                </GridTableRow>
              );
            })}
          </GridTable>
        </div>
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`${revoking?.email ?? ""} 초대를 회수할까요?`}
        consequence="보낸 링크로는 더 가입할 수 없습니다. 다시 초대하려면 새 링크를 만들어 보내야 합니다."
        confirmLabel="회수"
        cancelLabel="취소"
        tone="danger"
        onConfirm={() => setRevoking(null)}
      />
    </div>
  );
}

/* ---- 팀 tab (TeamsScreen, MyTeams) and 팀 만들기 ---- */

function TeamCreateAction({
  initialOpen = false,
  taken = false,
}: {
  readonly initialOpen?: boolean;
  readonly taken?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [name, setName] = useState(taken ? "플랫폼팀" : "");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />팀 만들기
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>팀 만들기</DialogTitle>
            <DialogDescription>
              이름을 정해 팀을 만듭니다. 구성원은 만든 뒤 팀 화면에서 넣습니다.
            </DialogDescription>
          </DialogHeader>
          {taken ? (
            <Alert variant="red" role="alert">
              <AlertDescription>
                같은 이름의 팀이 이미 있습니다 — 다른 이름을 쓰세요.
              </AlertDescription>
            </Alert>
          ) : null}
          <Field>
            <FieldLabel>팀 이름</FieldLabel>
            <Input
              name="team-name"
              required
              maxLength={100}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                취소
              </Button>
            </DialogClose>
            <Button type="submit">팀 만들기</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// A manager reads this as the page's description; a member, above their teams.
const TEAMS_INTRO =
  "팀은 사람 묶음입니다. 에이전트의 담당 팀이나 관리자로 지정해 함께 관리하고 씁니다.";

/** A member's 팀 tab: what teams are for, then the tab's own sections. */
function TeamsIntro({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[var(--werft-space-section)]">
      <Text className={`${MUTED} text-sm`}>{TEAMS_INTRO}</Text>
      {children}
    </div>
  );
}

function TeamRowLink({ name }: { readonly name: string }) {
  return (
    <TextLink href="#team" className={`${ROW_LINK} [overflow-wrap:anywhere]`}>
      {name}
    </TextLink>
  );
}

function TeamsTab({
  teams,
  initialQuery = "",
}: {
  readonly teams: readonly TeamView[];
  readonly initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const items = teams.filter((team) => matches(query, team.name));
  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      <ListToolbar
        filter={null}
        search={{
          type: "search",
          "aria-label": "이름으로 팀 찾기",
          placeholder: "이름으로 팀 찾기",
          maxLength: SEARCH_MAX,
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }}
      />
      {items.length === 0 && query.trim() !== "" ? (
        <EmptyState
          className="w-full"
          title="검색어에 맞는 팀이 없습니다"
          description="다른 이름으로 찾아 보세요."
          action={<ClearSearch onClick={() => setQuery("")} />}
        />
      ) : items.length === 0 ? (
        <EmptyState title="아직 팀이 없습니다." />
      ) : (
        <div className="-m-1 grid overflow-x-auto p-1">
          <GridTable
            aria-label="팀 표"
            columns="minmax(0,1fr) 9rem"
            narrowAt={640}
            narrowColumns="minmax(0,1fr) 7rem"
            framed={true}
          >
            <GridTableHeader>
              <GridTableColumnHeader>팀</GridTableColumnHeader>
              <GridTableColumnHeader>구성원</GridTableColumnHeader>
            </GridTableHeader>
            {items.map((team) => (
              <GridTableRow key={team.id}>
                <GridTableCell>
                  <GridTableRowOpener aria-label={`팀 열기: ${team.name}`} />
                  <Text as="span" weight="medium" truncate title={team.name}>
                    {team.name}
                  </Text>
                </GridTableCell>
                <GridTableCell>
                  <Text as="span" variant="meta" numeric truncate>
                    {`구성원 ${team.member_count}명`}
                  </Text>
                  <ChevronRight
                    aria-hidden="true"
                    className="ml-auto size-4 shrink-0 text-subtle-foreground"
                  />
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        </div>
      )}
    </div>
  );
}

/** A member's 팀 tab: only the teams they are in (MyTeams showEmpty). */
function MyTeams({ teams }: { readonly teams: ListMyTeamsResponse["items"] }) {
  const titleId = useId();
  return (
    <TeamsIntro>
      <section className={SECTION} aria-labelledby={titleId}>
        <Heading id={titleId}>내가 속한 팀</Heading>
        {teams.length === 0 ? (
          <EmptyState title="아직 속한 팀이 없습니다." />
        ) : (
          <>
            <Text className={`${MUTED} text-sm`}>
              소유자나 관리자가 넣은 팀입니다. 팀이 담당 팀인 에이전트는 팀
              관리자가 관리하고 구성원은 설정을 보고 사용합니다. 팀이 에이전트
              관리자로 지정되면 구성원 모두가 그 에이전트를 관리합니다.
            </Text>
            <RowList>
              {teams.map((team) => (
                <RowListItem key={team.id} className={OPENS_ROW}>
                  <TeamRowLink name={team.name} />
                  <Badge
                    variant={team.role === "lead" ? "blue" : "gray"}
                    className="ml-auto shrink-0"
                  >
                    {TEAM_ROLE[team.role].label}
                  </Badge>
                </RowListItem>
              ))}
            </RowList>
          </>
        )}
      </section>
    </TeamsIntro>
  );
}

/* ---- A team's page (TeamPage) ---- */

function TeamPage({
  team,
  manages,
  initialDelete = false,
  initialPromote,
  initialRemove,
  initialQuery = "",
  manages409 = false,
}: {
  readonly team: TeamDetailView;
  readonly manages: boolean;
  readonly initialDelete?: boolean;
  /** Whose promotion to lead starts at its confirmation. */
  readonly initialPromote?: string | undefined;
  /** Whose removal starts at its confirmation. */
  readonly initialRemove?: string | undefined;
  readonly initialQuery?: string;
  /** The delete was refused: the team manages agents (409). */
  readonly manages409?: boolean;
}) {
  const [deleting, setDeleting] = useState(initialDelete);
  const [name, setName] = useState(team.name);
  return (
    <div className="flex flex-col gap-[var(--werft-space-section)]">
      <div className="flex flex-col gap-2">
        <TextLink
          href="#teams"
          className="inline-flex w-fit items-center gap-1"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />팀 목록
        </TextLink>
        <Heading className="min-w-0 [overflow-wrap:anywhere]">
          {team.name}
        </Heading>
      </div>
      {manages ? (
        <Section title="팀 설정" titleAs="h3">
          <form
            className={INLINE_FORM}
            onSubmit={(event) => event.preventDefault()}
          >
            <Field className={NAME_FIELD}>
              <FieldLabel>팀 이름</FieldLabel>
              <Input
                name="team-name"
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="outline"
              disabled={name.trim() === team.name}
            >
              이름 바꾸기
            </Button>
          </form>
        </Section>
      ) : null}
      <TeamMembers
        team={team}
        manages={manages}
        initialPromote={initialPromote}
        initialRemove={initialRemove}
        initialQuery={initialQuery}
      />
      {manages ? (
        <>
          {manages409 ? (
            <Alert variant="red" role="alert">
              <AlertDescription>
                이 팀이 담당 팀인 에이전트가 있어 삭제하지 못했습니다. 아래
                에이전트의 담당 팀을 먼저 바꾸세요.
              </AlertDescription>
              <ul
                aria-label="이 팀이 담당 팀인 에이전트"
                className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-control"
              >
                {MANAGED_AGENTS.map((agent) => (
                  <li key={agent}>
                    <TextLink href="#agent">{agent}</TextLink>
                  </li>
                ))}
                <li>그 밖에 1개</li>
              </ul>
            </Alert>
          ) : null}
          <DangerZone title="위험 구역" titleAs="h3">
            <DangerZoneRow
              title="팀 삭제"
              description="팀을 삭제하면 이 팀이 관리자로 있던 에이전트에서도 빠집니다. 이 팀이 담당 팀인 에이전트가 있으면 그 에이전트의 담당 팀을 먼저 바꿔야 삭제할 수 있습니다."
              actionLabel="팀 삭제"
              onAction={() => setDeleting(true)}
            />
          </DangerZone>
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={`${team.name} 팀을 삭제할까요?`}
            consequence="구성원은 워크스페이스에 그대로 남지만, 이 팀을 통해 관리하던 에이전트는 더 관리하지 못합니다."
            confirmLabel="팀 삭제"
            cancelLabel="취소"
            tone="danger"
            onConfirm={() => setDeleting(false)}
          />
        </>
      ) : null}
    </div>
  );
}

function TeamMembers({
  team,
  manages,
  initialPromote,
  initialRemove,
  initialQuery,
}: {
  readonly team: TeamDetailView;
  readonly manages: boolean;
  readonly initialPromote: string | undefined;
  readonly initialRemove: string | undefined;
  readonly initialQuery: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [removing, setRemoving] = useState<
    TeamDetailView["members"][number] | null
  >(team.members.find((member) => member.user_id === initialRemove) ?? null);
  // Managers read the workspace roles of the team's people; its own members
  // do not. The team role comes with the team.
  const roles = manages
    ? new Map(PEOPLE.map((person) => [person.user_id, person.role]))
    : undefined;
  const shown = team.members.filter((member) =>
    matches(query, member.display_name, member.email),
  );
  const roleColumn = manages ? "7.5rem" : "96px";
  const actionsColumn = "var(--werft-row-action-min-width)";
  const columns = [
    "minmax(0,1fr)",
    roles && "112px",
    roleColumn,
    "minmax(9.5rem,0.5fr)",
    manages && actionsColumn,
  ]
    .filter(Boolean)
    .join(" ");
  const narrowColumns = ["minmax(0,1fr)", roleColumn, manages && actionsColumn]
    .filter(Boolean)
    .join(" ");
  return (
    <Section
      title="팀 구성원"
      titleAs="h3"
      badge={<Badge variant="gray">{`${team.members.length}명`}</Badge>}
    >
      {team.members.length === 0 ? (
        <EmptyState title="아직 구성원이 없습니다." />
      ) : (
        <div className="flex flex-col gap-3">
          <ListToolbar
            filter={null}
            search={{
              type: "search",
              "aria-label": "이름이나 이메일로 구성원 찾기",
              placeholder: "이름이나 이메일로 구성원 찾기",
              maxLength: SEARCH_MAX,
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }}
          />
          {shown.length === 0 ? (
            <EmptyState
              className="w-full"
              title="검색어에 맞는 구성원이 없습니다"
              description="다른 이름이나 이메일로 찾아 보세요."
              action={<ClearSearch onClick={() => setQuery("")} />}
            />
          ) : (
            <div className="-m-1 grid overflow-x-auto p-1">
              <GridTable
                aria-label="팀 구성원"
                columns={columns}
                narrowAt={820}
                narrowColumns={narrowColumns}
                framed={true}
              >
                <GridTableHeader>
                  <GridTableColumnHeader>구성원</GridTableColumnHeader>
                  {roles && (
                    <GridTableColumnHeader hideNarrow={true}>
                      워크스페이스 역할
                    </GridTableColumnHeader>
                  )}
                  <GridTableColumnHeader>팀 역할</GridTableColumnHeader>
                  <GridTableColumnHeader hideNarrow={true}>
                    추가한 날
                  </GridTableColumnHeader>
                  {manages && (
                    <GridTableColumnHeader action={true}>
                      관리
                    </GridTableColumnHeader>
                  )}
                </GridTableHeader>
                {shown.map((member) => {
                  const name = member.display_name ?? member.email;
                  const role = roles?.get(member.user_id);
                  const inactive = member.disabled_at !== null;
                  return (
                    <GridTableRow
                      key={member.user_id}
                      inactive={inactive}
                      className={inactive ? INACTIVE_ROW : undefined}
                      data-disabled={inactive}
                    >
                      <GridTableCell lines={true}>
                        <span className="grid max-w-full grid-cols-[minmax(0,auto)_auto] items-center gap-y-[var(--werft-row-line-gap)] @max-md:grid-cols-[minmax(0,auto)]">
                          <Text as="span" weight="medium" truncate>
                            {name}
                          </Text>
                          {inactive ? (
                            <Badge
                              variant="gray"
                              className="ms-1.5 @max-md:col-start-1 @max-md:row-start-2 @max-md:ms-0"
                            >
                              비활성
                            </Badge>
                          ) : null}
                        </span>
                        {member.display_name !== null && (
                          <Text
                            as="span"
                            variant="meta"
                            truncate
                            title={member.email}
                          >
                            {member.email}
                          </Text>
                        )}
                      </GridTableCell>
                      {roles && (
                        <GridTableCell hideNarrow={true}>
                          {role && (
                            <Badge
                              variant={role === "member" ? "gray" : "blue"}
                            >
                              {ROLE_LABEL[role]}
                            </Badge>
                          )}
                        </GridTableCell>
                      )}
                      <GridTableCell>
                        {manages ? (
                          <TeamRoleSelect
                            member={member}
                            initialPromote={initialPromote === member.user_id}
                          />
                        ) : (
                          <Badge
                            variant={member.role === "lead" ? "blue" : "gray"}
                          >
                            {TEAM_ROLE[member.role].label}
                          </Badge>
                        )}
                      </GridTableCell>
                      <GridTableCell
                        hideNarrow={true}
                        className="text-caption text-muted-foreground tabular-nums"
                      >
                        {formatTimestamp(member.added_at, "ko")}
                      </GridTableCell>
                      {manages && (
                        <GridTableCell raised={true} align="end">
                          <RowAction
                            aria-label={`${name}님을 팀에서 제외`}
                            onClick={() => setRemoving(member)}
                          >
                            제외
                          </RowAction>
                        </GridTableCell>
                      )}
                    </GridTableRow>
                  );
                })}
              </GridTable>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`${removing?.display_name ?? removing?.email ?? ""}님을 ${team.name} 팀에서 제외할까요?`}
        consequence="워크스페이스에는 그대로 남지만, 이 팀을 통해 관리하던 에이전트는 더 관리하지 못합니다. 다시 추가하면 돌아옵니다."
        confirmLabel="제외"
        cancelLabel="취소"
        tone="danger"
        onConfirm={() => setRemoving(null)}
      />
    </Section>
  );
}

/** The role applies at once; only promotion to lead asks first. */
function TeamRoleSelect({
  member,
  initialPromote,
}: {
  readonly member: TeamDetailView["members"][number];
  readonly initialPromote: boolean;
}) {
  const [role, setRole] = useState<TeamMemberRole>(member.role);
  const [promoting, setPromoting] = useState(initialPromote);
  const name = member.display_name ?? member.email;
  return (
    <>
      <NativeSelect
        className="w-auto ps-2 pe-8"
        aria-label={`${name}님의 팀 역할`}
        value={role}
        onChange={(event) => {
          const next = event.target.value as TeamMemberRole;
          if (next === "lead") setPromoting(true);
          else setRole(next);
        }}
      >
        {TEAM_ROLES.map((value) => (
          <NativeSelectOption key={value} value={value}>
            {TEAM_ROLE[value].label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <ConfirmDialog
        open={promoting}
        onOpenChange={setPromoting}
        title={`${name}님을 팀 관리자로 바꿀까요?`}
        consequence="팀 관리자는 이 팀이 담당 팀인 에이전트를 모두 관리합니다. 바꾸면 바로 적용됩니다."
        confirmLabel="팀 관리자로 바꾸기"
        cancelLabel="취소"
        onConfirm={() => {
          setRole("lead");
          setPromoting(false);
        }}
      />
    </>
  );
}

function AddMembers({
  team,
  initialOpen,
}: {
  readonly team: TeamDetailView;
  readonly initialOpen: boolean;
}) {
  const pickerId = useId();
  const [open, setOpen] = useState(initialOpen);
  const [picked, setPicked] = useState<readonly Person[]>(
    initialOpen ? PEOPLE.filter((person) => person.user_id === ID.hoon) : [],
  );
  const taken = new Set([
    ...team.members.map((member) => member.user_id),
    ...picked.map((member) => member.user_id),
  ]);
  const candidates = PEOPLE.filter(
    (person) => person.disabled_at === null && !taken.has(person.user_id),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setPicked([]);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          구성원 추가
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (picked.length > 0) setOpen(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{`${team.name}에 구성원 추가`}</DialogTitle>
            <DialogDescription>
              여러 명을 골라 한 번에 추가할 수 있습니다. 추가하면 수락 없이 바로
              구성원이 됩니다.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={pickerId}>추가할 사람</FieldLabel>
            <Combobox
              id={pickerId}
              options={candidates.map((member) => ({
                value: member.user_id,
                label: member.display_name,
                description: member.email,
              }))}
              value={null}
              clearOnSelect={true}
              maxLength={SEARCH_MAX}
              onValueChange={(value) => {
                const member = candidates.find((m) => m.user_id === value);
                if (member) setPicked((list) => [...list, member]);
              }}
              placeholder="이름이나 이메일로 찾기"
              loadingMessage="구성원을 불러오는 중…"
              emptyMessage="맞는 사람이 없습니다."
              resultCountMessage={(count) => `${count}명이 있습니다.`}
            />
          </Field>
          {picked.length > 0 && (
            <ul
              aria-label="추가할 사람"
              className="m-0 flex list-none flex-wrap gap-2 p-0"
            >
              {picked.map((member) => (
                <li
                  key={member.user_id}
                  className="inline-flex items-center gap-1 rounded-full border bg-surface-sunken py-0.5 ps-2.5 pe-0.5 text-caption"
                >
                  <Text
                    as="span"
                    className="max-w-48 truncate text-caption"
                    title={member.email}
                  >
                    {member.display_name}
                  </Text>
                  <button
                    type="button"
                    className="inline-grid size-5 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-50"
                    aria-label={`${member.display_name}님을 추가할 사람에서 빼기`}
                    onClick={() => {
                      setPicked((list) =>
                        list.filter((m) => m.user_id !== member.user_id),
                      );
                      document.getElementById(pickerId)?.focus();
                    }}
                  >
                    <X aria-hidden="true" className="size-3" strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                취소
              </Button>
            </DialogClose>
            <Button
              type="submit"
              aria-disabled={picked.length === 0 || undefined}
            >
              {picked.length > 1 ? `${picked.length}명 추가` : "구성원 추가"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---- Screens ---- */

type Screen =
  | "members"
  | "members-admin"
  | "members-loading"
  | "members-error"
  | "members-no-match"
  | "member-edit"
  | "member-edit-admin"
  | "member-edit-admin-owner"
  | "member-edit-disabled"
  | "member-role-change"
  | "member-disable"
  | "invite"
  | "invite-admin"
  | "teams"
  | "teams-empty"
  | "teams-no-match"
  | "team-create"
  | "team-create-taken"
  | "team"
  | "team-empty"
  | "team-delete"
  | "team-delete-manages"
  | "team-add"
  | "team-promote"
  | "team-remove"
  | "team-no-match"
  | "team-as-member"
  | "invites"
  | "invites-empty"
  | "invites-many"
  | "invites-no-match"
  | "invite-revoke"
  | "member-view";

function tabOf(screen: Screen): Tab {
  if (screen.startsWith("team")) return "teams";
  if (screen.startsWith("invites") || screen === "invite-revoke")
    return "invites";
  return screen === "member-view" ? "teams" : "members";
}

function viewerOf(screen: Screen): Viewer {
  if (screen === "member-view" || screen === "team-as-member") return "member";
  return screen.includes("-admin") ? "admin" : "owner";
}

function MembersScreen({ screen }: { readonly screen: Screen }) {
  const viewer = viewerOf(screen);
  const tab = tabOf(screen);
  const manager = viewer === "member" ? null : viewer;
  const onTeamPage = [
    "team",
    "team-empty",
    "team-delete",
    "team-delete-manages",
    "team-add",
    "team-promote",
    "team-remove",
    "team-no-match",
    "team-as-member",
  ].includes(screen);

  let action: ReactNode;
  // A members read that failed for any reason but 403 withholds the invite.
  if (manager && tab !== "teams" && screen !== "members-error") {
    action = (
      <InviteAction
        viewer={manager}
        initialOpen={screen === "invite" || screen === "invite-admin"}
      />
    );
  } else if (manager && tab === "teams" && !onTeamPage) {
    // First-time and empty lists keep the head button too: it is the only way in.
    action = (
      <TeamCreateAction
        initialOpen={screen.startsWith("team-create")}
        taken={screen === "team-create-taken"}
      />
    );
  } else if (manager && onTeamPage) {
    action = (
      <AddMembers
        team={screen === "team-empty" ? EMPTY_TEAM : TEAM}
        initialOpen={screen === "team-add"}
      />
    );
  }

  let content: ReactNode;
  if (tab === "members" && manager) {
    content = (
      <MembersTab
        viewer={manager}
        state={
          screen === "members-loading"
            ? "loading"
            : screen === "members-error"
              ? "error"
              : "ready"
        }
        initialQuery={screen === "members-no-match" ? "없는 사람" : ""}
        initialEdit={
          screen === "member-edit" || screen === "member-edit-admin"
            ? ID.minji
            : screen === "member-edit-admin-owner"
              ? ID.dana
              : screen === "member-edit-disabled"
                ? ID.sora
                : undefined
        }
        initialDisable={screen === "member-disable" ? ID.hoon : undefined}
        initialRoleChange={
          screen === "member-role-change"
            ? { id: ID.minji, role: "admin" }
            : undefined
        }
      />
    );
  } else if (tab === "invites") {
    content = (
      <InvitesTab
        invites={
          screen === "invites-empty"
            ? []
            : screen.startsWith("invites-many") || screen === "invites-no-match"
              ? MANY_INVITES
              : INVITES
        }
        initialQuery={screen === "invites-no-match" ? "nobody" : ""}
        initialRevoke={screen === "invite-revoke" ? INVITES[0]?.id : undefined}
      />
    );
  } else if (onTeamPage) {
    content = (
      <TeamPage
        team={screen === "team-empty" ? EMPTY_TEAM : TEAM}
        manages={manager !== null}
        initialDelete={screen === "team-delete"}
        initialPromote={screen === "team-promote" ? ID.minji : undefined}
        initialRemove={screen === "team-remove" ? ID.minji : undefined}
        initialQuery={screen === "team-no-match" ? "없는 사람" : ""}
        manages409={screen === "team-delete-manages"}
      />
    );
  } else if (manager) {
    content = (
      <TeamsTab
        teams={screen === "teams-empty" ? [] : TEAMS}
        initialQuery={screen === "teams-no-match" ? "없는 팀" : ""}
      />
    );
  } else {
    content = <MyTeams teams={MY_TEAMS} />;
  }

  return (
    <ScreenShell current="members" crumb={["구성원"]} role={viewer}>
      <MembersLayout
        manages={manager !== null}
        tab={tab}
        onTeamList={tab === "teams" && !onTeamPage}
        action={action}
      >
        {content}
      </MembersLayout>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Members (v3)",
  component: MembersScreen,
  parameters: { layout: "fullscreen" },
  args: { screen: "members" },
} satisfies Meta<typeof MembersScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Members: Story = {};
// Apart from Members, so the list's own story is not left under the dialog.
export const MemberRowOpensEdit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Verify Minji 편집" }),
    );
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(
        body.getByRole("dialog", { name: "구성원 편집" }),
      ).toBeInTheDocument(),
    );
  },
};
export const MembersAsAdmin: Story = {
  name: "Members (admin: owner rows locked)",
  args: { screen: "members-admin" },
};
export const MembersLoading: Story = { args: { screen: "members-loading" } };
export const MembersError: Story = { args: { screen: "members-error" } };
export const MembersNoMatch: Story = {
  name: "Members (search: no match)",
  args: { screen: "members-no-match" },
};
export const MemberEdit: Story = {
  name: "Member edit (role)",
  args: { screen: "member-edit" },
};
export const MemberEditAsAdmin: Story = {
  name: "Member edit (admin)",
  args: { screen: "member-edit-admin" },
};
export const MemberEditOwnerAsAdmin: Story = {
  name: "Member edit (admin on an owner: locked)",
  args: { screen: "member-edit-admin-owner" },
};
export const MemberEditDisabled: Story = {
  name: "Member edit (disabled member: locked)",
  args: { screen: "member-edit-disabled" },
};
export const MemberRoleChange: Story = {
  name: "Member role change (confirm)",
  args: { screen: "member-role-change" },
};
export const MemberDisable: Story = { args: { screen: "member-disable" } };
export const Invite: Story = {
  name: "Invite (head button → dialog)",
  args: { screen: "invite" },
};
export const InviteAsAdmin: Story = {
  name: "Invite (admin: owner role withheld)",
  args: { screen: "invite-admin" },
};
export const Teams: Story = { args: { screen: "teams" } };
export const TeamsEmpty: Story = { args: { screen: "teams-empty" } };
export const TeamCreate: Story = {
  name: "Team create (head button → dialog)",
  args: { screen: "team-create" },
};
export const TeamCreateMobile: Story = {
  name: "Team create (390px)",
  args: { screen: "team-create" },
  globals: MOBILE,
};
export const TeamCreateTaken: Story = {
  name: "Team create (name taken)",
  args: { screen: "team-create-taken" },
};
export const TeamDetail: Story = {
  name: "Team detail (inside 팀 tab)",
  args: { screen: "team" },
};
export const TeamDetailEmpty: Story = { args: { screen: "team-empty" } };
export const TeamDetailAsMember: Story = {
  name: "Team detail (member: read only)",
  args: { screen: "team-as-member" },
};
export const TeamDelete: Story = { args: { screen: "team-delete" } };
export const TeamDeleteManagesAgents: Story = {
  name: "Team delete refused (managing team, 409)",
  args: { screen: "team-delete-manages" },
};
export const TeamRolePromote: Story = {
  name: "Team detail (팀 관리자로 올리기: 확인)",
  args: { screen: "team-promote" },
};
export const TeamMemberRemove: Story = {
  name: "Team detail (제외: 확인)",
  args: { screen: "team-remove" },
};
export const TeamDetailNoMatch: Story = {
  name: "Team detail (search: no match)",
  args: { screen: "team-no-match" },
};
export const TeamsNoMatch: Story = {
  name: "Teams (search: no match)",
  args: { screen: "teams-no-match" },
};
export const TeamsEmptyMobile: Story = {
  name: "Teams (empty, 390px)",
  args: { screen: "teams-empty" },
  globals: MOBILE,
};
export const TeamsMobile: Story = {
  name: "Teams (390px)",
  args: { screen: "teams" },
  globals: MOBILE,
};
export const TeamsDark: Story = {
  name: "Teams (dark)",
  args: { screen: "teams" },
  globals: { theme: "dark" },
};
export const TeamDetailDark: Story = {
  name: "Team detail (dark)",
  args: { screen: "team" },
  globals: { theme: "dark" },
};
export const TeamDetailMobile: Story = {
  name: "Team detail (390px)",
  args: { screen: "team" },
  globals: MOBILE,
};
export const TeamAddMembers: Story = {
  name: "Team detail (구성원 추가)",
  args: { screen: "team-add" },
};
export const Invites: Story = { args: { screen: "invites" } };
export const InvitesEmpty: Story = { args: { screen: "invites-empty" } };
export const InvitesWithSearch: Story = { args: { screen: "invites-many" } };
export const InvitesNoMatch: Story = { args: { screen: "invites-no-match" } };
export const InviteRevoke: Story = { args: { screen: "invite-revoke" } };
export const MemberView: Story = {
  name: "As member (내가 속한 팀)",
  args: { screen: "member-view" },
};

export const MembersDark: Story = {
  name: "Members (dark)",
  globals: { theme: "dark" },
};
export const MembersMobile: Story = {
  name: "Members (390px)",
  globals: MOBILE,
};
export const TeamDetailMobileDark: Story = {
  name: "Team detail (390px, dark)",
  args: { screen: "team" },
  globals: { ...MOBILE, theme: "dark" },
};
