import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import { useState } from "react";
import { useMe } from "../../../auth/guard.tsx";
import { useI18n } from "../../../i18n/i18n.tsx";
import { useAppServices } from "../../../services.tsx";
import { useSlackState } from "./queries.ts";

/**
 * The agent's Slack app and what can be done to it: make and install,
 * re-check the Request URL, disconnect and delete. The new-agent flow and the
 * Slack tab both drive the app through this.
 */
export function useSlackApp(agentId: string) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const me = useMe();
  const { leave } = useAppServices();
  const { app, identities, key } = useSlackState(agentId);
  // The last action's outcome, read out in the section of its button: the
  // Request URL's recheck in the address section, the rest with the app.
  const [outcome, setOutcome] = useState<{
    readonly text: string;
    readonly at: SlackActionSite;
  } | null>(null);
  const setNotice = (text: string, at: SlackActionSite = "app") =>
    setOutcome(text ? { text, at } : null);
  const identity = identities.data?.items.find(
    (item) => item.provider === "slack_bot" && item.status === "active",
  );
  const record = app.data?.slack_app;
  const refresh = () => cache.invalidateQueries({ queryKey: key });
  const connect = useMutation({
    mutationFn: async () => {
      if (!record)
        await unwrap(
          client.POST("/v1/agents/{id}/slack/app", {
            params: { path: { id: agentId } },
            body: { replace_uncertain: false },
          }),
        );
      await refresh();
      return unwrap(
        client.POST("/v1/agents/{id}/slack/install/start", {
          params: { path: { id: agentId } },
        }),
      );
    },
    onSuccess: ({ authorize_url }) => {
      leave(authorize_url);
    },
  });
  const remove = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: async () => {
      if (!record || !me?.workspace) return;
      await unwrap(
        client.DELETE("/v1/workspaces/{id}/slack/apps/{app_id}", {
          params: { path: { id: me.workspace.id, app_id: record.id } },
        }),
      );
    },
    onSuccess: async () => {
      setNotice(t("slack.deleted"));
      await refresh();
    },
  });
  const revoke = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: async () => {
      if (!identity) return;
      await unwrap(
        client.DELETE("/v1/agents/{id}/identities/{identity_id}", {
          params: { path: { id: agentId, identity_id: identity.id } },
        }),
      );
    },
    onSuccess: async () => {
      setNotice(t("slack.revoked"));
      await refresh();
    },
  });
  const recheck = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: () =>
      unwrap(
        client.POST("/v1/agents/{id}/slack/app/events/recheck", {
          params: { path: { id: agentId } },
        }),
      ),
    onSuccess: async (read) => {
      setNotice(
        t(
          read.events.state === "verified"
            ? "slack.eventsUrl.done"
            : "slack.eventsUrl.sent",
        ),
        "address",
      );
      await refresh();
    },
  });
  const busy =
    connect.isPending ||
    remove.isPending ||
    revoke.isPending ||
    recheck.isPending;
  return {
    app,
    identities,
    identity,
    record,
    refresh,
    connect,
    remove,
    revoke,
    recheck,
    busy,
    /** The outcome for the wizard's one section, wherever it came from. */
    notice: outcome?.text ?? "",
    /** The outcome to read out in a section of the tab, if it is that one's. */
    noticeAt: (site: SlackActionSite) =>
      outcome?.at === site ? outcome.text : "",
    /** A record in flight cannot be installed or re-checked. */
    pending: record?.state === "creating" || record?.state === "deleting",
    readError: app.error ?? identities.error,
    saveError: connect.error ?? remove.error ?? revoke.error ?? recheck.error,
  };
}

export type SlackApp = ReturnType<typeof useSlackApp>;
/** The tab section whose button an action is. */
export type SlackActionSite = "address" | "app";
