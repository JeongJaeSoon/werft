import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { Agent, SetAgentManagingTeamResponse } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  NativeSelect,
  NativeSelectOption,
  Section,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { useId } from "react";
import {
  agentListsFilter,
  myTeamsQuery,
  queryKeysOf,
  teamQuery,
  teamsQuery,
} from "../api/queries.ts";
import {
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { LoadFailure } from "./load-failure.tsx";
import type { Outcome } from "./outcome.tsx";
import { SECTION_BODY } from "./section-body.ts";
import type { Notify } from "./toast.tsx";

export interface TeamChoice {
  readonly id: string;
  readonly name: string;
}

export function useTeamChoices() {
  const { client } = useWerft();
  const everywhere = useHasPermission("team.manage");
  const all = useQuery({ ...teamsQuery(client), enabled: everywhere });
  const mine = useQuery({ ...myTeamsQuery(client), enabled: !everywhere });
  const read = everywhere ? all : mine;
  return {
    everywhere,
    choices: read.data?.items.map(
      (team): TeamChoice => ({ id: team.id, name: team.name }),
    ),
    error: read.error,
    refetch: () => void read.refetch(),
  };
}

export function ManagingTeamName({ agent }: { readonly agent: Agent }) {
  return (
    <Text as="span" className="[overflow-wrap:anywhere]">
      {agent.managing_team_name}
    </Text>
  );
}

export function ManagingTeam({
  agent,
  manages,
  notify,
  onOutcome,
}: {
  readonly agent: Agent;
  readonly manages: boolean;
  /** Said as a toast: a change is applied on the spot and needs no banner. */
  readonly notify: Notify;
  /** Only a refusal is placed on the page. */
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const limited =
    useMe()?.workspace?.settings.agent_outsider_session_visibility ===
    "managing_team";
  return (
    <Section
      title={t("managingTeam.title")}
      description={t("managingTeam.intro")}
    >
      <div className={SECTION_BODY}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <TextLink asChild className="[overflow-wrap:anywhere]">
            <RouterLink
              to="/members/teams/$teamId"
              params={{ teamId: agent.managing_team_id }}
            >
              {agent.managing_team_name}
            </RouterLink>
          </TextLink>
          {manages ? (
            <ChangeTeam agent={agent} notify={notify} onOutcome={onOutcome} />
          ) : null}
        </div>
        <NoLeadNotice teamId={agent.managing_team_id} />
        {manages && limited ? (
          <Text variant="meta">{t("managingTeam.audience")}</Text>
        ) : null}
      </div>
    </Section>
  );
}

function NoLeadNotice({ teamId }: { readonly teamId: string }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const everywhere = useHasPermission("team.manage");
  const mine = useQuery({ ...myTeamsQuery(client), enabled: !everywhere });
  const readable =
    everywhere ||
    (mine.data?.items.some((team) => team.id === teamId) ?? false);
  const team = useQuery({ ...teamQuery(client, teamId), enabled: readable });
  if (!team.data || team.data.members.some((m) => m.role === "lead"))
    return null;
  return (
    <Alert variant="amber">
      <AlertDescription>{t("managingTeam.noLead")}</AlertDescription>
    </Alert>
  );
}

/**
 * One control: choosing a team applies it. The select itself never holds the
 * choice (its value stays ""), so a refused change shows the old state again
 * without any undo, and it is locked while the request is out.
 */
function ChangeTeam({
  agent,
  notify,
  onOutcome,
}: {
  readonly agent: Agent;
  readonly notify: Notify;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const { choices, error, refetch } = useTeamChoices();
  const selectId = useId();
  const others = choices?.filter((team) => team.id !== agent.managing_team_id);

  const set = useMutation<SetAgentManagingTeamResponse, ApiError, TeamChoice>({
    mutationFn: (team) =>
      unwrap(
        client.PUT("/v1/agents/{id}/managing-team", {
          params: { path: { id: agent.id } },
          body: { team_id: team.id },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (_result, team) => {
      notify(t("managingTeam.saved", { name: team.name }));
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).agent(agent.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).agentAdmins(agent.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).administeredAgents,
        }),
        queryClient.invalidateQueries(agentListsFilter(client)),
      ]);
    },
    onError: (failure) => {
      const reason = (failure.details as { reason_code?: unknown } | null)
        ?.reason_code;
      onOutcome({
        kind: "error",
        text:
          reason === "team_not_allowed"
            ? t("managingTeam.notAllowed")
            : reason === "team_holding"
              ? t("managingTeam.holding")
              : refusalText(t, failure, "agent.admin.manage", role),
      });
    },
  });

  if (error) return <LoadFailure error={error} onRetry={refetch} />;
  if (others === undefined) return null;
  if (others.length === 0)
    return <Text variant="meta">{t("managingTeam.noChoices")}</Text>;
  return (
    <>
      <label className="sr-only" htmlFor={selectId}>
        {t("managingTeam.pick")}
      </label>
      <NativeSelect
        id={selectId}
        className="w-auto max-w-full"
        value=""
        disabled={set.isPending}
        onChange={(event) => {
          const team = others.find((row) => row.id === event.target.value);
          if (team) set.mutate(team);
        }}
      >
        <NativeSelectOption value="" disabled>
          {set.isPending ? t("managingTeam.saving") : t("managingTeam.change")}
        </NativeSelectOption>
        {others.map((team) => (
          <NativeSelectOption key={team.id} value={team.id}>
            {team.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </>
  );
}
