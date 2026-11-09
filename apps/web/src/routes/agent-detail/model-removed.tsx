import { useQuery } from "@tanstack/react-query";
import type { AgentRelease } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { Alert, AlertDescription, AlertTitle } from "@werft-ai/ui";
import { profilesQuery } from "../../api/queries.ts";
import {
  profileDisplay,
  runsModel,
  successorOf,
} from "../../components/profile-options.tsx";
import { useI18n } from "../../i18n/i18n.tsx";

/**
 * Says so when the model the active release runs is no longer on its
 * profile's allowed list: which model, and what to do. Nothing while the
 * profile list loads or does not name the profile.
 */
export function ModelRemovedAlert({
  release,
}: {
  readonly release: AgentRelease | null;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const profiles = useQuery(profilesQuery(client));
  const model = release?.runtime_config_snapshot.model;
  const profile = profiles.data?.items.find(
    (listed) => listed.id === release?.runtime_profile_id,
  );
  if (
    release === null ||
    typeof model !== "string" ||
    profile === undefined ||
    runsModel(profile, model)
  ) {
    return null;
  }
  const successor = successorOf(profile, model);
  const params = {
    model,
    profile: profileDisplay(t, profiles.data?.items, profile.id),
  };
  // A successor keeps the agent running: sessions start on it, so this only
  // asks the admin to bring the card's model up to date.
  return successor === undefined ? (
    <Alert variant="amber" className="border-0">
      <AlertTitle>{t("agent.modelRemoved.title", params)}</AlertTitle>
      <AlertDescription>{t("agent.modelRemoved.text")}</AlertDescription>
    </Alert>
  ) : (
    <Alert variant="blue" className="border-0">
      <AlertTitle>
        {t("agent.modelMoves.title", { ...params, successor })}
      </AlertTitle>
      <AlertDescription>
        {t("agent.modelMoves.text", { model, successor })}
      </AlertDescription>
    </Alert>
  );
}
