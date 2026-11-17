import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@werft-ai/client";
import type {
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
  const role = useRole();
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
  onDisable,
  onEnable,
}: {
  readonly item: SettingsConnection;
  readonly busy: boolean;
  readonly onValue: (opener: HTMLElement) => void;
  readonly onDisable: () => void;
  readonly onEnable: () => void;
}) {
  const { t } = useI18n();
  const actions = entryActions(item);
  const credentialKind = t(`settings.connections.authKind.${item.auth_kind}`);
  // As on the connections screen: a disabled one with no value takes its
  // first, so it can be enabled again.
  const firstValue =
    item.state === "disabled" &&
    item.credential.source === "stored" &&
    item.credential.last4 === null;
  return (
    <SettingRow
      // Below 640px SettingRow pins the buttons to the title's line; these
      // lines are short, so they keep to the left column and the buttons
      // centre on the whole row as on a desktop. A long address breaks.
      className="max-sm:[&>span:nth-child(2)]:col-1 max-sm:[&>div]:row-end-3 max-sm:[&>div]:self-center [&_p]:wrap-anywhere"
      title={<Code>{item.id}</Code>}
      badge={<StateBadge state={item.state} />}
      description={item.endpoint}
      meta={credentialText(t, item.credential)}
      actions={
        <>
          {actions.setValue || firstValue ? (
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
