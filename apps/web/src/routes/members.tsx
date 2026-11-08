import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  Invite,
  MemberRefusal,
  MemberRow,
  MemberVerdict,
  MemberView,
  WorkspaceRole,
} from "@werft-ai/contracts";
import { useMemberPages, useWerft } from "@werft-ai/react";
import { ListToolbar } from "@werft-ai/react/components";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DisabledReason,
  EmptyState,
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
  LinkTab,
  LinkTabs,
  Page,
  RadioGroup,
  RadioGroupItem,
  RowAction,
  Text,
} from "@werft-ai/ui";
import { useId, useRef, useState } from "react";
import {
  firstMembersQuery,
  invitesQuery,
  queryKeysOf,
  teamPagesQuery,
} from "../api/queries.ts";
import {
  offeredActions,
  offeredInviteRoles,
  permissionReason,
  roleLabel,
  useHasPermission,
  useMe,
  usePermissionReason,
  useRole,
  WORKSPACE_ROLE_VALUES,
} from "../auth/guard.tsx";
import { FormError } from "../components/auth-page.tsx";
import {
  INACTIVE_ROW_CLASS,
  InactiveBadge,
} from "../components/inactive-member.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { ToastProvider, useNotify } from "../components/toast.tsx";
import {
  errorKey,
  type MessageKey,
  type Translate,
  useI18n,
} from "../i18n/i18n.tsx";
import { InviteDialog } from "./invite-dialog.tsx";
import { TeamCreateDialog } from "./team-create-dialog.tsx";

// Role and actions keep one width on every row, so badges and buttons line
// up under their headers; the actions track never drops below its button.
const MEMBER_COLUMNS =
  "minmax(0,1.6fr) 120px minmax(var(--werft-row-action-min-width),1fr)";
const MEMBER_NARROW_COLUMNS =
  "minmax(0,1fr) 72px var(--werft-row-action-min-width)";
// 320px of columns plus the frame's 1px border on each side.
const MEMBER_TABLE_MIN = "min-w-[322px]";

type MemberAction = "role" | "disable" | "enable";

// What each server reason says beside the control it withholds. `unchanged`
// withholds nothing: the write would answer 200 and change nothing.
const REASONS: Record<
  MemberAction,
  Partial<Record<MemberRefusal, MessageKey>>
> = {
  role: {
    self_protected: "members.roleSelf",
    owner_protected: "members.roleOwnerProtected",
    last_owner: "members.roleLastOwner",
    member_disabled: "members.edit.disabledNote",
    account_disabled: "members.roleAccountDisabled",
  },
  disable: {
    self_protected: "members.disableSelf",
    owner_protected: "members.disableOwnerProtected",
    last_owner: "members.disableLastOwner",
  },
  enable: {
    owner_protected: "members.enableOwnerProtected",
    account_disabled: "members.enableAccountDisabled",
  },
};

function reasonOf(
  t: Translate,
  action: MemberAction,
  verdict: MemberVerdict,
): string | undefined {
  if (verdict.allowed || verdict.reason === "unchanged") return undefined;
  const key = REASONS[action][verdict.reason];
  return t(key ?? errorKey(verdict.reason.toUpperCase()));
}

/**
 * What a refused member action says. The server's reasons are its error
 * codes lower-cased, so a 403 or 409 reads exactly like the reason on the
 * control the row withholds; the server's own sentence follows it.
 */
function refusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
  action?: MemberAction,
) {
  if (error.code === "FORBIDDEN")
    return permissionReason(t, "member.manage", role);
  const reason = error.code.toLowerCase() as MemberRefusal;
  // OWNER_PROTECTED on a role change is either the owner's row or the owner
  // role asked for; the error alone does not say which.
  const key =
    action && !(action === "role" && reason === "owner_protected")
      ? REASONS[action][reason]
      : undefined;
  return t(key ?? errorKey(error.code));
}

/**
 * The 구성원 page: its head and the 구성원 · 팀 · 초대 tabs (v3 M-01), each an
 * address of its own. A tab the viewer may not manage is not offered; 팀
 * always is, since anyone sees the teams they are in there.
 */
export function MembersLayout() {
  const { t } = useI18n();
  // One toast for the three tabs and the team pages under them, so a notice
  // outlives the screen that raised it.
  return (
    <ToastProvider dismissLabel={t("common.dismiss")}>
      <MembersPage />
    </ToastProvider>
  );
}

function MembersPage() {
  const { t } = useI18n();
  const notify = useNotify();
  const { client } = useWerft();
  const { pathname } = useLocation();
  const manages = useHasPermission("member.manage");
  const members = useQuery({ ...firstMembersQuery(client), enabled: manages });
  const reason = usePermissionReason("member.manage", members);
  // The read is the permission probe: when it failed, nobody knows.
  const failed = members.isError && !isApiError(members.error, "FORBIDDEN");
  const onTeams = pathname.startsWith("/members/teams");
  // The router also serves the list at "/members/teams/".
  const onTeamList = pathname.replace(/\/$/, "") === "/members/teams";
  const managesTeams = useHasPermission("team.manage");
  // The teams screen's own first page: only whether it is refused matters.
  const teams = useInfiniteQuery({
    ...teamPagesQuery(client),
    enabled: managesTeams && onTeams,
  });
  const teamReason = usePermissionReason("team.manage", teams);
  const teamsFailed = teams.isError && !isApiError(teams.error, "FORBIDDEN");

  // Each tab's one primary action, in the same place (v4 toolbar ②).
  const action = onTeams ? (
    onTeamList && managesTeams && !teamsFailed ? (
      <TeamCreateDialog
        reason={teamReason}
        onCreated={(name) => notify(t("teams.created", { name }))}
      />
    ) : undefined
  ) : manages && !failed ? (
    <InviteDialog
      reason={reason}
      assignableRoles={offeredInviteRoles(members.data)}
      refusal={(error, role) => refusal(t, error, role)}
    />
  ) : undefined;

  return (
    <Page
      title={t("members.title")}
      description={t(
        !manages
          ? "members.withheld"
          : onTeamList && managesTeams
            ? "teams.intro"
            : "members.description",
      )}
      actions={action}
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        <LinkTabs aria-label={t("members.tabs")}>
          {manages ? (
            <LinkTab asChild current={pathname === "/members"}>
              <Link to="/members" activeOptions={{ exact: true }}>
                {t("members.tab.members")}
              </Link>
            </LinkTab>
          ) : null}
          <LinkTab asChild current={onTeams}>
            <Link to="/members/teams" activeOptions={{ exact: true }}>
              {t("members.tab.teams")}
            </Link>
          </LinkTab>
          {manages ? (
            <LinkTab asChild current={pathname === "/members/invites"}>
              <Link to="/members/invites" activeOptions={{ exact: true }}>
                {t("members.tab.invites")}
              </Link>
            </LinkTab>
          ) : null}
        </LinkTabs>
        <Outlet />
      </div>
    </Page>
  );
}

/**
 * The 구성원 tab: the first page, more on request, searched on the server.
 * Without member.manage the page head already says why.
 */
export function MembersScreen() {
  const { t } = useI18n();
  const manages = useHasPermission("member.manage");
  const [query, setQuery] = useState("");
  const q = useSearchTerm(query);
  const members = useMemberPages(q, { enabled: manages });
  const search = useRef<HTMLInputElement>(null);

  if (!manages) return null;

  const items = (members.data?.pages.flatMap((page) => page.items) ?? []).map(
    (member) => ({ ...member, actions: offeredActions(member) }),
  );
  // The clear button leaves with the empty state; focus goes back to the box.
  const clear = () => {
    setQuery("");
    search.current?.focus();
  };

  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      <ListToolbar
        filter={null}
        search={{
          ref: search,
          type: "search",
          "aria-label": t("members.search"),
          placeholder: t("members.search"),
          maxLength: SEARCH_MAX,
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }}
      />
      {members.isPending ? (
        <StatusScreen kind="loading" />
      ) : members.error && items.length === 0 ? (
        isApiError(members.error, "FORBIDDEN") ? (
          <StatusScreen kind="forbidden" />
        ) : (
          <LoadFailure
            error={members.error}
            onRetry={() => void members.refetch()}
          />
        )
      ) : items.length === 0 && q !== undefined ? (
        <EmptyState
          className="w-full"
          title={t("members.noMatch")}
          description={t("members.noMatchHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={clear}>
              {t("members.clearSearch")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <MemberTable items={items} />
          <PagedListFooter list={members} />
        </div>
      )}
    </div>
  );
}

/** The 초대 tab: invites still waiting to be accepted. */
export function InvitesScreen() {
  const { client } = useWerft();
  const manages = useHasPermission("member.manage");
  const members = useQuery({ ...firstMembersQuery(client), enabled: manages });

  if (!manages) return null;

  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      {/* The invite button in the head waits on this list; say why it is gone. */}
      {members.isError && !isApiError(members.error, "FORBIDDEN") ? (
        <LoadFailure
          error={members.error}
          onRetry={() => void members.refetch()}
        />
      ) : null}
      <InviteList />
    </div>
  );
}

function MemberTable({ items }: { readonly items: readonly MemberRow[] }) {
  const { t } = useI18n();
  const notify = useNotify();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [confirming, setConfirming] = useState<MemberRow | null>(null);
  // Roles change in 구성원 편집, not in the row (rows only disable). It
  // follows the row as the list is read again, not the row it opened on.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = items.find((member) => member.user_id === editingId);
  // The name button that opened 구성원 편집 gets the keyboard back, and a
  // saved role opens its confirmation only once the editor has handed it
  // back, so the confirmation returns there too rather than to <body>.
  const editOpener = useRef<HTMLElement | null>(null);
  const saved = useRef<{ member: MemberRow; role: WorkspaceRole } | null>(null);
  // A saved role still waits here for the confirmation.
  const [roleChange, setRoleChange] = useState<{
    member: MemberRow;
    role: WorkspaceRole;
  } | null>(null);
  const self = useMe()?.user?.id;

  const settle = async (text: string) => {
    notify(text);
    await queryClient.invalidateQueries({
      queryKey: queryKeysOf(client).members,
    });
  };
  const fail = (error: ApiError, action: MemberAction) => {
    // Disabling is confirmed in a dialog that has closed by now: the person
    // must read why it did not happen, so the error waits to be dismissed.
    notify(refusal(t, error, role, action), {
      tone: "error",
      persistent: action === "disable",
    });
    // A refusal means the rows' verdicts were stale: read them again.
    if (error.status === 403 || error.status === 409) {
      void queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).members,
      });
    }
  };

  const changeRole = useMutation<
    MemberView,
    ApiError,
    { member: MemberRow; role: WorkspaceRole }
  >({
    mutationFn: ({ member, role: next }) =>
      unwrap(
        client.PATCH("/v1/members/{user_id}", {
          params: { path: { user_id: member.user_id } },
          body: { role: next },
        }),
      ),
    onSettled: () => setRoleChange(null),
    onSuccess: (updated) =>
      settle(
        t("members.roleChanged", {
          name: updated.display_name,
          role: roleLabel(t, updated.role),
        }),
      ),
    onError: (error) => fail(error, "role"),
  });

  const setAccess = useMutation<
    { member: MemberView; receipt_id: string | null },
    ApiError,
    { member: MemberRow; enable: boolean }
  >({
    mutationFn: ({ member, enable }) => {
      const params = {
        params: { path: { user_id: member.user_id } },
        body: {},
      };
      return unwrap(
        enable
          ? client.POST("/v1/members/{user_id}/enable", params)
          : client.POST("/v1/members/{user_id}/disable", params),
      );
    },
    onSuccess: async (result) => {
      setConfirming(null);
      const name = result.member.display_name;
      await settle(
        result.member.disabled_at === null
          ? t("members.enabled", { name })
          : t("members.disabled", { name }),
      );
    },
    onError: (error, { enable }) => {
      setConfirming(null);
      fail(error, enable ? "enable" : "disable");
    },
  });

  if (items.length === 0) {
    return <EmptyState title={t("members.empty")} />;
  }

  return (
    <>
      {/* Below the table's minimum the actions would cover the role badges,
          so it scrolls instead. The padding keeps the opener's focus ring,
          2px outside the row, inside the scroller's clip. */}
      <div className="-m-1 grid overflow-x-auto p-1">
        <GridTable
          aria-label={t("members.tableLabel")}
          columns={MEMBER_COLUMNS}
          narrowAt={640}
          narrowColumns={MEMBER_NARROW_COLUMNS}
          framed={true}
          className={MEMBER_TABLE_MIN}
        >
          <GridTableHeader>
            <GridTableColumnHeader>
              {t("members.column.name")}
            </GridTableColumnHeader>
            <GridTableColumnHeader>
              {t("members.column.role")}
            </GridTableColumnHeader>
            <GridTableColumnHeader action={true}>
              {t("members.column.actions")}
            </GridTableColumnHeader>
          </GridTableHeader>
          {items.map((member) => {
            const disabled = member.disabled_at !== null;
            const keepWhy = disabled
              ? reasonOf(t, "enable", member.actions.enable)
              : reasonOf(t, "disable", member.actions.disable);
            const busy =
              (changeRole.isPending &&
                changeRole.variables?.member.user_id === member.user_id) ||
              (setAccess.isPending &&
                setAccess.variables?.member.user_id === member.user_id);
            const button = disabled ? (
              <RowAction
                disabled={busy || keepWhy !== undefined}
                aria-label={t("members.enableFor", {
                  name: member.display_name,
                })}
                onClick={() => setAccess.mutate({ member, enable: true })}
              >
                {t("members.enable")}
              </RowAction>
            ) : (
              <RowAction
                disabled={busy || keepWhy !== undefined}
                aria-label={t("members.disableFor", {
                  name: member.display_name,
                })}
                onClick={() => setConfirming(member)}
              >
                {t("members.disable")}
              </RowAction>
            );
            return (
              <GridTableRow
                key={member.user_id}
                inactive={disabled}
                className={disabled ? INACTIVE_ROW_CLASS : undefined}
                data-disabled={disabled}
              >
                <GridTableCell lines={true}>
                  <GridTableRowOpener
                    aria-label={t(
                      disabled ? "members.editForDisabled" : "members.editFor",
                      { name: member.display_name },
                    )}
                    onClick={(event) => {
                      editOpener.current = event.currentTarget;
                      setEditingId(member.user_id);
                    }}
                  />
                  {/* v4 .strong: body text at weight 500, not link blue;
                      blue stays for links that move (→). */}
                  {/* Below md the "you" badge drops to its own line under
                      the name, so the name gets the whole column (QA L-17). */}
                  <span className="grid max-w-full grid-cols-[minmax(0,auto)_auto] items-center gap-y-[var(--werft-row-line-gap)] @max-md:grid-cols-[minmax(0,auto)]">
                    <Text as="span" weight="medium" truncate>
                      {member.display_name}
                    </Text>
                    {disabled ? (
                      <InactiveBadge className="ms-1.5 @max-md:col-start-1 @max-md:row-start-2 @max-md:ms-0" />
                    ) : null}
                    {member.user_id === self ? (
                      <Badge
                        variant="gray"
                        className="ms-1.5 @max-md:col-start-1 @max-md:row-start-2 @max-md:ms-0"
                      >
                        {t("members.you")}
                      </Badge>
                    ) : null}
                  </span>
                  <Text as="span" variant="meta" title={member.email}>
                    {member.email}
                  </Text>
                </GridTableCell>
                <GridTableCell>
                  <Badge variant={member.role === "member" ? "gray" : "blue"}>
                    {roleLabel(t, member.role)}
                  </Badge>
                </GridTableCell>
                <GridTableCell raised={true} align="end" className="gap-1">
                  {keepWhy ? (
                    <DisabledReason
                      reason={keepWhy}
                      label={t(
                        disabled ? "members.enableFor" : "members.disableFor",
                        { name: member.display_name },
                      )}
                    >
                      {button}
                    </DisabledReason>
                  ) : (
                    button
                  )}
                </GridTableCell>
              </GridTableRow>
            );
          })}
        </GridTable>
      </div>
      {editing ? (
        <MemberEditDialog
          member={editing}
          busy={changeRole.isPending}
          onClose={() => setEditingId(null)}
          onSave={(next) => {
            saved.current = { member: editing, role: next };
            setEditingId(null);
          }}
          onClosed={() => {
            if (editOpener.current?.isConnected) editOpener.current.focus();
            if (saved.current) setRoleChange(saved.current);
            saved.current = null;
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t("members.disableTitle", {
          name: confirming?.display_name ?? "",
        })}
        consequence={t("members.disableConsequence")}
        confirmLabel={t("members.disable")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={setAccess.isPending}
        onConfirm={() => {
          if (confirming)
            setAccess.mutate({ member: confirming, enable: false });
        }}
      />
      <ConfirmDialog
        open={roleChange !== null}
        onOpenChange={(open) => {
          if (!open) setRoleChange(null);
        }}
        title={t("members.roleChangeTitle", {
          name: roleChange?.member.display_name ?? "",
          role: roleChange ? roleLabel(t, roleChange.role) : "",
        })}
        consequence={
          roleChange?.role === "owner"
            ? t("members.roleChangeOwnerConsequence")
            : t("members.roleChangeConsequence")
        }
        confirmLabel={t("members.roleChangeConfirm")}
        cancelLabel={t("common.cancel")}
        busy={changeRole.isPending}
        onConfirm={() => {
          if (roleChange) changeRole.mutate(roleChange);
        }}
      />
    </>
  );
}

/**
 * 구성원 편집 (v3 MemberEdit): the role, picked here and saved through the
 * same confirmation the row used to raise. When the server offers no other
 * role, its reason shows and every choice is disabled; a single role it
 * withholds is disabled with its reason in place of the role's help.
 */
function MemberEditDialog({
  member,
  busy,
  onClose,
  onSave,
  onClosed,
}: {
  readonly member: MemberRow;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (role: WorkspaceRole) => void;
  /** After it has closed and would hand focus back; the screen does that. */
  readonly onClosed: () => void;
}) {
  const { t } = useI18n();
  // Until a role is picked the dialog follows the row, so a refetch that
  // changed the role elsewhere is not saved back over.
  const [picked, setPicked] = useState<string>();
  const role = picked ?? member.role;
  const legendId = useId();
  const reasonId = useId();
  const roleReasonId = useId();
  const verdicts = member.actions.change_role;
  const refusals = WORKSPACE_ROLE_VALUES.filter(
    (value) => value !== member.role,
  ).map((value) => verdicts[value]);
  // Every other role refused is the row's reason, not a role's. A state
  // reason (disabled, suspended) refuses every role, so it outranks the
  // owner grant this caller lacks.
  const rowRefusal = refusals.every((verdict) => !verdict.allowed)
    ? (refusals.find((verdict) => verdict.reason !== "owner_protected") ??
      refusals[0])
    : undefined;
  const reason = rowRefusal ? reasonOf(t, "role", rowRefusal) : undefined;
  const blocked = reason !== undefined;
  // One role refused on its own is a role this caller cannot grant.
  const withheld = (value: WorkspaceRole) => {
    const verdict = verdicts[value];
    if (blocked || verdict.allowed) return undefined;
    return verdict.reason === "owner_protected"
      ? t("members.roleOwnerGrant")
      : reasonOf(t, "role", verdict);
  };
  const withheldIds = WORKSPACE_ROLE_VALUES.filter(
    (value) => withheld(value) !== undefined,
  )
    .map((value) => `${roleReasonId}-${value}`)
    .join(" ");
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("members.edit.title")}</DialogTitle>
          <DialogDescription>
            {member.display_name} · {member.email}
          </DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend id={legendId} variant="label">
            {t("members.column.role")}
          </FieldLegend>
          {blocked ? (
            <FieldDescription id={reasonId}>{reason}</FieldDescription>
          ) : null}
          <RadioGroup
            value={role}
            onValueChange={setPicked}
            disabled={blocked || busy}
            aria-labelledby={legendId}
            // A disabled radio is out of the arrow-key loop, so its reason
            // also describes the group a keyboard user does reach.
            aria-describedby={blocked ? reasonId : withheldIds || undefined}
          >
            {WORKSPACE_ROLE_VALUES.map((value) => {
              const why = withheld(value);
              return (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem value={value} disabled={why !== undefined} />
                  <FieldLabel>{roleLabel(t, value)}</FieldLabel>
                  <FieldDescription
                    id={why ? `${roleReasonId}-${value}` : undefined}
                  >
                    {why ?? t(`members.roleHelp.${value}`)}
                  </FieldDescription>
                </Field>
              );
            })}
          </RadioGroup>
        </FieldSet>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={
              blocked || busy || !verdicts[role as WorkspaceRole]?.allowed
            }
            onClick={() => onSave(role as WorkspaceRole)}
          >
            {t("members.edit.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteList() {
  const { t, locale } = useI18n();
  const notify = useNotify();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const invites = useQuery(invitesQuery(client));
  const [revoking, setRevoking] = useState<Invite | null>(null);

  const revoke = useMutation<unknown, ApiError, Invite>({
    mutationFn: (invite) =>
      unwrap(
        client.DELETE("/v1/invites/{id}", {
          params: { path: { id: invite.id } },
        }),
      ),
    onSettled: () => setRevoking(null),
    onSuccess: async (_result, invite) => {
      notify(t("members.invites.revoked", { email: invite.email }));
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).invites,
      });
    },
    // The confirmation has closed: the person reads why it did not happen.
    onError: (error) =>
      notify(refusal(t, error, role), { tone: "error", persistent: true }),
  });

  const pending =
    invites.data?.items.filter((invite) => invite.status === "pending") ?? [];

  return (
    <>
      {invites.isPending ? (
        <StatusScreen kind="loading" />
      ) : invites.error ? (
        isApiError(invites.error, "FORBIDDEN") ? (
          <FormError>{refusal(t, invites.error, role)}</FormError>
        ) : (
          <LoadFailure
            error={invites.error}
            onRetry={() => void invites.refetch()}
          />
        )
      ) : pending.length === 0 ? (
        <EmptyState title={t("members.invites.empty")} />
      ) : (
        // Same frame and padding as the 구성원 table.
        <div className="-m-1 grid overflow-x-auto p-1">
          <GridTable
            aria-label={t("members.invites.tableLabel")}
            columns={MEMBER_COLUMNS}
            narrowAt={640}
            narrowColumns={MEMBER_NARROW_COLUMNS}
            framed={true}
            className={MEMBER_TABLE_MIN}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("members.tab.invites")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("members.column.role")}
              </GridTableColumnHeader>
              <GridTableColumnHeader action={true}>
                {t("members.column.actions")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {pending.map((invite) => {
              // The cell ellipsizes a long line; the title keeps the full time.
              const expires = t("members.invites.expires", {
                expires: formatTimestamp(invite.expires_at, locale),
              });
              return (
                <GridTableRow key={invite.id}>
                  <GridTableCell lines={true}>
                    <Text
                      as="span"
                      weight="medium"
                      truncate
                      title={invite.email}
                    >
                      {invite.email}
                    </Text>
                    <Text as="span" variant="meta" title={expires}>
                      {expires}
                    </Text>
                  </GridTableCell>
                  <GridTableCell>
                    <Badge variant={invite.role === "member" ? "gray" : "blue"}>
                      {roleLabel(t, invite.role)}
                    </Badge>
                  </GridTableCell>
                  <GridTableCell align="end">
                    <RowAction
                      variant="danger"
                      disabled={revoke.isPending}
                      aria-label={t("members.invites.revokeFor", {
                        email: invite.email,
                      })}
                      onClick={() => setRevoking(invite)}
                    >
                      {t("members.invites.revoke")}
                    </RowAction>
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
        title={t("members.invites.revokeTitle", {
          email: revoking?.email ?? "",
        })}
        consequence={t("members.invites.revokeConsequence")}
        confirmLabel={t("members.invites.revoke")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking);
        }}
      />
    </>
  );
}
