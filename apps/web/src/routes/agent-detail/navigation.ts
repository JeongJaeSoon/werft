import { type RefObject, useEffect, useState } from "react";
import type { Place } from "./placement.tsx";

export const AGENT_TABS = [
  "overview",
  "card",
  "release",
  "access",
  "engine",
  "admins",
  "slack",
  "github",
] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

export interface AgentSearch {
  readonly notice?: "created";
  /** Absent for the overview, so a plain agent link opens it. */
  readonly tab?: Exclude<AgentTab, "overview">;
}

export function agentSearch(search: Record<string, unknown>): AgentSearch {
  const tab = AGENT_TABS.find(
    (name) => name !== "overview" && name === search.tab,
  ) as AgentSearch["tab"];
  return {
    ...(search.notice === "created" ? { notice: "created" as const } : {}),
    ...(tab ? { tab } : {}),
  };
}

/** The tab holding each section a result is placed in. */
export const PLACE_TAB = {
  page: undefined,
  card: "card",
  mcp: "access",
  credentials: "access",
  releases: "release",
  admins: "admins",
} as const satisfies Record<Place, AgentTab | undefined>;

/** Where the keyboard goes once `tab` is showing. */
interface Landing {
  readonly tab: AgentTab;
  readonly target: RefObject<HTMLElement | null>;
}

/**
 * The one way the detail screen opens a tab: its own tab buttons, the buttons
 * that point at another tab, a result placed in a section and a refused
 * activation all go through `open`.
 *
 * The tab is held here as well as in the URL, because the URL settles a
 * render later and a result opening its tab must be visible in the same
 * render that focuses it. `setUrl` writes the URL; it replaces rather than
 * pushes, so arrowing across the tabs does not fill the back button.
 */
export function useAgentTabs(
  urlTab: AgentTab,
  setUrl: (tab: AgentTab) => void,
) {
  const [tab, setTab] = useState(urlTab);
  const [seenUrlTab, setSeenUrlTab] = useState(urlTab);
  if (urlTab !== seenUrlTab) {
    setSeenUrlTab(urlTab);
    setTab(urlTab);
  }
  // A tab that has been shown once stays mounted for its lazy panel.
  const [shown, setShown] = useState<readonly AgentTab[]>([urlTab]);
  useEffect(() => {
    setShown((seen) => (seen.includes(tab) ? seen : [...seen, tab]));
  }, [tab]);
  const [landing, setLanding] = useState<Landing | null>(null);
  useEffect(() => {
    if (landing && landing.tab === tab) {
      landing.target.current?.focus();
      setLanding(null);
    }
  }, [landing, tab]);

  const open = (next: AgentTab, focus?: RefObject<HTMLElement | null>) => {
    setTab(next);
    setUrl(next);
    if (focus) setLanding({ tab: next, target: focus });
  };
  /** A result placed in a section opens that section's tab. */
  const openPlace = (at: Place) => {
    const home = PLACE_TAB[at];
    if (home) open(home);
  };
  const hasShown = (name: AgentTab) => tab === name || shown.includes(name);
  return { tab, open, openPlace, hasShown };
}
