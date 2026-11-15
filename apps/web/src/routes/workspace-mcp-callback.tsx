import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { WorkspaceMcpServer } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { Button, Page } from "@werft-ai/ui";
import { useEffect, useRef } from "react";
import { useRole } from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  workspaceMcpRefusal,
  workspaceMcpServersKey,
} from "./workspace-mcp-servers.tsx";

const FROM = "/authed/settings/workspace/mcp-servers/$serverId/callback";

export function WorkspaceMcpCallback() {
  const { serverId } = useParams({ from: FROM });
  const search = useSearch({ from: FROM });
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const started = useRef(false);
  const { code, state, iss, error } = search;
  const complete = useMutation<
    WorkspaceMcpServer,
    ApiError,
    { code: string; state: string; iss?: string }
  >({
    mutationFn: (body) =>
      unwrap(
        client.POST("/v1/workspace/mcp-servers/{id}/oauth/complete", {
          params: { path: { id: serverId } },
          body,
        }),
      ),
    onSuccess: async (server) => {
      await cache.invalidateQueries({
        queryKey: workspaceMcpServersKey(client),
      });
      await navigate({
        to: "/settings/workspace/mcp-servers",
        state: (previous) => ({
          ...previous,
          workspaceMcpConnected: server.name,
        }),
        replace: true,
      });
    },
  });
  const usable =
    error === undefined && code !== undefined && state !== undefined;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The code is single-use; it must not stay in the address bar or history.
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
    if (usable)
      complete.mutate({ code, state, ...(iss === undefined ? {} : { iss }) });
  }, [complete.mutate, usable, code, state, iss]);

  const text =
    error !== undefined
      ? t("workspaceMcp.callback.denied", { code: error })
      : !usable
        ? t("workspaceMcp.callback.missing")
        : complete.error
          ? workspaceMcpRefusal(t, complete.error, role)
          : t("workspaceMcp.callback.working");
  const done = !usable || complete.isError;
  return (
    <Page title={t("workspaceMcp.callback.title")}>
      <output aria-live="polite">{text}</output>
      {done ? (
        <Button asChild variant="outline">
          <Link to="/settings/workspace/mcp-servers">
            {t("workspaceMcp.callback.back")}
          </Link>
        </Button>
      ) : null}
    </Page>
  );
}
