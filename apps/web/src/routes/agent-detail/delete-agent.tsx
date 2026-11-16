import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { Agent } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { ConfirmDialog, DangerZone, DangerZoneRow } from "@werft-ai/ui";
import { useState } from "react";
import { queryKeysOf } from "../../api/queries.ts";
import { refusalText, useRole } from "../../auth/guard.tsx";
import { OutcomeLine } from "../../components/outcome.tsx";
import { useI18n } from "../../i18n/i18n.tsx";

/** Deleting the agent, last in its settings, for whoever manages it. */
export function AgentDangerZone({ agent }: { readonly agent: Agent }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const role = useRole();
  const [confirming, setConfirming] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const remove = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.DELETE("/v1/agents/{id}", {
          params: { path: { id: agent.id } },
        }),
      ),
    onMutate: () => setRefused(null),
    onSuccess: async () => {
      setConfirming(false);
      const keys = queryKeysOf(client);
      queryClient.removeQueries({ queryKey: keys.agent(agent.id) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.agents }),
        queryClient.invalidateQueries({ queryKey: keys.administeredAgents }),
      ]);
      // The list no longer shows it; there is no page left to say more.
      await navigate({ to: "/agents" });
    },
    onError: (error) => {
      setConfirming(false);
      setRefused(refusalText(t, error, "agent.manage", role));
    },
  });

  return (
    <>
      <OutcomeLine
        outcome={refused === null ? null : { kind: "error", text: refused }}
      />
      <DangerZone title={t("workspace.danger")}>
        <DangerZoneRow
          title={t("agent.delete")}
          description={t("agent.deleteHint")}
          actionLabel={t("workspace.delete")}
          disabled={remove.isPending}
          onAction={() => setConfirming(true)}
        />
      </DangerZone>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("agent.deleteTitle", { name: agent.name })}
        consequence={t("agent.deleteConsequence")}
        confirmLabel={t("agent.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
