import { useLocation, useNavigate } from "@tanstack/react-router";
import { EmptyState, SettingsSection } from "@werft-ai/ui";
import { useEffect, useState } from "react";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { useToast } from "../../components/toast.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { SectionNavLayout } from "./section-nav.tsx";
import { useSlackApp } from "./slack/actions.ts";
import {
  eventUrl,
  SlackAddressSection,
  SlackAppSection,
  SlackDangerSection,
  SlackTokenSection,
} from "./slack/app.tsx";
import { SlackDmSetting, SlackMentionOnly } from "./slack/basic.tsx";
import { SlackAllowedBots } from "./slack/bots.tsx";
import { SlackChannels } from "./slack/channels.tsx";
import { SlackSkeleton } from "./slack/connect.tsx";
import { SlackNoticeSection } from "./slack/notice.tsx";
import { unverifiedApp, useSlackBindings } from "./slack/queries.ts";
import {
  SECTION,
  SECTION_LABEL,
  SECTION_TARGET,
  type SectionKey,
} from "./slack/shared.ts";
import { SlackHeader } from "./slack/status.tsx";

export { SlackConnect } from "./slack/connect.tsx";

/**
 * An agent's Slack tab, in the GitHub tab's frame: the Slack card, then what
 * this agent does in Slack (its channels and basic settings), then for its
 * managers the sections Integrations > Slack has, under the same names and in
 * the same order, saying what this agent uses, and last the danger zone.
 */
export default function SlackTab({
  agentId,
  slug,
  name,
  active,
}: {
  readonly agentId: string;
  /** The app manifest names the bot after it. */
  readonly slug: string;
  /** The agent's name, which its app is listed under. */
  readonly name: string;
  readonly active: boolean;
}) {
  const { t } = useI18n();
  const { notify, toast } = useToast();
  const navigate = useNavigate();
  const justInstalled = useLocation({
    select: (location) => location.state.slackInstalled === true,
  });
  useEffect(() => {
    if (!justInstalled) return;
    notify(t("slack.installed"));
    // A reload or Back must not repeat the notice.
    void navigate({
      to: ".",
      search: true,
      replace: true,
      state: ({ slackInstalled: _, ...rest }) => rest,
    });
  }, [justInstalled, notify, navigate, t]);
  const slack = useSlackApp(agentId);
  const { app, identities } = slack;
  const bindings = useSlackBindings(agentId);
  const unverified = unverifiedApp(app.data);
  const installed =
    identities.data?.items.some((item) => item.status === "active") ?? false;
  // An installed agent picks its home before anything else in the tab. A
  // failed refetch keeps the last data, so the step follows the data.
  const homeStep =
    installed &&
    bindings.data !== undefined &&
    !bindings.data.items.some((binding) => binding.home);
  const manages = useManagesAgent();
  const [wasConnected, setWasConnected] = useState(installed);
  useEffect(() => {
    if (installed) setWasConnected(true);
  }, [installed]);
  const connected = installed || wasConnected;
  if (!connected) {
    if (!manages)
      return identities.isPending ? null : (
        <EmptyState title={t("slack.notConnectedReadOnly")} />
      );
    if (app.isPending || identities.isPending) return <SlackSkeleton />;
  }
  // As on the GitHub tab: the card and what this agent does in Slack, then
  // under Manage the danger zone, which exists only while there is an app to
  // revoke or delete. Before the first install there are no channels yet.
  const keys: readonly SectionKey[] = [
    "slack",
    ...(connected ? (["notice", "channels"] as const) : []),
    ...(connected && !homeStep ? (["basic"] as const) : []),
    ...(manages ? (["token"] as const) : []),
    // Before an app there is no address to put in it.
    ...(manages && eventUrl(slack) ? (["addresses"] as const) : []),
    ...(manages ? (["app"] as const) : []),
  ];
  const manageKeys: readonly SectionKey[] =
    manages && app.data?.slack_app ? ["danger"] : [];
  const item = (key: SectionKey) => ({
    id: SECTION[key],
    label: t(SECTION_LABEL[key]),
  });
  return (
    <>
      <SectionNavLayout
        label={t("slack.sectionNav")}
        groups={[
          { items: keys.map(item) },
          { label: t("slack.manage"), items: manageKeys.map(item) },
        ]}
      >
        <SlackHeader
          agentId={agentId}
          slack={slack}
          manages={manages}
          connected={connected}
        />
        {connected ? (
          <SlackNoticeSection agentId={agentId} notify={notify} />
        ) : null}
        {connected ? (
          <SlackChannels
            agentId={agentId}
            invite={`/invite @${slug}`}
            notify={notify}
            homeStep={homeStep}
            slack={slack}
            // A managing-team member reads the app too and gets the notice.
            lockedApp={unverified}
            // The address section offers Recheck only for an installed app.
            canRecheck={manages && installed && eventUrl(slack) !== null}
            installed={installed}
          />
        ) : null}
        {connected && !homeStep ? (
          <SettingsSection
            id={SECTION.basic}
            tabIndex={-1}
            className={SECTION_TARGET}
            titleAs="h3"
            title={t("slack.basic")}
            description={t("slack.basicHint")}
            rows={
              <>
                <SlackDmSetting agentId={agentId} />
                <SlackMentionOnly agentId={agentId} notify={notify} />
                {installed ? (
                  <SlackAllowedBots agentId={agentId} notify={notify} />
                ) : null}
              </>
            }
          />
        ) : null}
        {/* What the workspace screen also has, then the danger zone. */}
        {manages ? (
          <>
            <SlackTokenSection slack={slack} />
            <SlackAddressSection slack={slack} />
            <SlackAppSection slack={slack} name={name} active={active} />
            <SlackDangerSection slack={slack} />
          </>
        ) : null}
      </SectionNavLayout>
      {toast}
    </>
  );
}
