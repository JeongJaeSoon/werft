import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { Agent, SetAgentManagingTeamResponse } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Button,
  NativeSelect,
  NativeSelectOption,
  Section,
  Text,
} from "@werft-ai/ui";
import { useId, useState } from "react";
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
  onOutcome,
}: {
  readonly agent: Agent;
  readonly manages: boolean;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  return (
    <Section
      title={t("managingTeam.title")}
      description={t("managingTeam.intro")}
    >
      <div className={SECTION_BODY}>
        <div className="flex flex-wrap items-center gap-2">
          <ManagingTeamName agent={agent} />
        </div>
        <NoLeadNotice teamId={agent.managing_team_id} />
        {manages ? <ChangeTeam agent={agent} onOutcome={onOutcome} /> : null}
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

function ChangeTeam({
  agent,
  onOutcome,
}: {
  readonly agent: Agent;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const limited =
    useMe()?.workspace?.settings.agent_outsider_session_visibility ===
    "managing_team";
  const { choices, error, refetch } = useTeamChoices();
  const [picked, setPicked] = useState("");
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
      setPicked("");
      onOutcome({
        kind: "notice",
        text: t("managingTeam.saved", { name: team.name }),
      });
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
    onError: (failure) =>
      onOutcome({
        kind: "error",
        text:
          (failure.details as { reason_code?: unknown } | null)?.reason_code ===
          "team_not_allowed"
            ? t("managingTeam.notAllowed")
            : refusalText(t, failure, "agent.admin.manage", role),
      }),
  });

  if (error) return <LoadFailure error={error} onRetry={refetch} />;
  if (others === undefined) return null;
  const choice = others.find((team) => team.id === picked);
  return (
    <div className="flex flex-col gap-3">
      {others.length === 0 ? (
        <Text variant="meta">{t("managingTeam.noChoices")}</Text>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (choice) set.mutate(choice);
          }}
        >
          <label className="sr-only" htmlFor={selectId}>
            {t("managingTeam.pick")}
          </label>
          <NativeSelect
            id={selectId}
            className="w-auto max-w-full"
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
          >
            <NativeSelectOption value="" disabled>
              {t("managingTeam.pickPlaceholder")}
            </NativeSelectOption>
            {others.map((team) => (
              <NativeSelectOption key={team.id} value={team.id}>
                {team.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            type="submit"
            variant="outline"
            disabled={!choice || set.isPending}
          >
            {set.isPending
              ? t("managingTeam.saving")
              : t("managingTeam.change")}
          </Button>
        </form>
      )}
      {limited ? (
        <Text variant="meta">{t("managingTeam.audience")}</Text>
      ) : null}
    </div>
  );
}
