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
  GridTableCell,
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
import { MemberTableFrame } from "../components/member-table.tsx";
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
import { TeamHeadAction } from "./teams.tsx";

// Past more invites than this the list is searched like the member list.
export const INVITE_SEARCH_THRESHOLD = 10;

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
    ) : !onTeamList ? (
      <TeamHeadAction />
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

  if (items.length === 0) {
    return <EmptyState title={t("members.empty")} />;
  }

  return (
    <>
      <MemberTableFrame
        label={t("members.tableLabel")}
        firstColumn={t("members.column.name")}
      >
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
              data-member-id={member.user_id}
            >
              <GridTableCell lines={true}>
                {/* A disabled member opens nothing: no opener, so no pointer,
                      hover fill, Tab stop or click. "다시 활성화" is the only
                      action left on the row. */}
                {disabled ? null : (
                  <GridTableRowOpener
                    aria-label={t("members.editFor", {
                      name: member.display_name,
                    })}
                    onClick={(event) => {
                      editOpener.current = event.currentTarget;
                      editedId.current = member.user_id;
                      setEditingId(member.user_id);
                    }}
                  />
                )}
                {/* v4 .strong: body text at weight 500, not link blue;
                      blue stays for links that move (→). */}
                {/* Below md the "you" badge drops to its own line under
                      the name, so the name gets the whole column (QA L-17). */}
                <span className="grid max-w-full grid-cols-[minmax(0,auto)_auto] items-center gap-y-[var(--werft-row-line-gap)] @max-md:grid-cols-[minmax(0,auto)]">
                  <Text
                    as="span"
                    weight="medium"
                    title={member.display_name}
                    className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]"
                  >
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
      </MemberTableFrame>
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
            const opener = editOpener.current;
            if (opener?.isConnected) {
              opener.focus();
              return;
            }
            // The member was disabled while the dialog was open, so the row
            // lost its opener: focus what the row still offers instead, the
            // button or, when the server withholds it, the box that says why.
            const row = `[data-member-id="${editedId.current}"]`;
            document
              .querySelector<HTMLElement>(
                `${row} button:not(:disabled), ${row} [data-slot=disabled-reason]`,
              )
              ?.focus();
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

  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  // Revoked and accepted invites are history; waiting and lapsed ones are
  // what someone may still act on or ask about.
  const listed =
    invites.data?.items.filter(
      (invite) => invite.status === "pending" || inviteLapsed(invite),
    ) ?? [];
  const term = query.trim().toLowerCase();
  const shown = term
    ? listed.filter((invite) => invite.email.toLowerCase().includes(term))
    : listed;
  // Once shown the box stays: a revoke that brings the list under the
  // threshold must not remove the field that holds the focus.
  const [shownBefore, setShownBefore] = useState(false);
  const searchable =
    shownBefore || listed.length > INVITE_SEARCH_THRESHOLD || query !== "";
  if (searchable && !shownBefore) setShownBefore(true);
  // The clear button leaves with the empty state; focus goes back to the box.
  const clear = () => {
    setQuery("");
    search.current?.focus();
  };

  return (
    <>
      {searchable ? (
        <ListToolbar
          filter={null}
          search={{
            ref: search,
            type: "search",
            "aria-label": t("members.invites.search"),
            placeholder: t("members.invites.search"),
            maxLength: SEARCH_MAX,
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }}
        />
      ) : null}
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
      ) : listed.length === 0 ? (
        <EmptyState title={t("members.invites.empty")} />
      ) : shown.length === 0 ? (
        <EmptyState
          className="w-full"
          title={t("members.invites.noMatch")}
          description={t("members.invites.noMatchHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={clear}>
              {t("members.clearSearch")}
            </Button>
          }
        />
      ) : (
        <MemberTableFrame
          label={t("members.invites.tableLabel")}
          firstColumn={t("members.tab.invites")}
        >
          {shown.map((invite) => {
            const lapsed = inviteLapsed(invite);
            // The cell ellipsizes a long line; the title keeps the full time.
            const expires = t(
              lapsed ? "members.invites.expiredAt" : "members.invites.expires",
              { expires: formatTimestamp(invite.expires_at, locale) },
            );
            return (
              <GridTableRow
                key={invite.id}
                inactive={lapsed}
                className={lapsed ? INACTIVE_ROW_CLASS : undefined}
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
                        {t("members.invites.state.expired")}
                      </Badge>
                    ) : null}
                  </span>
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
                  {lapsed ? null : (
                    <RowAction
                      disabled={revoke.isPending}
                      aria-label={t("members.invites.revokeFor", {
                        email: invite.email,
                      })}
                      onClick={() => setRevoking(invite)}
                    >
                      {t("members.invites.revoke")}
                    </RowAction>
                  )}
                </GridTableCell>
              </GridTableRow>
            );
          })}
        </MemberTableFrame>
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
