import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Code,
  Link,
  RowList,
  RowListItem,
  Skeleton,
} from "@werft-ai/ui";
import { LoadFailure } from "../../../components/load-failure.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import {
  unverifiedApp,
  useSlackBindings,
  useSlackChannels,
  useSlackState,
} from "./queries.ts";
import { dmOn, slackReason, slackState } from "./shared.ts";

export function SlackStatus({ agentId }: { readonly agentId: string }) {
  const { t } = useI18n();
  const { app, identities } = useSlackState(agentId);
  const bindings = useSlackBindings(agentId);
  const channels = useSlackChannels(agentId, "");
  const identity = identities.data?.items.find(
    (item) => item.status === "active",
  );
  const dm = bindings.data?.items.find((row) => row.surface_kind === "dm");
  const home = bindings.data?.items.find((row) => row.home);
  const homeName = channels.data?.pages
    .flatMap((page) => page.items)
    .find((channel) => channel.id === home?.external_surface_id)?.name;
  const error = app.error ?? identities.error ?? bindings.error;
  const failed = [app, identities, bindings].filter((read) => read.isError);
  const retry = () => {
    for (const read of failed) void read.refetch();
  };
  const state = slackState(error, identity, app.data?.slack_app);
  const placeholder = <Skeleton className="h-5 w-24" />;
  const bindingsLost = bindings.isError && !bindings.data;
  const unverified = unverifiedApp(app.data);
  return (
    <section
      className="flex flex-col gap-[var(--werft-space-block)]"
      aria-label={t("slack.status")}
    >
      {error ? (
        <LoadFailure
          error={error}
          guidance={slackReason(error, t)}
          kept={failed.every((read) => read.data !== undefined)}
          onRetry={retry}
        />
      ) : null}
      {unverified ? (
        <Alert variant="amber">
          <AlertTitle>{t("slack.eventsPending.title")}</AlertTitle>
          <AlertDescription>
            {t("slack.eventsPending.body")}{" "}
            <Link
              href={`https://api.slack.com/apps/${encodeURIComponent(unverified)}/event-subscriptions`}
              target="_blank"
              newTabLabel={t("slack.newTab")}
              underline="always"
            >
              {t("slack.eventsPending.open")}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <RowList variant="joined" framed={false}>
        <RowListItem className="flex flex-wrap items-center gap-x-4 gap-y-2 text-control">
          <Badge
            variant={
              state === "connected"
                ? "green"
                : state === "error"
                  ? "red"
                  : "gray"
            }
          >
            {t(`slack.state.${state}`)}
          </Badge>
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">{t("slack.botId")}</span>
            <Code>{identity?.bot_user_id ?? "—"}</Code>
          </span>
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t("slack.homeChannel")}
            </span>
            {bindings.isPending || (home && channels.isPending) ? (
              placeholder
            ) : (
              <span>
                {bindingsLost
                  ? "—"
                  : homeName
                    ? `#${homeName}`
                    : home?.external_surface_id
                      ? t("slack.channelId", { id: home.external_surface_id })
                      : t("slack.homeUnset")}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t("slack.dmSetting")}
            </span>
            {bindings.isPending ? (
              placeholder
            ) : (
              <span>
                {bindingsLost ? "—" : t(dmOn(dm) ? "slack.on" : "slack.off")}
              </span>
            )}
          </span>
        </RowListItem>
      </RowList>
    </section>
  );
}
