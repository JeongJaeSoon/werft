import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  ListLoginProvidersResponse,
  LoginProviderState,
  LoginProviderView,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Code,
  ConfirmDialog,
  CopyButton,
  DangerZone,
  DangerZoneRow,
  DisabledReason,
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
  NativeSelect,
  NativeSelectOption,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  RelativeTime,
  RowAction,
  SettingRow,
  SettingsSection,
  Skeleton,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useHasPermission, useRole } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { isMessageKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useAppServices } from "../services.tsx";
import {
  FormDialog,
  type Outcome,
  OutcomeLine,
  SecretInput,
} from "./settings-entries.tsx";

const PERMISSION = "installation.settings.manage";
const LIST = "/settings/workspace/login";

const listKey = (client: ApiClient) => scopedKey(client, "login-providers");

export function loginProvidersQuery(client: ApiClient, enabled = true) {
  return queryOptions({
    queryKey: listKey(client),
    queryFn: () =>
      unwrap(
        client.GET("/v1/login-providers"),
      ) as Promise<ListLoginProvidersResponse>,
    enabled,
    retry: false,
  });
}

/** The words for a refused change: the server's reason first. */
function refusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
  // Starting a test and turning on are refused with the same reason code.
  step: "test" | "other",
): string {
  const details = error.details as {
    problem?: unknown;
    reason_code?: unknown;
  } | null;
  if (error.code === "BAD_REQUEST") {
    // A message key takes no digit; the one problem code that has one loses it.
    const problem = String(details?.problem).replace("_s256", "");
    const key = `loginProviders.problem.${problem}`;
    if (isMessageKey(key)) return t(key);
  }
  if (error.code === "ALREADY_EXISTS") return t("loginProviders.error.exists");
  if (error.code === "VERSION_MISMATCH") return t("loginProviders.error.stale");
  if (error.code === "REVISION_CONFLICT") {
    if (details?.reason_code === "provider_enabled")
      return t("loginProviders.error.enabled");
    if (details?.reason_code === "not_tested")
      return t(
        step === "test"
          ? "loginProviders.error.clientMissing"
          : "loginProviders.error.notTested",
      );
  }
  if (error.code === "BACKEND_UNAVAILABLE") return t("loginProviders.noOrigin");
  return refusalText(t, error, PERMISSION, role);
}

/** One change to the providers, then the list read again whatever it said. */
function useProviderWrite<V, R>(
  write: (client: ApiClient, variables: V) => Promise<R>,
  handlers: {
    readonly onDone: (answer: R, variables: V) => void;
    readonly onRefused: (text: string) => void;
    readonly step?: "test";
  },
) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  return useMutation<R, ApiError, V>({
    mutationFn: (variables) => write(client, variables),
    onSuccess: (answer, variables) => handlers.onDone(answer, variables),
    onError: (error) =>
      handlers.onRefused(refusal(t, error, role, handlers.step ?? "other")),
    // A refusal is often news about the provider: its revision moved.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: listKey(client) }),
  });
}

const STATE_BADGE: Record<LoginProviderState, "green" | "amber" | "gray"> = {
  draft: "gray",
  needs_test: "amber",
  ready: "gray",
  enabled: "green",
  enabled_secret_pending: "amber",
};

function StateBadge({ state }: { readonly state: LoginProviderState }) {
  const { t } = useI18n();
  return (
    <Badge variant={STATE_BADGE[state]}>
      {t(`loginProviders.state.${state}`)}
    </Badge>
  );
}

const isOn = (provider: LoginProviderView) =>
  provider.state === "enabled" || provider.state === "enabled_secret_pending";

// Name and issuer, state, last test; a phone keeps the name and the state.
const COLUMNS = [
  "minmax(0,1fr) 220px 180px",
  "minmax(0,1fr) fit-content(55%)",
] as const;

export function LoginProvidersScreen() {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const owns = useHasPermission(PERMISSION);
  const list = useQuery(loginProvidersQuery(client, owns));
  const [adding, setAdding] = useState(false);

  if (!owns)
    return (
      <Page title={t("loginProviders.title")}>
        <StatusScreen kind="forbidden" />
      </Page>
    );

  return (
    <Page
      title={t("loginProviders.title")}
      description={t("loginProviders.description")}
      actions={
        list.data?.console_origin_configured ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden="true" />
            {t("loginProviders.add")}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        {list.data?.console_origin_configured === false ? (
          <Alert variant="amber" role="status">
            <AlertDescription>{t("loginProviders.noOrigin")}</AlertDescription>
          </Alert>
        ) : null}
        {list.isPending ? (
          <Skeleton width="60%" />
        ) : list.isError ? (
          <LoadFailure error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.providers.length === 0 ? (
          <EmptyState framed title={t("loginProviders.empty")} />
        ) : (
          <GridTable
            // The settings layout zeroes the row inset; a framed table needs it.
            className="[--werft-row-padding-x:var(--werft-space-4)]"
            aria-label={t("loginProviders.title")}
            columns={COLUMNS[0]}
            narrowAt={760}
            narrowColumns={COLUMNS[1]}
            framed
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("loginProviders.column.name")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("loginProviders.column.state")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("loginProviders.column.tested")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {list.data.providers.map((provider) => (
              <GridTableRow key={provider.id}>
                <GridTableCell>
                  <div className="flex min-w-0 flex-col items-start gap-[var(--werft-row-line-gap)]">
                    <TextLink asChild>
                      <Link
                        to="/settings/workspace/login/$providerId"
                        params={{ providerId: provider.id }}
                      >
                        {provider.display_name}
                      </Link>
                    </TextLink>
                    <Code className="wrap-anywhere">{provider.issuer}</Code>
                  </div>
                </GridTableCell>
                <GridTableCell>
                  <StateBadge state={provider.state} />
                </GridTableCell>
                <GridTableCell hideNarrow>
                  <Text as="span" variant="meta">
                    {provider.tested_at ? (
                      <RelativeTime
                        value={provider.tested_at}
                        locale={locale}
                      />
                    ) : (
                      t("loginProviders.neverTested")
                    )}
                  </Text>
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        )}
      </div>
      <AddProvider open={adding} onOpenChange={setAdding} />
    </Page>
  );
}

function AddProvider({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const create = useProviderWrite(
    (client, body: { display_name: string; issuer: string }) =>
      unwrap(client.POST("/v1/login-providers", { body })),
    {
      // The new provider's page has what to register at the provider.
      onDone: ({ provider }) =>
        void navigate({
          to: "/settings/workspace/login/$providerId",
          params: { providerId: provider.id },
        }),
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
      title={t("loginProviders.add")}
      description={t("loginProviders.addDescription")}
      error={error}
      submitLabel={t("settings.create")}
      pendingLabel={t("settings.creating")}
      onSubmit={(form) => {
        setError(null);
        create.mutate({
          display_name: String(form.get("display_name")).trim(),
          issuer: String(form.get("issuer")).trim(),
        });
      }}
    >
      <Field>
        <FieldLabel>{t("loginProviders.name")}</FieldLabel>
        <Input name="display_name" required maxLength={64} autoComplete="off" />
        <FieldDescription>{t("loginProviders.nameHint")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>{t("loginProviders.issuer")}</FieldLabel>
        <Input
          name="issuer"
          type="url"
          required
          maxLength={2048}
          autoComplete="off"
          spellCheck={false}
        />
        <FieldDescription>{t("loginProviders.issuerHint")}</FieldDescription>
      </Field>
    </FormDialog>
  );
}

/** A row's action; one that is withheld stays on the page and says why. */
function Action({
  label,
  reason,
  busy,
  onClick,
}: {
  readonly label: string;
  readonly reason?: string | undefined;
  readonly busy: boolean;
  readonly onClick: () => void;
}) {
  const button = (
    <RowAction disabled={busy || reason !== undefined} onClick={onClick}>
      {label}
    </RowAction>
  );
  return reason === undefined ? (
    button
  ) : (
    <DisabledReason reason={reason} label={label}>
      {button}
    </DisabledReason>
  );
}

type Editing = "name" | "client" | "secret" | "disable" | "delete" | null;

export function LoginProviderScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const owns = useHasPermission(PERMISSION);
  const { providerId } = useParams({
    from: "/authed/settings/workspace/login/$providerId",
  });
  const list = useQuery(loginProvidersQuery(client, owns));
  const provider = list.data?.providers.find((item) => item.id === providerId);
  const title = provider?.display_name ?? t("loginProviders.title");
  const breadcrumb = (
    <PageBreadcrumb label={t("shell.breadcrumb")}>
      <PageBreadcrumbLink asChild>
        {/* The list is this page's parent, not the page itself. */}
        <Link to={LIST} activeOptions={{ exact: true }}>
          {t("loginProviders.title")}
        </Link>
      </PageBreadcrumbLink>
      <PageBreadcrumbCurrent>{title}</PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );

  if (!owns)
    return (
      <Page title={t("loginProviders.title")}>
        <StatusScreen kind="forbidden" />
      </Page>
    );
  if (list.isPending)
    return (
      <Page title={title} breadcrumb={breadcrumb}>
        <Skeleton width="60%" />
      </Page>
    );
  if (list.isError)
    return (
      <Page title={title} breadcrumb={breadcrumb}>
        <LoadFailure error={list.error} onRetry={() => void list.refetch()} />
      </Page>
    );
  if (provider === undefined)
    return (
      <Page title={title} breadcrumb={breadcrumb}>
        <EmptyState framed title={t("loginProviders.notFound")} />
      </Page>
    );
  return (
    <Page
      title={title}
      breadcrumb={breadcrumb}
      actions={<StateBadge state={provider.state} />}
    >
      <ProviderSettings provider={provider} />
    </Page>
  );
}

function ProviderSettings({
  provider,
}: {
  readonly provider: LoginProviderView;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { leave } = useAppServices();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const on = isOn(provider);
  const id = { params: { path: { id: provider.id } } };
  const refused = (text: string) => setOutcome({ kind: "error", text });
  const notice = (text: string) => setOutcome({ kind: "notice", text });
  const open = (next: Editing) => {
    setOutcome(null);
    setDialogError(null);
    setEditing(next);
  };
  const saved = () => {
    setEditing(null);
    notice(t("loginProviders.done.saved"));
  };

  const change = useProviderWrite(
    (
      api,
      body: {
        display_name?: string;
        client_id?: string;
        token_auth_method?: LoginProviderView["token_auth_method"];
      },
    ) =>
      unwrap(
        api.PATCH("/v1/login-providers/{id}", {
          params: {
            path: { id: provider.id },
            header: { "If-Match": String(provider.revision) },
          },
          body,
        }),
      ),
    { onDone: saved, onRefused: setDialogError },
  );
  const setSecret = useProviderWrite(
    (api, value: string) =>
      unwrap(
        api.PUT("/v1/login-providers/{id}/client-secret", {
          ...id,
          body: { value },
        }),
      ),
    {
      onDone: (answer) => {
        setEditing(null);
        notice(
          t(
            answer.provider.pending_client_secret
              ? "loginProviders.done.secretPending"
              : "loginProviders.done.saved",
          ),
        );
      },
      onRefused: setDialogError,
    },
  );
  const refresh = useProviderWrite(
    (api, _: undefined) =>
      unwrap(api.POST("/v1/login-providers/{id}/refresh-discovery", id)),
    {
      onDone: () => notice(t("loginProviders.done.refreshed")),
      onRefused: refused,
    },
  );
  const test = useProviderWrite(
    (api, _: undefined) =>
      unwrap(api.POST("/v1/login-providers/{id}/test/start", id)),
    {
      onDone: ({ authorization_url }) => leave(authorization_url),
      onRefused: refused,
      step: "test",
    },
  );
  const enable = useProviderWrite(
    (api, _: undefined) =>
      unwrap(api.POST("/v1/login-providers/{id}/enable", id)),
    {
      onDone: () => notice(t("loginProviders.done.enabled")),
      onRefused: refused,
    },
  );
  const disable = useProviderWrite(
    (api, _: undefined) =>
      unwrap(api.POST("/v1/login-providers/{id}/disable", id)),
    {
      onDone: (answer) => {
        setEditing(null);
        notice(
          t("loginProviders.done.disabled", { count: answer.sessions_revoked }),
        );
      },
      onRefused: setDialogError,
    },
  );
  const remove = useProviderWrite(
    (api, _: undefined) => unwrap(api.DELETE("/v1/login-providers/{id}", id)),
    {
      onDone: () => void navigate({ to: LIST }),
      onRefused: setDialogError,
    },
  );
  const busy =
    change.isPending ||
    setSecret.isPending ||
    refresh.isPending ||
    test.isPending ||
    enable.isPending ||
    disable.isPending ||
    remove.isPending;
  const locked = on ? t("loginProviders.lockedWhileOn") : undefined;

  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      <OutcomeLine outcome={outcome} />
      <SettingsSection
        title={t("loginProviders.section.general")}
        rows={
          <>
            <SettingRow
              title={t("loginProviders.name")}
              meta={provider.display_name}
              actions={
                <Action
                  label={t("loginProviders.rename")}
                  busy={busy}
                  onClick={() => open("name")}
                />
              }
            />
            <SettingRow
              title={t("loginProviders.issuer")}
              meta={<Code className="wrap-anywhere">{provider.issuer}</Code>}
            />
          </>
        }
      />
      <SettingsSection
        title={t("loginProviders.section.register")}
        description={t("loginProviders.section.registerHint")}
        rows={
          <>
            <SettingRow
              title={t("loginProviders.redirectUri")}
              meta={
                provider.redirect_uri ? (
                  <Code className="wrap-anywhere">{provider.redirect_uri}</Code>
                ) : (
                  t("loginProviders.redirectUriNone")
                )
              }
              actions={
                provider.redirect_uri ? (
                  <CopyButton
                    value={provider.redirect_uri}
                    variant="outline"
                    size="sm"
                    label={t("loginProviders.copy")}
                    copiedMessage={t("loginProviders.copied")}
                    icon="copy"
                    onResult={(ok) => {
                      if (!ok) refused(t("loginProviders.copyFailed"));
                    }}
                  />
                ) : null
              }
            />
            <SettingRow
              title={t("loginProviders.hosts")}
              meta={provider.endpoint_hosts.map((host) => (
                <Code key={host} className="wrap-anywhere mr-2">
                  {host}
                </Code>
              ))}
              description={t("loginProviders.hostsHint")}
            />
            <SettingRow
              title={t("loginProviders.discovery")}
              meta={
                // One line: a row's lines stack.
                <Text as="span" variant="meta">
                  {t("loginProviders.discoveryChecked")}{" "}
                  <RelativeTime
                    value={provider.discovery_checked_at}
                    locale={locale}
                  />
                </Text>
              }
              actions={
                <Action
                  label={t(
                    refresh.isPending
                      ? "loginProviders.refreshing"
                      : "loginProviders.refresh",
                  )}
                  reason={locked}
                  busy={busy}
                  onClick={() => {
                    setOutcome(null);
                    refresh.mutate(undefined);
                  }}
                />
              }
            />
          </>
        }
      />
      <SettingsSection
        title={t("loginProviders.section.client")}
        description={t("loginProviders.section.clientHint")}
        rows={
          <>
            <SettingRow
              title={t("loginProviders.clientId")}
              meta={
                provider.client_id ? (
                  <Code className="wrap-anywhere">{provider.client_id}</Code>
                ) : (
                  t("loginProviders.unset")
                )
              }
              actions={
                <Action
                  label={t("loginProviders.clientEdit")}
                  reason={locked}
                  busy={busy}
                  onClick={() => open("client")}
                />
              }
            />
            <SettingRow
              title={t("loginProviders.authMethod")}
              meta={t(
                `loginProviders.authMethod.${provider.token_auth_method}`,
              )}
            />
            <SettingRow
              title={t("loginProviders.secret")}
              meta={
                provider.client_secret
                  ? t("loginProviders.secretStored", {
                      last4: provider.client_secret.last4,
                    })
                  : t("loginProviders.unset")
              }
              description={
                provider.pending_client_secret
                  ? t("loginProviders.secretPending", {
                      last4: provider.pending_client_secret.last4,
                    })
                  : undefined
              }
              actions={
                <Action
                  label={t(
                    provider.client_secret
                      ? "loginProviders.secretChange"
                      : "loginProviders.secretSet",
                  )}
                  busy={busy}
                  onClick={() => open("secret")}
                />
              }
            />
          </>
        }
      />
      <SettingsSection
        title={t("loginProviders.section.test")}
        description={t(`loginProviders.stateHint.${provider.state}`)}
        rows={
          <>
            <SettingRow
              title={t("loginProviders.test")}
              meta={
                provider.tested_at ? (
                  <Text as="span" variant="meta">
                    {t("loginProviders.testedAt")}{" "}
                    <RelativeTime value={provider.tested_at} locale={locale} />
                  </Text>
                ) : (
                  t("loginProviders.neverTested")
                )
              }
              description={t("loginProviders.testHint")}
              actions={
                <Action
                  label={t(
                    test.isPending
                      ? "loginProviders.testStarting"
                      : "loginProviders.test",
                  )}
                  reason={
                    provider.state === "draft"
                      ? t("loginProviders.error.clientMissing")
                      : undefined
                  }
                  busy={busy}
                  onClick={() => {
                    setOutcome(null);
                    test.mutate(undefined);
                  }}
                />
              }
            />
            {on ? null : (
              <SettingRow
                title={t("loginProviders.enable")}
                actions={
                  <Action
                    label={t(
                      enable.isPending
                        ? "loginProviders.enabling"
                        : "loginProviders.enable",
                    )}
                    reason={
                      provider.state === "ready"
                        ? undefined
                        : t("loginProviders.error.notTested")
                    }
                    busy={busy}
                    onClick={() => {
                      setOutcome(null);
                      enable.mutate(undefined);
                    }}
                  />
                }
              />
            )}
          </>
        }
      />
      <DangerZone title={t("workspace.danger")}>
        <DangerZoneRow
          title={t("loginProviders.disable")}
          description={t("loginProviders.disableDescription")}
          actionLabel={t("loginProviders.disable")}
          disabled={busy}
          reason={on ? undefined : t("loginProviders.disableReason")}
          onAction={() => open("disable")}
        />
        <DangerZoneRow
          title={t("loginProviders.delete")}
          description={t("loginProviders.deleteDescription")}
          actionLabel={t("loginProviders.delete")}
          disabled={busy}
          reason={on ? t("loginProviders.deleteReason") : undefined}
          onAction={() => open("delete")}
        />
      </DangerZone>
      <FormDialog
        open={editing === "name"}
        onOpenChange={(next) => open(next ? "name" : null)}
        pending={change.isPending}
        title={t("loginProviders.rename")}
        description={t("loginProviders.nameHint")}
        error={dialogError}
        submitLabel={t("settings.save")}
        pendingLabel={t("settings.saving")}
        onSubmit={(form) => {
          setDialogError(null);
          change.mutate({
            display_name: String(form.get("display_name")).trim(),
          });
        }}
      >
        <Field>
          <FieldLabel>{t("loginProviders.name")}</FieldLabel>
          <Input
            name="display_name"
            required
            maxLength={64}
            autoComplete="off"
            defaultValue={provider.display_name}
          />
        </Field>
      </FormDialog>
      <FormDialog
        open={editing === "client"}
        onOpenChange={(next) => open(next ? "client" : null)}
        pending={change.isPending}
        title={t("loginProviders.clientEditTitle")}
        description={t("loginProviders.clientEditDescription")}
        error={dialogError}
        submitLabel={t("settings.save")}
        pendingLabel={t("settings.saving")}
        onSubmit={(form) => {
          setDialogError(null);
          change.mutate({
            client_id: String(form.get("client_id")).trim(),
            token_auth_method: String(
              form.get("token_auth_method"),
            ) as LoginProviderView["token_auth_method"],
          });
        }}
      >
        <Field>
          <FieldLabel>{t("loginProviders.clientId")}</FieldLabel>
          <Input
            name="client_id"
            required
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
            defaultValue={provider.client_id ?? ""}
          />
        </Field>
        <Field>
          <FieldLabel>{t("loginProviders.authMethod")}</FieldLabel>
          <NativeSelect
            name="token_auth_method"
            defaultValue={provider.token_auth_method}
          >
            <NativeSelectOption value="client_secret_basic">
              {t("loginProviders.authMethod.client_secret_basic")}
            </NativeSelectOption>
            <NativeSelectOption value="client_secret_post">
              {t("loginProviders.authMethod.client_secret_post")}
            </NativeSelectOption>
          </NativeSelect>
        </Field>
      </FormDialog>
      <FormDialog
        open={editing === "secret"}
        onOpenChange={(next) => open(next ? "secret" : null)}
        pending={setSecret.isPending}
        title={t("loginProviders.secretTitle")}
        description={t(
          on
            ? "loginProviders.secretDescriptionOn"
            : "loginProviders.secretDescriptionOff",
        )}
        error={dialogError}
        submitLabel={t("settings.save")}
        pendingLabel={t("settings.saving")}
        onSubmit={(form) => {
          setDialogError(null);
          setSecret.mutate(String(form.get("value")));
        }}
      >
        <SecretInput label={t("loginProviders.secret")} />
      </FormDialog>
      <ConfirmDialog
        open={editing === "disable"}
        onOpenChange={(next) => open(next ? "disable" : null)}
        title={t("loginProviders.disableTitle", {
          name: provider.display_name,
        })}
        consequence={t("loginProviders.disableConsequence")}
        confirmLabel={t("loginProviders.disable")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={disable.isPending}
        onConfirm={() => disable.mutate(undefined)}
      >
        {dialogError ? (
          <Alert variant="red" role="alert">
            <AlertDescription>{dialogError}</AlertDescription>
          </Alert>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={editing === "delete"}
        onOpenChange={(next) => open(next ? "delete" : null)}
        title={t("loginProviders.deleteTitle", { name: provider.display_name })}
        consequence={t("loginProviders.deleteConsequence")}
        confirmLabel={t("loginProviders.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      >
        {dialogError ? (
          <Alert variant="red" role="alert">
            <AlertDescription>{dialogError}</AlertDescription>
          </Alert>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
