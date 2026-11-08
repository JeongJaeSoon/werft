import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  GitHubAppPermissionLevel,
  GitHubAppPermissions,
  GitHubSettingsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  ConfirmDialog,
  RowList,
  SettingRow,
  Skeleton,
  Switch,
  Text,
} from "@werft-ai/ui";
import { useId, useRef, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { isMessageKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import {
  type Feature,
  featureMark,
  OFFERED_FEATURES,
  type OfferedFeature,
} from "./github-permission-table.ts";
import { type OnOutcome, ReadOnlyMark } from "./workspace-settings.tsx";

export const githubSettingsKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-settings");

export function useGitHubSettings(): UseQueryResult<GitHubSettingsResponse> {
  const { client } = useWerft();
  const workspaceId = useMe()?.workspace?.id ?? "";
  return useQuery({
    queryKey: githubSettingsKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-settings", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "",
  });
}

export const levelText = (t: Translate, level: GitHubAppPermissionLevel) =>
  t(`github.permissions.level.${level}`);

// A permission this build has no words for is shown as GitHub names it.
export function permissionName(t: Translate, name: string): string {
  const key = `github.permissions.name.${name}`;
  return isMessageKey(key) ? t(key) : name;
}

/** "Workflows 쓰기, Actions 쓰기". */
export function permissionsText(t: Translate, need: GitHubAppPermissions) {
  return Object.entries(need)
    .map(([name, level]) => `${permissionName(t, name)} ${levelText(t, level)}`)
    .join(", ");
}

export const featureName = (t: Translate, feature: Feature) =>
  t(`github.feature.${feature}`);

/**
 * What agents may turn on beyond writing a PR: the workspace's one ceiling.
 * A switch saves at once; a lowering asks first, since a running release
 * loses the feature at its next token.
 */
export function FeatureList({
  settings,
  onOutcome,
}: {
  readonly settings: UseQueryResult<GitHubSettingsResponse>;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const key = githubSettingsKey(client, workspaceId);
  const readOnlyId = useId();
  // What each switch shows until its saves settle: the server's value after.
  const [shown, setShown] = useState<Partial<Record<OfferedFeature, boolean>>>(
    {},
  );
  // Saves not yet answered, per switch.
  const saving = useRef<Partial<Record<OfferedFeature, number>>>({});
  const [, rerender] = useState(0);
  const [lowering, setLowering] = useState<OfferedFeature | null>(null);
  const [live, setLive] = useState("");
  // One save at a time, each on the revision the last one answered; a
  // failure drops what was queued behind it.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const round = useRef(0);

  const settle = (feature: OfferedFeature) => {
    const left = (saving.current[feature] ?? 1) - 1;
    if (left > 0) saving.current[feature] = left;
    else {
      delete saving.current[feature];
      setShown(({ [feature]: _, ...rest }) => rest);
    }
    rerender((n) => n + 1);
  };

  const send = (feature: OfferedFeature, next: boolean) => {
    const name = featureName(t, feature);
    setShown((was) => ({ ...was, [feature]: next }));
    saving.current[feature] = (saving.current[feature] ?? 0) + 1;
    rerender((n) => n + 1);
    setLive(t("github.ceiling.saving", { feature: name }));
    onOutcome(null);
    const started = round.current;
    chain.current = chain.current.then(async () => {
      if (started !== round.current) return;
      const base = queryClient.getQueryData<GitHubSettingsResponse>(key);
      if (base === undefined) {
        settle(feature);
        return;
      }
      try {
        const saved = await unwrap(
          client.PUT("/v1/workspaces/{id}/github-settings", {
            params: { path: { id: workspaceId } },
            body: {
              ceiling: { ...base.ceiling, [feature]: next },
              revision: base.revision,
            },
          }),
        );
        queryClient.setQueryData(key, saved);
        setLive(t("github.ceiling.saved", { feature: name }));
        settle(feature);
      } catch (error) {
        // Cleared before the refetch, so a switch turned while it runs keeps
        // its own pending save.
        round.current += 1;
        saving.current = {};
        setShown({});
        await settings.refetch();
        const text = isApiError(error, "REVISION_CONFLICT")
          ? t("github.ceiling.conflict")
          : isApiError(error)
            ? `${t("github.ceiling.failed")} ${refusalText(t, error, "workspace.manage", role)}`
            : t("github.ceiling.failed");
        setLive(text);
        onOutcome({ kind: "error", text });
      }
    });
  };

  const data = settings.data;
  const value = (feature: OfferedFeature) =>
    shown[feature] ?? data?.ceiling[feature] ?? false;
  const mark = (feature: Feature) => {
    const kind = data
      ? featureMark(feature, data.connections, {
          ...data.ceiling,
          ...shown,
        })
      : null;
    return kind === null ? null : (
      <Badge variant="amber">
        {t(
          kind === "appShort"
            ? "github.ceiling.appShort"
            : "github.ceiling.pending",
        )}
      </Badge>
    );
  };
  const reviewer = data?.connections.find(
    (connection) => connection.role === "reviewer",
  );

  // The workspace alone sets merge; no release holds it, so nothing counts it.
  const agentsUsing = (feature: OfferedFeature) =>
    feature === "merge" ? null : (data?.agents_using[feature] ?? 0);

  const featureRow = (feature: OfferedFeature) => {
    const on = value(feature);
    const busy = (saving.current[feature] ?? 0) > 0;
    // A review needs a reviewer App; one already on can still be turned off.
    const locked = feature === "review" && reviewer === undefined && !on;
    const count = agentsUsing(feature);
    const using =
      count === null ? null : t("github.ceiling.agentsUsing", { count });
    return (
      <SettingRow
        key={feature}
        title={featureName(t, feature)}
        badge={mark(feature)}
        description={t(`github.feature.${feature}Hint`)}
        meta={
          using === null ? undefined : (
            <Text as="div" variant="meta">
              {feature === "review" && reviewer
                ? t("github.ceiling.viaApp", { name: reviewer.name, using })
                : using}
            </Text>
          )
        }
        control={
          <Switch
            checked={on}
            aria-busy={busy || undefined}
            aria-describedby={canManage ? undefined : readOnlyId}
            disabled={!canManage || data === undefined || locked}
            onCheckedChange={(next) => {
              if (busy) return;
              if (next) send(feature, true);
              else setLowering(feature);
            }}
          />
        }
      />
    );
  };

  const rows = settings.isPending ? (
    <SettingRow title={<Skeleton width="40%" />} />
  ) : settings.isError ? (
    <li className="list-none py-4">
      <LoadFailure
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    </li>
  ) : (
    <>
      <SettingRow
        title={featureName(t, "base")}
        badge={mark("base")}
        description={t("github.feature.baseHint")}
        actions={
          <Text as="div" variant="meta">
            {t("github.ceiling.always")}
          </Text>
        }
      />
      {OFFERED_FEATURES.map(featureRow)}
    </>
  );

  return (
    <>
      <RowList variant="joined" framed={false}>
        {rows}
      </RowList>
      <div aria-live="polite" className="sr-only">
        {live}
      </div>
      {canManage ? null : (
        <div id={readOnlyId} className="flex flex-wrap items-center gap-2">
          <ReadOnlyMark />
          <Text as="div" variant="meta">
            {permissionReason(t, "workspace.manage", role)}
          </Text>
        </div>
      )}
      <ConfirmDialog
        open={lowering !== null}
        onOpenChange={(open) => {
          if (!open) setLowering(null);
        }}
        title={t("github.ceiling.lowerTitle")}
        consequence={
          lowering === null
            ? ""
            : lowering === "merge"
              ? t("github.ceiling.lowerBodyNoCount", {
                  feature: featureName(t, lowering),
                })
              : t("github.ceiling.lowerBody", {
                  feature: featureName(t, lowering),
                  count: agentsUsing(lowering) ?? 0,
                })
        }
        confirmLabel={t("github.ceiling.lowerConfirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          if (lowering !== null) send(lowering, false);
          setLowering(null);
        }}
      />
    </>
  );
}
