import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@werft-ai/client";
import type {
  CreateSettingsConnectionRequest,
  SettingsConnection,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Button,
  Code,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  NativeSelect,
  NativeSelectOption,
  Page,
  RowAction,
  Skeleton,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { LoadFailure } from "../components/load-failure.tsx";
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
  settingsConnectionsQuery,
  useRowActions,
  useSettingsWrite,
} from "./settings-entries.tsx";

// id and source, kind and endpoint, credential, models, state, actions; a phone keeps the id (with the state) and the actions.
const COLUMNS = [
  "minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,1fr) 112px 128px 196px",
  SETTINGS_NARROW_COLUMNS,
] as const;

/**
 * The model settings' connections (settings-replace-file-catalog.md §1-§3):
 * the operator file's and the database's in one table, each marked by
 * where it comes from. Only the owner reads them.
 */
export function ModelConnections() {
  const { t } = useI18n();
  const { client } = useWerft();
  const connections = useQuery(settingsConnectionsQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [adding, setAdding] = useState(false);
  const [judging, setJudging] = useState<SettingsConnection | null>(null);
  const [listing, setListing] = useState<SettingsConnection | null>(null);
  const rows = useRowActions("connection", setOutcome);

  return (
    <Page
      title={t("settings.connections.title")}
      description={t("settings.connections.description")}
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
          {t("settings.connections.add")}
        </Button>
      }
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        {connections.isPending ? (
          <Skeleton width="60%" />
        ) : connections.isError ? (
          <LoadFailure
            error={connections.error}
            onRetry={() => void connections.refetch()}
          />
        ) : connections.data.items.length === 0 ? (
          <EmptyState framed title={t("settings.connections.empty")} />
        ) : (
          <GridTable
            // The settings layout zeroes the row inset; a framed table needs it.
            className="[--werft-row-padding-x:var(--werft-space-4)]"
            aria-label={t("settings.connections.title")}
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
                {t("settings.connections.endpoint")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.column.credential")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.connections.models")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("settings.column.state")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("settings.column.actions")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {connections.data.items.map((item) => (
              <ConnectionRow
                key={item.id}
                item={item}
                busy={rows.busy}
                onValue={() => rows.openValue(item.id)}
                onConvert={() => rows.openConvert(item.id)}
                onAutoMode={() => {
                  setOutcome(null);
                  setJudging(item);
                }}
                onModels={() => {
                  setOutcome(null);
                  setListing(item);
                }}
                onDisable={() => rows.openDisable(item.id)}
                onEnable={() => rows.openEnable(item.id)}
              />
            ))}
          </GridTable>
        )}
        <OutcomeLine outcome={outcome} />
      </div>
      <AddConnection
        open={adding}
        onOpenChange={setAdding}
        hosts={connections.data?.credential_hosts ?? null}
        defaults={connections.data?.endpoint_defaults ?? {}}
        onOutcome={setOutcome}
      />
      <AutoModeDialog
        item={judging}
        onClose={() => setJudging(null)}
        onOutcome={setOutcome}
      />
      <ModelsDialog
        item={listing}
        onClose={() => setListing(null)}
        onOutcome={setOutcome}
      />
      {rows.dialogs}
    </Page>
  );
}

function ConnectionRow({
  item,
  busy,
  onValue,
  onConvert,
  onAutoMode,
  onModels,
  onDisable,
  onEnable,
}: {
  readonly item: SettingsConnection;
  readonly busy: boolean;
  readonly onValue: () => void;
  readonly onConvert: () => void;
  readonly onAutoMode: () => void;
  readonly onModels: () => void;
  readonly onDisable: () => void;
  readonly onEnable: () => void;
}) {
  const { t } = useI18n();
  const actions = entryActions(item);
  return (
    <GridTableRow>
      <GridTableCell>
        <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
          <Code className="wrap-anywhere">{item.id}</Code>
          <div className="flex flex-wrap items-center gap-1">
            <NarrowState state={item.state} />
            <Text as="span" variant="meta">
              {t(`settings.connections.authKind.${item.auth_kind}`)}
            </Text>
          </div>
        </div>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
          <Code className="wrap-anywhere">{item.endpoint}</Code>
          <Text as="span" variant="meta">
            {item.kind} · {t(`settings.connections.billing.${item.billing}`)} ·{" "}
            {t("settings.autoMode.column")}{" "}
            {t(`settings.autoMode.${item.auto_mode}`)}
          </Text>
        </div>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Text as="span" variant="meta" className="wrap-anywhere">
          {credentialText(t, item.credential)}
        </Text>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Text as="span" variant="meta" className="wrap-anywhere">
          {item.models.length === 0
            ? t("settings.connections.noModels")
            : item.models.join(", ")}
        </Text>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <StateBadge state={item.state} />
      </GridTableCell>
      <GridTableCell>
        <div className="flex flex-wrap gap-1">
          {actions.setValue ? (
            <RowAction
              disabled={busy}
              aria-label={t("settings.setValueFor", { id: item.id })}
              onClick={onValue}
            >
              {item.state === "needs_value"
                ? t("settings.setFirstValue")
                : t("settings.setValue")}
            </RowAction>
          ) : null}
          {actions.convert ? (
            <RowAction
              disabled={busy}
              aria-label={t("settings.convertFor", { id: item.id })}
              onClick={onConvert}
            >
              {t("settings.convert")}
            </RowAction>
          ) : null}
          {item.state !== "disabled" ? (
            <RowAction
              disabled={busy}
              aria-label={t("settings.autoMode.setFor", { id: item.id })}
              onClick={onAutoMode}
            >
              {t("settings.autoMode.set")}
            </RowAction>
          ) : null}
          {item.state !== "disabled" ? (
            <RowAction
              disabled={busy}
              aria-label={t("settings.models.setFor", { id: item.id })}
              onClick={onModels}
            >
              {t("settings.models.set")}
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
        </div>
      </GridTableCell>
    </GridTableRow>
  );
}

const AUTO_MODES = ["unknown", "supported", "unsupported"] as const;

/**
 * Records whether a connection's models run the auto-mode classifier. Only
 * "supported" changes how agents run, so the dialog says what that does.
 */
function AutoModeDialog({
  item,
  onClose,
  onOutcome,
}: {
  readonly item: SettingsConnection | null;
  readonly onClose: () => void;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const save = useSettingsWrite(
    "connection",
    (
      client,
      variables: {
        readonly id: string;
        readonly auto_mode: (typeof AUTO_MODES)[number];
      },
    ) =>
      unwrap(
        client.POST("/v1/installation/settings/connections/{id}/auto-mode", {
          params: { path: { id: variables.id } },
          body: { auto_mode: variables.auto_mode },
        }),
      ),
    {
      onDone: (_answer, variables) => {
        onClose();
        onOutcome({
          kind: "notice",
          text: t("settings.done.autoMode", {
            id: variables.id,
            value: t(`settings.autoMode.${variables.auto_mode}`),
          }),
        });
      },
      onRefused: setError,
    },
  );

  return (
    <FormDialog
      open={item !== null}
      onOpenChange={(next) => {
        if (next) return;
        setError(null);
        onClose();
      }}
      pending={save.isPending}
      title={t("settings.autoMode.title")}
      description={t("settings.autoMode.description")}
      error={error}
      submitLabel={t("settings.autoMode.save")}
      pendingLabel={t("settings.autoMode.saving")}
      onSubmit={(form) => {
        if (item === null) return;
        setError(null);
        const picked = AUTO_MODES.find(
          (mode) => mode === form.get("auto_mode"),
        );
        if (picked === undefined) return;
        save.mutate({ id: item.id, auto_mode: picked });
      }}
    >
      <Field>
        <FieldLabel>{t("settings.autoMode.label")}</FieldLabel>
        {/* Keyed so each connection opens on its own stored value. */}
        <NativeSelect
          key={item?.id ?? ""}
          name="auto_mode"
          defaultValue={item?.auto_mode ?? "unknown"}
        >
          {AUTO_MODES.map((mode) => (
            <NativeSelectOption key={mode} value={mode}>
              {t(`settings.autoMode.${mode}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    </FormDialog>
  );
}

/** One model per line or comma, trimmed, repeats dropped, in order. */
function modelsOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((model) => model.trim())
        .filter((model) => model !== ""),
    ),
  ];
}

/**
 * The models an agent's card may name on a connection, one per line. A
 * session on a model taken off the list stops at its next model call.
 */
function ModelsDialog({
  item,
  onClose,
  onOutcome,
}: {
  readonly item: SettingsConnection | null;
  readonly onClose: () => void;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const save = useSettingsWrite(
    "connection",
    (client, variables: { readonly id: string; readonly models: string[] }) =>
      unwrap(
        client.POST("/v1/installation/settings/connections/{id}/models", {
          params: { path: { id: variables.id } },
          body: { models: variables.models },
        }),
      ),
    {
      onDone: (_answer, variables) => {
        onClose();
        onOutcome({
          kind: "notice",
          text: t("settings.done.models", {
            id: variables.id,
            count: variables.models.length,
          }),
        });
      },
      onRefused: setError,
    },
  );

  return (
    <FormDialog
      open={item !== null}
      onOpenChange={(next) => {
        if (next) return;
        setError(null);
        onClose();
      }}
      pending={save.isPending}
      title={t("settings.models.title")}
      description={t("settings.models.description")}
      error={error}
      submitLabel={t("settings.models.save")}
      pendingLabel={t("settings.models.saving")}
      onSubmit={(form) => {
        if (item === null) return;
        setError(null);
        save.mutate({
          id: item.id,
          models: modelsOf(String(form.get("models") ?? "")),
        });
      }}
    >
      <Field>
        <FieldLabel>{t("settings.models.label")}</FieldLabel>
        {/* Keyed so each connection opens on its own stored list. */}
        <Textarea
          key={item?.id ?? ""}
          name="models"
          rows={5}
          defaultValue={(item?.models ?? []).join("\n")}
        />
        <FieldDescription>{t("settings.models.hint")}</FieldDescription>
      </Field>
    </FormDialog>
  );
}

type ConnectionKind = SettingsConnection["kind"];

// The kinds in the order the form lists them. The record stops compiling when
// the contract gains a kind this form does not offer.
const CONNECTION_KINDS = Object.keys({
  anthropic: true,
  litellm: true,
  openai_responses: true,
} satisfies Record<ConnectionKind, true>) as ConnectionKind[];

/** `host:port` of an endpoint, the port spelled out as the proxy lists it. */
function endpointHost(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.hostname}:${port}`;
  } catch {
    return null;
  }
}

function AddConnection({
  open,
  onOpenChange,
  hosts,
  defaults,
  onOutcome,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The egress credential allowlist, when the API knows it. */
  readonly hosts: readonly string[] | null;
  /** The endpoint each kind takes when left empty, by kind. */
  readonly defaults: Readonly<Record<string, string>>;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<ConnectionKind>("anthropic");
  // What the person typed; null until they touch the field, so the kind's
  // default shows through and a kind change can swap it.
  const [edited, setEdited] = useState<string | null>(null);
  const fallback = defaults[kind];
  const endpoint = edited ?? fallback ?? "";
  const [error, setError] = useState<string | null>(null);
  // Set when a kind with no default address is submitted without one.
  const [endpointMissing, setEndpointMissing] = useState(false);
  const create = useSettingsWrite(
    "connection",
    (
      client,
      body: Omit<CreateSettingsConnectionRequest, "billing" | "endpoint"> & {
        readonly billing: "none" | "per_token";
        readonly endpoint?: string;
      },
    ) => unwrap(client.POST("/v1/installation/settings/connections", { body })),
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
  const host = endpointHost(endpoint);
  const outside = hosts !== null && host !== null && !hosts.includes(host);

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        setEndpointMissing(false);
        if (!next) {
          setKind("anthropic");
          setEdited(null);
        }
        onOpenChange(next);
      }}
      pending={create.isPending}
      title={t("settings.connections.add")}
      description={t("settings.immutable")}
      error={error}
      submitLabel={t("settings.create")}
      pendingLabel={t("settings.creating")}
      onSubmit={(form) => {
        setError(null);
        const billing = String(form.get("billing"));
        // Only what the person typed goes out; the shown default stays the
        // server's to fill, so its billing check still runs.
        const named = (edited ?? "").trim();
        if (named === "" && fallback === undefined) {
          setEndpointMissing(true);
          return;
        }
        create.mutate({
          id: String(form.get("id")).trim(),
          kind,
          // Left empty, the server fills the kind's default.
          ...(named === "" ? {} : { endpoint: named }),
          billing: billing === "none" ? "none" : "per_token",
          auth_kind:
            kind === "litellm" && form.get("auth_kind") === "bearer"
              ? "bearer"
              : "api_key",
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
        <FieldLabel>{t("settings.connections.kind")}</FieldLabel>
        <NativeSelect
          name="kind"
          value={kind}
          onChange={(event) => {
            // A cleared field hands the new kind's default back.
            if (edited === "") setEdited(null);
            setEndpointMissing(false);
            const next = CONNECTION_KINDS.find(
              (known) => known === event.target.value,
            );
            if (next !== undefined) setKind(next);
          }}
        >
          {CONNECTION_KINDS.map((known) => (
            <NativeSelectOption key={known} value={known}>
              {known}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {kind === "openai_responses" ? (
          <FieldDescription>
            {t("settings.connections.kindHint.openai_responses")}
          </FieldDescription>
        ) : null}
      </Field>
      <Field>
        <FieldLabel>{t("settings.connections.endpoint")}</FieldLabel>
        <Input
          name="endpoint"
          type="url"
          aria-required={fallback === undefined || undefined}
          aria-invalid={endpointMissing || undefined}
          autoComplete="off"
          spellCheck={false}
          value={endpoint}
          onChange={(event) => {
            setEndpointMissing(false);
            setEdited(event.target.value);
          }}
        />
        {endpointMissing ? (
          <FieldError>{t("settings.connections.endpointRequired")}</FieldError>
        ) : null}
        {fallback === undefined ? null : (
          <FieldDescription>
            {t("settings.connections.endpointDefault")}
          </FieldDescription>
        )}
      </Field>
      {outside ? (
        <Alert variant="amber" role="status">
          <AlertDescription>
            {t("settings.connections.egressWarning", { host })}
          </AlertDescription>
        </Alert>
      ) : null}
      <Field>
        <FieldLabel>{t("settings.connections.billing")}</FieldLabel>
        <NativeSelect name="billing" defaultValue="per_token">
          <NativeSelectOption value="per_token">
            {t("settings.connections.billing.per_token")}
          </NativeSelectOption>
          <NativeSelectOption value="none">
            {t("settings.connections.billing.none")}
          </NativeSelectOption>
        </NativeSelect>
      </Field>
      {kind === "litellm" ? (
        <Field>
          <FieldLabel>{t("settings.connections.authKind")}</FieldLabel>
          <NativeSelect name="auth_kind" defaultValue="api_key">
            <NativeSelectOption value="api_key">
              {t("settings.connections.authKind.api_key")}
            </NativeSelectOption>
            <NativeSelectOption value="bearer">
              {t("settings.connections.authKind.bearer")}
            </NativeSelectOption>
          </NativeSelect>
        </Field>
      ) : null}
      <SecretInput label={t("settings.connections.key")} />
    </FormDialog>
  );
}
