import { type RefObject, useEffect, useState } from "react";
import type { Place } from "./placement.tsx";

export const AGENT_TABS = [
  "overview",
  "engine",
  "access",
  "sessions",
  "settings",
] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/** The sections the settings tab holds, top to bottom. */
export const SETTINGS_SECTIONS = [
  "card",
  "release",
  "admins",
  "slack",
  "github",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The element id of a settings section; other panels' ids stay clear of it. */
export const sectionId = (section: SettingsSection) =>
  `agent-settings-${section}`;

export interface AgentSearch {
  readonly notice?: "created";
  /** Absent for the overview, so a plain agent link opens it. */
  readonly tab?: Exclude<AgentTab, "overview">;
  /** Only with `tab: "settings"`: the section to scroll and focus. */
  readonly section?: SettingsSection;
}

const isSection = (value: unknown): value is SettingsSection =>
  SETTINGS_SECTIONS.some((section) => section === value);

/**
 * Links and bookmarks from before the tabs were folded into the settings
 * tab keep working: `?tab=slack` opens the settings tab at its Slack section.
 */
export function agentSearch(search: Record<string, unknown>): AgentSearch {
  const notice =
    search.notice === "created" ? { notice: "created" as const } : {};
  if (isSection(search.tab))
    return { ...notice, tab: "settings", section: search.tab };
  const tab = AGENT_TABS.find(
    (name) => name !== "overview" && name === search.tab,
  ) as AgentSearch["tab"];
  if (tab === "settings" && isSection(search.section))
    return { ...notice, tab, section: search.section };
  return { ...notice, ...(tab ? { tab } : {}) };
}

/** The tab holding each section a result is placed in. */
export const PLACE_TAB = {
  page: undefined,
  card: "settings",
  mcp: "access",
  credentials: "access",
  releases: "settings",
  admins: "settings",
} as const satisfies Record<Place, AgentTab | undefined>;

/** Where the keyboard goes once `tab` is showing. */
interface Landing {
  readonly tab: AgentTab;
  readonly target: RefObject<HTMLElement | null>;
}

/** Resolved when the focus lands, so a section mounted later is still found. */
const sectionTarget = (
  section: SettingsSection,
): RefObject<HTMLElement | null> => ({
  get current() {
    return document.getElementById(sectionId(section));
  },
  set current(_) {},
});

/** Where the page is, as the URL spells it. */
export interface AgentPlace {
  readonly tab: AgentTab;
  readonly section?: SettingsSection | undefined;
}

/**
 * The one way the detail screen opens a tab: its own tab buttons, the buttons
 * that point at another tab or settings section, a result placed in a section
 * and a refused activation all go through `open` and `openSection`.
 *
 * The tab is held here as well as in the URL, because the URL settles a
 * render later and a result opening its tab must be visible in the same
 * render that focuses it. `setUrl` writes the URL; it replaces rather than
 * pushes, so arrowing across the tabs does not fill the back button.
 */
export function useAgentTabs(
  url: AgentPlace,
  setUrl: (place: AgentPlace) => void,
) {
  const [tab, setTab] = useState(url.tab);
  const [section, setSection] = useState(url.section);
  const [seenUrl, setSeenUrl] = useState(url);
  const [landing, setLanding] = useState<Landing | null>(
    url.section ? { tab: url.tab, target: sectionTarget(url.section) } : null,
  );
  if (url.tab !== seenUrl.tab || url.section !== seenUrl.section) {
    setSeenUrl(url);
    setTab(url.tab);
    // The URL echoing what `openSection` just wrote has nothing new to land on.
    if (url.section !== section) {
      setSection(url.section);
      if (url.section)
        setLanding({ tab: url.tab, target: sectionTarget(url.section) });
    }
  }
  // A tab that has been shown once stays mounted for its lazy panel.
  const [shown, setShown] = useState<readonly AgentTab[]>([url.tab]);
  useEffect(() => {
    setShown((seen) => (seen.includes(tab) ? seen : [...seen, tab]));
  }, [tab]);
  useEffect(() => {
    if (landing && landing.tab === tab) {
      landing.target.current?.focus();
      setLanding(null);
    }
  }, [landing, tab]);

  const open = (next: AgentTab, focus?: RefObject<HTMLElement | null>) => {
    setTab(next);
    setSection(undefined);
    setUrl({ tab: next });
    if (focus) setLanding({ tab: next, target: focus });
  };
  /** Opens the settings tab and puts the keyboard on one of its sections. */
  const openSection = (next: SettingsSection) => {
    setTab("settings");
    setSection(next);
    setUrl({ tab: "settings", section: next });
    setLanding({ tab: "settings", target: sectionTarget(next) });
  };
  /** A result placed in a section opens that section's tab. */
  const openPlace = (at: Place) => {
    const home = PLACE_TAB[at];
    if (home) open(home);
  };
  const hasShown = (name: AgentTab) => tab === name || shown.includes(name);
  return { tab, open, openSection, openPlace, hasShown };
}
