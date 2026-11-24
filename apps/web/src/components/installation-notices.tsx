import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { LostCheckpointNotices } from "@werft-ai/contracts";
import { scopedKey } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import { Alert, Button, Text } from "@werft-ai/ui";
import { useHasPermission } from "../auth/guard.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { FormError } from "./auth-page.tsx";

/**
 * Standing notes about the installation itself, above every console page for
 * the people who run it (owners and admins). One so far: a test installation
 * gave up checkpoints when it was switched back on. It stays until one of
 * them closes it, which closes it for all of them.
 */
export function InstallationNotices() {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const manages = useHasPermission("workspace.manage");
  const key = scopedKey(client, "lost-checkpoint-notices");
  const read = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        client.GET("/v1/lost-checkpoint-notices"),
      ) as Promise<LostCheckpointNotices>,
    enabled: manages,
    // A server from before the notices answers 404: nothing to show.
    retry: false,
  });
  const close = useMutation<LostCheckpointNotices, ApiError, string[]>({
    mutationFn: (ids) =>
      unwrap(
        client.POST("/v1/lost-checkpoint-notices/close", { body: { ids } }),
      ),
    // What the server still holds open: a restart since the read stays.
    onSuccess: (left) => queryClient.setQueryData(key, left),
  });
  const notices = read.data?.notices ?? [];
  if (!manages || notices.length === 0) return null;
  const count = notices.reduce((sum, notice) => sum + notice.sessions, 0);
  return (
    <Alert
      variant="amber"
      data-slot="installation-notice"
      className="rounded-none border-x-0 border-t-0 md:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Text className="text-foreground">
          {t("shell.lostCheckpoints", { count })}
        </Text>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={close.isPending}
          onClick={() => close.mutate(notices.map((notice) => notice.id))}
        >
          {t("shell.lostCheckpoints.close")}
        </Button>
      </div>
      {close.error ? (
        <FormError>
          {t("shell.lostCheckpoints.closeFailed")}{" "}
          {t(errorKey(close.error.code))}
        </FormError>
      ) : null}
    </Alert>
  );
}
