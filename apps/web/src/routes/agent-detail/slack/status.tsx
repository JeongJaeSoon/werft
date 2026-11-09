import {
  Alert,
  AlertDescription,
  AlertTitle,
  Code,
  Heading,
  IconTile,
  Link,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { LoadFailure } from "../../../components/load-failure.tsx";
import { useProfileDisplay } from "../../../components/profile-options.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import { SETTINGS_CARD } from "../../workspace-settings.tsx";
import { TileMark } from "../../workspace-slack.tsx";
import type { SlackApp } from "./actions.ts";
import {
  unverifiedApp,
  useSlackBindings,
  useSlackChannels,
} from "./queries.ts";
import { dmOn, SLACK_WARNING_KEY, slackReason, slackState } from "./shared.ts";

/**
 * The tab's Slack card, as on Integrations › Slack: the mark, then this
 * agent's state, bot, home channel and DM at a glance, then what stops it
 * from working.
 */
export function SlackHeader({
  agentId,
  slack,
  manages,
  connected,
}: {
  readonly agentId: string;
  readonly slack: SlackApp;
  readonly manages: boolean;
  /** Installed, now or earlier in this visit: the home and DM mean something. */
  readonly connected: boolean;
}) {
  const { t } = useI18n();
  const profile = useProfileDisplay();
  const titleId = useId();
  const { app, identities, identity, record } = slack;
  const bindings = useSlackBindings(agentId);
  const channels = useSlackChannels(agentId, "", connected);
  const dm = bindings.data?.items.find((row) => row.surface_kind === "dm");
  const home = bindings.data?.items.find((row) => row.home);
  const homeName = channels.data?.pages
    .flatMap((page) => page.items)
    .find((channel) => channel.id === home?.external_surface_id)?.name;
  const bindingsLost = bindings.isError && !bindings.data;
  const placeholder = <Skeleton className="h-4 w-20" />;
  const reads = connected ? [app, identities, bindings] : [app, identities];
  const failed = reads.filter((read) => read.isError);
  const error = failed[0]?.error ?? null;
  const retry = () => {
    for (const read of failed) void read.refetch();
  };
  const state = slackState(error, identity, record);
  const unverified = unverifiedApp(app.data);
  // At most one reason sessions would fail, after any token issuer change.
  const warnings = manages ? (app.data?.warnings ?? []) : [];
  const item = (label: string, value: ReactNode) => (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className="text-foreground">{value}</span>
    </span>
  );
  return (
    <section aria-labelledby={titleId} className={SETTINGS_CARD}>
      <div className="flex items-center gap-3">
        <IconTile icon={TileMark} hue="slate" size="two-line" />
        <div className="flex min-w-0 flex-1 flex-col">
          <Heading id={titleId} level={2}>
            Slack
          </Heading>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-control text-muted-foreground">
            <span className="text-foreground">
              {app.isPending ? placeholder : t(`slack.state.${state}`)}
            </span>
            {item(
              t("slack.botId"),
              <Code>{identity?.bot_user_id ?? "—"}</Code>,
            )}
            {connected
              ? item(
                  t("slack.homeChannel"),
                  bindings.isPending || (home && channels.isPending)
                    ? placeholder
                    : bindingsLost
                      ? "—"
                      : homeName
                        ? `#${homeName}`
                        : home?.external_surface_id
                          ? t("slack.channelId", {
                              id: home.external_surface_id,
                            })
                          : t("slack.homeUnset"),
                )
              : null}
            {connected
              ? item(
                  t("slack.dmSetting"),
                  bindings.isPending
                    ? placeholder
                    : bindingsLost
                      ? "—"
                      : t(dmOn(dm) ? "slack.on" : "slack.off"),
                )
              : null}
          </div>
        </div>
      </div>
      <Text variant="sub">{t("slack.cardHint")}</Text>
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
      {warnings.map((warning) => (
        <Alert key={warning.code} variant="amber">
          <AlertTitle>{t(SLACK_WARNING_KEY[warning.code].title)}</AlertTitle>
          <AlertDescription>
            {t(SLACK_WARNING_KEY[warning.code].body, {
              profile:
                "profile_id" in warning ? profile.show(warning.profile_id) : "",
              previous:
                "previous_user_id" in warning ? warning.previous_user_id : "",
              user: "user_id" in warning ? warning.user_id : "",
            })}
          </AlertDescription>
        </Alert>
      ))}
    </section>
  );
}
