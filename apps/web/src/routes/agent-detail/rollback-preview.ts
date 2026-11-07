import type {
  AgentDetail,
  AgentRelease,
  ProfileSummary,
} from "@werft-ai/contracts";
import { profileName, versionOf } from "../../components/profile-options.tsx";
import type { MessageKey, Translate } from "../../i18n/i18n.tsx";

type Tracking = NonNullable<AgentDetail["profile_tracking"]>;

export type TrackingChange = "keepOn" | "keepOff" | "turnedOff" | "turnedOn";

export function trackingChange(
  before: Tracking,
  after: Tracking,
): TrackingChange {
  if (before === after) return before === "follow" ? "keepOn" : "keepOff";
  return after === "follow" ? "turnedOn" : "turnedOff";
}

export const trackingOf = (detail: Pick<AgentDetail, "profile_tracking">) =>
  detail.profile_tracking ?? "follow";

function lineage(profile: ProfileSummary): string | null {
  const name = profile.workspace?.name ?? profile.installation?.name;
  return name == null ? null : `${profile.source}:${name}`;
}

function runsNewest(
  profiles: readonly ProfileSummary[],
  profileId: string,
): boolean | null {
  const own = profiles.find((profile) => profile.id === profileId);
  if (own === undefined) return null;
  const key = lineage(own);
  // Nothing ties a nameless profile to other versions, so the web cannot say
  // it is the newest.
  if (key === null) return null;
  // A later installation version names its predecessor even when its name
  // or version number differs from it.
  if (profiles.some((other) => other.installation?.previous_id === own.id))
    return false;
  return !profiles.some(
    (other) => lineage(other) === key && versionOf(other) > versionOf(own),
  );
}

const TRACKING_TEXT = {
  keepOn: "agent.rollback.tracking.keepOn",
  keepOff: "agent.rollback.tracking.keepOff",
  turnedOff: "agent.rollback.tracking.turnedOff",
  turnedOn: "agent.rollback.tracking.turnedOn",
  undetermined: "agent.rollback.tracking.undetermined",
} as const satisfies Record<TrackingChange | "undetermined", MessageKey>;

export const trackingLine = (
  t: Translate,
  change: TrackingChange | "undetermined",
): string => t("agent.rollback.tracking", { change: t(TRACKING_TEXT[change]) });

export function rolledBackText(
  t: Translate,
  input: {
    readonly release: string;
    readonly before: {
      readonly tracking: Tracking;
      readonly modelSource: AgentDetail["model_source"];
    };
    readonly after: Pick<AgentDetail, "profile_tracking" | "model_source">;
  },
): string {
  const tracking = trackingOf(input.after);
  return [
    t("agent.rolledBack", { release: input.release }),
    trackingLine(t, trackingChange(input.before.tracking, tracking)),
    input.before.modelSource === "profile" &&
    input.after.model_source === "fixed"
      ? t("agent.rollback.modelFixed")
      : null,
    t("agent.rollback.settingsKept"),
    tracking === "pinned" ? t("agent.rolledBack.reenable") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

export interface RollbackPreview {
  readonly tracking: TrackingChange | "undetermined";
  readonly modelBecomesFixed: boolean;
  /** The agent follows the profile's model but the target's profile is unknown. */
  readonly modelMayBecomeFixed: boolean;
  readonly profile: string | null;
}

export function rollbackPreview(
  detail: Pick<AgentDetail, "profile_tracking" | "model_source">,
  release: Pick<AgentRelease, "runtime_profile_id" | "runtime_config_snapshot">,
  profiles: readonly ProfileSummary[],
): RollbackPreview {
  const tracking = trackingOf(detail);
  const newest = runsNewest(profiles, release.runtime_profile_id);
  const profile = profiles.find(
    (listed) => listed.id === release.runtime_profile_id,
  );
  const model = release.runtime_config_snapshot.model;
  return {
    tracking:
      tracking === "pinned"
        ? "keepOff"
        : newest === true
          ? "keepOn"
          : "undetermined",
    modelBecomesFixed:
      detail.model_source === "profile" &&
      profile !== undefined &&
      typeof model === "string" &&
      model !== profile.model,
    modelMayBecomeFixed:
      detail.model_source === "profile" && profile === undefined,
    profile: profile ? profileName(profile) : null,
  };
}
