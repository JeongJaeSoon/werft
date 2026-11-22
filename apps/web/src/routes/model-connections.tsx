import { queryOptions, useQuery } from "@tanstack/react-query";
import { type ApiClient, ApiError, unwrap } from "@werft-ai/client";
import type {
  CreateSettingsConnectionRequest,
  DiscoverConnectionModelsResponse,
  SettingsConnection,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
  Code,
  EmptyState,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  NativeSelect,
  NativeSelectOption,
  Page,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { INACTIVE_ROW_CLASS } from "../components/inactive-member.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { RowMenu, RowMenuItem } from "../components/row-menu.tsx";
import { type Translate, useI18n } from "../i18n/i18n.tsx";
import {
  credentialText,
  entryActions,
  FormDialog,
  NarrowState,
  SETTINGS_NARROW_COLUMNS,
  SecretInput,
  StateText,
  settingsConnectionsQuery,
  useRowActions,
  useSettingsWrite,
} from "./settings-entries.tsx";

// id, endpoint, kind, credential, models, state, ⋯, one line each so a row
// is as tall as the members table's; a phone keeps the id (with the state)
// and the ⋯. The state and the ⋯ are as wide as their widest cell.
const COLUMNS = [
  "minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.6fr) minmax(0,1.1fr) minmax(0,0.9fr) max-content max-content",
  SETTINGS_NARROW_COLUMNS,
] as const;

/**
 * The model settings' connections:
 * the operator file's and the database's in one table, each marked by
 * where it comes from. Only the owner reads them.
 */
export function ModelConnections() {
  const { t } = useI18n();
  const { client } = useWerft();
  const connections = useQuery(settingsConnectionsQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [adding, setAdding] = useState(false);
  const [listing, setListing] = useState<string | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const rows = useRowActions("connection", setOutcome);
  // The judge's connections are managed on the achievement rules screen.
  const items = connections.data?.items.filter(
    (item) => item.kind !== DECISION_KIND,
  );

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
        <OutcomeLine outcome={outcome} live />
        {connections.isPending ? (
          <Skeleton width="60%" label={t("status.loading.title")} />
        ) : connections.isError ? (
          <LoadFailure
            error={connections.error}
            onRetry={() => void connections.refetch()}
          />
        ) : items === undefined || items.length === 0 ? (
          <EmptyState framed title={t("settings.connections.empty")} />
        ) : (
          <GridTable
            // The settings layout zeroes the row inset; a framed table needs it.
            className="[--werft-row-padding-x:var(--werft-space-4)]"
            aria-label={t("settings.connections.title")}
            columns={COLUMNS[0]}
            align={[
              "start",
              "start",
              "start",
              "start",
              "start",
              "start",
              "action",
            ]}
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
                {t("settings.connections.kind")}
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
            {items.map((item) => (
              <ConnectionRow
                key={item.id}
                item={item}
                busy={rows.busy}
                onValue={(opener) => rows.openValue(item.id, opener)}
                onModels={(opener) => {
                  setOutcome(null);
                  setOpener(opener);
                  setListing(item.id);
                }}
                onDisable={() => rows.openDisable(item.id)}
                onEnable={() => rows.openEnable(item.id)}
              />
            ))}
          </GridTable>
        )}
      </div>
      <AddConnection
        open={adding}
        onOpenChange={setAdding}
        hosts={connections.data?.credential_hosts ?? null}
        defaults={connections.data?.endpoint_defaults ?? {}}
        onOutcome={setOutcome}
        onCreated={(id) => {
          setOpener(null);
          setListing(id);
        }}
      />
      <ModelsDialog
        // Keyed so each connection opens on its own saved list.
        key={listing ?? ""}
        id={listing}
        opener={opener}
        item={connections.data?.items.find((item) => item.id === listing)}
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
  onModels,
  onDisable,
  onEnable,
}: {
  readonly item: SettingsConnection;
  readonly busy: boolean;
  /** Each gets the menu's button, which takes the focus back on close. */
  readonly onValue: (opener: HTMLElement | null) => void;
  readonly onModels: (opener: HTMLElement | null) => void;
  readonly onDisable: () => void;
  readonly onEnable: () => void;
}) {
  const { t } = useI18n();
  const actions = entryActions(item);
  const disabled = item.state === "disabled";
  const credentialKind = t(`settings.connections.authKind.${item.auth_kind}`);
  const detail = `${item.kind} · ${t(`settings.connections.billing.${item.billing}`)}`;
  const credential = `${credentialKind} · ${credentialText(t, item.credential)}`;
  const models =
    item.models.length === 0
      ? t("settings.connections.noModels")
      : item.models.join(", ");
  // A disabled connection with no value takes its first, so it can be
  // enabled again.
  const firstValue =
    disabled &&
    item.credential.source === "stored" &&
    item.credential.last4 === null;
  const menu = [
    (actions.setValue || firstValue) && {
      label: t("settings.connections.changeCredentialFor", {
        id: item.id,
        kind: credentialKind,
      }),
      text: t("settings.connections.changeCredential", {
        kind: credentialKind,
      }),
      open: onValue,
    },
    !disabled && {
      label: t("settings.models.setFor", { id: item.id }),
      text: t("settings.models.set"),
      open: onModels,
    },
  ].filter((entry) => entry !== false);
  return (
    <GridTableRow className={disabled ? INACTIVE_ROW_CLASS : undefined}>
      <GridTableCell>
        <Code className="truncate" title={item.id}>
          {item.id}
        </Code>
        <NarrowState state={item.state} dot />
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Code className="truncate" title={item.endpoint}>
          {item.endpoint}
        </Code>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Text as="span" variant="meta" truncate title={detail}>
          {detail}
        </Text>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Text as="span" variant="meta" truncate title={credential}>
          {credential}
        </Text>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Text as="span" variant="meta" truncate title={models}>
          {models}
        </Text>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <StateText state={item.state} />
      </GridTableCell>
      <GridTableCell>
        {/* As the members table: the ⋯ menu alone, disable last and red. */}
        <RowMenu
          label={t("settings.connections.menuFor", { id: item.id })}
          disabled={busy}
        >
          {(close) => (
            <>
              {menu.map((entry) => (
                <RowMenuItem
                  key={entry.label}
                  label={entry.label}
                  onSelect={() => entry.open(close())}
                >
                  {entry.text}
                </RowMenuItem>
              ))}
              {actions.enable ? (
                <RowMenuItem
                  label={t("settings.enableFor", { id: item.id })}
                  onSelect={() => {
                    close();
                    onEnable();
                  }}
                >
                  {t("settings.enable")}
                </RowMenuItem>
              ) : null}
              {actions.disable ? (
                <RowMenuItem
                  tone="danger"
                  label={t("settings.disableFor", { id: item.id })}
                  onSelect={() => {
                    close();
                    onDisable();
                  }}
                >
                  {t("settings.disable")}
                </RowMenuItem>
              ) : null}
            </>
          )}
        </RowMenu>
      </GridTableCell>
    </GridTableRow>
  );
}

/** The server's cap on a connection's saved models. */
const MAX_MODELS = 64;

const DISCOVERY_REASONS = [
  "credential_allowlist_unset",
  "host_not_allowed",
  "url_insecure",
  "address_not_allowed",
  "provider_unauthorized",
  "provider_answered",
  "provider_unreachable",
  "provider_failed",
  "credential_reflected",
  "credential_unresolved",
  "kind_unsupported",
] as const;

/**
 * The client does not validate a 200, so a body of another shape (an older
 * or newer server) fails here and reads as a failed load.
 */
function discoveredOf(body: unknown): DiscoverConnectionModelsResponse {
  const answer = body as Partial<DiscoverConnectionModelsResponse> | null;
  if (
    answer === null ||
    typeof answer !== "object" ||
    !Array.isArray(answer.models) ||
    !Array.isArray(answer.missing) ||
    answer.models.some((model) => typeof model?.id !== "string")
  ) {
    throw new Error("unexpected model list");
  }
  return {
    models: answer.models,
    missing: answer.missing,
    skipped: typeof answer.skipped === "number" ? answer.skipped : 0,
    truncated: answer.truncated === true,
  };
}

/** Read from the provider each time the dialog opens, never reused. */
function connectionModelsQuery(
  client: ApiClient,
  id: string,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: scopedKey(client, "connection-model-discovery", id),
    queryFn: async () =>
      discoveredOf(
        await unwrap(
          client.POST(
            "/v1/installation/settings/connections/{id}/models/discover",
            { params: { path: { id } } },
          ),
        ),
      ),
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

function discoveryFailure(
  t: Translate,
  error: unknown,
  role: string | undefined,
): string {
  if (
    !(error instanceof ApiError) ||
    error.code === "CLIENT_CONTRACT_MISMATCH"
  ) {
    return t("settings.models.error.unknown");
  }
  const details = error.details as {
    reason_code?: unknown;
    provider_status?: unknown;
  } | null;
  const reason = details?.reason_code;
  const known = DISCOVERY_REASONS.find((item) => item === reason);
  if (known === "provider_answered") {
    return t("settings.models.error.provider_answered", {
      status:
        typeof details?.provider_status === "number"
          ? details.provider_status
          : "?",
    });
  }
  if (known !== undefined) return t(`settings.models.error.${known}`);
  if (reason === "disabled" || reason === "needs_value") {
    return t(`settings.error.${reason}`);
  }
  if (error.code === "NOT_FOUND" && reason === undefined) {
    return t("settings.models.error.unknown");
  }
  return refusalText(t, error, "installation.settings.manage", role);
}

/**
 * The models an agent's card may name on a connection, picked from what the
 * provider lists. Saved models the provider no longer lists stay checked
 * until unchecked; only saving changes the list.
 */
function ModelsDialog({
  id,
  opener,
  item,
  onClose,
  onOutcome,
}: {
  readonly id: string | null;
  readonly opener: HTMLElement | null;
  /** The listed row, which may lag just after a create. */
  readonly item: SettingsConnection | undefined;
  readonly onClose: () => void;
  readonly onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const [error, setError] = useState<string | null>(null);
  // Null until the owner toggles one, so the saved list shows through.
  const [checked, setChecked] = useState<ReadonlySet<string> | null>(null);
  const discovery = useQuery(
    connectionModelsQuery(client, id ?? "", id !== null),
  );
  const saved = item?.models ?? [];
  const picked = checked ?? new Set(saved);
  const listed = discovery.isSuccess ? discovery.data.models : [];
  const listedIds = new Set(listed.map((model) => model.id));
  // A pick the provider stopped listing after a refresh stays, like a saved one.
  const unlisted = [
    ...new Set([...saved, ...(discovery.data?.missing ?? []), ...picked]),
  ].filter((model) => !listedIds.has(model));
  const toggle = (model: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(model);
    else next.delete(model);
    setChecked(next);
  };
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

  const pickedCount = picked.size;

  return (
    <FormDialog
      open={id !== null}
      opener={opener}
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
      onSubmit={() => {
        if (id === null) return;
        setError(null);
        if (pickedCount > MAX_MODELS) {
          setError(
            t("settings.models.tooMany", {
              max: MAX_MODELS,
              count: pickedCount,
            }),
          );
          return;
        }
        // Saved ones keep their order; new picks follow in the provider's.
        const kept = saved.filter((model) => picked.has(model));
        const added = [...listed.map((model) => model.id), ...unlisted].filter(
          (model) => picked.has(model) && !saved.includes(model),
        );
        save.mutate({ id, models: [...kept, ...added] });
      }}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
        <Text as="span" variant="meta">
          {t("settings.models.connection")}
        </Text>
        <Code className="wrap-anywhere">{id}</Code>
        <Text as="span" variant="meta">
          {t("settings.connections.endpoint")}
        </Text>
        {item === undefined ? (
          <Skeleton width="60%" label={t("status.loading.title")} />
        ) : (
          <Code className="wrap-anywhere">{item.endpoint}</Code>
        )}
      </div>
      <FieldSet className="w-full gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FieldLegend variant="label" className="mb-0">
            {t("settings.models.list")}
          </FieldLegend>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={discovery.isFetching || undefined}
            onClick={() => {
              if (!discovery.isFetching) void discovery.refetch();
            }}
          >
            <RefreshCw aria-hidden="true" />
            {t("settings.models.refresh")}
          </Button>
        </div>
        {discovery.isFetching ? (
          <Text as="span" variant="meta" role="status">
            {t("settings.models.loading")}
          </Text>
        ) : discovery.isError ? (
          <Alert variant="red" role="alert">
            <AlertDescription>
              {discoveryFailure(t, discovery.error, role)}
            </AlertDescription>
          </Alert>
        ) : discovery.isSuccess ? (
          <>
            {listed.length === 0 ? (
              <FieldDescription>{t("settings.models.empty")}</FieldDescription>
            ) : null}
            {discovery.data.skipped > 0 ? (
              <FieldDescription>
                {t("settings.models.skipped", {
                  count: discovery.data.skipped,
                })}
              </FieldDescription>
            ) : null}
            {discovery.data.truncated ? (
              <FieldDescription>
                {t("settings.models.truncated")}
              </FieldDescription>
            ) : null}
          </>
        ) : null}
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {discovery.isSuccess && !discovery.isFetching
            ? listed.map((model) => (
                <ModelChoice
                  key={model.id}
                  id={model.id}
                  name={model.display_name}
                  checked={picked.has(model.id)}
                  onChange={(on) => toggle(model.id, on)}
                />
              ))
            : null}
          {unlisted.map((model) => (
            <ModelChoice
              key={model}
              id={model}
              name={null}
              checked={picked.has(model)}
              onChange={(on) => toggle(model, on)}
              notListed={discovery.isSuccess && !discovery.isFetching}
            />
          ))}
        </div>
        {unlisted.length > 0 && discovery.isSuccess && !discovery.isFetching ? (
          <FieldDescription>
            {t("settings.models.notListedHint")}
          </FieldDescription>
        ) : null}
        <FieldDescription>
          {t("settings.models.count", { count: pickedCount, max: MAX_MODELS })}
        </FieldDescription>
      </FieldSet>
    </FormDialog>
  );
}

function ModelChoice({
  id,
  name,
  checked,
  onChange,
  notListed = false,
}: {
  readonly id: string;
  readonly name: string | null;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly notListed?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Field orientation="horizontal">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <FieldContent>
        <FieldLabel className="flex flex-wrap items-center gap-2">
          {name === null || name === id ? null : name}
          <Code className="wrap-anywhere">{id}</Code>
          {notListed ? (
            <Badge variant="amber">{t("settings.models.notListed")}</Badge>
          ) : null}
        </FieldLabel>
      </FieldContent>
    </Field>
  );
}

type ConnectionKind = SettingsConnection["kind"];

// The kinds in the order the form lists them. The record stops compiling when
// the contract gains a kind this form does not offer.
const CONNECTION_KINDS = Object.keys({
  anthropic: true,
  litellm: true,
  openai_responses: true,
  openai_decisions: true,
} satisfies Record<ConnectionKind, true>) as ConnectionKind[];

/** The achievement judge's kind, managed from the achievement rules screen. */
export const DECISION_KIND = "openai_decisions" satisfies ConnectionKind;

const AGENT_KINDS = CONNECTION_KINDS.filter((kind) => kind !== DECISION_KIND);

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

export function AddConnection({
  open,
  onOpenChange,
  hosts,
  defaults,
  onOutcome,
  onCreated,
  decision = false,
  opener = null,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The egress credential allowlist, when the API knows it. */
  readonly hosts: readonly string[] | null;
  /** The endpoint each kind takes when left empty, by kind. */
  readonly defaults: Readonly<Record<string, string>>;
  readonly onOutcome: (outcome: Outcome) => void;
  /** Opens the new connection's models, read from its provider. */
  readonly onCreated?: (id: string) => void;
  /**
   * Creates the achievement judge's connection, and nothing else; the API
   * names it in a judge that names none.
   */
  readonly decision?: boolean;
  readonly opener?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const initialKind: ConnectionKind = decision ? DECISION_KIND : "anthropic";
  const [kind, setKind] = useState<ConnectionKind>(initialKind);
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
        onCreated?.(answer.id);
      },
      onRefused: setError,
    },
  );
  const host = endpointHost(endpoint);
  const outside = hosts !== null && host !== null && !hosts.includes(host);

  return (
    <FormDialog
      open={open}
      opener={opener}
      onOpenChange={(next) => {
        setError(null);
        setEndpointMissing(false);
        if (!next) {
          setKind(initialKind);
          setEdited(null);
        }
        onOpenChange(next);
      }}
      pending={create.isPending}
      title={t(decision ? "decisionModel.add" : "settings.connections.add")}
      description={t("settings.immutable")}
      gated
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
      {decision ? (
        <DecisionModelField />
      ) : (
        <Field>
          <FieldLabel>{t("settings.connections.kind")}</FieldLabel>
          <NativeSelect
            name="kind"
            value={kind}
            onChange={(event) => {
              // A cleared field hands the new kind's default back.
              if (edited === "") setEdited(null);
              setEndpointMissing(false);
              const next = AGENT_KINDS.find(
                (known) => known === event.target.value,
              );
              if (next !== undefined) setKind(next);
            }}
          >
            {AGENT_KINDS.map((known) => (
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
      )}
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
      {/* A judgment is always priced, against the workspace's budget. */}
      {kind === "openai_decisions" ? null : (
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
      )}
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

/** The judge's one model, which no field picks. */
function DecisionModelField() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3">
        <Text as="span" variant="meta">
          {t("decisionModel.model")}
        </Text>
        <Code>gpt-6-luna</Code>
      </div>
      <Text variant="meta">
        {t("settings.connections.kindHint.openai_decisions")}
      </Text>
    </div>
  );
}
