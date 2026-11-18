import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Code,
  IntegrationHeader,
  Skeleton,
} from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { SlackTileMark } from "../../../components/brand-marks.tsx";
import { LoadFailure } from "../../../components/load-failure.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import type { SlackApp } from "./actions.ts";
import { useSlackBindings, useSlackChannels } from "./queries.ts";
import {
  dmOn,
  SECTION,
  SECTION_TARGET,
  SLACK_WARNING_KEY,
  STATE_BADGE,
  slackReason,
  slackState,
} from "./shared.ts";

/**
 * The tab's Slack card, as on Integrations > Slack: the mark, then this
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
  const placeholder = (
    <Skeleton className="h-4 w-20" label={t("status.loading.title")} />
  );
  const reads = connected ? [app, identities, bindings] : [app, identities];
  const failed = reads.filter((read) => read.isError);
  const error = failed[0]?.error ?? null;
  const retry = () => {
    for (const read of failed) void read.refetch();
  };
  const state = slackState(error, identity, record);
  // At most one reason sessions would fail, after any token issuer change.
  const warnings = manages ? (app.data?.warnings ?? []) : [];
  // GitHub's summary line: "label value" pairs between middle dots.
  const item = (label: string, value: ReactNode, first = false) => (
    <span className="inline-flex items-center gap-1.5">
      {first ? null : <span aria-hidden="true">·</span>}
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
  const summary = (
    <span className="flex flex-wrap items-center gap-x-1.5">
      {item(
        t("slack.botId"),
        <Code>{identity?.bot_user_id ?? "—"}</Code>,
        true,
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
                    ? t("slack.channelId", { id: home.external_surface_id })
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
    </span>
  );
  return (
    <section
      id={SECTION.slack}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={SECTION_TARGET}
    >
      <IntegrationHeader
        icon={SlackTileMark}
        title="Slack"
        titleId={titleId}
        status={
          app.isPending ? (
            placeholder
          ) : (
            <Badge variant={STATE_BADGE[state]}>
              {t(`slack.state.${state}`)}
            </Badge>
          )
        }
        summary={summary}
        description={t("slack.cardHint")}
      >
        {error ? (
          <LoadFailure
            error={error}
            guidance={slackReason(error, t)}
            kept={failed.every((read) => read.data !== undefined)}
            onRetry={retry}
          />
        ) : null}
        {warnings.map((warning) => (
          <Alert key={warning.code} variant="amber">
            <AlertTitle>{t(SLACK_WARNING_KEY[warning.code].title)}</AlertTitle>
            <AlertDescription>
              {t(SLACK_WARNING_KEY[warning.code].body, {
                release: "release_id" in warning ? warning.release_id : "",
                previous:
                  "previous_user_id" in warning ? warning.previous_user_id : "",
                user: "user_id" in warning ? warning.user_id : "",
              })}
            </AlertDescription>
          </Alert>
        ))}
      </IntegrationHeader>
    </section>
  );
}
