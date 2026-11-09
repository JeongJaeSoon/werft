import { Link } from "@tanstack/react-router";
import { LinkTab, LinkTabs, Page } from "@werft-ai/ui";
import type { ReactNode } from "react";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { SECTIONS } from "./workspace-settings.tsx";

export type IntegrationsTab = "slack" | "github";

const TABS: readonly {
  readonly id: IntegrationsTab;
  readonly to:
    | "/settings/workspace/integrations/slack"
    | "/settings/workspace/integrations/github";
  readonly title: MessageKey;
}[] = [
  {
    id: "slack",
    to: "/settings/workspace/integrations/slack",
    title: "integrations.tab.slack",
  },
  {
    id: "github",
    to: "/settings/workspace/integrations/github",
    title: "integrations.tab.github",
  },
];

// The route passes `tab` because the GitHub App callback lives under the
// GitHub address and must keep the GitHub tab current.
export function IntegrationsLayout({
  tab,
  children,
}: {
  readonly tab: IntegrationsTab;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Page
      title={t("integrations.title")}
      description={t(
        tab === "slack" ? "workspace.slackDescription" : "github.description",
      )}
    >
      <LinkTabs aria-label={t("integrations.tabs")}>
        {TABS.map((entry) => (
          <LinkTab key={entry.id} asChild current={entry.id === tab}>
            {/* TanStack marks a parent path active; exact keeps one tab current. */}
            <Link to={entry.to} activeOptions={{ exact: true }}>
              {t(entry.title)}
            </Link>
          </LinkTab>
        ))}
      </LinkTabs>
      <div className={SECTIONS}>{children}</div>
    </Page>
  );
}
