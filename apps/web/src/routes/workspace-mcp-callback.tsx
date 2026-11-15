import { useMutation } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type { WorkspaceMcpServer } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { Button } from "@werft-ai/ui";
import { useEffect, useRef, useState } from "react";
import { AuthPage } from "../components/auth-page.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { workspaceMcpRefusal } from "./workspace-mcp-servers.tsx";

const FROM = "/settings/workspace/mcp-servers/$serverId/callback";

/**
 * Public, like the login callback: behind the session guard an expired
 * session would carry the code into the login page's redirect address.
 */
export function WorkspaceMcpCallback() {
  const { serverId } = useParams({ from: FROM });
  const search = useSearch({ from: FROM });
  // Taken once: the address loses its query on the first effect.
  const [given] = useState(search);
  const { t } = useI18n();
  const { client } = useWerft();
  const navigate = useNavigate();
  const started = useRef(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const { code, state, iss, error } = given;
  const complete = useMutation<
    WorkspaceMcpServer,
    ApiError,
    { code: string; state: string; iss?: string }
  >({
    // A 401 here is answered on this screen, not by the sign-in redirect.
    meta: { public: true },
    // The variables hold the code; keep them nowhere once the attempt ends.
    gcTime: 0,
    mutationFn: (body) =>
      unwrap(
        client.POST("/v1/workspace/mcp-servers/{id}/oauth/complete", {
          params: { path: { id: serverId } },
          body,
        }),
      ),
    // No invalidation: out here the client has no query scope, and the list
    // keeps no stale time, so it reads the new connection when it mounts.
    onSuccess: async (server) => {
      await navigate({
        to: "/settings/workspace/mcp-servers",
        state: (previous) => ({
          ...previous,
          workspaceMcpConnected: server.name,
        }),
        replace: true,
      });
    },
    onError: setFailure,
  });
  const usable =
    error === undefined && code !== undefined && state !== undefined;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The code is single-use; it must not stay in the address or history.
    void navigate({ to: ".", search: {}, replace: true });
    if (usable)
      complete.mutate(
        { code, state, ...(iss === undefined ? {} : { iss }) },
        // Detach the observer so gcTime 0 drops the attempt and its code.
        { onSettled: () => complete.reset() },
      );
  }, [navigate, complete.mutate, complete.reset, usable, code, state, iss]);

  const text =
    error !== undefined
      ? t("workspaceMcp.callback.denied", { code: error })
      : !usable
        ? t("workspaceMcp.callback.missing")
        : failure === null
          ? t("workspaceMcp.callback.working")
          : isApiError(failure, "UNAUTHORIZED")
            ? t("workspaceMcp.callback.signedOut")
            : workspaceMcpRefusal(t, failure, undefined);
  const done = !usable || failure !== null;
  return (
    <AuthPage title={t("workspaceMcp.callback.title")}>
      <output aria-live="polite">{text}</output>
      {done ? (
        <Button asChild variant="outline">
          <Link to="/settings/workspace/mcp-servers">
            {t("workspaceMcp.callback.back")}
          </Link>
        </Button>
      ) : null}
    </AuthPage>
  );
}
