import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type components, unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import {
  FieldError,
  SettingRow,
  SettingsSection,
  Skeleton,
  Switch,
  Text,
} from "@werft-ai/ui";
import { LoadFailure } from "../../../components/load-failure.tsx";
import type { Notify } from "../../../components/toast.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import { slackKey, useSlackNotice } from "./queries.ts";
import {
  SECTION,
  SECTION_TARGET,
  slackFailure,
  slackReason,
} from "./shared.ts";

type Switchboard = components["schemas"]["GetSlackNoticeResponse"];

/**
 * The agent's conversation switch, off or shadow. Whoever reads the agent's
 * Slack tab sees it; the server says who may change it.
 */
export function SlackRolloutSection({
  agentId,
  notify,
}: {
  readonly agentId: string;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const read = useSlackNotice(agentId);
  const key = [...slackKey(client, agentId), "notice"];
  const change = useMutation({
    mutationFn: (rollout: Switchboard["rollout"]) =>
      unwrap(
        client.POST("/v1/agents/{id}/slack/notice/rollout", {
          params: { path: { id: agentId } },
          body: { rollout },
        }),
      ),
    onSuccess: (view) => {
      cache.setQueryData(key, view);
      notify(
        t(
          view.rollout === "off"
            ? "slack.rollout.savedOff"
            : "slack.rollout.savedOn",
        ),
      );
    },
    // Refused because the switch changed under the reader: show it now.
    onError: () => void cache.invalidateQueries({ queryKey: key }),
  });
  const data = read.data;
  const raised = data !== undefined && data.rollout !== "off";
  return (
    <SettingsSection
      id={SECTION.rollout}
      tabIndex={-1}
      className={SECTION_TARGET}
      titleAs="h3"
      title={t("slack.rolloutSection")}
      box={true}
    >
      {read.isPending ? (
        <Skeleton className="h-16 w-full" label={t("status.loading.title")} />
      ) : !data ? (
        <LoadFailure
          error={read.error}
          guidance={slackReason(read.error, t)}
          kept={false}
          onRetry={() => void read.refetch()}
        />
      ) : (
        <SettingRow
          title={t("slack.rollout")}
          description={t("slack.rolloutHint")}
          status={
            <Text as="span" variant="sub">
              {t(raised ? "slack.on" : "slack.off")}
            </Text>
          }
          meta={
            <>
              {data.can_approve ? null : (
                <Text as="span" variant="sub">
                  {t("slack.rollout.adminOnly")}
                </Text>
              )}
              {change.error ? (
                <FieldError>{slackFailure(change.error, t)}</FieldError>
              ) : null}
            </>
          }
          control={
            data.can_approve ? (
              <Switch
                aria-label={t("slack.rollout")}
                checked={raised}
                aria-disabled={change.isPending}
                onCheckedChange={(checked) => {
                  if (!change.isPending)
                    change.mutate(checked ? "shadow" : "off");
                }}
              />
            ) : null
          }
        />
      )}
    </SettingsSection>
  );
}
