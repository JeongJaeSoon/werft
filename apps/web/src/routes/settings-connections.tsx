import { Page } from "@werft-ai/ui";
import { useHasPermission } from "../auth/guard.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { ModelConnections } from "./model-connections.tsx";

/**
 * Model connections under Settings, beside the MCP servers. This is the only
 * place agents' connections and the models they may name are managed; the
 * achievement judge's connection is set up on the achievement rules screen.
 */
export function ConnectionsScreen() {
  const { t } = useI18n();
  const owns = useHasPermission("installation.settings.manage");

  if (!owns)
    return (
      <Page title={t("settings.connections.title")}>
        <StatusScreen kind="forbidden" />
      </Page>
    );

  return <ModelConnections />;
}
