import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  AgentAdminChangeResponse,
  AgentAdminKind,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Combobox,
  ConfirmDialog,
  EmptyState,
  RowAction,
  RowList,
  RowListItem,
  Section,
  SettingRow,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { useId, useState } from "react";
import {
  administeredAgentsQuery,
  agentAdminsQuery,
  agentListsFilter,
  memberPagesQuery,
  queryKeysOf,
  teamPagesQuery,
} from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  usePermissionReason,
  useRole,
} from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { useManagesAgent } from "./agent-access.tsx";
import { LoadFailure } from "./load-failure.tsx";
import type { Outcome } from "./outcome.tsx";
import { OPENS_ROW, ROW_LINK } from "./row-link.ts";
import { SEARCH_MAX, SEARCH_SETTLE_MS } from "./search-term.ts";
import { SECTION_BODY } from "./section-body.ts";
import { StatusScreen } from "./status-screen.tsx";
import type { Notify } from "./toast.tsx";

// Lines that wrap on a narrow screen sit a line gap apart, not RowListItem's 8px.
const ADMIN_ROW = "gap-y-[var(--werft-row-line-gap)]";

// Month/day in the product's zone, the way the console shows a short date.
const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
});

/** contracts TEAM_LIST_LIMIT: a list this long may have left agents out. */
export const ADMINISTERED_LIST_LIMIT = 200;

interface AdminListProps {
  readonly agentId: string;
  /** Marks the admin team that is also the managing team. */
  readonly managingTeamId: string;
  /** Said as a toast; only a refusal is placed on the page. */
  readonly notify: Notify;
  readonly onOutcome: (outcome: Outcome | null) => void;
}

export function AgentAdmins(props: AdminListProps) {
  const { t } = useI18n();
  return (
    <Section
      title={t("agentAdmins.title")}
      description={t("agentAdmins.intro")}
    >
      <div className={SECTION_BODY}>
        <AdminList {...props} />
      </div>
    </Section>
  );
}

function AdminList({
  agentId,
  managingTeamId,
  notify,
  onOutcome,
}: AdminListProps) {
  const manages = useManagesAgent();
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const admins = useQuery(agentAdminsQuery(client, agentId));
  const reason = usePermissionReason("agent.admin.manage", admins);
  // Asked only of roles that can list them, so an agent's own admin does
  // not leave a refused decision on every visit.
  const listsMembers = useHasPermission("member.manage");
  const listsTeams = useHasPermission("team.manage");
  // The picker asks the server once someone reaches for it, a page of people
  // and a page of teams at a time, as typing pauses.
  const [picking, setPicking] = useState(false);
  const [term, setTerm] = useState("");
  const q = term.trim() || undefined;
  const members = useInfiniteQuery({
    ...memberPagesQuery(client, q),
    enabled: listsMembers && picking,
  });
  const teams = useInfiniteQuery({
    ...teamPagesQuery(client, q),
    enabled: listsTeams && picking,
  });
  const [removing, setRemoving] = useState<{
    kind: AgentAdminKind;
    id: string;
    name: string;
  } | null>(null);
  const me = useMe();
  // Owners and admins manage every agent whatever this list says.
  const everywhere = useHasPermission("agent.admin.manage");
  const losesAccess =
    !everywhere && removing?.kind === "users" && removing.id === me?.user?.id;
  const pickerId = useId();
  const hintId = useId();

  const change = useMutation<
    AgentAdminChangeResponse,
    ApiError,
    { add: boolean; kind: AgentAdminKind; id: string; name: string }
  >({
    mutationFn: ({ add, kind, id }) =>
      unwrap(
        add
          ? client.POST("/v1/agents/{id}/admins", {
              params: { path: { id: agentId } },
              body: kind === "users" ? { user_id: id } : { team_id: id },
            })
          : client.DELETE("/v1/agents/{id}/admins/{kind}/{subject_id}", {
              params: { path: { id: agentId, kind, subject_id: id } },
            }),
      ),
    onMutate: () => onOutcome(null),
    onSettled: () => setRemoving(null),
    onSuccess: async (result, { add, name }) => {
      queryClient.setQueryData(
        queryKeysOf(client).agentAdmins(agentId),
        result.admins,
      );
      notify(t(add ? "agentAdmins.added" : "agentAdmins.removed", { name }));
      // Naming or dropping the caller (or their team) changes what they
      // administer; the list's summaries name the admins.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).administeredAgents,
        }),
        queryClient.invalidateQueries(agentListsFilter(client)),
      ]);
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "agent.admin.manage", role),
      }),
  });

  if (admins.isPending) return <StatusScreen kind="loading" />;
  if (admins.error) {
    return isApiError(admins.error, "FORBIDDEN") ? (
      <Text variant="meta">{reason}</Text>
    ) : (
      <LoadFailure error={admins.error} onRetry={() => void admins.refetch()} />
    );
  }

  const userIds = new Set(admins.data.users.map((user) => user.user_id));
  const teamIds = new Set(admins.data.teams.map((row) => row.team_id));
  const people =
    members.data?.pages
      .flatMap((page) => page.items)
      .filter(
        (member) => member.disabled_at === null && !userIds.has(member.user_id),
      ) ?? [];
  const groups =
    teams.data?.pages
      .flatMap((page) => page.items)
      .filter((row) => !teamIds.has(row.id)) ?? [];
  // "<kind>:<id>", so one picker holds people and teams.
  const options = [
    ...people.map((member) => ({
      value: `users:${member.user_id}`,
      label: member.display_name,
      description: member.email,
    })),
    ...groups.map((row) => ({
      value: `teams:${row.id}`,
      label: row.name,
      description: t("agentAdmins.team"),
    })),
  ];
  // Picking needs the member and team lists, which only owners and admins
  // read; an agent's own admin sees why the picker stays closed.
  const personReason = !listsMembers
    ? permissionReason(t, "member.manage", role)
    : members.error
      ? refusalText(t, members.error as ApiError, "member.manage", role)
      : undefined;
  const teamReason = !listsTeams
    ? permissionReason(t, "team.manage", role)
    : teams.error
      ? refusalText(t, teams.error as ApiError, "team.manage", role)
      : undefined;
  // Only when neither half can be picked is the button withheld, saying why
  // for both; a list that failed beside one that loaded is said under the
  // picker.
  const addReason =
    personReason && teamReason
      ? personReason === teamReason
        ? personReason
        : `${personReason} ${teamReason}`
      : undefined;
  // Said, not shown by disabling the picker: a picker disabled under the
  // pointer or focus greys out and drops focus to the page.
  // Only unsearched, fully read lists prove nobody is left to add.
  const nothingLeft =
    picking &&
    q === undefined &&
    members.isSuccess &&
    !members.isFetching &&
    !members.hasNextPage &&
    teams.isSuccess &&
    !teams.isFetching &&
    !teams.hasNextPage &&
    people.length === 0 &&
    groups.length === 0;
  const partial =
    addReason === undefined
      ? members.error
        ? personReason
        : teams.error
          ? teamReason
          : nothingLeft
            ? t("agentAdmins.nothingLeft")
            : undefined
      : undefined;
  // Said under the picker: the whole reason when neither half can be picked
  // (the picker is shut), else the part that failed or ran out.
  const hint = addReason ?? partial;
  const since = (at: string) => {
    const parts = new Map(
      DAY.formatToParts(new Date(at)).map((p) => [p.type, p.value] as const),
    );
    return t("agentAdmins.since", {
      date: `${parts.get("month")}/${parts.get("day")}`,
    });
  };
  // A quiet action like the repository and channel lists use; the confirm
  // dialog still stands between it and the change.
  const removeButton = (kind: AgentAdminKind, id: string, name: string) =>
    manages ? (
      <RowAction
        disabled={change.isPending}
        aria-label={t("agentAdmins.removeFor", { name })}
        onClick={() => setRemoving({ kind, id, name })}
      >
        {t("agentAdmins.remove")}
      </RowAction>
    ) : undefined;

  return (
    <>
      {admins.data.users.length + admins.data.teams.length === 0 ? (
        <EmptyState title={t("agentAdmins.empty")} />
      ) : (
        <RowList variant="joined" aria-label={t("agentAdmins.title")}>
          {admins.data.users.map((user) => {
            const name = user.display_name ?? user.email;
            return (
              <SettingRow
                key={`u:${user.user_id}`}
                title={name}
                badge={<Badge>{t("agentAdmins.person")}</Badge>}
                description={`${user.email} · ${since(user.created_at)}`}
                actions={removeButton("users", user.user_id, name)}
              />
            );
          })}
          {admins.data.teams.map((row) => (
            <SettingRow
              key={`t:${row.team_id}`}
              title={row.name}
              badge={
                <>
                  <Badge>{t("agentAdmins.team")}</Badge>
                  {row.team_id === managingTeamId ? (
                    <Badge variant="blue">
                      {t("agentAdmins.alsoManaging")}
                    </Badge>
                  ) : null}
                </>
              }
              description={
                row.team_id === managingTeamId
                  ? `${t("agentAdmins.alsoManagingNote")} · ${since(row.created_at)}`
                  : since(row.created_at)
              }
              actions={removeButton("teams", row.team_id, row.name)}
            />
          ))}
        </RowList>
      )}
      {manages ? (
        // A form so the pointer and focus listeners sit on an element that may
        // carry them; Enter never submits it (the picker takes the key).
        <form
          className="flex flex-wrap items-center gap-2"
          onPointerEnter={() => setPicking(true)}
          onFocus={() => setPicking(true)}
          onSubmit={(event) => event.preventDefault()}
        >
          <label className="sr-only" htmlFor={pickerId}>
            {t("agentAdmins.pick")}
          </label>
          <div className="w-72 max-w-full min-w-0 flex-1 sm:flex-none">
            <Combobox
              id={pickerId}
              aria-describedby={hint ? hintId : undefined}
              options={options}
              value={null}
              clearOnSelect
              maxLength={SEARCH_MAX}
              // Locked while a change is in flight: the picker clears its query on
              // select, so a choice made now would be dropped with nothing to retry.
              // Locked while a change is in flight: the picker clears its query on
              // select, so a choice made now would be dropped with nothing to retry.
              disabled={change.isPending || (!listsMembers && !listsTeams)}
              filter="none"
              onQueryChange={setTerm}
              debounceMs={SEARCH_SETTLE_MS}
              hasMore={members.hasNextPage || teams.hasNextPage}
              onLoadMore={() => {
                if (members.hasNextPage) void members.fetchNextPage();
                if (teams.hasNextPage) void teams.fetchNextPage();
              }}
              // Choosing from the results adds at once; there is no second
              // button to leave disabled.
              onValueChange={(value, option) => {
                const [kind, id] = value.split(":") as [AgentAdminKind, string];
                change.mutate({ add: true, kind, id, name: option.label });
              }}
              placeholder={t("agentAdmins.pickPlaceholder")}
              loading={members.isFetching || teams.isFetching}
              loadingMessage={t("agentAdmins.pickLoading")}
              emptyMessage={t(
                nothingLeft
                  ? "agentAdmins.nothingLeft"
                  : "agentAdmins.pickEmpty",
              )}
              resultCountMessage={(count) =>
                t("agentAdmins.pickCount", { count })
              }
            />
          </div>
          {hint ? (
            <Text id={hintId} variant="meta" className="basis-full">
              {hint}
            </Text>
          ) : null}
        </form>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("agentAdmins.removeTitle", { name: removing?.name ?? "" })}
        consequence={
          losesAccess
            ? t("agentAdmins.removeSelfConsequence")
            : t("agentAdmins.removeConsequence")
        }
        confirmLabel={t("agentAdmins.remove")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={change.isPending}
        onConfirm={() => {
          if (removing) change.mutate({ add: false, ...removing });
        }}
      />
    </>
  );
}

/**
 * The agents the viewer was named admin of. Owners and admins hold the right
 * on every agent, so a list of some would mislead them and they get nothing.
 */
export function AdministeredAgents({
  showEmpty,
}: {
  /** Off where an empty section would only be noise (home). */
  readonly showEmpty: boolean;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const everywhere = useHasPermission("agent.admin.manage");
  const administered = useQuery({
    ...administeredAgentsQuery(client),
    enabled: !everywhere,
  });
  if (everywhere || administered.isPending) return null;
  const items = administered.data?.items ?? [];
  if (!administered.error && items.length === 0 && !showEmpty) return null;

  return (
    <Section title={t("agentAdmins.mine.title")}>
      <div className={SECTION_BODY}>
        {administered.error ? (
          <LoadFailure
            error={administered.error}
            onRetry={() => void administered.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState title={t("agentAdmins.mine.empty")} />
        ) : (
          <>
            <Text variant="meta">{t("agentAdmins.mine.intro")}</Text>
            <RowList>
              {items.map((agent) => (
                <RowListItem
                  key={agent.id}
                  className={`${ADMIN_ROW} ${OPENS_ROW}`}
                >
                  <TextLink
                    asChild
                    className={`${ROW_LINK} [overflow-wrap:anywhere]`}
                  >
                    <Link to="/agents/$id" params={{ id: agent.id }}>
                      {agent.name}
                    </Link>
                  </TextLink>
                  <Text
                    as="span"
                    variant="meta"
                    className="ml-auto [overflow-wrap:anywhere]"
                  >
                    {agent.slug}
                  </Text>
                </RowListItem>
              ))}
            </RowList>
            {items.length >= ADMINISTERED_LIST_LIMIT ? (
              <Text variant="meta">
                {t("agentAdmins.mine.truncated", {
                  count: ADMINISTERED_LIST_LIMIT,
                })}
              </Text>
            ) : null}
          </>
        )}
      </div>
    </Section>
  );
}
