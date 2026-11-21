import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  ListSettingsConnectionsResponse,
  ListSettingsMcpServersResponse,
  SettingsChangeResponse,
  SettingsCredentialView,
  SettingsEntryState,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  type StatusDotStatus,
  StatusText,
} from "@werft-ai/ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { queryKeysOf, scopedKey } from "../api/queries.ts";
import {
  type ManagedPermission,
  refusalText,
  useRole,
} from "../auth/guard.tsx";
import type { Outcome } from "../components/outcome.tsx";
import { focusBack } from "../components/row-menu.tsx";
import { type Translate, useI18n } from "../i18n/i18n.tsx";

export type SettingsKind = "connection" | "mcp";

const SEGMENT = {
  connection: "connections",
  mcp: "mcp-servers",
} as const satisfies Record<SettingsKind, string>;

const PERMISSION: Record<SettingsKind, ManagedPermission> = {
  connection: "installation.settings.manage",
  mcp: "installation.settings.manage",
};

const listKey = (client: ApiClient, kind: SettingsKind) =>
  scopedKey(client, "installation-settings", kind);

export function settingsConnectionsQuery(client: ApiClient, enabled = true) {
  return queryOptions({
    queryKey: listKey(client, "connection"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation/settings/connections"),
      ) as Promise<ListSettingsConnectionsResponse>,
    enabled,
    retry: false,
  });
}

/** What disabling a connection leaves without a model, counted by the server. */
export type ConnectionImpact = {
  readonly agents: number;
  readonly sessions: number;
  readonly judge: boolean;
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The client does not validate a 200 by default, so a body of another shape
 * (an older or newer server) fails here and reads as "could not check".
 */
function impactOf(body: unknown): ConnectionImpact {
  const impact = body as Record<string, unknown> | null;
  if (
    impact === null ||
    typeof impact !== "object" ||
    !isCount(impact.agent_count) ||
    !isCount(impact.session_count) ||
    typeof impact.judge_used !== "boolean"
  ) {
    throw new Error("unexpected connection impact");
  }
  return {
    agents: impact.agent_count,
    sessions: impact.session_count,
    judge: impact.judge_used,
  };
}

/**
 * Read each time the disable confirmation opens, never reused: the counts
 * move with every session and release, and the answer to a write is too late.
 */
function settingsConnectionImpactQuery(
  client: ApiClient,
  id: string,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: scopedKey(client, "installation-settings", "impact", id),
    queryFn: async () =>
      impactOf(
        await unwrap(
          client.GET("/v1/installation/settings/connections/{id}/impact", {
            params: { path: { id } },
          }),
        ),
      ),
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function settingsMcpServersQuery(client: ApiClient, enabled = true) {
  return queryOptions({
    queryKey: listKey(client, "mcp"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation/settings/mcp-servers"),
      ) as Promise<ListSettingsMcpServersResponse>,
    enabled,
    retry: false,
  });
}

const REASONS = [
  "already_exists",
  "not_stored",
  "disabled",
  "not_disabled",
  "definition_active",
  "needs_value",
  "invalid_entry",
] as const;

/** The words for a refused settings write: the server's reason first. */
function settingsRefusal(
  t: Translate,
  error: ApiError,
  kind: SettingsKind,
  role: string | undefined,
): string {
  const reason = (error.details as { reason_code?: unknown } | null)
    ?.reason_code;
  const known = REASONS.find((item) => item === reason);
  if (known === "invalid_entry") {
    return t("settings.error.invalid_entry", { detail: error.message });
  }
  if (known !== undefined) return t(`settings.error.${known}`);
  return refusalText(t, error, PERMISSION[kind], role);
}

/**
 * One settings write, then every screen that reads the settings again:
 * the lists and the connections agents pick from.
 */
export function useSettingsWrite<V>(
  kind: SettingsKind,
  write: (client: ApiClient, variables: V) => Promise<SettingsChangeResponse>,
  handlers: {
    readonly onDone: (answer: SettingsChangeResponse, variables: V) => void;
    readonly onRefused: (text: string) => void;
  },
) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  return useMutation<SettingsChangeResponse, ApiError, V>({
    mutationFn: (variables) => write(client, variables),
    onSuccess: async (answer, variables) => {
      handlers.onDone(answer, variables);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: scopedKey(client, "installation-settings"),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).connections,
        }),
        // The judge lists the enabled decision connections, which lock or
        // unlock the achievement rules.
        queryClient.invalidateQueries({
          queryKey: scopedKey(client, "achievement-judge"),
        }),
      ]);
    },
    onError: (error) =>
      handlers.onRefused(settingsRefusal(t, error, kind, role)),
  });
}

function setCredential(
  client: ApiClient,
  kind: SettingsKind,
  id: string,
  value: string,
): Promise<SettingsChangeResponse> {
  const params = { params: { path: { id } }, body: { value } };
  switch (SEGMENT[kind]) {
    case "connections":
      return unwrap(
        client.POST(
          "/v1/installation/settings/connections/{id}/credential",
          params,
        ),
      );
    case "mcp-servers":
      return unwrap(
        client.POST(
          "/v1/installation/settings/mcp-servers/{id}/credential",
          params,
        ),
      );
  }
}

function disableEntry(
  client: ApiClient,
  kind: SettingsKind,
  id: string,
): Promise<SettingsChangeResponse> {
  const params = { params: { path: { id } } };
  switch (SEGMENT[kind]) {
    case "connections":
      return unwrap(
        client.POST(
          "/v1/installation/settings/connections/{id}/disable",
          params,
        ),
      );
    case "mcp-servers":
      return unwrap(
        client.POST(
          "/v1/installation/settings/mcp-servers/{id}/disable",
          params,
        ),
      );
  }
}

/** Connections only: an MCP server cannot be enabled again. */
function enableConnection(
  client: ApiClient,
  id: string,
): Promise<SettingsChangeResponse> {
  return unwrap(
    client.POST("/v1/installation/settings/connections/{id}/enable", {
      params: { path: { id } },
    }),
  );
}

const STATE_BADGE: Record<
  SettingsEntryState,
  "green" | "amber" | "red" | "gray"
> = {
  active: "green",
  needs_value: "amber",
  unresolved: "red",
  disabled: "gray",
};

export function StateBadge({ state }: { readonly state: SettingsEntryState }) {
  const { t } = useI18n();
  return (
    <Badge variant={STATE_BADGE[state]}>{t(`settings.state.${state}`)}</Badge>
  );
}

/**
 * A settings table once narrow (860px, its `narrowAt`): the id cell, which
 * then carries the state, and the actions, which wrap rather than go.
 */
export const SETTINGS_NARROW_COLUMNS = "minmax(0,1fr) fit-content(55%)";

const STATE_DOT: Record<SettingsEntryState, StatusDotStatus> = {
  active: "done",
  needs_value: "wait",
  unresolved: "failed",
  disabled: "idle",
};

/** The state as the members table says its own: a dot and its name. */
export function StateText({ state }: { readonly state: SettingsEntryState }) {
  const { t } = useI18n();
  return (
    <StatusText status={STATE_DOT[state]}>
      {t(`settings.state.${state}`)}
    </StatusText>
  );
}

/** The state inside the id cell, where a narrow table drops its column. */
export function NarrowState({
  state,
  dot = false,
}: {
  readonly state: SettingsEntryState;
  /** StateText instead of StateBadge, as the table's state column. */
  readonly dot?: boolean;
}) {
  return (
    <span className="hidden [@container(max-width:860px)]:inline-flex">
      {dot ? <StateText state={state} /> : <StateBadge state={state} />}
    </span>
  );
}

/** A credential as words: a stored value's last four, never the value. */
export function credentialText(
  t: Translate,
  credential: SettingsCredentialView,
): string {
  switch (credential.source) {
    case "stored":
      return credential.last4 === null
        ? t("settings.credential.storedEmpty")
        : t("settings.credential.stored", { last4: credential.last4 });
    case "none":
      return t("settings.credential.none");
  }
}

export function entryActions(entry: {
  readonly state: SettingsEntryState;
  readonly credential: SettingsCredentialView;
}): {
  readonly setValue: boolean;
  readonly disable: boolean;
  /** Only a connection can: `useRowActions("connection")` offers it. */
  readonly enable: boolean;
} {
  if (entry.state === "disabled") {
    return { setValue: false, disable: false, enable: true };
  }
  return {
    setValue: entry.credential.source === "stored",
    disable: true,
    enable: false,
  };
}

/** A form in a dialog that stays open until its request answers. */
export function FormDialog({
  open,
  onOpenChange,
  pending,
  title,
  description,
  error,
  submitLabel,
  pendingLabel,
  onSubmit,
  opener,
  gated = false,
  blocked = false,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The button that opened it, which gets the keyboard back on close. */
  readonly opener?: HTMLElement | null;
  readonly pending: boolean;
  readonly title: string;
  readonly description: ReactNode;
  readonly error: string | null;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly onSubmit: (form: FormData) => void;
  /** Keeps the submit button off until every field holds what it accepts. */
  readonly gated?: boolean;
  /** Keeps the submit button off while the form still lacks what it needs. */
  readonly blocked?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      {/* A form with many fields scrolls on a short screen, as teams.tsx's. */}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onCloseAutoFocus={focusBack(opener)}
      >
        <DialogForm
          pending={pending}
          title={title}
          description={description}
          error={error}
          submitLabel={submitLabel}
          pendingLabel={pendingLabel}
          onSubmit={onSubmit}
          gated={gated}
          blocked={blocked}
        >
          {children}
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted with each opening, so a gated form starts off again. */
function DialogForm({
  pending,
  title,
  description,
  error,
  submitLabel,
  pendingLabel,
  onSubmit,
  gated,
  blocked,
  children,
}: {
  readonly pending: boolean;
  readonly title: string;
  readonly description: ReactNode;
  readonly error: string | null;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly onSubmit: (form: FormData) => void;
  readonly gated: boolean;
  readonly blocked: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const [filled, setFilled] = useState(!gated);
  const off = pending || !filled || blocked;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!off) onSubmit(new FormData(event.currentTarget));
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={submit}
      onInput={(event) => {
        if (gated) setFilled(event.currentTarget.checkValidity());
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {error === null ? null : (
        <Alert variant="red" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {children}
      <DialogFooter>
        <DialogClose asChild>
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
          >
            {t("common.cancel")}
          </Button>
        </DialogClose>
        {/* aria-disabled, not disabled: it stays in the tab order, and a
            click still runs the browser's check, which says what is missing. */}
        <Button type="submit" aria-disabled={off || undefined}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The server refuses a shorter value (`MIN_CREDENTIAL_BYTES`). */
const MIN_VALUE_LENGTH = 8;

/** A value typed in, sealed at once; the field never shows it back. */
export function SecretInput({
  label,
  name = "value",
}: {
  readonly label: string;
  readonly name?: string;
}) {
  const { t } = useI18n();
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        name={name}
        type="password"
        required
        minLength={MIN_VALUE_LENGTH}
        maxLength={8192}
        autoComplete="off"
        spellCheck={false}
      />
      <FieldDescription>{t("settings.valueHint")}</FieldDescription>
    </Field>
  );
}

/**
 * Mounted only while the disable confirmation is open, so the server's count
 * is read when it opens. It never blocks the button: a count that is loading
 * or could not be read is said so, and disabling stays possible.
 */
function ConnectionImpactNotice({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const impact = useQuery(settingsConnectionImpactQuery(client, id, true));
  if (impact.isFetching) {
    return (
      <output className="block text-description text-muted-foreground">
        {t("settings.connections.impact.checking")}
      </output>
    );
  }
  // A refetch that failed keeps the data of the one before, which is no
  // longer what the server says.
  if (impact.isError || impact.data === undefined) {
    return (
      <Alert variant="amber" role="status">
        <AlertDescription>
          {t("settings.connections.impact.failed")}
        </AlertDescription>
      </Alert>
    );
  }
  const { agents, sessions, judge } = impact.data;
  if (agents === 0 && sessions === 0 && !judge) return null;
  // The judge setting only names the connection; the judge does not call a
  // model through it today, so it is said apart from the calls that would stop.
  const calls = agents > 0 || sessions > 0;
  return (
    <Alert variant="amber" role="alert">
      <AlertDescription>
        {calls ? (
          <>
            <p>{t("settings.connections.impact.warning")}</p>
            <ul className="mt-1 list-disc pl-5">
              {agents > 0 ? (
                <li>
                  {t("settings.connections.impact.agents", { count: agents })}
                </li>
              ) : null}
              {sessions > 0 ? (
                <li>
                  {t("settings.connections.impact.sessions", {
                    count: sessions,
                  })}
                </li>
              ) : null}
            </ul>
          </>
        ) : null}
        {judge ? (
          <p className={calls ? "mt-2" : undefined}>
            {t("settings.connections.impact.judge")}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Replacing or disabling one entry from a table's row: the dialogs and the
 * writes they make, opened by `open`.
 */
export function useRowActions(
  kind: SettingsKind,
  onOutcome: (outcome: Outcome | null) => void,
) {
  const { t } = useI18n();
  const [valueFor, setValueFor] = useState<string | null>(null);
  // A row menu's button; a plain row button needs none.
  const [valueOpener, setValueOpener] = useState<HTMLElement | null>(null);
  const [disabling, setDisabling] = useState<string | null>(null);
  const [enabling, setEnabling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = useSettingsWrite(
    kind,
    (client, input: { id: string; value: string }) =>
      setCredential(client, kind, input.id, input.value),
    {
      onDone: (answer) => {
        setValueFor(null);
        onOutcome({
          kind: "notice",
          text: t("settings.done.value", { id: answer.id }),
        });
      },
      onRefused: setError,
    },
  );
  const disable = useSettingsWrite(
    kind,
    (client, id: string) => disableEntry(client, kind, id),
    {
      onDone: (answer) => {
        setDisabling(null);
        onOutcome({
          kind: "notice",
          text: t("settings.done.disabled", { id: answer.id }),
        });
      },
      onRefused: (text) => {
        setDisabling(null);
        onOutcome({ kind: "error", text });
      },
    },
  );

  // The "enable again" item opened the dialog from a menu that is gone, so
  // the focus goes back to the row's ⋯ button once the refetch brings it.
  const [refocus, setRefocus] = useState<string | null>(null);
  useEffect(() => {
    if (refocus === null) return;
    const label = t("settings.connections.menuFor", { id: refocus });
    const next = [...document.querySelectorAll<HTMLElement>("button")].find(
      (button) => button.getAttribute("aria-label") === label,
    );
    if (next === undefined) return;
    // Keep trying until the focus lands, should a render steal it first.
    next.focus();
    if (document.activeElement === next) setRefocus(null);
  });

  const enable = useSettingsWrite(
    kind,
    (client, id: string) => enableConnection(client, id),
    {
      onDone: (answer) => {
        setEnabling(null);
        setRefocus(answer.id);
        onOutcome({
          kind: "notice",
          text: t("settings.done.enabled", { id: answer.id }),
        });
      },
      onRefused: (text) => {
        setEnabling(null);
        onOutcome({ kind: "error", text });
      },
    },
  );

  const dialogs = (
    <>
      <ConfirmDialog
        open={enabling !== null}
        onOpenChange={(open) => {
          if (!open) setEnabling(null);
        }}
        title={t("settings.enableTitle", { id: enabling ?? "" })}
        consequence={t("settings.connections.enableConsequence")}
        confirmLabel={t("settings.enable")}
        cancelLabel={t("common.cancel")}
        busy={enable.isPending}
        onConfirm={() => {
          if (enabling !== null) enable.mutate(enabling);
        }}
      />
      <FormDialog
        open={valueFor !== null}
        opener={valueOpener}
        onOpenChange={(open) => {
          if (!open) setValueFor(null);
        }}
        pending={value.isPending}
        title={t("settings.setValueTitle", { id: valueFor ?? "" })}
        description={t("settings.setValueDescription")}
        gated
        error={error}
        submitLabel={t("settings.save")}
        pendingLabel={t("settings.saving")}
        onSubmit={(form) => {
          if (valueFor === null) return;
          setError(null);
          value.mutate({
            id: valueFor,
            value: String(form.get("value")),
          });
        }}
      >
        <SecretInput label={t("settings.value")} />
      </FormDialog>
      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(open) => {
          if (!open) setDisabling(null);
        }}
        title={t("settings.disableTitle", { id: disabling ?? "" })}
        consequence={
          kind === "connection"
            ? `${t("settings.connections.disableConsequence")} ${t("settings.connections.disableReenable")}`
            : t("settings.disableConsequence")
        }
        confirmLabel={t("settings.disable")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={disable.isPending}
        onConfirm={() => {
          if (disabling !== null) disable.mutate(disabling);
        }}
      >
        {kind === "connection" && disabling !== null ? (
          <ConnectionImpactNotice id={disabling} />
        ) : null}
      </ConfirmDialog>
    </>
  );

  return {
    dialogs,
    openValue: (id: string, opener: HTMLElement | null = null) => {
      setError(null);
      onOutcome(null);
      setValueOpener(opener);
      setValueFor(id);
    },
    openDisable: (id: string) => {
      onOutcome(null);
      setDisabling(id);
    },
    openEnable: (id: string) => {
      onOutcome(null);
      setEnabling(id);
    },
    busy: value.isPending || disable.isPending || enable.isPending,
  };
}
