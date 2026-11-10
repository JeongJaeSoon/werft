import type { AgentDetail } from "@werft-ai/contracts";
import type { ReactNode } from "react";
import type { Outcome } from "../../components/outcome.tsx";
import { AdminsTab } from "./admins-tab.tsx";
import { CardTab } from "./card-tab.tsx";
import { GitHubPanel, SlackPanel } from "./lazy-tabs.tsx";
import { type SettingsSection, sectionId } from "./navigation.ts";
import { type Place, type Placed, PlacedOutcome } from "./placement.tsx";
import { ReleaseTab, type useReleaseActivation } from "./release-tab.tsx";

/** A section the keyboard can land on when a link or a button opens it. */
function LandingSection({
  name,
  children,
}: {
  readonly name: SettingsSection;
  readonly children: ReactNode;
}) {
  // A plain element: the panels inside already name themselves, and a second
  // landmark of the same name would double each of them.
  return (
    <div
      id={sectionId(name)}
      tabIndex={-1}
      className="flex scroll-mt-4 flex-col gap-8 outline-none"
    >
      {children}
    </div>
  );
}

/** The five sections that were tabs of their own, moved here unchanged. */
export function SettingsTab({
  detail,
  manages,
  shown,
  mounted,
  placed,
  outcomeAt,
  activation,
  onReload,
  onGoCredentials,
  toRelease,
}: {
  readonly detail: AgentDetail;
  readonly manages: boolean;
  /** This tab is showing: the release list reads its members only then. */
  readonly shown: boolean;
  /** This tab has been shown once: Slack and GitHub load, then stay mounted. */
  readonly mounted: boolean;
  readonly placed: Placed | null;
  readonly outcomeAt: (at: Place) => (outcome: Outcome | null) => void;
  readonly activation: ReturnType<typeof useReleaseActivation>;
  readonly onReload: () => void;
  readonly onGoCredentials: () => void;
  readonly toRelease: ReactNode;
}) {
  return (
    <>
      <LandingSection name="card">
        <CardTab
          detail={detail}
          manages={manages}
          placed={placed}
          onOutcome={outcomeAt("card")}
          toRelease={toRelease}
        />
      </LandingSection>
      <LandingSection name="release">
        <ReleaseTab
          detail={detail}
          shown={shown}
          placed={placed}
          activation={activation}
          onReload={onReload}
          onGoCredentials={onGoCredentials}
        />
      </LandingSection>
      <LandingSection name="admins">
        <AdminsTab
          agent={detail.agent}
          manages={manages}
          onOutcome={outcomeAt("admins")}
          result={<PlacedOutcome placed={placed} at="admins" />}
        />
      </LandingSection>
      <LandingSection name="slack">
        <SlackPanel agent={detail.agent} mounted={mounted} />
      </LandingSection>
      <LandingSection name="github">
        <GitHubPanel detail={detail} mounted={mounted} />
      </LandingSection>
    </>
  );
}
