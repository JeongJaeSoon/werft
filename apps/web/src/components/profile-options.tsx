import { useQuery } from "@tanstack/react-query";
import type { ProfileSummary } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { NativeSelectOption } from "@werft-ai/ui";
import { profilesQuery } from "../api/queries.ts";
import { type Translate, useI18n } from "../i18n/i18n.tsx";

const stateOf = (profile: ProfileSummary) =>
  profile.source === "operator"
    ? (profile.installation?.state ?? "usable")
    : profile.workspace?.state;

export const pickable = (profile: ProfileSummary) =>
  stateOf(profile) === "usable";

export const startableWhenPinned = (profile: ProfileSummary) => {
  const state = stateOf(profile);
  return (
    state === undefined ||
    state === "usable" ||
    state === "retired" ||
    state === "base_retired"
  );
};

/** Whether a release of a card naming `model` may run on it, as the server checks. */
export const runsModel = (
  profile: ProfileSummary,
  model: string | undefined,
): boolean => model === undefined || profile.models.includes(model);

/** What a profile is called: an imported ceiling has only its id. */
export const profileName = (profile: ProfileSummary): string =>
  profile.workspace?.name ?? profile.installation?.name ?? profile.id;

export const versionOf = (profile: ProfileSummary): number =>
  profile.workspace?.version ?? profile.installation?.version ?? 1;

/** A profile as the profiles screen names it: name, version and model. */
export const profileLabel = (t: Translate, profile: ProfileSummary): string => {
  const named = profile.workspace?.name ?? profile.installation?.name;
  // A nameless ceiling has only its id, which a choice never shows.
  if (named == null)
    return t("profiles.optionUnnamed", { model: profile.model });
  return t("profiles.option", {
    name: named,
    version: versionOf(profile),
    model: profile.model,
  });
};

/**
 * A profile id as people read it: "name vN". The id itself stands in when the
 * list has no entry for it (not loaded, not readable, an older version the
 * list leaves out) or names it with no name.
 */
export const profileDisplay = (
  t: Translate,
  profiles: readonly ProfileSummary[] | undefined,
  id: string,
): string => {
  const profile = profiles?.find((listed) => listed.id === id);
  const named = profile?.workspace?.name ?? profile?.installation?.name;
  if (profile === undefined || named == null) return id;
  return `${named} ${t("profiles.versionTag", { version: versionOf(profile) })}`;
};

/** `profileDisplay` over the shared profile list, for any role that reads it. */
export function useProfileDisplay(): {
  readonly show: (id: string) => string;
} {
  const { t } = useI18n();
  const { client } = useWerft();
  const items = useQuery(profilesQuery(client)).data?.items;
  return { show: (id) => profileDisplay(t, items, id) };
}

/**
 * One option per profile: those that `fit` first, each part installation
 * profiles before workspace ones. One that does not fit is listed last,
 * disabled, and says why, so a refused choice is never the one picked.
 */
export function ProfileOptions({
  profiles,
  label,
  usable = pickable,
  fits = () => true,
}: {
  readonly profiles: readonly ProfileSummary[];
  readonly label?: ((profile: ProfileSummary) => string) | undefined;
  readonly usable?: (profile: ProfileSummary) => boolean;
  readonly fits?: (profile: ProfileSummary) => boolean;
}) {
  const { t } = useI18n();
  const rank = (profile: ProfileSummary) =>
    (fits(profile) ? 0 : 2) + (profile.source === "operator" ? 0 : 1);
  const ordered = [...profiles].sort((a, b) => rank(a) - rank(b));
  return ordered.map((profile) => {
    const state = stateOf(profile);
    const named = label?.(profile) ?? profileLabel(t, profile);
    const text = fits(profile)
      ? named
      : t("agent.releases.profileOptionMismatch", { profile: named });
    return (
      <NativeSelectOption
        key={profile.id}
        value={profile.id}
        disabled={!usable(profile) || !fits(profile)}
      >
        {pickable(profile) || state === undefined
          ? text
          : `${text} · ${t(`profiles.state.${state}`)}`}
      </NativeSelectOption>
    );
  });
}
