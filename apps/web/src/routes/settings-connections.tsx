import { useQuery } from "@tanstack/react-query";
import { useWerft } from "@werft-ai/react";
import { Page, Skeleton } from "@werft-ai/ui";
import { profilesQuery } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { ModelConnections } from "./model-connections.tsx";

/**
 * Model connections under Settings, beside the MCP servers. This is the only
 * place connections are managed; the Profiles screens only pick one.
 */
export function ConnectionsScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const owns = useHasPermission("installation.settings.manage");
  // Only the owner reads the connections; the others never fetch the profiles here.
  const profiles = useQuery({ ...profilesQuery(client), enabled: owns });

  if (!owns)
    return (
      <Page title={t("settings.connections.title")}>
        <StatusScreen kind="forbidden" />
      </Page>
    );

  // The usage counts need the ceilings; a missing list must not read as 0.
  if (profiles.isPending || profiles.isError)
    return (
      <Page title={t("settings.connections.title")}>
        {profiles.isError ? (
          <LoadFailure
            error={profiles.error}
            onRetry={() => void profiles.refetch()}
          />
        ) : (
          <Skeleton width="60%" />
        )}
      </Page>
    );

  return (
    <ModelConnections
      profiles={profiles.data.items.filter(
        (item) => item.source === "operator",
      )}
    />
  );
}
