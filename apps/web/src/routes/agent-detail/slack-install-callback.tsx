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
import { SLACK_INSTALL_CALLBACK } from "../../auth/limits.ts";
import { useToast } from "../../components/toast.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { slackKey } from "./slack/queries.ts";
import { slackFailure } from "./slack/shared.ts";
import type { slackInstallSearch } from "./slack-install-search.ts";

type CompleteSlackInstallResponse =
  components["schemas"]["CompleteSlackInstallResponse"];

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The Slack tab announces a finished install once. */
    readonly slackInstalled?: boolean;
  }
}

/** A redirect the server would take: exactly one of code and error. */
export function slackCallbackValid({
  state,
  code,
  error,
}: ReturnType<typeof slackInstallSearch>): boolean {
  return (
    SLACK_INSTALL_CALLBACK.state.test(state) &&
    (code === undefined) !== (error === undefined) &&
    (code === undefined || SLACK_INSTALL_CALLBACK.code.test(code)) &&
    (error === undefined || SLACK_INSTALL_CALLBACK.error.test(error))
  );
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
            ...(search.code === undefined ? {} : { code: search.code }),
            ...(search.error === undefined ? {} : { error: search.error }),
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
  // A cut or hand-edited redirect is spent before any request: start again.
  const valid = slackCallbackValid(search);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (valid) complete.mutate();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
  }, [complete.mutate, valid]);
  return (
    <Page title={t("slack.install")}>
      <output aria-live="polite">
        {!valid
          ? t("slack.error.expired")
          : complete.error
            ? slackFailure(complete.error, t)
            : ((complete.data && unfinished(complete.data)) ??
              t("slack.working"))}
      </output>
      {!valid || complete.error || complete.data ? (
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
