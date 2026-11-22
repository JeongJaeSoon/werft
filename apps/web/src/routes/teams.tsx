import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  MemberView,
  TeamChangeResponse,
  TeamDetail,
  TeamMemberRole,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
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
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  GridTableCell,
  GridTableColumnHeader,
  GridTableRow,
  GridTableRowOpener,
  Heading,
  Input,
  RemoveButton,
  SegmentedControl,
  SegmentedControlItem,
  SettingsSection,
  StatusText,
  TableTime,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { ChevronRight, Pencil, Plus } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import {
  agentSummariesQuery,
  memberPagesQuery,
  queryKeysOf,
  teamPagesQuery,
  teamQuery,
} from "../api/queries.ts";
import { refusalText, useHasPermission, useRole } from "../auth/guard.tsx";
import { INACTIVE_ROW_CLASS } from "../components/inactive-member.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { MemberTableFrame } from "../components/member-table.tsx";
import { MyTeams } from "../components/my-teams.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import { RowMenu, RowMenuItem } from "../components/row-menu.tsx";
import {
  SEARCH_MAX,
  SEARCH_SETTLE_MS,
  useSearchTerm,
} from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { useNotify } from "../components/toast.tsx";
import { useI18n } from "../i18n/i18n.tsx";

type TeamMember = TeamDetail["members"][number];

function matches(member: TeamMember, needle: string): boolean {
  return [member.display_name, member.email].some(
    (text) => text?.normalize("NFKC").toLowerCase().includes(needle) ?? false,
  );
}
function ListError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  return isApiError(error, "FORBIDDEN") ? (
    <StatusScreen kind="forbidden" />
  ) : (
    <LoadFailure error={error} onRetry={onRetry} />
  );
}

/** Teams: groups of people an owner or admin manages. */
export function TeamsScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const manages = useHasPermission("team.manage");
  const [query, setQuery] = useState("");
  const q = useSearchTerm(query);
  const teams = useInfiniteQuery({
    ...teamPagesQuery(client, q),
    enabled: manages,
  });
  const items = teams.data?.pages.flatMap((page) => page.items) ?? [];
  const search = useRef<HTMLInputElement>(null);
  const clear = () => {
    setQuery("");
    search.current?.focus();
  };

  if (!manages) return <MyTeams showEmpty />;

  // Creating a team is the page head's button (TeamCreateButton). The intro
  // is the page's description line, so the tab opens on the search box like
  // the 구성원 tab does.
  const listEmpty =
    !teams.isPending && !teams.error && items.length === 0 && query === "";
  const section = (
    <div
      className={
        listEmpty
          ? "flex min-w-0 flex-col gap-4 rounded-card border bg-card p-4"
          : "flex min-w-0 flex-col gap-4"
      }
    >
      {isApiError(teams.error, "FORBIDDEN") || listEmpty ? null : (
        <ListToolbar
          filter={null}
          search={{
            ref: search,
            type: "search",
            "aria-label": t("teams.listSearch"),
            placeholder: t("teams.listSearch"),
            maxLength: SEARCH_MAX,
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }}
        />
      )}
      {teams.isPending ? (
        <StatusScreen kind="loading" />
      ) : teams.error && items.length === 0 ? (
        <ListError error={teams.error} onRetry={() => void teams.refetch()} />
      ) : items.length === 0 && q !== undefined ? (
        <EmptyState
          className="w-full"
          title={t("teams.listNoMatch")}
          description={t("teams.listNoMatchHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={clear}>
              {t("members.clearSearch")}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState title={t("teams.empty")} />
      ) : (
        <div className="flex flex-col gap-4">
          <TeamTable items={items} />
          <PagedListFooter list={teams} />
        </div>
      )}
    </div>
  );
  if (!isApiError(teams.error, "FORBIDDEN")) return section;
  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      {section}
      <MyTeams showEmpty />
    </div>
  );
}

// The same frame as the 구성원 table; the count and its arrow share the
// second track at its end, as wide as its widest cell, so every row's arrow
// closes the row and the counts end at one x.
const TEAM_COLUMNS = "minmax(0,1fr) max-content";
const TEAM_NARROW_COLUMNS = TEAM_COLUMNS;

function TeamTable({
  items,
}: {
  readonly items: readonly { id: string; name: string; member_count: number }[];
}) {
  const { t } = useI18n();
  return (
    <MemberTableFrame
      label={t("teams.listLabel")}
      layout={{
        columns: TEAM_COLUMNS,
        narrowColumns: TEAM_NARROW_COLUMNS,
        narrowAt: 640,
        align: ["start", "end"],
        headers: (
          <>
            <GridTableColumnHeader>
              {t("teams.column.team")}
            </GridTableColumnHeader>
            {/* pr-6 is the arrow and its gap, so the header ends where
                the count does. */}
            <GridTableColumnHeader className="pr-6">
              {t("teams.column.members")}
            </GridTableColumnHeader>
          </>
        ),
      }}
    >
      {items.map((team) => (
        <GridTableRow key={team.id}>
          <GridTableCell>
            <GridTableRowOpener
              asChild
              aria-label={t("teams.open", { name: team.name })}
            >
              <Link to="/members/teams/$teamId" params={{ teamId: team.id }} />
            </GridTableRowOpener>
            <Text as="span" weight="medium" truncate title={team.name}>
              {team.name}
            </Text>
          </GridTableCell>
          <GridTableCell>
            <Text as="span" variant="meta" numeric truncate>
              {t("teams.memberCount", { count: team.member_count })}
            </Text>
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-subtle-foreground"
            />
          </GridTableCell>
        </GridTableRow>
      ))}
    </MemberTableFrame>
  );
}

export function TeamDetailScreen() {
  const { teamId } = useParams({ from: "/authed/members/teams/$teamId" });
  return <TeamPage key={teamId} id={teamId} />;
}

function TeamPage({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const team = useQuery(teamQuery(client, id));
  // A team's own members read it; only managers see what changes it.
  const manages = useHasPermission("team.manage");
  if (team.isPending) return <StatusScreen kind="loading" />;
  // Inside the 팀 tab (v3 M-03): the page head stays 구성원 and the team's
  // name heads the tab. The way back is the 팀 tab above, which stays current
  // on a team's address, or the browser's back.
  return (
    <div className="flex flex-col gap-[var(--werft-space-section)]">
      <div className="flex min-w-0 items-center gap-1">
        <Heading className="min-w-0 [overflow-wrap:anywhere]">
          {team.error ? t("teams.title") : team.data.name}
        </Heading>
        {manages && !team.error ? <TeamRenameDialog team={team.data} /> : null}
      </div>
      {team.error ? (
        <ListError error={team.error} onRetry={() => void team.refetch()} />
      ) : (
        <>
          <TeamMembers team={team.data} manages={manages} />
          {manages && <TeamDangerZone team={team.data} />}
        </>
      )}
    </div>
  );
}

/**
 * The pencil beside the team's heading: the name in a dialog, so the page holds
 * no form of its own above the members.
 */
function TeamRenameDialog({ team }: { readonly team: TeamDetail }) {
  const { t } = useI18n();
  const notify = useNotify();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team.name);
  const [blank, setBlank] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The name that was refused, not a flag: a reply that comes after the box
  // was edited must not mark the new name.
  const [taken, setTaken] = useState<string | null>(null);

  const rename = useMutation<TeamChangeResponse, ApiError, string>({
    mutationFn: (submitted) =>
      unwrap(
        client.PATCH("/v1/teams/{team_id}", {
          params: { path: { team_id: team.id } },
          body: { name: submitted },
        }),
      ),
    onMutate: () => {
      setError(null);
      setTaken(null);
    },
    onSuccess: async ({ team: renamed }) => {
      setOpen(false);
      notify(t("teams.renamed", { name: renamed.name }));
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).teams,
      });
    },
    onError: (failure, submitted) => {
      if (failure.code === "ALREADY_EXISTS") setTaken(submitted);
      else setError(refusalText(t, failure, "team.manage", role));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (rename.isPending) return;
    const next = name.trim();
    if (next === "") {
      setBlank(true);
      return;
    }
    if (next === team.name) {
      setOpen(false);
      return;
    }
    rename.mutate(next);
  };

  const fieldError = blank
    ? t("teams.nameRequired")
    : name.trim() === taken
      ? t("teams.nameTaken")
      : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Open until the request answers, so its answer lands in this opening.
        if (rename.isPending) return;
        setName(team.name);
        setBlank(false);
        setError(null);
        setTaken(null);
        setOpen(next);
      }}
    >
      {/* As the trigger, the button gets the focus back when the dialog closes. */}
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          // Under the 14px heading: an 8px pencil, about half the heading's
          // size as GitHub draws its title pencil, in the faint text colour; a
          // heavier stroke keeps its lines visible. The 20px target meets
          // WCAG 2.5.8 by spacing: nothing else to press sits within 24px of
          // its centre.
          className="size-5 shrink-0 text-subtle-foreground focus-visible:text-foreground"
          aria-label={t("teams.rename")}
        >
          <Pencil aria-hidden="true" className="size-2" strokeWidth={2.5} />
        </Button>
      </DialogTrigger>
      <DialogContent>
        {/* noValidate: an empty name says so under its box, and the server
            owns the other limits. */}
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("teams.rename")}</DialogTitle>
            <DialogDescription>
              {t("teams.renameDescription")}
            </DialogDescription>
          </DialogHeader>
          {error === null ? null : (
            <Alert variant="red" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel>{t("teams.name")}</FieldLabel>
            <Input
              name="team-name"
              required
              maxLength={100}
              autoComplete="off"
              value={name}
              readOnly={rename.isPending}
              onChange={(event) => {
                setBlank(false);
                setName(event.target.value);
              }}
            />
            <FieldError>{fieldError}</FieldError>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                aria-disabled={rename.isPending || undefined}
              >
                {t("common.cancel")}
              </Button>
            </DialogClose>
            {/* aria-disabled, not disabled: Enter on it keeps the focus there. */}
            <Button type="submit" aria-disabled={rename.isPending || undefined}>
              {rename.isPending ? t("settings.saving") : t("settings.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A team page's primary action, at the page head's end like 구성원 초대 on
 * the 구성원 tab. Only for managers, once the team has been read.
 */
export function TeamAddButton({ teamId }: { readonly teamId: string }) {
  const { client } = useWerft();
  const manages = useHasPermission("team.manage");
  const team = useQuery({ ...teamQuery(client, teamId), enabled: manages });
  if (!manages || !team.data) return null;
  // The key ties the dialog's picks to one team, so going to another team
  // never carries them over.
  return <AddMembersDialog key={team.data.id} team={team.data} />;
}

/** Deleting the team, last on the page, in the settings' danger zone. */
function TeamDangerZone({ team }: { readonly team: TeamDetail }) {
  const { t } = useI18n();
  const notify = useNotify();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const role = useRole();
  const [confirming, setConfirming] = useState(false);
  // The agents the server named when it refused: this team manages them.
  const [managed, setManaged] = useState<readonly string[] | null>(null);

  const remove = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.DELETE("/v1/teams/{team_id}", {
          params: { path: { team_id: team.id } },
        }),
      ),
    onMutate: () => setManaged(null),
    onSuccess: async () => {
      setConfirming(false);
      queryClient.removeQueries({
        queryKey: queryKeysOf(client).team(team.id),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).teams,
      });
      await navigate({ to: "/members/teams" });
      // This page is gone; the toast belongs to the tabs above it.
      notify(t("teams.deleted", { name: team.name }));
    },
    onError: (error) => {
      setConfirming(false);
      const ids = managedAgentIds(error);
      if (ids) {
        setManaged(ids);
        return;
      }
      // The confirmation has closed: the person reads why it did not happen.
      notify(refusalText(t, error, "team.manage", role), {
        tone: "error",
        persistent: true,
      });
    },
  });

  return (
    <>
      {managed && <ManagedAgents ids={managed} />}
      <DangerZone title={t("workspace.danger")} titleAs="h3">
        <DangerZoneRow
          title={t("teams.delete")}
          description={t("teams.deleteHint")}
          actionLabel={t("workspace.delete")}
          disabled={remove.isPending}
          onAction={() => setConfirming(true)}
        />
      </DangerZone>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("teams.deleteTitle", { name: team.name })}
        consequence={t("teams.deleteConsequence")}
        confirmLabel={t("teams.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function managedAgentIds(error: ApiError): readonly string[] | null {
  if (error.code !== "TEAM_MANAGES_AGENTS") return null;
  const ids = (error.details as { agent_ids?: unknown } | null)?.agent_ids;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}

/** Why the team stayed: the agents it manages, each a way to move it. */
function ManagedAgents({ ids }: { readonly ids: readonly string[] }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const agents = useQuery({
    ...agentSummariesQuery(client, ids),
    enabled: ids.length > 0,
  });
  // Only the ones this caller still reads come back; the rest are counted.
  const found = agents.data?.items ?? [];
  const named = found.length > 0;
  return (
    <Alert variant="red" role="alert">
      <AlertDescription>
        {named
          ? t("teams.deleteManages")
          : t("teams.deleteManagesCount", { count: ids.length })}
      </AlertDescription>
      {named && (
        <ul
          aria-label={t("teams.deleteManagesList")}
          className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-control"
        >
          {found.map((agent) => (
            <li key={agent.id}>
              <TextLink asChild>
                <Link to="/agents/$id" params={{ id: agent.id }}>
                  {agent.name}
                </Link>
              </TextLink>
            </li>
          ))}
          {ids.length > found.length && (
            <li>
              {t("teams.deleteManagesMore", {
                count: ids.length - found.length,
              })}
            </li>
          )}
        </ul>
      )}
    </Alert>
  );
}

function TeamMembers({
  team,
  manages,
}: {
  readonly team: TeamDetail;
  readonly manages: boolean;
}) {
  const { t, locale } = useI18n();
  const notify = useNotify();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [promoting, setPromoting] = useState<TeamMember | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<TeamRoleFilter>("all");
  const search = useRef<HTMLInputElement>(null);

  // A lead administers every agent the team manages from the next request on
  // (agent-rbac (d)), so promotion asks first; demotion does not.
  const changeRole = useMutation<
    TeamChangeResponse,
    ApiError,
    { member: TeamMember; role: TeamMemberRole }
  >({
    mutationFn: ({ member, role: next }) =>
      unwrap(
        client.PATCH("/v1/teams/{team_id}/members/{user_id}", {
          params: { path: { team_id: team.id, user_id: member.user_id } },
          body: { role: next },
        }),
      ),
    onSettled: () => setPromoting(null),
    onSuccess: async (_result, { member, role: next }) => {
      notify(
        t("teams.roleChanged", {
          name: member.display_name ?? member.email,
          role: t(`teams.role.${next}`),
        }),
      );
      await refreshTeam(queryClient, client, team.id);
    },
    // A failure after the promotion's confirmation stays until read.
    onError: (error, { role: next }) =>
      notify(refusalText(t, error, "team.manage", role), {
        tone: "error",
        persistent: next === "lead",
      }),
  });

  const remove = useMutation<TeamChangeResponse, ApiError, TeamMember>({
    mutationFn: (member) =>
      unwrap(
        client.DELETE("/v1/teams/{team_id}/members/{user_id}", {
          params: { path: { team_id: team.id, user_id: member.user_id } },
        }),
      ),
    onSettled: () => setRemoving(null),
    onSuccess: async (_result, member) => {
      notify(
        t("teams.memberRemoved", { name: member.display_name ?? member.email }),
      );
      await refreshTeam(queryClient, client, team.id);
    },
    // The confirmation has closed: the person reads why it did not happen.
    onError: (error) =>
      notify(refusalText(t, error, "team.manage", role), {
        tone: "error",
        persistent: true,
      }),
  });

  const needle = query.trim().normalize("NFKC").toLowerCase();
  const found = needle
    ? team.members.filter((member) => matches(member, needle))
    : team.members;
  const countOf = (filter: TeamRoleFilter) =>
    found.filter((member) => filter === "all" || member.role === filter).length;
  const shown =
    roleFilter === "all"
      ? found
      : found.filter((member) => member.role === roleFilter);
  // The members table's tracks, with the team role and the date added; the
  // short ones as wide as their widest cell. Below 820px the name keeps what
  // the team role and the ⋯ button leave, and carries the status itself.
  const columns = [
    "minmax(0,1.3fr)",
    "minmax(0,1.5fr)",
    "max-content",
    "max-content",
    "max-content",
    manages && "max-content",
  ]
    .filter(Boolean)
    .join(" ");
  const narrowColumns = [
    "minmax(0,1fr)",
    "max-content",
    manages && "max-content",
  ]
    .filter(Boolean)
    .join(" ");
  const clear = () => {
    setQuery("");
    search.current?.focus();
  };

  const listEmpty = team.members.length === 0;

  return (
    <SettingsSection title={t("teams.members")} titleAs="h3" box={listEmpty}>
      {listEmpty ? (
        <EmptyState title={t("teams.noMembers")} />
      ) : (
        <div className="flex flex-col gap-3">
          <ListToolbar
            filter={
              <SegmentedControl
                aria-label={t("teams.filter.label")}
                value={roleFilter}
                onValueChange={(next) => setRoleFilter(next as TeamRoleFilter)}
              >
                <SegmentedControlItem value="all" count={countOf("all")}>
                  {t("members.filter.all")}
                </SegmentedControlItem>
                {TEAM_ROLES.map((value) => (
                  <SegmentedControlItem
                    key={value}
                    value={value}
                    count={countOf(value)}
                  >
                    {t(`teams.role.${value}`)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            }
            search={{
              ref: search,
              type: "search",
              "aria-label": t("teams.search"),
              placeholder: t("teams.search"),
              maxLength: SEARCH_MAX,
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }}
          />
          {shown.length === 0 ? (
            found.length === 0 ? (
              <EmptyState
                className="w-full"
                title={t("teams.noMatch")}
                description={t("teams.noMatchHint")}
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
            ) : (
              <EmptyState
                className="w-full"
                title={t("teams.filter.empty", {
                  role: t(`teams.role.${roleFilter as TeamMemberRole}`),
                })}
              />
            )
          ) : (
            <MemberTableFrame
              label={t("teams.tableLabel")}
              layout={{
                columns,
                narrowColumns,
                narrowAt: 820,
                align: [
                  "start",
                  "start",
                  "start",
                  "start",
                  "start",
                  ...(manages ? ["action" as const] : []),
                ],
                headers: (
                  <>
                    <GridTableColumnHeader>
                      {t("members.column.name")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader hideNarrow={true}>
                      {t("members.column.email")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader>
                      {t("teams.column.teamRole")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader hideNarrow={true}>
                      {t("members.column.status")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader hideNarrow={true}>
                      {t("teams.column.addedAt")}
                    </GridTableColumnHeader>
                    {manages && (
                      <GridTableColumnHeader>
                        {t("members.column.actions")}
                      </GridTableColumnHeader>
                    )}
                  </>
                ),
              }}
            >
              {shown.map((member) => {
                const name = member.display_name ?? member.email;
                const inactive = member.disabled_at !== null;
                const status = (
                  <StatusText status={inactive ? "failed" : "done"}>
                    {t(
                      inactive
                        ? "members.state.suspended"
                        : "members.state.active",
                    )}
                  </StatusText>
                );
                // One shared mutation per action: a second row's request
                // would close the first's confirmation and unlock its menu.
                const busy = changeRole.isPending || remove.isPending;
                return (
                  <GridTableRow
                    key={member.user_id}
                    // Not `inactive`, as on 구성원: the status says it.
                    className={inactive ? INACTIVE_ROW_CLASS : undefined}
                    data-disabled={inactive}
                    data-member-id={member.user_id}
                  >
                    <GridTableCell>
                      <span className="flex min-w-0 items-center gap-2">
                        <Text as="span" weight="medium" truncate title={name}>
                          {name}
                        </Text>
                        {/* Narrow, the status column is gone: a suspended
                            member says so beside the name. */}
                        {inactive ? (
                          <span className="hidden shrink-0 [@container(max-width:820px)]:inline-flex">
                            {status}
                          </span>
                        ) : null}
                      </span>
                    </GridTableCell>
                    <GridTableCell hideNarrow={true}>
                      <Text
                        as="span"
                        truncate
                        title={member.email}
                        className="text-muted-foreground"
                      >
                        {member.email}
                      </Text>
                    </GridTableCell>
                    <GridTableCell>
                      <TeamRoleBadge role={member.role} />
                    </GridTableCell>
                    <GridTableCell hideNarrow={true}>{status}</GridTableCell>
                    <GridTableCell
                      hideNarrow={true}
                      className="text-caption text-muted-foreground tabular-nums"
                    >
                      <TableTime value={member.added_at} locale={locale} />
                    </GridTableCell>
                    {manages && (
                      <GridTableCell raised={true}>
                        {/* The server refuses a role change or a removal on a
                            suspended member: its ⋯ stays, named and
                            focusable, but does not open. */}
                        <RowMenu
                          label={t("members.menuFor", { name })}
                          disabled={inactive || busy}
                        >
                          {(close) => (
                            <>
                              <RowMenuItem
                                onSelect={() => {
                                  close();
                                  if (member.role === "member")
                                    setPromoting(member);
                                  else
                                    changeRole.mutate({
                                      member,
                                      role: "member",
                                    });
                                }}
                              >
                                {t(
                                  member.role === "member"
                                    ? "teams.promoteConfirm"
                                    : "teams.demote",
                                )}
                              </RowMenuItem>
                              <RowMenuItem
                                tone="danger"
                                label={t("teams.removeMemberFor", { name })}
                                onSelect={() => {
                                  close();
                                  setRemoving(member);
                                }}
                              >
                                {t("teams.removeMember")}
                              </RowMenuItem>
                            </>
                          )}
                        </RowMenu>
                      </GridTableCell>
                    )}
                  </GridTableRow>
                );
              })}
            </MemberTableFrame>
          )}
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("teams.removeMemberTitle", {
          name: removing?.display_name ?? removing?.email ?? "",
          team: team.name,
        })}
        consequence={t("teams.removeMemberConsequence")}
        confirmLabel={t("teams.removeMember")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing);
        }}
      />
      <ConfirmDialog
        open={promoting !== null}
        onOpenChange={(open) => {
          if (!open && !changeRole.isPending) setPromoting(null);
        }}
        title={t("teams.promoteTitle", {
          name: promoting?.display_name ?? promoting?.email ?? "",
        })}
        consequence={t("teams.promoteConsequence")}
        confirmLabel={t("teams.promoteConfirm")}
        cancelLabel={t("common.cancel")}
        busy={changeRole.isPending}
        onConfirm={() => {
          if (promoting) changeRole.mutate({ member: promoting, role: "lead" });
        }}
      />
    </SettingsSection>
  );
}

const TEAM_ROLES: readonly TeamMemberRole[] = ["lead", "member"];

type TeamRoleFilter = "all" | TeamMemberRole;

function TeamRoleBadge({ role }: { readonly role: TeamMemberRole }) {
  const { t } = useI18n();
  return (
    <Badge variant={role === "lead" ? "blue" : "gray"}>
      {t(`teams.role.${role}`)}
    </Badge>
  );
}

function refreshTeam(
  queryClient: ReturnType<typeof useQueryClient>,
  client: ReturnType<typeof useWerft>["client"],
  teamId: string,
) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeysOf(client).team(teamId),
    }),
    queryClient.invalidateQueries({ queryKey: queryKeysOf(client).teams }),
  ]);
}

type AddResult = {
  readonly added: readonly MemberView[];
  readonly failed: readonly {
    readonly member: MemberView;
    readonly error: ApiError;
  }[];
};

function AddMembersDialog({ team }: { readonly team: TeamDetail }) {
  const { t } = useI18n();
  const notify = useNotify();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<readonly MemberView[]>([]);
  // Who was refused, said inside the dialog while it stays open: the page
  // behind is hidden from assistive tech until it closes. Who joined is the
  // toast's to say.
  const [refused, setRefused] = useState<string | null>(null);

  const add = useMutation<AddResult, never, readonly MemberView[]>({
    mutationFn: async (people) => {
      const added: MemberView[] = [];
      const failed: { member: MemberView; error: ApiError }[] = [];
      for (const member of people) {
        try {
          await unwrap(
            client.POST("/v1/teams/{team_id}/members", {
              params: { path: { team_id: team.id } },
              body: { user_id: member.user_id },
            }),
          );
          added.push(member);
        } catch (failure) {
          failed.push({ member, error: failure as ApiError });
        }
      }
      return { added, failed };
    },
    onMutate: () => setRefused(null),
    onSuccess: async ({ added, failed }) => {
      // Only who joined leaves the picks: the refused stay for a retry, and
      // anyone picked while the requests ran waits for the next one.
      const joined = new Set(added.map((member) => member.user_id));
      const left = picked.filter((member) => !joined.has(member.user_id));
      setPicked(left);
      if (left.length === 0) setOpen(false);
      const [first] = added;
      const joinedText = first
        ? added.length === 1
          ? t("teams.memberAdded", { name: first.display_name })
          : t("teams.membersAdded", { count: added.length })
        : null;
      if (joinedText) notify(joinedText);
      const byReason = new Map<string, string[]>();
      for (const { member, error: refusal } of failed) {
        const why = refusalText(t, refusal, "team.manage", role);
        byReason.set(why, [...(byReason.get(why) ?? []), member.display_name]);
      }
      const refusedLines = [...byReason].map(([reason, names]) =>
        t("teams.addFailed", { names: names.join(", "), reason }),
      );
      setRefused(refusedLines.length > 0 ? refusedLines.join(" ") : null);
      if (added.length > 0) await refreshTeam(queryClient, client, team.id);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (add.isPending) return;
        setRefused(null);
        setPicked([]);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          {t("teams.addOpen")}
        </Button>
      </DialogTrigger>
      {/* Many picks or a long refusal must not push the buttons off screen. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AddMembersForm
          team={team}
          picked={picked}
          onPickedChange={setPicked}
          pending={add.isPending}
          refused={refused}
          onSubmit={() => {
            if (picked.length > 0 && !add.isPending) add.mutate(picked);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// Mounted while the dialog is open, so the picker asks the server only then.
function AddMembersForm({
  team,
  picked,
  onPickedChange,
  pending,
  refused,
  onSubmit,
}: {
  readonly team: TeamDetail;
  readonly picked: readonly MemberView[];
  readonly onPickedChange: (picked: readonly MemberView[]) => void;
  readonly pending: boolean;
  readonly refused: string | null;
  readonly onSubmit: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const pickerId = useId();
  const [term, setTerm] = useState("");
  const members = useInfiniteQuery(
    memberPagesQuery(client, term.trim() || undefined),
  );
  const found = members.data?.pages.flatMap((page) => page.items);

  const taken = new Set([
    ...team.members.map((member) => member.user_id),
    ...picked.map((member) => member.user_id),
  ]);
  // Only active people can be added; a disabled membership is refused.
  const candidates =
    found?.filter(
      (member) => member.disabled_at === null && !taken.has(member.user_id),
    ) ?? [];
  const reason = members.error
    ? refusalText(t, members.error as ApiError, "member.manage", role)
    : null;
  // Only an unsearched, fully read list proves nobody is left to add.
  const noneLeft =
    members.isSuccess &&
    term.trim() === "" &&
    !members.hasNextPage &&
    candidates.length === 0;
  const nothingLeft = noneLeft && picked.length === 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("teams.addTitle", { team: team.name })}</DialogTitle>
        <DialogDescription>{t("teams.addHint")}</DialogDescription>
      </DialogHeader>
      {[refused, reason].map((text) =>
        text === null ? null : (
          <Alert key={text} variant="red" role="alert">
            <AlertDescription>{text}</AlertDescription>
          </Alert>
        ),
      )}
      <Field>
        <FieldLabel htmlFor={pickerId}>{t("teams.pickMember")}</FieldLabel>
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
          filter="none"
          onQueryChange={setTerm}
          debounceMs={SEARCH_SETTLE_MS}
          hasMore={members.hasNextPage}
          onLoadMore={() => void members.fetchNextPage()}
          onValueChange={(value) => {
            const member = candidates.find((m) => m.user_id === value);
            if (member) onPickedChange([...picked, member]);
          }}
          placeholder={t("teams.pickPlaceholder")}
          loading={members.isPending}
          loadingMessage={t("teams.pickLoading")}
          emptyMessage={t(noneLeft ? "teams.noCandidates" : "teams.pickEmpty")}
          resultCountMessage={(count) => t("teams.pickCount", { count })}
        />
      </Field>
      {picked.length > 0 && (
        <ul
          aria-label={t("teams.picked")}
          className="m-0 flex list-none flex-wrap gap-2 p-0"
        >
          {picked.map((member) => (
            <li
              key={member.user_id}
              className="inline-flex items-center gap-1 rounded-full border bg-surface-sunken py-0.5 ps-2.5 pe-0.5 text-caption"
            >
              <span className="max-w-48 truncate" title={member.email}>
                {member.display_name}
              </span>
              <RemoveButton
                aria-label={t("teams.unpick", { name: member.display_name })}
                disabled={pending}
                onClick={() => {
                  onPickedChange(
                    picked.filter((m) => m.user_id !== member.user_id),
                  );
                  // The button leaves with its person; the search box keeps the keyboard.
                  document.getElementById(pickerId)?.focus();
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {nothingLeft && <Text variant="meta">{t("teams.noCandidates")}</Text>}
      <DialogFooter>
        <DialogClose asChild>
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
          >
            {t("common.cancel")}
          </Button>
        </DialogClose>
        {/* aria-disabled, not disabled: Enter on it keeps the focus there. */}
        <Button
          type="submit"
          aria-disabled={pending || picked.length === 0 || undefined}
        >
          {picked.length > 1
            ? t("teams.addMembers", { count: picked.length })
            : t("teams.addOpen")}
        </Button>
      </DialogFooter>
    </form>
  );
}
