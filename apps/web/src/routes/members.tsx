import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useParams } from "@tanstack/react-router";
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
  EmptyState,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  formatExactTime,
  GridTableCell,
  GridTableRow,
  LinkTab,
  LinkTabs,
  Page,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  SegmentedControlItem,
  StatusText,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import { Info } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
  firstMembersQuery,
  invitesQuery,
  queryKeysOf,
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
import { INACTIVE_ROW_CLASS } from "../components/inactive-member.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { MemberTableFrame } from "../components/member-table.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import { RoleBadge } from "../components/role-badge.tsx";
import { RowMenu, RowMenuItem } from "../components/row-menu.tsx";
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
import { TeamCreateButton } from "./team-create-dialog.tsx";
import { TeamAddButton } from "./teams.tsx";

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
 * The 구성원 page: its head and the 구성원 · 팀 tabs (v3 M-01), each an
 * address of its own. A tab the viewer may not manage is not offered; 팀
 * always is, since anyone sees the teams they are in there.
 */
export function MembersLayout() {
  const { t } = useI18n();
  // One toast for the tabs and the team pages under them, so a notice
  // outlives the screen that raised it.
  return (
    <ToastProvider dismissLabel={t("common.dismiss")}>
      <MembersPage />
    </ToastProvider>
  );
}

function MembersPage() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const manages = useHasPermission("member.manage");
  const onTeams = pathname.startsWith("/members/teams");
  // The router also serves the list at "/members/teams/".
  const onTeamList = pathname.replace(/\/$/, "") === "/members/teams";
  const onMemberList = pathname.replace(/\/$/, "") === "/members";
  const managesTeams = useHasPermission("team.manage");
  const { teamId } = useParams({ strict: false });

  // The open tab's one primary action sits at the head's end, as on the
  // agents page; a team's own page adds people to that team.
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
      actions={
        onMemberList ? (
          <InviteButton />
        ) : onTeamList ? (
          <TeamCreateButton />
        ) : teamId ? (
          <TeamAddButton teamId={teamId} />
        ) : undefined
      }
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
        </LinkTabs>
        <Outlet />
      </div>
    </Page>
  );
}

type RoleFilter = "all" | WorkspaceRole;

/**
 * The 구성원 tab: the first page, more on request, searched on the server,
 * with the invites still waiting as rows of their own. Without member.manage
 * the page head already says why.
 */
export function MembersScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const manages = useHasPermission("member.manage");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const q = useSearchTerm(query);
  const members = useMemberPages(q, { enabled: manages });
  const invites = useQuery({ ...invitesQuery(client), enabled: manages });
  // The head's invite button reads this too (same cache entry); when only it
  // fails, the button is gone and this screen says why.
  const probe = useQuery({ ...firstMembersQuery(client), enabled: manages });
  const role = useRole();
  const search = useRef<HTMLInputElement>(null);
  const filterId = useId();
  // The member whose 구성원 편집 is open or still closing: a role change can
  // take the row out of the role filter, and the table must outlive it.
  const [editing, setEditing] = useState<string | null>(null);

  if (!manages) return null;

  const items = (members.data?.pages.flatMap((page) => page.items) ?? []).map(
    (member) => ({ ...member, actions: offeredActions(member) }),
  );
  // Revoked and accepted invites are history; waiting and lapsed ones are
  // what someone may still act on or ask about. The server searches members;
  // invites, which have only an email, are searched here the same way.
  const term = q?.toLowerCase();
  const invited =
    invites.data?.items.filter(
      (invite) =>
        (invite.status === "pending" || inviteLapsed(invite)) &&
        (term === undefined || invite.email.toLowerCase().includes(term)),
    ) ?? [];
  // Counts only once every member page and the invites are here: a partial
  // list would undercount the roles further down.
  const counted =
    members.isSuccess && !members.hasNextPage && invites.isSuccess;
  const countOf = (role: RoleFilter) =>
    counted
      ? [...items, ...invited].filter(
          (row) => role === "all" || row.role === role,
        ).length
      : undefined;
  const shownMembers =
    roleFilter === "all"
      ? items
      : items.filter((member) => member.role === roleFilter);
  const shownInvites =
    roleFilter === "all"
      ? invited
      : invited.filter((invite) => invite.role === roleFilter);
  // The clear button leaves with the empty state; focus goes back to the box.
  const clear = () => {
    setQuery("");
    search.current?.focus();
  };

  // Nothing to search in a list that is empty to begin with: its box holds
  // only the empty state (R4).
  const listFailed = members.error !== null && items.length === 0;
  const invitesFailed =
    invites.error !== null && !isApiError(invites.error, "FORBIDDEN");
  const probeFailed =
    probe.error !== null && !isApiError(probe.error, "FORBIDDEN");
  const sideFailure = invitesFailed
    ? invites.error
    : probeFailed
      ? probe.error
      : null;
  const listEmpty =
    !members.isPending &&
    !members.error &&
    items.length === 0 &&
    invited.length === 0 &&
    query === "";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {listEmpty ? (
        <div className="flex min-w-0 flex-col gap-4 rounded-card border bg-card p-4">
          <EmptyState title={t("members.empty")} />
        </div>
      ) : (
        <ListToolbar
          filter={
            <SegmentedControl
              id={filterId}
              aria-label={t("members.filter.label")}
              value={roleFilter}
              onValueChange={(next) => setRoleFilter(next as RoleFilter)}
            >
              <SegmentedControlItem value="all" count={countOf("all")}>
                {t("members.filter.all")}
              </SegmentedControlItem>
              {WORKSPACE_ROLE_VALUES.map((value) => (
                <SegmentedControlItem
                  key={value}
                  value={value}
                  count={countOf(value)}
                >
                  {roleLabel(t, value)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          }
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
      )}
      {listEmpty ? null : members.isPending ? (
        <StatusScreen kind="loading" />
      ) : listFailed ? (
        isApiError(members.error, "FORBIDDEN") ? (
          <StatusScreen kind="forbidden" />
        ) : (
          <LoadFailure
            error={members.error}
            onRetry={() => {
              void members.refetch();
              if (invites.error) void invites.refetch();
              // The head's invite button waits on its own read of the list.
              void queryClient.refetchQueries({
                queryKey: queryKeysOf(client).firstMembers,
              });
            }}
          />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {shownMembers.length === 0 &&
          shownInvites.length === 0 &&
          !items.some((member) => member.user_id === editing) ? (
            q !== undefined ? (
              <EmptyState
                className="w-full"
                title={t("members.noMatch")}
                description={t("members.noMatchHint")}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={clear}
                  >
                    {t("members.clearSearch")}
                  </Button>
                }
              />
            ) : roleFilter !== "all" ? (
              <EmptyState
                className="w-full"
                title={t("members.filter.empty", {
                  role: roleLabel(t, roleFilter),
                })}
              />
            ) : (
              <EmptyState className="w-full" title={t("members.empty")} />
            )
          ) : (
            <MemberTable
              items={shownMembers}
              everyone={items}
              invites={shownInvites}
              onEditing={setEditing}
              onRowGone={() =>
                document
                  .getElementById(filterId)
                  ?.querySelector<HTMLElement>("[aria-pressed=true]")
                  ?.focus()
              }
            />
          )}
          {/* The role filter sees only the pages read so far: the rest may
              still hold matches. */}
          <PagedListFooter list={members} />
        </div>
      )}
      {isApiError(invites.error, "FORBIDDEN") && !listFailed ? (
        <FormError>{refusal(t, invites.error, role)}</FormError>
      ) : null}
      {/* The members still show when only the invites or the head button's
          read failed: one alert and one retry for both. While the list has
          its own failure on screen, that alert speaks for the outage. */}
      {sideFailure !== null && !members.error ? (
        <LoadFailure
          error={sideFailure}
          onRetry={() => {
            if (invitesFailed) void invites.refetch();
            if (probeFailed) void probe.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The 구성원 tab's head button. It waits on the first member page for the
 * roles it may offer.
 */
function InviteButton() {
  const { t } = useI18n();
  const { client } = useWerft();
  const manages = useHasPermission("member.manage");
  const members = useQuery({ ...firstMembersQuery(client), enabled: manages });
  const reason = usePermissionReason("member.manage", members);
  // The read is the permission probe: when it failed, nobody knows, and the
  // list under the head says why.
  const failed = members.isError && !isApiError(members.error, "FORBIDDEN");
  if (!manages || failed) return null;
  return (
    <InviteDialog
      reason={reason}
      assignableRoles={offeredInviteRoles(members.data)}
      refusal={(error, role) => refusal(t, error, role)}
    />
  );
}

function MemberTable({
  items,
  everyone,
  invites,
  onEditing,
  onRowGone,
}: {
  /** The rows shown: the loaded members the role filter lets through. */
  readonly items: readonly MemberRow[];
  /** Every loaded member, so 구성원 편집 outlives a row the filter drops. */
  readonly everyone: readonly MemberRow[];
  readonly invites: readonly Invite[];
  readonly onEditing: (userId: string | null) => void;
  /** Takes the keyboard when the edited row is no longer shown. */
  readonly onRowGone: () => void;
}) {
  const { t, locale } = useI18n();
  const notify = useNotify();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [confirming, setConfirming] = useState<MemberRow | null>(null);
  // Roles change in 구성원 편집, not in the row (rows only disable). It
  // follows the row as the list is read again, not the row it opened on.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = everyone.find((member) => member.user_id === editingId);
  // The name button that opened 구성원 편집 gets the keyboard back.
  const editOpener = useRef<HTMLElement | null>(null);
  const editedId = useRef<string | null>(null);
  const self = useMe()?.user?.id;

  const settle = async (text: string) => {
    notify(text);
    await queryClient.invalidateQueries({
      queryKey: queryKeysOf(client).members,
    });
  };
  const fail = (error: ApiError, action: MemberAction) => {
    // Disabling and role changes are confirmed in a dialog that has closed by
    // now: the person must read why it did not happen, so the error waits to
    // be dismissed. Re-enabling has no dialog.
    notify(refusal(t, error, role, action), {
      tone: "error",
      persistent: action !== "enable",
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
    onSettled: () => setEditingId(null),
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

  return (
    <>
      <MemberTableFrame label={t("members.tableLabel")}>
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
          return (
            <GridTableRow
              key={member.user_id}
              // Not `inactive`: that greys every tone, and the status column
              // already says "정지됨" with its red dot.
              className={disabled ? INACTIVE_ROW_CLASS : undefined}
              data-disabled={disabled}
              data-member-id={member.user_id}
            >
              <GridTableCell>
                <span className="flex min-w-0 items-center gap-1.5">
                  <Text
                    as="span"
                    weight="medium"
                    truncate
                    title={member.display_name}
                  >
                    {member.display_name}
                  </Text>
                  {member.user_id === self ? (
                    <Badge variant="gray">{t("members.you")}</Badge>
                  ) : null}
                </span>
              </GridTableCell>
              <GridTableCell>
                <Text
                  as="span"
                  truncate
                  title={member.email}
                  className="text-muted-foreground"
                >
                  {member.email}
                </Text>
              </GridTableCell>
              <GridTableCell cardLabel={t("members.column.role")}>
                <RoleBadge role={member.role} />
              </GridTableCell>
              <GridTableCell cardLabel={t("members.column.status")}>
                <StatusText status={disabled ? "failed" : "done"}>
                  {t(
                    disabled
                      ? "members.state.suspended"
                      : "members.state.active",
                  )}
                </StatusText>
              </GridTableCell>
              <GridTableCell
                raised={true}
                cardLabel={t("members.column.actions")}
              >
                <RowMenu
                  label={t("members.menuFor", { name: member.display_name })}
                >
                  {(close) => (
                    <>
                      <RowMenuItem
                        reason={
                          disabled ? t("members.edit.disabledNote") : undefined
                        }
                        onSelect={() => {
                          editOpener.current = close();
                          editedId.current = member.user_id;
                          setEditingId(member.user_id);
                          onEditing(member.user_id);
                        }}
                      >
                        {t("members.edit.title")}
                      </RowMenuItem>
                      {disabled ? (
                        <RowMenuItem
                          reason={busy ? undefined : keepWhy}
                          onSelect={() => {
                            close();
                            if (!busy)
                              setAccess.mutate({ member, enable: true });
                          }}
                        >
                          {t("members.enable")}
                        </RowMenuItem>
                      ) : (
                        <RowMenuItem
                          tone="danger"
                          reason={busy ? undefined : keepWhy}
                          onSelect={() => {
                            close();
                            if (!busy) setConfirming(member);
                          }}
                        >
                          {t("members.disable")}
                        </RowMenuItem>
                      )}
                    </>
                  )}
                </RowMenu>
              </GridTableCell>
            </GridTableRow>
          );
        })}
        {invites.map((invite) => {
          const lapsed = inviteLapsed(invite);
          const expires = t(
            lapsed ? "members.invites.expiredAt" : "members.invites.expires",
            { expires: formatExactTime(invite.expires_at, locale) },
          );
          return (
            <GridTableRow
              key={invite.id}
              inactive={lapsed}
              className={lapsed ? INACTIVE_ROW_CLASS : undefined}
              data-invite-id={invite.id}
              data-expired={lapsed}
            >
              {/* An invite has no name until it is accepted: its email
                  stands in. */}
              <GridTableCell>
                <Text as="span" weight="medium" truncate title={invite.email}>
                  {invite.email}
                </Text>
              </GridTableCell>
              <GridTableCell>
                <Text
                  as="span"
                  truncate
                  title={invite.email}
                  className="text-muted-foreground"
                >
                  {invite.email}
                </Text>
              </GridTableCell>
              <GridTableCell cardLabel={t("members.column.role")}>
                <RoleBadge role={invite.role} />
              </GridTableCell>
              {/* The expiry sits behind an icon so an invite row is one line
                  tall like a member row (owner, 2026-11-16). */}
              <GridTableCell
                className="gap-1"
                cardLabel={t("members.column.status")}
              >
                <StatusText status={lapsed ? "idle" : "wait"}>
                  {t(
                    lapsed
                      ? "members.invites.state.expired"
                      : "members.invites.state.pending",
                  )}
                </StatusText>
                <Tooltip>
                  <TooltipTrigger asChild={true}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-6"
                      aria-label={t("members.invites.expiryFor", {
                        email: invite.email,
                      })}
                      data-slot="invite-expiry"
                    >
                      <Info aria-hidden="true" className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{expires}</TooltipContent>
                </Tooltip>
              </GridTableCell>
              <GridTableCell
                raised={true}
                cardLabel={lapsed ? undefined : t("members.column.actions")}
              >
                {lapsed ? null : (
                  <RowMenu label={t("members.menuFor", { name: invite.email })}>
                    {(close) => (
                      <RowMenuItem
                        tone="danger"
                        onSelect={() => {
                          close();
                          if (!revoke.isPending) setRevoking(invite);
                        }}
                      >
                        {t("members.invites.revoke")}
                      </RowMenuItem>
                    )}
                  </RowMenu>
                )}
              </GridTableCell>
            </GridTableRow>
          );
        })}
      </MemberTableFrame>
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
      {editing ? (
        <MemberEditDialog
          member={editing}
          busy={changeRole.isPending}
          // A request still out settles into this dialog, so it stays open.
          onClose={() => {
            if (!changeRole.isPending) setEditingId(null);
          }}
          onSave={(next) => changeRole.mutate({ member: editing, role: next })}
          onClosed={() => {
            onEditing(null);
            const opener = editOpener.current;
            if (opener?.isConnected) {
              opener.focus();
              return;
            }
            // The row was drawn again while the dialog was open: focus its
            // ⋯ button, which opened the dialog.
            const row = `[data-member-id="${editedId.current}"]`;
            const menu = document.querySelector<HTMLElement>(
              `${row} button[aria-haspopup=menu]`,
            );
            if (menu) menu.focus();
            else onRowGone();
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
    </>
  );
}

/**
 * 구성원 편집 (v3 MemberEdit): the role, picked here and confirmed here by
 * the one button that names the change. When the server offers no other
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
  const changed = role !== member.role;
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
        {/* What confirming does, said before the button that does it. */}
        {changed && !blocked ? (
          <FieldDescription role="status">
            {t("members.edit.result", {
              name: member.display_name,
              role: roleLabel(t, role as WorkspaceRole),
            })}{" "}
            {role === "owner"
              ? t("members.roleChangeOwnerConsequence")
              : t("members.roleChangeConsequence")}
          </FieldDescription>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={
              blocked ||
              busy ||
              !changed ||
              !verdicts[role as WorkspaceRole]?.allowed
            }
            onClick={() => onSave(role as WorkspaceRole)}
          >
            {t("members.roleChangeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The server lists an invite whose time has passed as expired. */
function inviteLapsed(invite: Invite): boolean {
  return invite.status === "expired";
}
