import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { type ApiClient, type components, unwrap } from "@werft-ai/client";
import { queryKeysOf } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import { UNVERIFIED_POLL_MS } from "./shared.ts";

/**
 * The app ID of an app whose sent Request URL Slack has not checked; until a
 * Request URL has gone to Slack there is nothing to verify.
 */
export function unverifiedApp(
  read: components["schemas"]["GetSlackAppResponse"] | undefined,
): string | null {
  return read?.events.state === "pending" &&
    read.events.url !== null &&
    read.slack_app?.state === "created"
    ? read.slack_app.app_id
    : null;
}

/** Under the agent's key, so whatever refreshes the agent refreshes these. */
export const slackKey = (client: ApiClient, agentId: string) =>
  [...queryKeysOf(client).agent(agentId), "slack"] as const;

export function useSlackState(agentId: string) {
  const { client } = useWerft();
  const key = slackKey(client, agentId);
  const app = useQuery({
    queryKey: [...key, "app"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/app", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    // Slack may check the URL from its own App Manifest page.
    refetchInterval: (query) =>
      unverifiedApp(query.state.data) ? UNVERIFIED_POLL_MS : false,
    retry: false,
  });
  const identities = useQuery({
    queryKey: [...key, "identities"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/identities", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
  return { app, identities, key };
}

export function useSlackBindings(agentId: string) {
  const { client } = useWerft();
  return useQuery({
    queryKey: [...slackKey(client, agentId), "bindings"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack-bindings", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

/** Asked only of a viewer who may read it: anyone else gets 403. */
export function useSlackJudgments(agentId: string, enabled: boolean) {
  const { client } = useWerft();
  return useQuery({
    enabled,
    queryKey: [...slackKey(client, agentId), "judgments"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/judgments", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * GitHub's head of the active release's repository branch, read when the
 * tab opens: never on a timer, a focus, a reconnect or a Slack refresh. Keyed
 * by the release, so a new release never shows the last one's comparison.
 */
export function useSlackInstructionsHead(
  agentId: string,
  releaseId: string | null,
  enabled: boolean,
) {
  const { client } = useWerft();
  return useQuery({
    enabled: enabled && releaseId !== null,
    queryKey: [
      ...queryKeysOf(client).agent(agentId),
      "instructions-head",
      releaseId,
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/instructions-head", {
          params: { path: { id: agentId } },
        }),
      ),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

/** Channel names for the IDs, at most 50 per read. */
export function useSlackChannelNames(agentId: string, ids: readonly string[]) {
  const { client } = useWerft();
  const wanted = [...new Set(ids)].sort().slice(0, 50);
  return useQuery({
    enabled: wanted.length > 0,
    queryKey: [...slackKey(client, agentId), "channel-names", wanted],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack-channels", {
          params: { path: { id: agentId }, query: { ids: wanted.join(",") } },
        }),
      ),
    staleTime: 60_000,
    retry: false,
  });
}

export function useSlackSettings(agentId: string) {
  const { client } = useWerft();
  return useQuery({
    queryKey: [...slackKey(client, agentId), "settings"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/app/settings", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function useSlackNotice(agentId: string) {
  const { client } = useWerft();
  return useQuery({
    queryKey: [...slackKey(client, agentId), "notice"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/notice", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function useSlackBots(agentId: string) {
  const { client } = useWerft();
  return useQuery({
    queryKey: [...slackKey(client, agentId), "bots"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/app/bots", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function useSlackChannels(
  agentId: string,
  query: string,
  enabled = true,
) {
  const { client } = useWerft();
  return useInfiniteQuery({
    enabled,
    queryKey: [...slackKey(client, agentId), "channels", query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/channels", {
          params: {
            path: { id: agentId },
            query: {
              q: query,
              limit: 20,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}
