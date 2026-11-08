import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { AgentDetail, SaveAgentResponse } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { Alert, AlertActions, Button, Heading, Text } from "@werft-ai/ui";
import { useState } from "react";
import { agentListsFilter, queryKeysOf } from "../../api/queries.ts";
import { useRole } from "../../auth/guard.tsx";
import { useProfileDisplay } from "../../components/profile-options.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { saveFailureText } from "./effective-behavior.tsx";

export function ProfileFollow({
  detail,
  manages,
}: {
  readonly detail: AgentDetail;
  readonly manages: boolean;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const profile = useProfileDisplay();
  const [outcome, setOutcome] = useState<string | null>(null);

  const raise = useMutation<SaveAgentResponse, ApiError>({
    mutationFn: () =>
      unwrap(
        client.PATCH("/v1/agents/{id}", {
          params: { path: { id: detail.agent.id } },
          body: { follow_latest_profile: true },
        }),
      ) as Promise<SaveAgentResponse>,
    onMutate: () => setOutcome(null),
    onSuccess: async ({ release, ...updated }) => {
      setOutcome(
        release.status === "failed"
          ? t("agent.profileFollow.failed", {
              reason: saveFailureText(t, release.reason),
            })
          : release.status === "superseded"
            ? t("agent.save.superseded")
            : t("agent.profileFollow.done"),
      );
      queryClient.setQueryData(
        queryKeysOf(client).agent(detail.agent.id),
        updated,
      );
      await queryClient.invalidateQueries(agentListsFilter(client));
    },
    onError: (error) => setOutcome(agentRefusal(t, error, role, profile.show)),
  });

  const step = detail.profile_rollout;
  const pinned = detail.profile_tracking === "pinned";
  if (!pinned && !step) return outcome ? <output>{outcome}</output> : null;

  const failed = step?.status === "failed";
  return (
    <Alert variant={failed ? "red" : "amber"}>
      <div className="flex min-w-0 flex-col gap-2">
        <Heading>
          {t(
            failed
              ? "agent.profileFollow.failedTitle"
              : "agent.profileFollow.pinnedTitle",
          )}
        </Heading>
        <Text as="span">
          {failed
            ? t("agent.profileFollow.failedText", {
                reason: saveFailureText(t, step.reason),
              })
            : t(
                pinned
                  ? "agent.profileFollow.pinnedText"
                  : "agent.profileFollow.pendingText",
              )}
        </Text>
        {outcome ? <output>{outcome}</output> : null}
      </div>
      {manages ? (
        <AlertActions>
          <Button
            type="button"
            variant="outline"
            disabled={raise.isPending}
            onClick={() => raise.mutate()}
          >
            {raise.isPending
              ? t("agent.profileFollow.raising")
              : t(
                  failed
                    ? "agent.profileFollow.retry"
                    : "agent.profileFollow.raise",
                )}
          </Button>
        </AlertActions>
      ) : null}
    </Alert>
  );
}
