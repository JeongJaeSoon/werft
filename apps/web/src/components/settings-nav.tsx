import { Link, useRouterState } from "@tanstack/react-router";
import {
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
} from "@werft-ai/ui";
import type { ReactNode } from "react";
import { useI18n } from "../i18n/i18n.tsx";
import { type NavItem, useSettingsNavGroups } from "./app-sidebar.tsx";
import { MAIN_CONTENT_ID } from "./main.tsx";

// A page's own sub-paths (a key's new page, the Slack link callback) keep
// their item current; 일반 alone has a sibling under its path. An item that
// spans several addresses names its base in `match`.
function isCurrent(item: NavItem, pathname: string): boolean {
  if (item.to === "/settings/workspace") return pathname === item.to;
  const base = item.match ?? item.to;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Settings as GitHub lays them out (V4-SETTINGS-LAYOUT A): the settings nav
 * on the left, the page in one column beside it.
 */
export function SettingsLayout({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const groups = useSettingsNavGroups();
  // The router also opens a page at its path with a trailing slash.
  const pathname = useRouterState({
    select: (state) => state.location.pathname.replace(/(.)\/$/, "$1"),
  });
  const here = groups
    .flatMap((group) => group.items)
    .find((item) => isCurrent(item, pathname));
  return (
    <SideNavLayout
      className="[--werft-row-padding-x:0px]"
      nav={
        <SideNav
          aria-label={t("nav.settings")}
          current={here ? t(here.label) : undefined}
          // The followed link hides with the list; focus lands on the page.
          onPick={() => document.getElementById(MAIN_CONTENT_ID)?.focus()}
        >
          {groups.map((group) => (
            <SideNavGroup key={group.label} label={t(group.label)}>
              {group.items.map((item) => (
                <SideNavLink
                  key={item.to}
                  asChild
                  current={isCurrent(item, pathname)}
                >
                  <Link to={item.to} activeOptions={{ exact: true }}>
                    {t(item.label)}
                  </Link>
                </SideNavLink>
              ))}
            </SideNavGroup>
          ))}
        </SideNav>
      }
    >
      {children}
    </SideNavLayout>
  );
}
