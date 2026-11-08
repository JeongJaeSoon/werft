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
  Avatar,
  avatarInitials,
  avatarTone,
  Badge,
  Button,
  buttonVariants,
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
  RadioGroup,
  RadioGroupItem,
  RowAction,
  Section,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { ArrowLeft, ChevronRight, Plus, X } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import {
  agentSummariesQuery,
  memberPagesQuery,
  memberSummariesQuery,
  queryKeysOf,
  teamPagesQuery,
  teamQuery,
} from "../api/queries.ts";
import {
  refusalText,
  roleLabel,
  useHasPermission,
  useRole,
} from "../auth/guard.tsx";
import { Notice } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { MyTeams } from "../components/my-teams.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import {
  SEARCH_MAX,
  SEARCH_SETTLE_MS,
  useSearchTerm,
} from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";

// The name and its button share a row; the button drops under the field only
// when the row is too narrow for both.
const INLINE_FORM = "flex max-w-xl flex-wrap items-end gap-2";
const NAME_FIELD = "min-w-0 flex-[1_1_14rem]";

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

function TeamNameField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field className={NAME_FIELD}>
      <FieldLabel>{t("teams.name")}</FieldLabel>
      <Input
        name="team-name"
        required
        maxLength={100}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** Teams: groups of people an owner or admin manages (design 4.7). */
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

  if (!manages) {
    return (
      <TeamsTab>
        <MyTeams showEmpty />
      </TeamsTab>
    );
  }

  // Creating a team is the page head's button (TeamCreateDialog). The intro
  // is the page's description line here, so the tab opens on the search box
  // like the 구성원 tab does.
  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      {isApiError(teams.error, "FORBIDDEN") ? null : (
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
      {isApiError(teams.error, "FORBIDDEN") ? <MyTeams showEmpty /> : null}
    </div>
  );
}

// The same frame as the 구성원 table; the count and its arrow share the
// second track, so every row's arrow lines up.
const TEAM_COLUMNS = "minmax(0,1fr) 9rem";

function TeamTable({
  items,
}: {
  readonly items: readonly { id: string; name: string; member_count: number }[];
}) {
  const { t } = useI18n();
  return (
    // The padding keeps the opener's focus ring inside the scroller's clip.
    <div className="-m-1 grid overflow-x-auto p-1">
      <GridTable
        aria-label={t("teams.listLabel")}
        columns={TEAM_COLUMNS}
        framed={true}
      >
        <GridTableHeader>
          <GridTableColumnHeader>
            {t("teams.column.team")}
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            {t("teams.column.members")}
          </GridTableColumnHeader>
        </GridTableHeader>
        {items.map((team) => (
          <GridTableRow key={team.id}>
            <GridTableCell>
              <GridTableRowOpener
                asChild
                aria-label={t("teams.open", { name: team.name })}
              >
                <Link
                  to="/members/teams/$teamId"
                  params={{ teamId: team.id }}
                />
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
                className="ml-auto size-4 shrink-0 text-subtle-foreground"
              />
            </GridTableCell>
          </GridTableRow>
        ))}
      </GridTable>
    </div>
  );
}

/** The 팀 tab of 구성원: what teams are for, then the tab's own sections. */
function TeamsTab({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-[var(--werft-space-section)]">
      <Text variant="sub">{t("teams.intro")}</Text>
      {children}
    </div>
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
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const back = (
    <Link
      to="/members/teams"
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      {t("teams.back")}
    </Link>
  );

  if (team.isPending) return <StatusScreen kind="loading" />;
  // Inside the 팀 tab (v3 M-03): the page head stays 구성원, the team's name
  // heads the tab with the way back beside it.
  return (
    <div className="flex flex-col gap-[var(--werft-space-section)]">
      <div className="flex items-start justify-between gap-4">
        <Heading className="min-w-0 [overflow-wrap:anywhere]">
          {team.error ? t("teams.title") : team.data.name}
        </Heading>
        {back}
      </div>
      {team.error ? (
        <ListError error={team.error} onRetry={() => void team.refetch()} />
      ) : (
        <>
          <OutcomeLine outcome={outcome} live={true} />
          {manages && <TeamSettings team={team.data} onOutcome={setOutcome} />}
          <TeamMembers
            team={team.data}
            manages={manages}
            onOutcome={setOutcome}
          />
          {manages && (
            <TeamDangerZone team={team.data} onOutcome={setOutcome} />
          )}
        </>
      )}
    </div>
  );
}

function TeamSettings({
  team,
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [name, setName] = useState(team.name);
  const path = { params: { path: { team_id: team.id } } };

  const fail = (error: ApiError) =>
    onOutcome({
      kind: "error",
      text:
        error.code === "ALREADY_EXISTS"
          ? t("teams.nameTaken")
          : refusalText(t, error, "team.manage", role),
    });

  const rename = useMutation<TeamChangeResponse, ApiError>({
    mutationFn: () =>
      unwrap(
        client.PATCH("/v1/teams/{team_id}", {
          ...path,
          body: { name: name.trim() },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async ({ team: renamed }) => {
      onOutcome({
        kind: "notice",
        text: t("teams.renamed", { name: renamed.name }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).teams,
      });
    },
    onError: fail,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    rename.mutate();
  };

  return (
    <Section title={t("teams.settings")} titleAs="h3">
      <form className={INLINE_FORM} onSubmit={submit}>
        <TeamNameField value={name} onChange={setName} />
        <Button
          type="submit"
          variant="outline"
          disabled={rename.isPending || name.trim() === team.name}
        >
          {t("teams.rename")}
        </Button>
      </form>
    </Section>
  );
}

/** Deleting the team, last on the page, in the settings' danger zone. */
function TeamDangerZone({
  team,
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
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
    onMutate: () => {
      onOutcome(null);
      setManaged(null);
    },
    onSuccess: async () => {
      setConfirming(false);
      queryClient.removeQueries({
        queryKey: queryKeysOf(client).team(team.id),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).teams,
      });
      await navigate({ to: "/members/teams" });
    },
    onError: (error) => {
      setConfirming(false);
      const ids = managedAgentIds(error);
      if (ids) {
        setManaged(ids);
        return;
      }
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "team.manage", role),
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
          actionLabel={t("teams.delete")}
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
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly manages: boolean;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  // Managers read the roles of this team's people only; the picker searches
  // the workspace on its own. A team's own members never ask.
  const members = useQuery({
    ...memberSummariesQuery(
      client,
      team.members.map((member) => member.user_id),
    ),
    enabled: manages && team.members.length > 0,
  });
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const remove = useMutation<TeamChangeResponse, ApiError, TeamMember>({
    mutationFn: (member) =>
      unwrap(
        client.DELETE("/v1/teams/{team_id}/members/{user_id}", {
          params: { path: { team_id: team.id, user_id: member.user_id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSettled: () => setRemoving(null),
    onSuccess: async (_result, member) => {
      onOutcome({
        kind: "notice",
        text: t("teams.memberRemoved", {
          name: member.display_name ?? member.email,
        }),
      });
      await refreshTeam(queryClient, client, team.id);
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "team.manage", role),
      }),
  });

  const roles = members.isSuccess
    ? new Map(members.data.items.map((member) => [member.user_id, member.role]))
    : undefined;
  const needle = query.trim().normalize("NFKC").toLowerCase();
  const shown = needle
    ? team.members.filter((member) => matches(member, needle))
    : team.members;
  // Below 640px the date and the workspace role drop out; the name keeps
  // what the team role and the buttons leave.
  const columns = [
    "minmax(0,1fr)",
    roles && "112px",
    "96px",
    "minmax(9.5rem,0.5fr)",
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

  return (
    <Section
      title={t("teams.members")}
      titleAs="h3"
      badge={
        <Badge variant="gray">
          {t("teams.memberTotal", { count: team.members.length })}
        </Badge>
      }
      actions={
        manages ? (
          <AddMembersDialog team={team} onOutcome={onOutcome} />
        ) : undefined
      }
    >
      {team.members.length === 0 ? (
        <EmptyState title={t("teams.noMembers")} />
      ) : (
        <div className="flex flex-col gap-3">
          <ListToolbar
            filter={null}
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
            <EmptyState
              className="w-full"
              title={t("teams.noMatch")}
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
            <GridTable
              aria-label={t("teams.tableLabel")}
              columns={columns}
              narrowAt={640}
              narrowColumns={narrowColumns}
              framed={true}
            >
              <GridTableHeader>
                <GridTableColumnHeader>
                  {t("members.column.name")}
                </GridTableColumnHeader>
                {roles && (
                  <GridTableColumnHeader hideNarrow={true}>
                    {t("teams.column.workspaceRole")}
                  </GridTableColumnHeader>
                )}
                <GridTableColumnHeader>
                  {t("teams.column.teamRole")}
                </GridTableColumnHeader>
                <GridTableColumnHeader hideNarrow={true}>
                  {t("teams.column.addedAt")}
                </GridTableColumnHeader>
                {manages && (
                  <GridTableColumnHeader action={true}>
                    {t("members.column.actions")}
                  </GridTableColumnHeader>
                )}
              </GridTableHeader>
              {shown.map((member) => {
                const name = member.display_name ?? member.email;
                const memberRole = roles?.get(member.user_id);
                return (
                  <GridTableRow key={member.user_id}>
                    <GridTableCell>
                      <Avatar
                        initials={avatarInitials(name)}
                        tone={avatarTone(member.user_id)}
                      />
                      <span className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
                        <Text as="span" weight="medium" truncate>
                          {name}
                        </Text>
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
                      </span>
                    </GridTableCell>
                    {roles && (
                      <GridTableCell hideNarrow={true}>
                        {memberRole && (
                          <Badge
                            variant={memberRole === "member" ? "gray" : "blue"}
                          >
                            {roleLabel(t, memberRole)}
                          </Badge>
                        )}
                      </GridTableCell>
                    )}
                    <GridTableCell>
                      <TeamRoleBadge role={member.role} />
                    </GridTableCell>
                    <GridTableCell
                      hideNarrow={true}
                      className="text-caption text-muted-foreground tabular-nums"
                    >
                      {formatTimestamp(member.added_at, locale)}
                    </GridTableCell>
                    {manages && (
                      <GridTableCell align="end">
                        <TeamRoleDialog
                          team={team}
                          member={member}
                          onOutcome={onOutcome}
                        />
                        <RowAction
                          variant="danger"
                          disabled={remove.isPending}
                          aria-label={t("teams.removeMemberFor", { name })}
                          onClick={() => setRemoving(member)}
                        >
                          {t("teams.removeMember")}
                        </RowAction>
                      </GridTableCell>
                    )}
                  </GridTableRow>
                );
              })}
            </GridTable>
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
    </Section>
  );
}

const TEAM_ROLES: readonly TeamMemberRole[] = ["lead", "member"];

export function TeamRoleBadge({ role }: { readonly role: TeamMemberRole }) {
  const { t } = useI18n();
  return (
    <Badge variant={role === "lead" ? "blue" : "gray"}>
      {t(`teams.role.${role}`)}
    </Badge>
  );
}

/**
 * A team member's role, picked here and saved with 저장: a lead administers
 * every agent the team manages from the next request on (agent-rbac (d)).
 */
function TeamRoleDialog({
  team,
  member,
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly member: TeamMember;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [open, setOpen] = useState(false);
  // Until a role is picked the dialog follows the row, so a refetch that
  // changed the role elsewhere is not saved back over.
  const [picked, setPicked] = useState<TeamMemberRole | null>(null);
  const chosen = picked ?? member.role;
  const legendId = useId();
  const name = member.display_name ?? member.email;

  const save = useMutation<TeamChangeResponse, ApiError, TeamMemberRole>({
    mutationFn: (next) =>
      unwrap(
        client.PATCH("/v1/teams/{team_id}/members/{user_id}", {
          params: { path: { team_id: team.id, user_id: member.user_id } },
          body: { role: next },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (_result, next) => {
      setOpen(false);
      onOutcome({
        kind: "notice",
        text: t("teams.roleChanged", {
          name,
          role: t(`teams.role.${next}`),
        }),
      });
      await refreshTeam(queryClient, client, team.id);
    },
    onError: (error) => {
      setOpen(false);
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "team.manage", role),
      });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return;
        setPicked(null);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <RowAction aria-label={t("teams.changeRoleFor", { name })}>
          {t("teams.changeRole")}
        </RowAction>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("teams.roleTitle")}</DialogTitle>
          <DialogDescription>
            {member.display_name === null
              ? member.email
              : `${member.display_name} · ${member.email}`}
          </DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend id={legendId} variant="label">
            {t("teams.column.teamRole")}
          </FieldLegend>
          <RadioGroup
            value={chosen}
            onValueChange={(value) => setPicked(value as TeamMemberRole)}
            disabled={save.isPending}
            aria-labelledby={legendId}
          >
            {TEAM_ROLES.map((value) => (
              <Field key={value} orientation="horizontal">
                <RadioGroupItem value={value} />
                <FieldLabel>{t(`teams.role.${value}`)}</FieldLabel>
                <FieldDescription>
                  {t(`teams.role.${value}.help`)}
                </FieldDescription>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("common.cancel")}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={save.isPending || chosen === member.role}
            onClick={() => save.mutate(chosen)}
          >
            {t("members.edit.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function AddMembersDialog({
  team,
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<readonly MemberView[]>([]);
  // What the last try came to, said inside the dialog while it stays open:
  // the page behind is hidden from assistive tech until it closes.
  const [result, setResult] = useState<Outcome | null>(null);

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
    onMutate: () => {
      setResult(null);
      onOutcome(null);
    },
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
      if (joinedText) onOutcome({ kind: "notice", text: joinedText });
      const byReason = new Map<string, string[]>();
      for (const { member, error: refusal } of failed) {
        const why = refusalText(t, refusal, "team.manage", role);
        byReason.set(why, [...(byReason.get(why) ?? []), member.display_name]);
      }
      const refused = [...byReason].map(([reason, names]) =>
        t("teams.addFailed", { names: names.join(", "), reason }),
      );
      const said = [joinedText, ...refused].filter((line) => line !== null);
      setResult(
        refused.length > 0
          ? { kind: "error", text: said.join(" ") }
          : joinedText
            ? { kind: "notice", text: joinedText }
            : null,
      );
      if (added.length > 0) await refreshTeam(queryClient, client, team.id);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (add.isPending) return;
        setResult(null);
        setPicked([]);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
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
          result={result}
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
  result,
  onSubmit,
}: {
  readonly team: TeamDetail;
  readonly picked: readonly MemberView[];
  readonly onPickedChange: (picked: readonly MemberView[]) => void;
  readonly pending: boolean;
  readonly result: Outcome | null;
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
      {[result?.kind === "error" ? result.text : null, reason].map((text) =>
        text === null ? null : (
          <Alert key={text} variant="red" role="alert">
            <AlertDescription>{text}</AlertDescription>
          </Alert>
        ),
      )}
      <Notice>{result?.kind === "notice" ? result.text : undefined}</Notice>
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
              <button
                type="button"
                className="inline-grid size-5 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-50"
                aria-label={t("teams.unpick", { name: member.display_name })}
                disabled={pending}
                onClick={() => {
                  onPickedChange(
                    picked.filter((m) => m.user_id !== member.user_id),
                  );
                  // The button leaves with its person; the search box keeps the keyboard.
                  document.getElementById(pickerId)?.focus();
                }}
              >
                <X aria-hidden="true" className="size-3" strokeWidth={2} />
              </button>
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
