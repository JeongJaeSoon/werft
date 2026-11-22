import { Page } from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";
import { WorkspaceMcpServers } from "./workspace-mcp-servers.tsx";

export function McpServersScreen() {
  const { t } = useI18n();
  return (
    <Page
      title={t("settings.mcp.title")}
      description={t("settings.mcp.pageDescription")}
    >
      <WorkspaceMcpServers />
    </Page>
  );
}
