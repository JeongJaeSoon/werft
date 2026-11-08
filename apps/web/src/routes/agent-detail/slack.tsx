import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  EmptyState,
  Heading,
  RowList,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
} from "@werft-ai/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { SlackDmSetting, SlackMentionOnly } from "./slack/basic.tsx";
import { SlackChannels } from "./slack/channels.tsx";
import { SlackConnect } from "./slack/connect.tsx";
import {
  unverifiedApp,
  useSlackBindings,
  useSlackState,
} from "./slack/queries.ts";
import {
  SECTION,
  SECTION_BOX,
  SECTION_LABEL,
  type SectionKey,
} from "./slack/shared.ts";
import { SlackStatus } from "./slack/status.tsx";
import { useToast } from "./toast.tsx";
import { useCurrentSection } from "./use-current-section.ts";
import { usePageFits } from "./use-page-fits.ts";

export { SlackConnect, SlackSkeleton } from "./slack/connect.tsx";
export { slackKey } from "./slack/queries.ts";
export { slackFailure } from "./slack/shared.ts";

export default function SlackTab({
  agentId,
  slug,
  active,
}: {
  readonly agentId: string;
  /** The app manifest names the bot after it. */
  readonly slug: string;
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
  const { app, identities } = useSlackState(agentId);
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
    ...(manages ? (["advanced"] as const) : []),
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
  if (!installed && !wasConnected) {
    if (!manages)
      return identities.isPending ? null : (
        <EmptyState title={t("slack.notConnectedReadOnly")} />
      );
    return (
      <div className="flex flex-col gap-8">
        <SlackConnect agentId={agentId} active={active} />
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
                {link("advanced")}
                {keys.includes("danger") ? link("danger") : null}
              </SideNavGroup>
            ) : null}
          </SideNav>
        }
      >
        <div ref={watchPage} className="flex flex-col gap-8">
          <SlackStatus agentId={agentId} />
          <SlackChannels
            agentId={agentId}
            invite={`/invite @${slug}`}
            notify={notify}
            homeStep={homeStep}
            locked={unverified && manages}
          />
          {homeStep ? null : (
            <section
              id={SECTION.basic}
              tabIndex={-1}
              className={SECTION_BOX}
              aria-labelledby={`${SECTION.basic}-title`}
            >
              <Heading id={`${SECTION.basic}-title`}>
                {t("slack.basic")}
              </Heading>
              <RowList variant="joined">
                <SlackDmSetting agentId={agentId} />
                <SlackMentionOnly agentId={agentId} notify={notify} />
              </RowList>
            </section>
          )}
          {manages ? (
            <SlackConnect
              agentId={agentId}
              active={active}
              inPage
              invite={`/invite @${slug}`}
              notify={notify}
            />
          ) : null}
        </div>
      </SideNavLayout>
      {toast}
    </>
  );
}
