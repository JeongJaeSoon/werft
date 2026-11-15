import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  AgentWorkspaceMcpServer,
  AgentWorkspaceMcpServerList,
  PutAgentWorkspaceMcpServersResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Code,
  RowLines,
  RowList,
  RowListItem,
  Section,
  Switch,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { scopedKey } from "../../api/queries.ts";
import { permissionReason, refusalText, useRole } from "../../auth/guard.tsx";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { StatusScreen } from "../../components/status-screen.tsx";
import { isMessageKey, useI18n } from "../../i18n/i18n.tsx";

const STATE_BADGE = {
  none: "gray",
  active: "green",
  needs_reauth: "amber",
} as const;

export const agentWorkspaceMcpKey = (client: ApiClient, agentId: string) =>
  scopedKey(client, "agent-workspace-mcp", agentId);

function agentWorkspaceMcpQuery(client: ApiClient, agentId: string) {
  return queryOptions({
    queryKey: agentWorkspaceMcpKey(client, agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/mcp/workspace-servers", {
          params: { path: { id: agentId } },
        }),
      ),
    retry: false,
  });
}

export function AgentWorkspaceMcp({
  agentId,
  result,
  onOutcome,
}: {
  readonly agentId: string;
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const role = useRole();
  const manages = useManagesAgent();
  const servers = useQuery(agentWorkspaceMcpQuery(client, agentId));
  const hintId = useId();
  const save = useMutation<
    PutAgentWorkspaceMcpServersResponse,
    ApiError,
    readonly string[]
  >({
    mutationFn: (ids) =>
      unwrap(
        client.PUT("/v1/agents/{id}/mcp/workspace-servers", {
          params: { path: { id: agentId } },
          body: { server_ids: [...ids] },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: (answer) => {
      cache.setQueryData<AgentWorkspaceMcpServerList>(
        agentWorkspaceMcpKey(client, agentId),
        answer.servers,
      );
      onOutcome({ kind: "notice", text: t("agentWorkspaceMcp.saved") });
    },
    onError: async (error) => {
      const reason = (error.details as { reason_code?: unknown } | null)
        ?.reason_code;
      const key = `agentWorkspaceMcp.error.${String(reason)}`;
      onOutcome({
        kind: "error",
        text: isMessageKey(key)
          ? t(key)
          : refusalText(t, error, "agent.manage", role),
      });
      await cache.invalidateQueries({
        queryKey: agentWorkspaceMcpKey(client, agentId),
      });
    },
  });

  const title = t("agentWorkspaceMcp.title");
  if (servers.isPending)
    return (
      <Section title={title}>
        <div className={SECTION_BODY}>
          <StatusScreen kind="loading" />
        </div>
      </Section>
    );
  if (servers.isError)
    return (
      <Section title={title}>
        <div className={SECTION_BODY}>
          {isApiError(servers.error, "FORBIDDEN") ? (
            <Text variant="sub">
              {permissionReason(t, "agent.manage", role)}
            </Text>
          ) : (
            <LoadFailure
              error={servers.error}
              onRetry={() => void servers.refetch()}
            />
          )}
        </div>
      </Section>
    );

  const { items, limit } = servers.data;
  const on = items.filter((item) => item.on).map((item) => item.server_id);
  const full = on.length >= limit;
  const toggle = (server: AgentWorkspaceMcpServer, next: boolean) => {
    if (save.isPending) return;
    save.mutate(
      next
        ? [...on, server.server_id]
        : on.filter((id) => id !== server.server_id),
    );
  };

  return (
    <Section
      title={title}
      description={t("agentWorkspaceMcp.description", {
        limit: String(limit),
      })}
    >
      <div className={SECTION_BODY}>
        {result}
        {items.length === 0 ? (
          <Text variant="sub">{t("agentWorkspaceMcp.empty")}</Text>
        ) : (
          <>
            <RowList aria-label={title}>
              {items.map((server) => (
                <ServerRow
                  key={server.server_id}
                  server={server}
                  // Turning one more on past the limit is refused; off stays.
                  locked={!manages || (!server.on && full)}
                  busy={save.isPending}
                  describedBy={full && !server.on ? hintId : undefined}
                  onToggle={(next) => toggle(server, next)}
                />
              ))}
            </RowList>
            {full ? (
              <Text id={hintId} variant="sub">
                {t("agentWorkspaceMcp.limitReached", { limit: String(limit) })}
              </Text>
            ) : null}
            <Text variant="sub">{t("agentWorkspaceMcp.denyHint")}</Text>
          </>
        )}
      </div>
    </Section>
  );
}

function ServerRow({
  server,
  locked,
  busy,
  describedBy,
  onToggle,
}: {
  readonly server: AgentWorkspaceMcpServer;
  readonly locked: boolean;
  readonly busy: boolean;
  readonly describedBy: string | undefined;
  readonly onToggle: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const caveat =
    server.state === "none"
      ? t("agentWorkspaceMcp.notConnected")
      : server.state === "needs_reauth"
        ? t("agentWorkspaceMcp.needsReauth")
        : null;
  return (
    <RowListItem>
      <RowLines>
        <div className="flex flex-wrap items-center gap-2">
          <Text as="span" weight="medium" className="wrap-anywhere">
            <Code size="inherit">{server.name}</Code>
          </Text>
          <Badge variant={STATE_BADGE[server.state]}>
            {t(`workspaceMcp.state.${server.state}`)}
          </Badge>
        </div>
        <Text as="span" variant="meta" className="wrap-anywhere">
          {t("workspaceMcp.tools", { count: String(server.tool_count) })}
          {server.connected_by
            ? ` · ${t("agentWorkspaceMcp.actingAs", {
                name: server.connected_by.display_name,
              })}`
            : ""}
        </Text>
        {caveat ? (
          <Text as="span" variant="meta">
            {caveat}
          </Text>
        ) : null}
      </RowLines>
      <Switch
        aria-label={t("agentWorkspaceMcp.toggle", { name: server.name })}
        aria-describedby={describedBy}
        checked={server.on}
        disabled={locked}
        aria-disabled={busy || undefined}
        onCheckedChange={(next) => {
          if (!busy) onToggle(next);
        }}
      />
    </RowListItem>
  );
}
