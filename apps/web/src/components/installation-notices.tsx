import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  InstallationStatus,
  LostCheckpointNotices,
} from "@werft-ai/contracts";
import { scopedKey } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import { Alert, Button, Text } from "@werft-ai/ui";
import { useLayoutEffect, useRef } from "react";
import { useHasPermission } from "../auth/guard.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { FormError } from "./auth-page.tsx";

// Another owner or admin may close it, and a restart may add to it.
const NOTICES_REFETCH_MS = 60_000;

/** What one close takes (closeLostCheckpointNoticesRequestSchema). */
const CLOSE_BATCH = 100;

/** What a page that fills the screen's height subtracts (tokens.css). */
const NOTICE_HEIGHT = "--werft-shell-notice-h";

/**
 * Standing notes about the installation itself, above every console page for
 * the people who run it (owners and admins). Worker workspaces without a disk
 * quota stay noted for as long as the installation runs that way. Checkpoints
 * a test installation gave up when it was switched back on stay until one of
 * them closes the note, which closes it for all of them.
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
    // A server from before the notices answers 404: nothing to show, and
    // nothing to keep asking for.
    retry: false,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : NOTICES_REFETCH_MS,
  });
  const status = useQuery({
    queryKey: scopedKey(client, "installation-status"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation-status"),
      ) as Promise<InstallationStatus>,
    enabled: manages,
    // Fixed for the life of an API process, but a restart can change it under
    // an open console; a server from before it is 404.
    retry: false,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : NOTICES_REFETCH_MS,
  });
  const close = useMutation<LostCheckpointNotices, ApiError, string[]>({
    // Everything that was read and nothing else, as many at a time as one
    // request takes. The last answer is what the server still holds open: a
    // restart since the read stays.
    mutationFn: async (ids) => {
      let left: LostCheckpointNotices = { notices: [] };
      for (let from = 0; from < ids.length; from += CLOSE_BATCH) {
        left = await unwrap(
          client.POST("/v1/lost-checkpoint-notices/close", {
            body: { ids: ids.slice(from, from + CLOSE_BATCH) },
          }),
        );
      }
      return left;
    },
    onSuccess: (left) => queryClient.setQueryData(key, left),
    // Some may have closed before the failure: show what is open now.
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const notices = read.data?.notices ?? [];
  const noDiskQuota = status.data?.no_disk_quota === true;
  const shown = manages && (notices.length > 0 || noDiskQuota);

  // The session chat sizes itself to the screen under the top bar; it has to
  // know how much of that this takes, which changes as the text wraps.
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    const shell = element?.parentElement;
    if (!shown || !element || !shell) return;
    const measure = () =>
      shell.style.setProperty(NOTICE_HEIGHT, `${element.offsetHeight}px`);
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      shell.style.removeProperty(NOTICE_HEIGHT);
    };
  }, [shown]);

  if (!shown) return null;
  const count = notices.reduce((sum, notice) => sum + notice.sessions, 0);
  return (
    <div ref={box} data-slot="installation-notice">
      {noDiskQuota ? (
        <Alert
          variant="amber"
          data-slot="no-disk-quota"
          className="rounded-none border-x-0 border-t-0 md:px-6"
        >
          <Text className="text-foreground">
            {status.data?.profile === "test"
              ? t("shell.noDiskQuota.test")
              : t("shell.noDiskQuota")}
          </Text>
        </Alert>
      ) : null}
      {notices.length > 0 ? (
        <Alert
          variant="amber"
          // One line beside a taller button: the icon centres on the row.
          className="items-center rounded-none border-x-0 border-t-0 md:px-6"
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
      ) : null}
    </div>
  );
}
