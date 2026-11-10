import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWerft } from "@werft-ai/react";
import { SettingsSection, Skeleton } from "@werft-ai/ui";
import {
  putWorkspaceEngineSettings,
  workspaceEngineSettingsKey,
  workspaceEngineSettingsQuery,
} from "../api/engine-settings.ts";
import {
  permissionReason,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { EngineSettingsEditor } from "../components/engine-settings-editor.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";

/**
 * The permission rules and auto mode sentences every agent of the workspace
 * runs under. Anyone in the workspace reads them; owners and admins save.
 */
export function WorkspaceEngineSettings() {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const role = useRole();
  const manages = useHasPermission("workspace.manage");
  const query = useQuery({
    ...workspaceEngineSettingsQuery(client, workspaceId),
    enabled: workspaceId !== "",
  });
  const title = t("engine.workspace.title");
  const description = t("engine.workspace.description");
  if (query.data === undefined) {
    return (
      <SettingsSection title={title} description={description} box>
        {query.isError ? (
          <LoadFailure
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <Skeleton width="60%" />
        )}
      </SettingsSection>
    );
  }
  return (
    <>
      {/* A failed refetch keeps the editor: its unsaved draft is the work. */}
      {query.isError ? (
        <LoadFailure error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <EngineSettingsEditor
        source="workspace"
        title={title}
        description={description}
        settings={query.data.settings}
        revision={query.data.settings_revision}
        writesOpen={query.data.writes_open}
        withheld={
          manages ? undefined : permissionReason(t, "workspace.manage", role)
        }
        save={(body) => putWorkspaceEngineSettings(client, workspaceId, body)}
        refresh={() =>
          queryClient.invalidateQueries({
            queryKey: workspaceEngineSettingsKey(client, workspaceId),
          })
        }
      />
    </>
  );
}
