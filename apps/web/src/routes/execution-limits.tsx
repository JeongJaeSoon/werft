import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  InstallationConfig,
  InstallationConfigKey,
  UpdateInstallationConfigResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FormActions,
  Input,
  NativeSelect,
  NativeSelectOption,
  Page,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { type FormEvent, useId, useRef, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useHasPermission, useRole } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { SECTIONS } from "./workspace-settings.tsx";

const PERMISSION = "installation.settings.manage";

type NumberKey = Exclude<
  InstallationConfigKey,
  "workspace_enforce" | "session_archive_after_days" | "session_archive_dry_run"
>;
type Enforce = InstallationConfig["workspace_enforce"]["value"];
/** Only the keys to change. */
type Patch = { [K in InstallationConfigKey]?: InstallationConfig[K]["value"] };

export type NumberLimit = {
  readonly key: NumberKey;
  /** Its messages, under `limits.<name>.`. */
  readonly name:
    | "wait"
    | "turn"
    | "retries"
    | "cost"
    | "tokens"
    | "queue"
    | "storage"
    | "stopped"
    | "paused";
  /** What migrate carried the value in from. */
  readonly env: string;
  readonly min: number;
  /** True when min itself is refused. */
  readonly aboveMin: boolean;
  readonly max: number;
  readonly whole: boolean;
};

// The server's ranges; the web takes contracts as types only, so a test
// keeps these equal to the contract's.
export const NUMBER_LIMITS: readonly NumberLimit[] = [
  {
    key: "pending_request_ttl_sec",
    name: "wait",
    env: "PENDING_REQUEST_TTL_SEC",
    min: 1,
    aboveMin: false,
    max: 604_800,
    whole: true,
  },
  {
    key: "max_turn_seconds",
    name: "turn",
    env: "MAX_TURN_SECONDS",
    min: 1,
    aboveMin: false,
    max: 604_800,
    whole: true,
  },
  {
    key: "provider_max_retries",
    name: "retries",
    env: "PROVIDER_MAX_RETRIES",
    min: 0,
    aboveMin: false,
    max: 10,
    whole: true,
  },
  {
    key: "session_cost_limit_usd",
    name: "cost",
    env: "SESSION_COST_LIMIT_USD",
    min: 0,
    aboveMin: true,
    max: 1_000_000,
    whole: false,
  },
  {
    key: "session_token_limit",
    name: "tokens",
    env: "SESSION_TOKEN_LIMIT",
    min: 0,
    aboveMin: false,
    max: Number.MAX_SAFE_INTEGER,
    whole: true,
  },
  {
    key: "queued_input_limit_per_session",
    name: "queue",
    env: "QUEUED_INPUT_LIMIT_PER_SESSION",
    min: 1,
    aboveMin: false,
    max: 100_000,
    whole: true,
  },
  {
    key: "storage_limit_bytes",
    name: "storage",
    env: "STORAGE_LIMIT_BYTES",
    min: 1,
    aboveMin: false,
    max: Number.MAX_SAFE_INTEGER,
    whole: true,
  },
  {
    key: "workspace_stopped_ttl_sec",
    name: "stopped",
    env: "EXECUTION_WORKSPACE_STOPPED_TTL_SEC",
    min: 0,
    aboveMin: false,
    max: 315_360_000,
    whole: true,
  },
  {
    key: "workspace_paused_ttl_sec",
    name: "paused",
    env: "EXECUTION_WORKSPACE_PAUSED_TTL_SEC",
    min: 0,
    aboveMin: false,
    max: 315_360_000,
    whole: true,
  },
];

export const ENFORCE_ENV = "WORKSPACE_ENFORCE";
export const ENFORCE_VALUES: readonly Enforce[] = ["warn", "fail", "off"];

/** 0 archives nothing; otherwise a whole number of days in this range. */
export const ARCHIVE_DAYS = {
  env: "SESSION_ARCHIVE_AFTER_DAYS",
  min: 30,
  max: 3650,
} as const;
export const ARCHIVE_DRY_RUN_ENV = "SESSION_ARCHIVE_DRY_RUN";

/** Whole days: 0, or in the archive's range; else null. */
export function archiveDaysOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return days === 0 || (days >= ARCHIVE_DAYS.min && days <= ARCHIVE_DAYS.max)
    ? days
    : null;
}

const configKey = (client: ApiClient) =>
  scopedKey(client, "installation-config");

/** A plain decimal in the limit's range, else null. */
export function limitValueOf(limit: NumberLimit, text: string): number | null {
  const trimmed = text.trim();
  if (!(limit.whole ? /^\d+$/ : /^\d+(\.\d+)?$/).test(trimmed)) return null;
  const value = Number(trimmed);
  if (limit.whole && !Number.isSafeInteger(value)) return null;
  const aboveMin = limit.aboveMin ? value > limit.min : value >= limit.min;
  return aboveMin && value <= limit.max ? value : null;
}

/** Settings > Workspace > Execution limits: the installation owner's. */
export function ExecutionLimitsScreen() {
  const { t } = useI18n();
  const owns = useHasPermission(PERMISSION);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  if (!owns)
    return (
      <Page title={t("limits.title")}>
        <StatusScreen kind="forbidden" />
      </Page>
    );
  return (
    <Page title={t("limits.title")} description={t("limits.description")}>
      <div className={SECTIONS}>
        <OutcomeLine outcome={outcome} live />
        <Limits onOutcome={setOutcome} />
      </div>
    </Page>
  );
}

function Limits({
  onOutcome,
}: {
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { client } = useWerft();
  const read = useQuery({
    queryKey: configKey(client),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation-config"),
      ) as Promise<InstallationConfig>,
    retry: false,
  });
  if (read.isPending) return <Skeleton width="50%" />;
  if (read.isError) {
    return (
      <LoadFailure error={read.error} onRetry={() => void read.refetch()} />
    );
  }
  return (
    <>
      {NUMBER_LIMITS.map((limit) => (
        <NumberLimitSection
          key={limit.key}
          limit={limit}
          entry={read.data[limit.key]}
          onOutcome={onOutcome}
        />
      ))}
      <EnforceSection
        entry={read.data.workspace_enforce}
        onOutcome={onOutcome}
      />
      <ArchiveSection config={read.data} onOutcome={onOutcome} />
    </>
  );
}

/** One key's save; the answer replaces the whole config every section reads. */
function useSave<T>(options: {
  readonly onOutcome: (outcome: Outcome | null) => void;
  readonly body: (value: T) => Patch;
  readonly saved: string;
  readonly onSaved: (sent: T) => void;
  readonly onRefused: (error: ApiError) => void;
}) {
  const { client } = useWerft();
  const queryClient = useQueryClient();
  return useMutation<UpdateInstallationConfigResponse, ApiError, T>({
    mutationFn: (value) =>
      unwrap(
        client.PATCH("/v1/installation-config", { body: options.body(value) }),
      ),
    onMutate: () => options.onOutcome(null),
    onSuccess: (answer, sent) => {
      const { receipt_id: _receipt, ...next } = answer;
      queryClient.setQueryData<InstallationConfig>(configKey(client), next);
      options.onSaved(sent);
      options.onOutcome({ kind: "notice", text: options.saved });
    },
    onError: options.onRefused,
  });
}

function Blocked({
  id,
  env,
  refused,
}: {
  readonly id: string;
  readonly env: string;
  readonly refused: string;
}) {
  const { t } = useI18n();
  return (
    <Alert variant="amber" role="status">
      <AlertDescription id={id}>
        {t("limits.blocked", { env, refused })}
      </AlertDescription>
    </Alert>
  );
}

function NumberLimitSection({
  limit,
  entry,
  onOutcome,
}: {
  readonly limit: NumberLimit;
  readonly entry: InstallationConfig[NumberKey];
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const role = useRole();
  const inputId = useId();
  const blockedId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // Untouched, the field follows the server's value as it refreshes.
  const [draft, setDraft] = useState<string | null>(null);
  const [shownError, setShownError] = useState<string | null>(null);
  const { name } = limit;
  const invalid = t(`limits.${name}.invalid`, {
    max: new Intl.NumberFormat(locale).format(limit.max),
  });
  const valueText = (value: number) =>
    name === "tokens" && value === 0
      ? t("limits.tokens.none")
      : t(`limits.${name}.value`, {
          value: new Intl.NumberFormat(locale, {
            maximumFractionDigits: 20,
          }).format(value),
        });

  const save = useSave<number>({
    onOutcome,
    body: (value) => ({ [limit.key]: value }) as Patch,
    saved: t(`limits.${name}.saved`),
    // Keep anything typed while the save was in flight.
    onSaved: (sent) =>
      setDraft((typed) =>
        typed !== null && limitValueOf(limit, typed) !== sent ? typed : null,
      ),
    onRefused: (error) => {
      setShownError(
        error.code === "BAD_REQUEST"
          ? invalid
          : refusalText(t, error, PERMISSION, role),
      );
      inputRef.current?.focus();
    },
  });

  const typed = draft ?? `${entry.value}`;
  const value = limitValueOf(limit, typed);
  // A blocked key takes any valid value, the default shown included.
  const unchanged = value === entry.value && !entry.blocked;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending || unchanged) return;
    if (value === null) {
      setShownError(invalid);
      inputRef.current?.focus();
      return;
    }
    setShownError(null);
    save.mutate(value);
  };

  return (
    <SettingsSection
      title={t(`limits.${name}.title`)}
      description={t(`limits.${name}.hint`)}
      box
    >
      <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
        {entry.blocked ? (
          <Blocked
            id={blockedId}
            env={limit.env}
            refused={t(`limits.${name}.refused`)}
          />
        ) : null}
        <Field>
          <FieldLabel htmlFor={inputId}>{t(`limits.${name}.label`)}</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              ref={inputRef}
              id={inputId}
              className="max-w-50"
              name={limit.key}
              type="number"
              inputMode={limit.whole ? "numeric" : "decimal"}
              min={limit.min}
              max={limit.max}
              step={limit.whole ? 1 : "any"}
              value={typed}
              aria-invalid={shownError !== null || undefined}
              // Heard on reaching the field, not only when the page loads.
              aria-describedby={entry.blocked ? blockedId : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                setShownError(null);
              }}
            />
            {/* The label already says the unit; this is for sighted readers. */}
            <Text as="span" variant="sub" aria-hidden="true">
              {t(`limits.${name}.unit`)}
            </Text>
          </div>
          <FieldDescription>
            {t(
              entry.saved || entry.blocked
                ? "limits.defaultIs"
                : "limits.defaultApplies",
              { value: valueText(entry.default) },
            )}
          </FieldDescription>
          <FieldDescription>{t(`limits.${name}.applies`)}</FieldDescription>
          <FieldError>{shownError}</FieldError>
        </Field>
        <FormActions>
          {entry.saved && entry.value !== entry.default ? (
            <Button
              type="button"
              variant="ghost"
              aria-disabled={save.isPending || undefined}
              onClick={() => {
                if (!save.isPending) save.mutate(entry.default);
              }}
            >
              {t("limits.useDefault")}
            </Button>
          ) : null}
          <Button
            type="submit"
            aria-disabled={save.isPending || unchanged || undefined}
          >
            {t("limits.save")}
          </Button>
        </FormActions>
      </form>
    </SettingsSection>
  );
}

/** The archive's days and what it does, saved together. */
function ArchiveSection({
  config,
  onOutcome,
}: {
  readonly config: InstallationConfig;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const role = useRole();
  const daysId = useId();
  const modeId = useId();
  const noticeId = useId();
  const daysBlockedId = useId();
  const modeBlockedId = useId();
  const daysRef = useRef<HTMLInputElement>(null);
  const days = config.session_archive_after_days;
  const mode = config.session_archive_dry_run;
  const status = config.session_archive;
  const [daysDraft, setDaysDraft] = useState<string | null>(null);
  const [modeDraft, setModeDraft] = useState<boolean | null>(null);
  const [shownError, setShownError] = useState<string | null>(null);
  const invalid = t("limits.archive.daysInvalid", {
    min: ARCHIVE_DAYS.min,
    max: new Intl.NumberFormat(locale).format(ARCHIVE_DAYS.max),
  });
  const daysText = (value: number) =>
    value === 0
      ? t("limits.archive.off")
      : t("limits.archive.daysValue", {
          value: new Intl.NumberFormat(locale).format(value),
        });
  const modeText = (dryRun: boolean) =>
    t(dryRun ? "limits.archive.count" : "limits.archive.move");

  const typed = daysDraft ?? `${days.value}`;
  const daysValue = archiveDaysOf(typed);
  const dryRun = modeDraft ?? mode.value;
  // A blocked key takes any valid value, the default shown included.
  const changes = (sentDays: number): Patch => ({
    ...(sentDays !== days.value || days.blocked
      ? { session_archive_after_days: sentDays }
      : {}),
    ...(dryRun !== mode.value || mode.blocked
      ? { session_archive_dry_run: dryRun }
      : {}),
  });
  const unchanged =
    daysValue !== null && Object.keys(changes(daysValue)).length === 0;

  const save = useSave<Patch>({
    onOutcome,
    body: (patch) => patch,
    saved: t("limits.archive.saved"),
    // Keep anything changed while the save was in flight.
    onSaved: (sent) => {
      setDaysDraft((text) =>
        text !== null &&
        archiveDaysOf(text) !== (sent.session_archive_after_days ?? days.value)
          ? text
          : null,
      );
      setModeDraft((chosen) =>
        chosen !== null &&
        chosen !== (sent.session_archive_dry_run ?? mode.value)
          ? chosen
          : null,
      );
    },
    onRefused: (error) => {
      setShownError(
        error.code === "BAD_REQUEST"
          ? invalid
          : refusalText(t, error, PERMISSION, role),
      );
      daysRef.current?.focus();
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending || unchanged) return;
    if (daysValue === null) {
      setShownError(invalid);
      daysRef.current?.focus();
      return;
    }
    setShownError(null);
    save.mutate(changes(daysValue));
  };
  const differs =
    (days.saved && days.value !== days.default) ||
    (mode.saved && mode.value !== mode.default);
  const describedBy = (blocked: boolean, blockedId: string) =>
    [status.available ? null : noticeId, blocked ? blockedId : null]
      .filter((id) => id !== null)
      .join(" ") || undefined;

  return (
    <SettingsSection
      title={t("limits.archive.title")}
      description={t("limits.archive.hint")}
      box
    >
      <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
        {status.available ? null : (
          <Alert variant="amber" role="status">
            <AlertDescription id={noticeId}>
              {t(
                `limits.archive.unavailable.${status.reason ?? "unversioned"}`,
              )}
            </AlertDescription>
          </Alert>
        )}
        {days.blocked ? (
          <Blocked
            id={daysBlockedId}
            env={ARCHIVE_DAYS.env}
            refused={t("limits.archive.refused")}
          />
        ) : null}
        {mode.blocked ? (
          <Blocked
            id={modeBlockedId}
            env={ARCHIVE_DRY_RUN_ENV}
            refused={t("limits.archive.refused")}
          />
        ) : null}
        <Field>
          <FieldLabel htmlFor={daysId}>
            {t("limits.archive.daysLabel")}
          </FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              ref={daysRef}
              id={daysId}
              className="max-w-50"
              name="session_archive_after_days"
              type="number"
              inputMode="numeric"
              min={0}
              max={ARCHIVE_DAYS.max}
              step={1}
              value={typed}
              aria-invalid={shownError !== null || undefined}
              aria-describedby={describedBy(days.blocked, daysBlockedId)}
              onChange={(event) => {
                setDaysDraft(event.target.value);
                setShownError(null);
              }}
            />
            {/* The label already says the unit; this is for sighted readers. */}
            <Text as="span" variant="sub" aria-hidden="true">
              {t("limits.archive.daysUnit")}
            </Text>
          </div>
          <FieldDescription>
            {t(
              days.saved || days.blocked
                ? "limits.defaultIs"
                : "limits.defaultApplies",
              { value: daysText(days.default) },
            )}
          </FieldDescription>
          <FieldError>{shownError}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor={modeId}>
            {t("limits.archive.modeLabel")}
          </FieldLabel>
          <NativeSelect
            id={modeId}
            name="session_archive_dry_run"
            value={dryRun ? "count" : "move"}
            aria-describedby={describedBy(mode.blocked, modeBlockedId)}
            onChange={(event) => {
              setModeDraft(event.target.value === "count");
              setShownError(null);
            }}
          >
            <NativeSelectOption value="count">
              {modeText(true)}
            </NativeSelectOption>
            <NativeSelectOption value="move">
              {modeText(false)}
            </NativeSelectOption>
          </NativeSelect>
          <FieldDescription>{t("limits.archive.options")}</FieldDescription>
          <FieldDescription>
            {t(
              mode.saved || mode.blocked
                ? "limits.defaultIs"
                : "limits.defaultApplies",
              { value: modeText(mode.default) },
            )}
          </FieldDescription>
          <FieldDescription>{t("limits.archive.applies")}</FieldDescription>
        </Field>
        <FormActions>
          {differs ? (
            <Button
              type="button"
              variant="ghost"
              aria-disabled={save.isPending || undefined}
              onClick={() => {
                if (!save.isPending) {
                  save.mutate({
                    session_archive_after_days: days.default,
                    session_archive_dry_run: mode.default,
                  });
                }
              }}
            >
              {t("limits.useDefault")}
            </Button>
          ) : null}
          <Button
            type="submit"
            aria-disabled={save.isPending || unchanged || undefined}
          >
            {t("limits.save")}
          </Button>
        </FormActions>
      </form>
    </SettingsSection>
  );
}

function EnforceSection({
  entry,
  onOutcome,
}: {
  readonly entry: InstallationConfig["workspace_enforce"];
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const role = useRole();
  const selectId = useId();
  const blockedId = useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const [draft, setDraft] = useState<Enforce | null>(null);
  const [shownError, setShownError] = useState<string | null>(null);
  const save = useSave<Enforce>({
    onOutcome,
    body: (value) => ({ workspace_enforce: value }),
    saved: t("limits.enforce.saved"),
    onSaved: (sent) =>
      setDraft((chosen) =>
        chosen !== null && chosen !== sent ? chosen : null,
      ),
    onRefused: (error) => {
      setShownError(refusalText(t, error, PERMISSION, role));
      selectRef.current?.focus();
    },
  });
  const chosen = draft ?? entry.value;
  const unchanged = chosen === entry.value && !entry.blocked;
  const label = (value: Enforce) => t(`limits.enforce.${value}`);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending || unchanged) return;
    setShownError(null);
    save.mutate(chosen);
  };

  return (
    <SettingsSection
      title={t("limits.enforce.title")}
      description={t("limits.enforce.hint")}
      box
    >
      <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
        {entry.blocked ? (
          <Blocked
            id={blockedId}
            env={ENFORCE_ENV}
            refused={t("limits.enforce.refused")}
          />
        ) : null}
        <Field>
          <FieldLabel htmlFor={selectId}>
            {t("limits.enforce.label")}
          </FieldLabel>
          <NativeSelect
            ref={selectRef}
            id={selectId}
            name="workspace_enforce"
            value={chosen}
            aria-invalid={shownError !== null || undefined}
            aria-describedby={entry.blocked ? blockedId : undefined}
            onChange={(event) => {
              setDraft(event.target.value as Enforce);
              setShownError(null);
            }}
          >
            {ENFORCE_VALUES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {label(value)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>{t("limits.enforce.options")}</FieldDescription>
          <FieldDescription>
            {t(
              entry.saved || entry.blocked
                ? "limits.defaultIs"
                : "limits.defaultApplies",
              { value: label(entry.default) },
            )}
          </FieldDescription>
          <FieldDescription>{t("limits.enforce.applies")}</FieldDescription>
          <FieldError>{shownError}</FieldError>
        </Field>
        <FormActions>
          {entry.saved && entry.value !== entry.default ? (
            <Button
              type="button"
              variant="ghost"
              aria-disabled={save.isPending || undefined}
              onClick={() => {
                if (!save.isPending) save.mutate(entry.default);
              }}
            >
              {t("limits.useDefault")}
            </Button>
          ) : null}
          <Button
            type="submit"
            aria-disabled={save.isPending || unchanged || undefined}
          >
            {t("limits.save")}
          </Button>
        </FormActions>
      </form>
    </SettingsSection>
  );
}
