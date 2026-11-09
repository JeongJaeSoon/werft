import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  EmptyState,
  SettingsSection,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
} from "@werft-ai/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { useToast } from "../../components/toast.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useSlackApp } from "./slack/actions.ts";
import {
  SlackAddressSection,
  SlackAppSection,
  SlackDangerSection,
  SlackTokenSection,
} from "./slack/app.tsx";
import { SlackDmSetting, SlackMentionOnly } from "./slack/basic.tsx";
import { SlackChannels } from "./slack/channels.tsx";
import { SlackSkeleton } from "./slack/connect.tsx";
import { unverifiedApp, useSlackBindings } from "./slack/queries.ts";
import {
  SECTION,
  SECTION_LABEL,
  SECTION_TARGET,
  type SectionKey,
} from "./slack/shared.ts";
import { SlackHeader } from "./slack/status.tsx";
import { useCurrentSection } from "./use-current-section.ts";
import { usePageFits } from "./use-page-fits.ts";

export { SlackConnect, SlackSkeleton } from "./slack/connect.tsx";
export { slackKey } from "./slack/queries.ts";
export { slackFailure } from "./slack/shared.ts";

/**
 * An agent's Slack tab, built like Integrations > Slack: the Slack card,
 * then what this agent does in Slack (its channels and basic settings), then
 * for its managers the sections the workspace screen has, under the same
 * names and in the same order, saying what this agent uses, and last the
 * danger zone.
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
  const unverified = unverifiedApp(app.data) !== null;
  const installed =
    identities.data?.items.some((item) => item.status === "active") ?? false;
  // An installed agent picks its home before anything else in the tab. A
  // failed refetch keeps the last data, so the step follows the data.
  const homeStep =
    installed &&
    bindings.data !== undefined &&
    !bindings.data.items.some((binding) => binding.home);
  const manages = useManagesAgent();
  // The danger zone exists only while there is an app to revoke or delete.
  const keys: readonly SectionKey[] = [
    "channels",
    ...(homeStep ? [] : (["basic"] as const)),
    ...(manages ? (["token", "addresses", "app"] as const) : []),
    ...(manages && app.data?.slack_app ? (["danger"] as const) : []),
  ];
  const [current, setCurrent] = useCurrentSection(
    keys.map((key) => SECTION[key]),
  );
  const jumped = useRef<string>(undefined);
  // With nothing to scroll to, the wide list only takes room from the page.
  const [fits, watchPage] = usePageFits();
  // The list also hides when the window widens past lg while the page fits.
  useLayoutEffect(() => {
    if (!fits) return;
    const leave = () => {
      const nav = document.activeElement?.closest("[data-slot=side-nav]");
      if (!nav || nav.getClientRects().length > 0) return;
      document.getElementById(current ?? "")?.focus({ preventScroll: true });
    };
    leave();
    window.addEventListener("resize", leave);
    return () => window.removeEventListener("resize", leave);
  }, [fits, current]);
  const [wasConnected, setWasConnected] = useState(installed);
  useEffect(() => {
    if (installed) setWasConnected(true);
  }, [installed]);
  const header = (
    <SlackHeader
      agentId={agentId}
      slack={slack}
      manages={manages}
      connected={installed || wasConnected}
    />
  );
  // What the workspace screen also has, then the danger zone.
  const appSections = manages ? (
    <>
      <SlackTokenSection slack={slack} />
      <SlackAddressSection slack={slack} />
      <SlackAppSection slack={slack} name={name} active={active} />
      <SlackDangerSection slack={slack} />
    </>
  ) : null;
  if (!installed && !wasConnected) {
    if (!manages)
      return identities.isPending ? null : (
        <EmptyState title={t("slack.notConnectedReadOnly")} />
      );
    if (app.isPending || identities.isPending) return <SlackSkeleton />;
    return (
      <div className="flex flex-col gap-[var(--werft-space-section)]">
        {header}
        {appSections}
        {toast}
      </div>
    );
  }
  const link = (key: SectionKey) => (
    <SideNavLink
      key={key}
      href={`#${SECTION[key]}`}
      current={current === SECTION[key] ? "location" : undefined}
      onClick={(event) => {
        // Stay off the URL hash: the router owns the location.
        event.preventDefault();
        const target = document.getElementById(SECTION[key]);
        target?.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
        target?.focus({ preventScroll: true });
        jumped.current = SECTION[key];
        setCurrent(SECTION[key]);
      }}
    >
      {t(SECTION_LABEL[key])}
    </SideNavLink>
  );
  const here = keys.find((key) => SECTION[key] === current);
  return (
    <>
      <SideNavLayout
        nav={
          <SideNav
            aria-label={t("slack.sectionNav")}
            className={fits ? "lg:hidden" : undefined}
            current={here ? t(SECTION_LABEL[here]) : undefined}
            // Folding the list sends focus to its button; take it back to
            // the section the link jumped to.
            onPick={() =>
              document
                .getElementById(jumped.current ?? "")
                ?.focus({ preventScroll: true })
            }
          >
            <SideNavGroup>
              {link("channels")}
              {homeStep ? null : link("basic")}
            </SideNavGroup>
            {manages ? (
              <SideNavGroup label={t("slack.manage")}>
                {link("token")}
                {link("addresses")}
                {link("app")}
                {keys.includes("danger") ? link("danger") : null}
              </SideNavGroup>
            ) : null}
          </SideNav>
        }
      >
        <div
          ref={watchPage}
          className="flex flex-col gap-[var(--werft-space-section)]"
        >
          {header}
          <SlackChannels
            agentId={agentId}
            invite={`/invite @${slug}`}
            notify={notify}
            homeStep={homeStep}
            locked={unverified && manages}
          />
          {homeStep ? null : (
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
                </>
              }
            />
          )}
          {appSections}
        </div>
      </SideNavLayout>
      {toast}
    </>
  );
}
