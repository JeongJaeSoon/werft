import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AchievementJudgeChangeResponse,
  AchievementJudgeResponse,
  SettingsConnection,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Button,
  Code,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  RowAction,
  RowList,
  SettingRow,
  Skeleton,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { AddConnection, DECISION_KIND } from "./model-connections.tsx";
import {
  credentialText,
  entryActions,
  StateBadge,
  settingsConnectionsQuery,
  useRowActions,
} from "./settings-entries.tsx";

/**
 * The workspace's achievement judge. Its `connections` are the enabled
 * decision models; with none, the achievement rules are locked.
 */
export function useAchievementJudge() {
  const { client } = useWerft();
  const workspaceId = useMe()?.workspace?.id ?? "";
  return useQuery({
    queryKey: scopedKey(client, "achievement-judge"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/achievement-judge", {
          params: { path: { id: workspaceId } },
        }),
      ) as Promise<AchievementJudgeResponse>,
    enabled: workspaceId !== "",
    retry: false,
  });
}

/**
 * Sets up the achievement judge's decision model: the installation's
 * `openai_decisions` connections, written through the settings API like any
 * other connection, so only the owner can.
 */
export function useDecisionModelSetup(
  onOutcome: (outcome: Outcome | null) => void,
): {
  /** Why this person cannot set one up, if they cannot. */
  readonly reason: string | undefined;
  /** Opens the setup from a button, which takes the focus back on close. */
  readonly open: (opener: HTMLElement) => void;
  readonly dialogs: ReactNode;
} {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const owns = useHasPermission("installation.settings.manage");
  const reason = owns
    ? undefined
    : permissionReason(t, "installation.settings.manage", role);
  const connections = useQuery(settingsConnectionsQuery(client, owns));
  const items = connections.data?.items.filter(
    (item) => item.kind === DECISION_KIND,
  );
  const [mode, setMode] = useState<"add" | "manage" | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  // Shown in the dialog too, which covers the screen's own line.
  const [last, setLast] = useState<Outcome | null>(null);
  const report = (outcome: Outcome | null) => {
    setLast(outcome);
    onOutcome(outcome);
  };
  const rows = useRowActions("connection", report);

  // A judge with no connection named takes the first decision model, so
  // setting one up is enough to judge. The settings are read again first:
  // the cached ones may predate another person's save, which this would undo.
  const select = useMutation<
    AchievementJudgeChangeResponse | null,
    ApiError,
    string
  >({
    mutationFn: async (id) => {
      const { achievement_judge: settings } = (await unwrap(
        client.GET("/v1/workspaces/{id}/achievement-judge", {
          params: { path: { id: workspaceId } },
        }),
      )) as AchievementJudgeResponse;
      if (settings.connection_id !== null) return null;
      return unwrap(
        client.PUT("/v1/workspaces/{id}/achievement-judge", {
          params: { path: { id: workspaceId } },
          body: { ...settings, connection_id: id },
        }),
      );
    },
    // A refetch started by the connection write may predate this one.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: scopedKey(client, "achievement-judge"),
      }),
    onError: (error) =>
      report({
        kind: "error",
        text: refusalText(t, error, "achievement_rule.manage", role),
      }),
  });

  const dialogs = (
    <>
      <AddConnection
        decision
        open={mode === "add"}
        opener={opener}
        onOpenChange={(next) => setMode(next ? "add" : null)}
        hosts={connections.data?.credential_hosts ?? null}
        defaults={connections.data?.endpoint_defaults ?? {}}
        onOutcome={report}
        onCreated={(id) => select.mutate(id)}
      />
      <Dialog
        open={mode === "manage"}
        onOpenChange={(next) => {
          if (!next) setMode(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("decisionModel.title")}</DialogTitle>
            <DialogDescription>
              {t("decisionModel.description")}
            </DialogDescription>
          </DialogHeader>
          <OutcomeLine outcome={last} />
          {connections.isError ? (
            <LoadFailure
              error={connections.error}
              onRetry={() => void connections.refetch()}
            />
          ) : items === undefined ? (
            <Skeleton height="4rem" />
          ) : (
            <RowList variant="joined">
              {items.map((item) => (
                <DecisionRow
                  key={item.id}
                  item={item}
                  busy={rows.busy}
                  onValue={(from) => rows.openValue(item.id, from)}
                  onConvert={(from) => rows.openConvert(item.id, from)}
                  onDisable={() => rows.openDisable(item.id)}
                  onEnable={() => rows.openEnable(item.id)}
                />
              ))}
            </RowList>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                report(null);
                setMode("add");
              }}
            >
              <Plus aria-hidden="true" />
              {t("decisionModel.addConnection")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {rows.dialogs}
    </>
  );

  return {
    reason,
    open: (from) => {
      if (reason !== undefined) return;
      setOpener(from);
      report(null);
      setMode(items?.length === 0 ? "add" : "manage");
    },
    dialogs,
  };
}

function DecisionRow({
  item,
  busy,
  onValue,
  onConvert,
  onDisable,
  onEnable,
}: {
  readonly item: SettingsConnection;
  readonly busy: boolean;
  readonly onValue: (opener: HTMLElement) => void;
  readonly onConvert: (opener: HTMLElement) => void;
  readonly onDisable: () => void;
  readonly onEnable: () => void;
}) {
  const { t } = useI18n();
  const actions = entryActions(item);
  const credentialKind = t(`settings.connections.authKind.${item.auth_kind}`);
  return (
    <SettingRow
      title={<Code>{item.id}</Code>}
      badge={<StateBadge state={item.state} />}
      description={item.endpoint}
      meta={credentialText(t, item.credential)}
      actions={
        <>
          {actions.setValue ? (
            <RowAction
              disabled={busy}
              aria-label={t("settings.connections.changeCredentialFor", {
                id: item.id,
                kind: credentialKind,
              })}
              onClick={(event) => onValue(event.currentTarget)}
            >
              {t("settings.connections.changeCredential", {
                kind: credentialKind,
              })}
            </RowAction>
          ) : null}
          {actions.convert ? (
            <RowAction
              disabled={busy}
              aria-label={t("settings.convertFor", { id: item.id })}
              onClick={(event) => onConvert(event.currentTarget)}
            >
              {t("settings.convert")}
            </RowAction>
          ) : null}
          {actions.disable ? (
            <RowAction
              variant="danger"
              disabled={busy}
              aria-label={t("settings.disableFor", { id: item.id })}
              onClick={onDisable}
            >
              {t("settings.disable")}
            </RowAction>
          ) : null}
          {actions.enable ? (
            <RowAction
              disabled={busy}
              aria-label={t("settings.enableFor", { id: item.id })}
              onClick={onEnable}
            >
              {t("settings.enable")}
            </RowAction>
          ) : null}
        </>
      }
    />
  );
}
