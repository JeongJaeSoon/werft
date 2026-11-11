import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { Agent, AgentRelease } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { Alert, AlertDescription, AlertTitle, Button } from "@werft-ai/ui";
import {
  agentListsFilter,
  connectionsQuery,
  queryKeysOf,
} from "../../api/queries.ts";
import { useRole } from "../../auth/guard.tsx";
import {
  runsModel,
  successorOf,
} from "../../components/connection-options.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";

/**
 * Says so when the model the active release runs is no longer on its
 * connection's model list: which model, and what to do. Nothing while the
 * connection list loads or does not name the connection.
 */
export function ModelRemovedAlert({
  agent,
  release,
}: {
  readonly agent: Pick<Agent, "id" | "auto_model_migration">;
  readonly release: AgentRelease | null;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const queryClient = useQueryClient();
  const toggle = useMutation<unknown, ApiError, boolean>({
    mutationFn: (next) =>
      unwrap(
        client.PATCH("/v1/agents/{id}", {
          params: { path: { id: agent.id } },
          body: { auto_model_migration: next },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).agent(agent.id),
      });
      await queryClient.invalidateQueries(agentListsFilter(client));
    },
  });
  const connections = useQuery(connectionsQuery(client));
  const model = release?.runtime_config_snapshot.model;
  const connection = connections.data?.items.find(
    (listed) => listed.id === release?.connection_id,
  );
  if (
    release === null ||
    typeof model !== "string" ||
    connection === undefined ||
    runsModel(connection, model)
  ) {
    return null;
  }
  const successor = successorOf(connection, model);
  const params = { model, connection: connection.id };
  const switchButton = (next: boolean) => (
    <Button
      size="sm"
      variant="outline"
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(next)}
    >
      {t(next ? "agent.modelMoves.turnOn" : "agent.modelMoves.turnOff")}
    </Button>
  );
  const refusal = toggle.error
    ? agentRefusal(t, toggle.error, role)
    : undefined;
  if (successor === undefined) {
    return (
      <Alert variant="amber" className="border-0">
        <AlertTitle>{t("agent.modelRemoved.title", params)}</AlertTitle>
        <AlertDescription>{t("agent.modelRemoved.text")}</AlertDescription>
      </Alert>
    );
  }
  const on = agent.auto_model_migration;
  return (
    <Alert variant={on ? "blue" : "amber"} className="border-0">
      <AlertTitle>
        {t(on ? "agent.modelMoves.title" : "agent.modelMoves.offTitle", {
          ...params,
          successor,
        })}
      </AlertTitle>
      <AlertDescription>
        {t(on ? "agent.modelMoves.text" : "agent.modelMoves.offText", {
          model,
          successor,
        })}
        <span className="mt-2 flex flex-wrap items-center gap-2">
          {switchButton(!on)}
          {refusal ? <span role="alert">{refusal}</span> : null}
        </span>
      </AlertDescription>
    </Alert>
  );
}
