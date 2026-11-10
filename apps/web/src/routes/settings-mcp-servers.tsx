import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@werft-ai/client";
import type { SettingsMcpServer } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Button,
  Code,
  EmptyState,
  Field,
  FieldDescription,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  Page,
  RowAction,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  credentialText,
  entryActions,
  FormDialog,
  NarrowState,
  type Outcome,
  OutcomeLine,
  SETTINGS_NARROW_COLUMNS,
  SecretInput,
  StateBadge,
  settingsMcpServersQuery,
  useRowActions,
  useSettingsWrite,
} from "./settings-entries.tsx";

// id and source, URL and tool names, credential, workspaces, state,
// actions; a phone keeps the id (with the state and tool names) and the
// actions.
const COLUMNS = [
  "minmax(0,1fr) minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) 128px 196px",
  SETTINGS_NARROW_COLUMNS,
] as const;

/** The tool names a server's tools get in a session (94S-1322 Z5 keys on it). */
export const mcpToolNamespace = (id: string) => `mcp__${id}__*`;

/** Workspace slugs typed as a list. */
export const slugList = (text: string): string[] =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export function McpServersScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const owns = useHasPermission("installation.settings.manage");
  const servers = useQuery(settingsMcpServersQuery(client, owns));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SettingsMcpServer | null>(null);
  const rows = useRowActions("mcp", setOutcome);

  if (!owns)
    return (
      <Page title={t("settings.mcp.title")}>
        <StatusScreen kind="forbidden" />
      </Page>
    );

  return (
    <Page
      title={t("settings.mcp.title")}
      description={t("settings.mcp.description")}
      actions={
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOutcome(null);
            setAdding(true);
          }}
        >
          <Plus aria-hidden="true" />
          {t("settings.mcp.add")}
        </Button>
      }
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        {servers.isPending ? (
          <Skeleton width="60%" />
        ) : servers.isError ? (
          <LoadFailure
            error={servers.error}
            onRetry={() => void servers.refetch()}
          />
        ) : servers.data.items.length === 0 ? (
          <EmptyState framed title={t("settings.mcp.empty")} />
        ) : (
          <GridTable
            // The settings layout zeroes the row inset; a framed table needs it.
            className="[--werft-row-padding-x:var(--werft-space-4)]"
            aria-label={t("settings.mcp.title")}
            columns={COLUMNS[0]}
            narrowAt={860}
            narrowColumns={COLUMNS[1]}
            framed
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("settings.column.id")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.mcp.url")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.column.credential")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.mcp.workspaces")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.column.state")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("settings.column.actions")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {servers.data.items.map((item) => (
              <McpRow
                key={item.id}
                item={item}
                busy={rows.busy}
                onValue={() => rows.openValue(item.id)}
                onDisable={() => rows.openDisable(item.id)}
                onWorkspaces={() => {
                  setOutcome(null);
                  setEditing(item);
                }}
              />
            ))}
          </GridTable>
        )}
        <OutcomeLine outcome={outcome} />
      </div>
      <AddMcpServer
        open={adding}
        onOpenChange={setAdding}
        onOutcome={setOutcome}
      />
      <EditWorkspaces
        server={editing}
        onClose={() => setEditing(null)}
        onOutcome={setOutcome}
      />
      {rows.dialogs}
    </Page>
  );
}

function McpRow({
  item,
  busy,
  onValue,
  onDisable,
  onWorkspaces,
}: {
  readonly item: SettingsMcpServer;
  readonly busy: boolean;
  readonly onValue: () => void;
  readonly onDisable: () => void;
  readonly onWorkspaces: () => void;
}) {
  const { t } = useI18n();
  const actions = entryActions(item);
  return (
    <GridTableRow>
      <GridTableCell>
        <div className="flex min-w-0 flex-col items-start gap-[var(--werft-row-line-gap)]">
          <Code className="wrap-anywhere">{item.id}</Code>
          <NarrowState state={item.state} />
          <Text
            as="span"
            variant="meta"
            className="wrap-anywhere [@container(min-width:861px)]:hidden"
          >
            <Code>{mcpToolNamespace(item.id)}</Code>
          </Text>
        </div>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
          <Code className="wrap-anywhere">{item.url}</Code>
          <Text as="span" variant="meta" className="wrap-anywhere">
            {t("settings.mcp.tools")} <Code>{mcpToolNamespace(item.id)}</Code>
          </Text>
        </div>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
          <Code className="wrap-anywhere">{item.credential_ref}</Code>
          <Text as="span" variant="meta" className="wrap-anywhere">
            {credentialText(t, item.credential)}
          </Text>
        </div>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Text as="span" variant="meta" className="wrap-anywhere">
          {item.workspaces.join(", ")}
        </Text>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <StateBadge state={item.state} />
      </GridTableCell>
      <GridTableCell>
        <div className="flex flex-wrap gap-1">
          {actions.setValue ? (
            <>
              <RowAction
                disabled={busy}
                aria-label={t("settings.setValueFor", { id: item.id })}
                onClick={onValue}
              >
                {item.state === "needs_value"
                  ? t("settings.setFirstValue")
                  : t("settings.setValue")}
              </RowAction>
              <RowAction
                disabled={busy}
                aria-label={t("settings.mcp.editWorkspacesFor", {
                  id: item.id,
                })}
                onClick={onWorkspaces}
              >
                {t("settings.mcp.editWorkspaces")}
              </RowAction>
            </>
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
          {item.credential.source === "external" &&
          item.state !== "disabled" ? (
            <Text as="span" variant="meta">
              {t("settings.externalRow")}
            </Text>
          ) : null}
        </div>
      </GridTableCell>
    </GridTableRow>
  );
}

function AddMcpServer({
  open,
  onOpenChange,
  onOutcome,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const create = useSettingsWrite(
    "mcp",
    (
      client,
      body: {
        id: string;
        url: string;
        credential_ref: string;
        workspaces: string[];
        value: string;
      },
    ) => unwrap(client.POST("/v1/installation/settings/mcp-servers", { body })),
    {
      onDone: (answer) => {
        onOpenChange(false);
        onOutcome({
          kind: "notice",
          text: t("settings.done.created", { id: answer.id }),
        });
      },
      onRefused: setError,
    },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
      pending={create.isPending}
      title={t("settings.mcp.add")}
      description={t("settings.immutable")}
      error={error}
      submitLabel={t("settings.create")}
      pendingLabel={t("settings.creating")}
      onSubmit={(form) => {
        setError(null);
        create.mutate({
          id: String(form.get("id")).trim(),
          url: String(form.get("url")).trim(),
          credential_ref: String(form.get("credential_ref")).trim(),
          workspaces: slugList(String(form.get("workspaces"))),
          value: String(form.get("value")),
        });
      }}
    >
      <Field>
        <FieldLabel>{t("settings.id")}</FieldLabel>
        <Input
          name="id"
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
        />
        <FieldDescription>{t("settings.idHint")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>{t("settings.mcp.url")}</FieldLabel>
        <Input
          name="url"
          type="url"
          required
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field>
        <FieldLabel>{t("settings.mcp.credentialRef")}</FieldLabel>
        <Input
          name="credential_ref"
          required
          autoComplete="off"
          spellCheck={false}
        />
        <FieldDescription>
          {t("settings.mcp.credentialRefHint")}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel>{t("settings.mcp.workspaces")}</FieldLabel>
        <Input
          name="workspaces"
          required
          autoComplete="off"
          spellCheck={false}
        />
        <FieldDescription>{t("settings.mcp.workspacesHint")}</FieldDescription>
      </Field>
      <SecretInput label={t("settings.mcp.bearer")} />
    </FormDialog>
  );
}

function EditWorkspaces({
  server,
  onClose,
  onOutcome,
}: {
  readonly server: SettingsMcpServer | null;
  readonly onClose: () => void;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const save = useSettingsWrite(
    "mcp",
    (client, input: { id: string; workspaces: string[] }) =>
      unwrap(
        client.PATCH("/v1/installation/settings/mcp-servers/{id}", {
          params: { path: { id: input.id } },
          body: { workspaces: input.workspaces },
        }),
      ),
    {
      onDone: (answer) => {
        onClose();
        onOutcome({
          kind: "notice",
          text: t("settings.done.changed", { id: answer.id }),
        });
      },
      onRefused: setError,
    },
  );
  return (
    <FormDialog
      open={server !== null}
      onOpenChange={(open) => {
        setError(null);
        if (!open) onClose();
      }}
      pending={save.isPending}
      title={t("settings.mcp.editWorkspacesTitle", { id: server?.id ?? "" })}
      description={t("settings.mcp.workspacesHint")}
      error={error}
      submitLabel={t("settings.save")}
      pendingLabel={t("settings.saving")}
      onSubmit={(form) => {
        if (server === null) return;
        setError(null);
        save.mutate({
          id: server.id,
          workspaces: slugList(String(form.get("workspaces"))),
        });
      }}
    >
      <Field>
        <FieldLabel>{t("settings.mcp.workspaces")}</FieldLabel>
        <Input
          name="workspaces"
          required
          autoComplete="off"
          spellCheck={false}
          defaultValue={server?.workspaces.join(", ") ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
