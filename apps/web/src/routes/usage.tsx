import { type ApiClient, unwrap } from "@werft-ai/client";
import type {
  UsageSummaryQuery,
  UsageSummaryResponse,
} from "@werft-ai/contracts";
import { scopedKey } from "../api/queries.ts";
import type { Translate } from "../i18n/i18n.tsx";

export function usageSummaryQuery(
  client: ApiClient,
  scope: UsageSummaryQuery["scope"],
  since: string,
  { until, agentId }: { until?: string; agentId?: string } = {},
) {
  return {
    queryKey: scopedKey(client, "usage-summary", scope, since, until, agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/usage/summary", {
          params: {
            query: {
              scope,
              since,
              ...(until === undefined ? {} : { until }),
              ...(agentId === undefined ? {} : { agent_id: agentId }),
            },
          },
        }),
      ) as Promise<UsageSummaryResponse>,
    // A failure shows its retry button at once, like the home's limits.
    retry: false,
  };
}

export function duration(seconds: number, t: Translate): string {
  // A fake-model or short run lasts seconds; "0분" would read as nothing ran.
  if (seconds < 60) return t("usage.duration.seconds", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0
    ? t("usage.duration.hours", { h, m })
    : t("usage.duration.minutes", { m });
}
