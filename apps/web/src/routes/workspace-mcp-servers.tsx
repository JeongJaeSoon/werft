import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  DiscoverWorkspaceMcpServerResponse,
  WorkspaceMcpServer,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  buttonVariants,
  Code,
  ConfirmDialog,
  EmptyState,
  Field,
  FieldDescription,
  FieldLabel,
  formatTimestamp,
  Input,
  KeyValueList,
  NativeSelect,
  NativeSelectOption,
  RowAction,
  RowLines,
  RowList,
  RowListItem,
  Section,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useHasPermission, useRole } from "../auth/guard.tsx";
import { WORKSPACE_MCP_RESERVED_NAMES } from "../auth/limits.ts";
import { ReasonButton } from "../auth/reason-button.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { isMessageKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useLeave } from "../services.tsx";
import { FormDialog } from "./settings-entries.tsx";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The server the OAuth callback page just connected, announced once. */
    readonly workspaceMcpConnected?: string;
  }
}

export const workspaceMcpServersKey = (client: ApiClient) =>
  scopedKey(client, "workspace-mcp-servers");

export function workspaceMcpServersQuery(client: ApiClient) {
  return queryOptions({
    queryKey: workspaceMcpServersKey(client),
    queryFn: () => unwrap(client.GET("/v1/workspace/mcp-servers")),
    retry: false,
  });
}

/** The words for a refused write: the server's reason first, then its code. */
export function workspaceMcpRefusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
): string {
  const reason = (error.details as { reason_code?: unknown } | null)
    ?.reason_code;
  for (const name of [reason, error.code]) {
    const key = `workspaceMcp.error.${String(name)}`;
    if (typeof name === "string" && isMessageKey(key)) return t(key);
  }
  return refusalText(t, error, "workspace.manage", role);
}

const STATE_BADGE = {
  none: "gray",
  active: "green",
  needs_reauth: "amber",
} as const;

type Dialogs =
  | { readonly kind: "disconnect" | "delete" | "token" | "client" }
  | { readonly kind: "none" };

export function WorkspaceMcpServers() {
  const { t } = useI18n();
  const { client } = useWerft();
  const manages = useHasPermission("workspace.manage");
  const servers = useQuery(workspaceMcpServersQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [registering, setRegistering] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const navigate = useNavigate();
  // Read from the history entry, not a mark taken once: on its way in from
  // the callback the screen mounts twice and the second would find it spent.
  const connected = useLocation({
    select: (location) => location.state.workspaceMcpConnected,
  });
  useEffect(() => {
    if (connected !== undefined)
      setOutcome({
        kind: "notice",
        text: t("workspaceMcp.connected", { name: connected }),
      });
  }, [connected, t]);
  // The entry stops saying it at the next thing the person does here, so a
  // reload or Back after that does not bring it over newer news.
  const report = (next: Outcome | null) => {
    setOutcome(next);
    if (next === null && connected !== undefined)
      void navigate({
        to: ".",
        replace: true,
        state: ({ workspaceMcpConnected: _, ...rest }) => rest,
      });
  };

  return (
    <Section
      title={t("workspaceMcp.title")}
      description={t("workspaceMcp.description")}
      actions={
        manages ? (
          <ReasonButton
            className={buttonVariants({ variant: "outline" })}
            // The server's own count: past it a register is refused only
            // after the discovery round trip and a typed token.
            reason={
              servers.data && servers.data.items.length >= servers.data.limit
                ? t("workspaceMcp.error.MCP_SERVER_QUOTA_EXCEEDED")
                : undefined
            }
            onClick={(event) => {
              report(null);
              setOpener(event.currentTarget);
              setRegistering(true);
            }}
          >
            <Plus aria-hidden="true" />
            {t("workspaceMcp.add")}
          </ReasonButton>
        ) : null
      }
    >
      <div className="flex flex-col gap-[var(--werft-space-block)]">
        {manages ? null : (
          <Text variant="sub">{t("workspaceMcp.readOnly")}</Text>
        )}
        <OutcomeLine outcome={outcome} live />
        {servers.isPending ? (
          <Skeleton width="60%" label={t("status.loading.title")} />
        ) : servers.isError ? (
          <LoadFailure
            error={servers.error}
            onRetry={() => void servers.refetch()}
          />
        ) : servers.data.items.length === 0 ? (
          <EmptyState framed title={t("workspaceMcp.empty")} />
        ) : (
          <RowList
            // The settings layout zeroes the row inset; a framed list needs it.
            className="[--werft-row-padding-x:var(--werft-space-4)]"
            aria-label={t("workspaceMcp.title")}
          >
            {servers.data.items.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                manages={manages}
                onOutcome={report}
              />
            ))}
          </RowList>
        )}
      </div>
      <RegisterServer
        open={registering}
        onOpenChange={setRegistering}
        onOutcome={report}
        opener={opener}
      />
    </Section>
  );
}

/** A write on one server, then the list read again. */
function useServerWrite<V, R>(
  write: (client: ApiClient, variables: V) => Promise<R>,
  handlers: {
    readonly onDone: (answer: R, variables: V) => void;
    readonly onRefused: (text: string) => void;
  },
) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const role = useRole();
  return useMutation<R, ApiError, V>({
    // Some writes carry a credential; a settled one must not wait in the
    // mutation cache for its five-minute collection.
    gcTime: 0,
    mutationFn: (variables) => write(client, variables),
    onSuccess: async (answer, variables) => {
      handlers.onDone(answer, variables);
      await cache.invalidateQueries({
        queryKey: workspaceMcpServersKey(client),
      });
    },
    onError: (error) => handlers.onRefused(workspaceMcpRefusal(t, error, role)),
  });
}

function ServerRow({
  server,
  manages,
  onOutcome,
}: {
  readonly server: WorkspaceMcpServer;
  readonly manages: boolean;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const [dialog, setDialog] = useState<Dialogs>({ kind: "none" });
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const close = () => setDialog({ kind: "none" });
  const refused = (text: string) => onOutcome({ kind: "error", text });
  const name = server.name;
  const { connection } = server;
  const oauth = server.auth_kind === "oauth";
  const manualClient = server.oauth?.client_registration === "manual";
  const needsClient =
    oauth && server.oauth?.dcr_supported === false && !server.oauth.client_id;

  const { client } = useWerft();
  const role = useRole();
  const [held, leaveFor] = useLeave();
  const start = useMutation<void, ApiError>({
    mutationFn: () =>
      leaveFor(
        async () =>
          (
            await unwrap(
              client.POST("/v1/workspace/mcp-servers/{id}/oauth/start", {
                params: { path: { id: server.id } },
              }),
            )
          ).authorization_url,
      ),
    onError: (error) => refused(workspaceMcpRefusal(t, error, role)),
  });
  const refresh = useServerWrite(
    (client) =>
      unwrap(
        client.POST("/v1/workspace/mcp-servers/{id}/tools/refresh", {
          params: { path: { id: server.id } },
        }),
      ),
    {
      onDone: (answer) =>
        onOutcome({
          kind: "notice",
          text: t("workspaceMcp.refreshed", {
            name,
            count: String(answer.tools.length),
          }),
        }),
      onRefused: refused,
    },
  );
  const disconnect = useServerWrite(
    (client) =>
      unwrap(
        client.POST("/v1/workspace/mcp-servers/{id}/disconnect", {
          params: { path: { id: server.id } },
        }),
      ),
    {
      onDone: (answer) => {
        close();
        onOutcome({
          kind: "notice",
          text: t(
            answer.revoked === false
              ? "workspaceMcp.disconnectedNotRevoked"
              : "workspaceMcp.disconnected",
            { name },
          ),
        });
      },
      onRefused: (text) => {
        close();
        refused(text);
      },
    },
  );
  const remove = useServerWrite(
    (client) =>
      unwrap(
        client.DELETE("/v1/workspace/mcp-servers/{id}", {
          params: { path: { id: server.id } },
        }),
      ),
    {
      onDone: () => {
        close();
        onOutcome({
          kind: "notice",
          text: t("workspaceMcp.deleted", { name }),
        });
      },
      onRefused: (text) => {
        close();
        refused(text);
      },
    },
  );
  // `held`: another start is on its way out; a second would replace its flow.
  const busy =
    held ||
    start.isPending ||
    refresh.isPending ||
    disconnect.isPending ||
    remove.isPending;

  const person =
    connection.connected_by?.display_name ?? t("workspaceMcp.actingAs.unknown");
  const reauth =
    connection.state === "needs_reauth" && connection.reauth_reason !== null
      ? connection.reauth_reason === "invalid_client" && manualClient
        ? t("workspaceMcp.reauth.invalid_client_manual")
        : t(`workspaceMcp.reauth.${connection.reauth_reason}`)
      : null;

  return (
    <RowListItem className="items-start">
      <div className="flex min-w-[min(100%,20rem)] flex-1 flex-col gap-3">
        <RowLines>
          <div className="flex flex-wrap items-center gap-2">
            <Text as="span" weight="medium" className="wrap-anywhere">
              <Code size="inherit">{name}</Code>
            </Text>
            <Badge variant={STATE_BADGE[connection.state]}>
              {t(`workspaceMcp.state.${connection.state}`)}
            </Badge>
            <Badge>{t(`workspaceMcp.auth.${server.auth_kind}`)}</Badge>
          </div>
          <Text as="span" variant="meta" className="wrap-anywhere">
            <Code>{server.url}</Code>
          </Text>
          <Text as="span" variant="meta" className="wrap-anywhere">
            {t("workspaceMcp.tools", { count: String(server.tools.length) })}
            {server.tools_skipped > 0
              ? ` · ${t("workspaceMcp.toolsSkipped", {
                  count: String(server.tools_skipped),
                })}`
              : ""}
            {server.tools_read_at
              ? ` · ${t("workspaceMcp.toolsReadAt", {
                  at: formatTimestamp(server.tools_read_at, locale),
                })}`
              : ""}
            {" · "}
            {t("workspaceMcp.namespace", { namespace: "" })}
            <Code>{`mcp__${name}__*`}</Code>
          </Text>
        </RowLines>
        {reauth ? (
          <Alert variant="amber">
            <AlertDescription>{reauth}</AlertDescription>
          </Alert>
        ) : null}
        {needsClient ? (
          <Alert variant="blue">
            <AlertDescription>
              {t("workspaceMcp.register.foundManual")}
            </AlertDescription>
          </Alert>
        ) : null}
        {connection.state !== "none" ? (
          <Alert
            role="region"
            aria-label={t("workspaceMcp.actingAs.title")}
            className="max-w-3xl"
          >
            <AlertTitle>{t("workspaceMcp.actingAs.title")}</AlertTitle>
            <AlertDescription>
              <div className="flex flex-col gap-2">
                <Text as="span" variant="sub">
                  {t(
                    oauth
                      ? "workspaceMcp.actingAs.oauth"
                      : "workspaceMcp.actingAs.bearer",
                    { name: person },
                  )}
                </Text>
                <KeyValueList
                  variant="grid"
                  stack="sm"
                  items={[
                    { label: t("workspaceMcp.connectedBy"), value: person },
                    ...(connection.connected_at
                      ? [
                          {
                            label: t("workspaceMcp.connectedAt"),
                            value: formatTimestamp(
                              connection.connected_at,
                              locale,
                            ),
                          },
                        ]
                      : []),
                    oauth
                      ? {
                          label: t("workspaceMcp.grantedScope"),
                          value: connection.granted_scope ? (
                            <Code className="wrap-anywhere">
                              {connection.granted_scope}
                            </Code>
                          ) : (
                            t("workspaceMcp.grantedScopeNone")
                          ),
                        }
                      : {
                          label: t("workspaceMcp.lastFour"),
                          value: <Code>{server.bearer?.last4 ?? "—"}</Code>,
                        },
                  ]}
                />
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      {manages ? (
        <div className="flex flex-wrap gap-1">
          {oauth ? (
            <RowAction
              disabled={busy || needsClient}
              aria-label={t(
                connection.state === "none"
                  ? "workspaceMcp.connectFor"
                  : "workspaceMcp.reconnectFor",
                { name },
              )}
              onClick={() => {
                onOutcome(null);
                start.mutate(undefined);
              }}
            >
              {start.isPending
                ? t("workspaceMcp.connecting")
                : t(
                    connection.state === "none"
                      ? "workspaceMcp.connect"
                      : "workspaceMcp.reconnect",
                  )}
            </RowAction>
          ) : (
            <RowAction
              disabled={busy}
              aria-label={t("workspaceMcp.replaceTokenFor", { name })}
              onClick={(event) => {
                setOpener(event.currentTarget);
                setDialog({ kind: "token" });
              }}
            >
              {t("workspaceMcp.replaceToken")}
            </RowAction>
          )}
          {oauth && (manualClient || server.oauth?.dcr_supported === false) ? (
            <RowAction
              disabled={busy}
              aria-label={t("workspaceMcp.clientFor", { name })}
              onClick={(event) => {
                setOpener(event.currentTarget);
                setDialog({ kind: "client" });
              }}
            >
              {t("workspaceMcp.client")}
            </RowAction>
          ) : null}
          {connection.state === "active" ? (
            <RowAction
              disabled={busy}
              aria-label={t("workspaceMcp.refreshFor", { name })}
              onClick={() => {
                onOutcome(null);
                refresh.mutate(undefined);
              }}
            >
              {t("workspaceMcp.refresh")}
            </RowAction>
          ) : null}
          {connection.state !== "none" ? (
            <RowAction
              variant="danger"
              disabled={busy}
              aria-label={t("workspaceMcp.disconnectFor", { name })}
              onClick={() => setDialog({ kind: "disconnect" })}
            >
              {t("workspaceMcp.disconnect")}
            </RowAction>
          ) : null}
          <RowAction
            variant="danger"
            disabled={busy}
            aria-label={t("workspaceMcp.deleteFor", { name })}
            onClick={() => setDialog({ kind: "delete" })}
          >
            {t("workspaceMcp.delete")}
          </RowAction>
        </div>
      ) : null}
      <ConfirmDialog
        open={dialog.kind === "disconnect"}
        onOpenChange={(open) => (open ? null : close())}
        title={t("workspaceMcp.disconnectTitle", { name })}
        consequence={t("workspaceMcp.disconnectConsequence")}
        tone="danger"
        busy={disconnect.isPending}
        confirmLabel={t("workspaceMcp.disconnect")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          onOutcome(null);
          disconnect.mutate(undefined);
        }}
      />
      <ConfirmDialog
        open={dialog.kind === "delete"}
        onOpenChange={(open) => (open ? null : close())}
        title={t("workspaceMcp.deleteTitle", { name })}
        consequence={t("workspaceMcp.deleteConsequence")}
        tone="danger"
        busy={remove.isPending}
        confirmLabel={t("workspaceMcp.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          onOutcome(null);
          remove.mutate(undefined);
        }}
      />
      <ReplaceToken
        server={dialog.kind === "token" ? server : null}
        onClose={close}
        onOutcome={onOutcome}
        opener={opener}
      />
      <SetClient
        server={dialog.kind === "client" ? server : null}
        onClose={close}
        onOutcome={onOutcome}
        opener={opener}
      />
    </RowListItem>
  );
}

function TokenInput({
  label,
  name,
  hint,
  required = true,
}: {
  readonly label: string;
  readonly name: string;
  readonly hint: string;
  readonly required?: boolean;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        name={name}
        type="password"
        required={required}
        minLength={8}
        maxLength={16 * 1024}
        autoComplete="off"
        spellCheck={false}
      />
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  );
}

function ReplaceToken({
  server,
  onClose,
  onOutcome,
  opener,
}: {
  readonly server: WorkspaceMcpServer | null;
  readonly onClose: () => void;
  readonly onOutcome: (outcome: Outcome) => void;
  readonly opener: HTMLElement | null;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const save = useServerWrite(
    (client, input: { id: string; token: string }) =>
      unwrap(
        client.PUT("/v1/workspace/mcp-servers/{id}/token", {
          params: { path: { id: input.id } },
          body: { token: input.token },
        }),
      ),
    {
      onDone: (answer) => {
        onClose();
        onOutcome({
          kind: "notice",
          text: t("workspaceMcp.tokenReplaced", { name: answer.name }),
        });
      },
      onRefused: setError,
    },
  );
  const name = server?.name ?? "";
  return (
    <FormDialog
      open={server !== null}
      onOpenChange={(open) => {
        setError(null);
        if (!open) onClose();
      }}
      pending={save.isPending}
      opener={opener}
      title={t("workspaceMcp.replaceTokenTitle", { name })}
      description={t("workspaceMcp.replaceTokenBody")}
      error={error}
      submitLabel={t("settings.save")}
      pendingLabel={t("settings.saving")}
      onSubmit={(form) => {
        if (server === null) return;
        setError(null);
        save.mutate(
          { id: server.id, token: String(form.get("token")) },
          // Detach the observer so the settled write and its token go now.
          { onSettled: () => save.reset() },
        );
      }}
    >
      <TokenInput
        label={t("workspaceMcp.register.token")}
        name="token"
        hint={t("workspaceMcp.register.tokenHint")}
      />
    </FormDialog>
  );
}

function SetClient({
  server,
  onClose,
  onOutcome,
  opener,
}: {
  readonly server: WorkspaceMcpServer | null;
  readonly onClose: () => void;
  readonly onOutcome: (outcome: Outcome) => void;
  readonly opener: HTMLElement | null;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const save = useServerWrite(
    (client, input: { id: string; client_id: string; client_secret: string }) =>
      unwrap(
        client.PUT("/v1/workspace/mcp-servers/{id}/oauth-client", {
          params: { path: { id: input.id } },
          body: {
            client_id: input.client_id,
            ...(input.client_secret === ""
              ? {}
              : { client_secret: input.client_secret }),
          },
        }),
      ),
    {
      onDone: (answer) => {
        onClose();
        onOutcome({
          kind: "notice",
          text: t("workspaceMcp.clientSaved", { name: answer.name }),
        });
      },
      onRefused: setError,
    },
  );
  const name = server?.name ?? "";
  return (
    <FormDialog
      open={server !== null}
      onOpenChange={(open) => {
        setError(null);
        if (!open) onClose();
      }}
      pending={save.isPending}
      opener={opener}
      title={t("workspaceMcp.clientTitle", { name })}
      description={t("workspaceMcp.clientBody")}
      error={error}
      submitLabel={t("settings.save")}
      pendingLabel={t("settings.saving")}
      onSubmit={(form) => {
        if (server === null) return;
        setError(null);
        save.mutate(
          {
            id: server.id,
            client_id: String(form.get("client_id")).trim(),
            client_secret: String(form.get("client_secret")),
          },
          { onSettled: () => save.reset() },
        );
      }}
    >
      <Field>
        <FieldLabel>{t("workspaceMcp.redirectUri")}</FieldLabel>
        <Input
          readOnly
          value={server?.redirect_uri ?? ""}
          className="font-mono"
        />
      </Field>
      <Field>
        <FieldLabel>{t("workspaceMcp.clientId")}</FieldLabel>
        <Input
          name="client_id"
          required
          maxLength={512}
          autoComplete="off"
          spellCheck={false}
          defaultValue={server?.oauth?.client_id ?? ""}
        />
      </Field>
      <TokenInput
        label={t("workspaceMcp.clientSecret")}
        name="client_secret"
        hint={t("workspaceMcp.clientSecretHint")}
        required={false}
      />
    </FormDialog>
  );
}

function RegisterServer({
  open,
  onOpenChange,
  onOutcome,
  opener,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOutcome: (outcome: Outcome) => void;
  readonly opener: HTMLElement | null;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const role = useRole();
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<DiscoverWorkspaceMcpServerResponse | null>(
    null,
  );
  const [kind, setKind] = useState<"oauth" | "bearer">("oauth");
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setUrl("");
    setFound(null);
    setError(null);
  };
  const discover = useMutation<
    DiscoverWorkspaceMcpServerResponse,
    ApiError,
    string
  >({
    mutationFn: (target) =>
      unwrap(
        client.POST("/v1/workspace/mcp-servers/discover", {
          body: { url: target },
        }),
      ),
    onSuccess: (answer) => {
      setFound(answer);
      setUrl(answer.url);
      setKind(answer.oauth === null ? "bearer" : "oauth");
    },
    onError: (failure) => setError(workspaceMcpRefusal(t, failure, role)),
  });
  const create = useServerWrite(
    (
      api,
      body:
        | { name: string; url: string; auth_kind: "bearer"; token: string }
        | { name: string; url: string; auth_kind: "oauth"; scope?: string },
    ) => unwrap(api.POST("/v1/workspace/mcp-servers", { body })),
    {
      onDone: (server) => {
        reset();
        onOpenChange(false);
        onOutcome({
          kind: "notice",
          text: t(
            server.auth_kind === "bearer"
              ? "workspaceMcp.registered.bearer"
              : server.oauth?.dcr_supported === false
                ? "workspaceMcp.registered.manual"
                : "workspaceMcp.registered.oauth",
            { name: server.name },
          ),
        });
      },
      onRefused: setError,
    },
  );
  const oauth = found?.oauth ?? null;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      opener={opener}
      pending={discover.isPending || create.isPending}
      title={t("workspaceMcp.register.title")}
      description={t("workspaceMcp.register.description")}
      error={error}
      submitLabel={t(
        found === null
          ? "workspaceMcp.register.discover"
          : "workspaceMcp.register.submit",
      )}
      pendingLabel={t(
        found === null
          ? "workspaceMcp.register.discovering"
          : "workspaceMcp.register.submitting",
      )}
      onSubmit={(form) => {
        setError(null);
        if (found === null) {
          discover.mutate(url.trim());
          return;
        }
        const name = String(form.get("name")).trim();
        if (WORKSPACE_MCP_RESERVED_NAMES.includes(name)) {
          setError(t("workspaceMcp.error.name_reserved"));
          return;
        }
        if (kind === "bearer") {
          create.mutate(
            {
              name,
              url: found.url,
              auth_kind: "bearer",
              token: String(form.get("token")),
            },
            { onSettled: () => create.reset() },
          );
          return;
        }
        const scope = String(form.get("scope") ?? "").trim();
        create.mutate({
          name,
          url: found.url,
          auth_kind: "oauth",
          ...(scope === "" ? {} : { scope }),
        });
      }}
    >
      <Field>
        <FieldLabel>{t("workspaceMcp.register.url")}</FieldLabel>
        <Input
          name="url"
          type="url"
          required
          maxLength={2048}
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            // A changed URL has not been discovered.
            setFound(null);
          }}
        />
        <FieldDescription>
          {t("workspaceMcp.register.urlHint")}
        </FieldDescription>
      </Field>
      {found === null ? null : (
        <>
          <Alert
            variant="blue"
            role="region"
            aria-label={t("workspaceMcp.register.found")}
          >
            <AlertTitle>{t("workspaceMcp.register.found")}</AlertTitle>
            <AlertDescription>
              {oauth === null ? (
                t("workspaceMcp.register.foundNone")
              ) : (
                <div className="flex flex-col gap-1">
                  <Text as="span" variant="sub" className="wrap-anywhere">
                    {t("workspaceMcp.register.foundOauth", {
                      issuer: oauth.issuer,
                    })}
                  </Text>
                  <Text as="span" variant="sub">
                    {t(
                      oauth.dcr_supported
                        ? "workspaceMcp.register.foundDcr"
                        : "workspaceMcp.register.foundManual",
                    )}
                  </Text>
                </div>
              )}
            </AlertDescription>
          </Alert>
          <Field>
            <FieldLabel>{t("workspaceMcp.register.name")}</FieldLabel>
            <Input
              name="name"
              required
              maxLength={32}
              pattern="[a-z0-9]([a-z0-9\-]|_(?!_)){0,31}"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldDescription>
              {t("workspaceMcp.register.nameHint")}
            </FieldDescription>
          </Field>
          {oauth === null ? null : (
            <Field>
              <FieldLabel>{t("workspaceMcp.register.authKind")}</FieldLabel>
              <NativeSelect
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value === "bearer" ? "bearer" : "oauth")
                }
              >
                <NativeSelectOption value="oauth">
                  {t("workspaceMcp.auth.oauth")}
                </NativeSelectOption>
                <NativeSelectOption value="bearer">
                  {t("workspaceMcp.auth.bearer")}
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
          {kind === "oauth" && oauth !== null ? (
            <Field>
              <FieldLabel>{t("workspaceMcp.register.scope")}</FieldLabel>
              <Input
                name="scope"
                maxLength={1024}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                defaultValue={oauth.default_scope ?? ""}
              />
              <FieldDescription>
                {t("workspaceMcp.register.scopeHint")}
              </FieldDescription>
            </Field>
          ) : (
            <TokenInput
              label={t("workspaceMcp.register.token")}
              name="token"
              hint={t("workspaceMcp.register.tokenHint")}
            />
          )}
        </>
      )}
    </FormDialog>
  );
}
