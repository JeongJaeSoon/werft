import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { type components, unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import { Button, Page } from "@werft-ai/ui";
import { useEffect, useRef } from "react";
import { useToast } from "../../components/toast.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { slackFailure, slackKey } from "./slack.tsx";

type CompleteSlackInstallResponse =
  components["schemas"]["CompleteSlackInstallResponse"];

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The Slack tab announces a finished install once. */
    readonly slackInstalled?: boolean;
  }
}

export function SlackInstallCallback() {
  const { id } = useParams({ from: "/authed/agents/$id/slack/callback" });
  const search = useSearch({ from: "/authed/agents/$id/slack/callback" });
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const started = useRef(false);
  const { notify: show, toast } = useToast();
  // The page's own output already reads the outcome out.
  const notify = (text: string) => show(text, { silent: true });
  const unfinished = (result: CompleteSlackInstallResponse) =>
    result.warnings.some((warning) => warning.code === "reinstall_required")
      ? t("slack.state.reinstall")
      : !result.finalized || result.warnings.length > 0
        ? t("slack.verifyNeeded")
        : null;
  const complete = useMutation({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/slack/install/complete", {
          body: {
            agent_id: id,
            state: search.state,
            ...(search.code ? { code: search.code } : {}),
            ...(search.error ? { error: search.error } : {}),
          },
        }),
      ),
    onSuccess: async (result) => {
      await cache.invalidateQueries({ queryKey: slackKey(client, id) });
      const left = unfinished(result);
      if (left) notify(left);
      else
        await navigate({
          to: "/agents/$id",
          params: { id },
          search: { tab: "slack" },
          state: (previous) => ({ ...previous, slackInstalled: true }),
          replace: true,
        });
    },
    onError: (failure) => notify(slackFailure(failure, t)),
  });
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    complete.mutate();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
  }, [complete.mutate]);
  return (
    <Page title={t("slack.install")}>
      <output aria-live="polite">
        {complete.error
          ? slackFailure(complete.error, t)
          : ((complete.data && unfinished(complete.data)) ??
            t("slack.working"))}
      </output>
      {complete.error || complete.data ? (
        <Button asChild variant="outline">
          <Link to="/agents/$id" params={{ id }} search={{ tab: "slack" }}>
            {t("slack.app")}
          </Link>
        </Button>
      ) : null}
      {toast}
    </Page>
  );
}
