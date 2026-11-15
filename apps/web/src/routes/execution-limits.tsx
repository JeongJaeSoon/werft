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
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Page,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { type FormEvent, type Ref, useId, useRef, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useHasPermission, useRole } from "../auth/guard.tsx";
import { FormRow } from "../components/form-row.tsx";
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
/** What is typed or chosen, by key; a key with none shows the saved value. */
type Drafts = Partial<
  Record<NumberKey | "session_archive_after_days", string> & {
    workspace_enforce: Enforce;
    session_archive_dry_run: boolean;
  }
>;
/** One row of the form: a number limit's name, or one of the others. */
type Row = NumberLimit["name"] | "enforce" | "archive";

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

const ROWS: readonly Row[] = [
  ...NUMBER_LIMITS.map((limit) => limit.name),
  "enforce",
  "archive",
];
const ROW_OF = Object.fromEntries([
  ...NUMBER_LIMITS.map((limit) => [limit.key, limit.name]),
  ["workspace_enforce", "enforce"],
  ["session_archive_after_days", "archive"],
  ["session_archive_dry_run", "archive"],
]) as Record<string, Row | undefined>;

/** The rows of these keys, in the form's order. */
const rowsOf = (keys: readonly string[]): Row[] =>
  ROWS.filter((row) => keys.some((key) => ROW_OF[key] === row));

/**
 * What one save sends: each key whose shown value is not the saved one, or
 * that is blocked (it takes any valid value, the default shown included);
 * and the rows whose text cannot be sent.
 */
function pendingOf(
  config: InstallationConfig,
  drafts: Drafts,
): { readonly patch: Patch; readonly invalid: readonly Row[] } {
  const patch: Patch = {};
  const invalid: Row[] = [];
  const differs = (key: InstallationConfigKey, value: unknown) =>
    value !== config[key].value || config[key].blocked;
  for (const limit of NUMBER_LIMITS) {
    const value = limitValueOf(
      limit,
      drafts[limit.key] ?? `${config[limit.key].value}`,
    );
    if (value === null) invalid.push(limit.name);
    else if (differs(limit.key, value)) patch[limit.key] = value;
  }
  const enforce = drafts.workspace_enforce ?? config.workspace_enforce.value;
  if (differs("workspace_enforce", enforce)) patch.workspace_enforce = enforce;
  const days = archiveDaysOf(
    drafts.session_archive_after_days ??
      `${config.session_archive_after_days.value}`,
  );
  if (days === null) invalid.push("archive");
  else if (differs("session_archive_after_days", days)) {
    patch.session_archive_after_days = days;
  }
  const dryRun =
    drafts.session_archive_dry_run ?? config.session_archive_dry_run.value;
  if (differs("session_archive_dry_run", dryRun)) {
    patch.session_archive_dry_run = dryRun;
  }
  return { patch, invalid };
}

/** The keys a refused body names; the server joins each issue's path. */
function refusedKeys(error: ApiError): string[] {
  const issues = (error.details as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map(
    (issue) =>
      `${(issue as { path?: unknown }).path ?? ""}`.split(".")[0] ?? "",
  );
}

/** All the limits in one form, saved with one request. */
function Limits({
  onOutcome,
}: {
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const read = useQuery({
    queryKey: configKey(client),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation-config"),
      ) as Promise<InstallationConfig>,
    retry: false,
  });
  // Untouched, a field follows the server's value as it refreshes.
  const [drafts, setDrafts] = useState<Drafts>({});
  const [errors, setErrors] = useState<Partial<Record<Row, string>>>({});
  const controls = useRef<Partial<Record<Row, HTMLElement | null>>>({});

  const invalidText = (row: Row, error?: ApiError): string => {
    if (row === "archive") {
      return t("limits.archive.daysInvalid", {
        min: ARCHIVE_DAYS.min,
        max: new Intl.NumberFormat(locale).format(ARCHIVE_DAYS.max),
      });
    }
    // A choice from the list is never invalid here; only the server refuses.
    if (row === "enforce") {
      return error ? refusalText(t, error, PERMISSION, role) : "";
    }
    const limit = NUMBER_LIMITS.find((each) => each.name === row);
    return t(`limits.${row}.invalid`, {
      max: new Intl.NumberFormat(locale).format(limit?.max ?? 0),
    });
  };
  const showErrors = (rows: readonly Row[], error?: ApiError) => {
    setErrors(
      Object.fromEntries(rows.map((row) => [row, invalidText(row, error)])),
    );
    const first = rows[0];
    if (first) controls.current[first]?.focus();
  };

  const save = useMutation<UpdateInstallationConfigResponse, ApiError, Patch>({
    mutationFn: (body) =>
      unwrap(client.PATCH("/v1/installation-config", { body })),
    onMutate: () => onOutcome(null),
    onSuccess: (answer, sent) => {
      const { receipt_id: _receipt, ...next } = answer;
      queryClient.setQueryData<InstallationConfig>(configKey(client), next);
      // Keep only what the saved config does not hold yet, such as a value
      // typed while the save was in flight.
      setDrafts((current) => {
        const left = pendingOf(next, current);
        return Object.fromEntries(
          Object.entries(current).filter(
            ([key]) =>
              key in left.patch ||
              left.invalid.some((row) => ROW_OF[key] === row),
          ),
        ) as Drafts;
      });
      const rows = rowsOf(Object.keys(sent));
      const only = rows.length === 1 ? rows[0] : undefined;
      onOutcome({
        kind: "notice",
        text: only
          ? t(`limits.${only}.saved`)
          : t("limits.savedMany", { count: rows.length }),
      });
    },
    // One transaction: a refusal saved nothing, and every draft stays.
    onError: (error, sent) => {
      if (error.code !== "BAD_REQUEST") {
        onOutcome({
          kind: "error",
          text: refusalText(t, error, PERMISSION, role),
        });
        return;
      }
      const named = refusedKeys(error).filter((key) => key in sent);
      showErrors(rowsOf(named.length > 0 ? named : Object.keys(sent)), error);
      onOutcome({ kind: "error", text: t("limits.notSaved") });
    },
  });

  if (read.isPending) return <Skeleton width="50%" />;
  if (read.isError) {
    return (
      <LoadFailure error={read.error} onRetry={() => void read.refetch()} />
    );
  }
  const config = read.data;
  const { patch, invalid } = pendingOf(config, drafts);
  const count = new Set([...rowsOf(Object.keys(patch)), ...invalid]).size;
  const change = (row: Row, next: Drafts) => {
    setDrafts((current) => ({ ...current, ...next }));
    setErrors(({ [row]: _cleared, ...rest }) => rest);
  };
  const controlOf = (row: Row) => (element: HTMLElement | null) => {
    controls.current[row] = element;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || count === 0) return;
    if (invalid.length > 0) {
      showErrors(invalid);
      return;
    }
    setErrors({});
    save.mutate(patch);
  };

  return (
    <SettingsSection
      title={t("limits.section.title")}
      description={t("limits.section.description")}
      onSubmit={submit}
      foot={
        <>
          <Text as="span" variant="meta">
            {count === 0 ? t("limits.clean") : t("limits.pending", { count })}
          </Text>
          <Button
            type="submit"
            size="sm"
            aria-disabled={save.isPending || count === 0 || undefined}
          >
            {t("limits.save")}
          </Button>
        </>
      }
    >
      {/* One block: the form's gap-4 would otherwise add to each row's rule. */}
      <div>
        {NUMBER_LIMITS.map((limit) => (
          <NumberRow
            key={limit.key}
            limit={limit}
            entry={config[limit.key]}
            typed={drafts[limit.key] ?? `${config[limit.key].value}`}
            error={errors[limit.name]}
            controlRef={controlOf(limit.name)}
            onChange={(text) =>
              change(limit.name, { [limit.key]: text } as Drafts)
            }
          />
        ))}
        <EnforceRow
          entry={config.workspace_enforce}
          chosen={drafts.workspace_enforce ?? config.workspace_enforce.value}
          error={errors.enforce}
          controlRef={controlOf("enforce")}
          onChange={(value) => change("enforce", { workspace_enforce: value })}
        />
        <ArchiveRow
          config={config}
          typed={
            drafts.session_archive_after_days ??
            `${config.session_archive_after_days.value}`
          }
          dryRun={
            drafts.session_archive_dry_run ??
            config.session_archive_dry_run.value
          }
          error={errors.archive}
          controlRef={controlOf("archive")}
          onChange={(next) => change("archive", next)}
        />
      </div>
    </SettingsSection>
  );
}

/** The ids, space-separated, or none. */
const describedBy = (...ids: readonly (string | false)[]) =>
  ids.filter((id) => id !== false).join(" ") || undefined;

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

function NumberRow({
  limit,
  entry,
  typed,
  error,
  controlRef,
  onChange,
}: {
  readonly limit: NumberLimit;
  readonly entry: InstallationConfig[NumberKey];
  readonly typed: string;
  readonly error: string | undefined;
  readonly controlRef: Ref<HTMLInputElement>;
  readonly onChange: (text: string) => void;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const { name } = limit;
  const valueText = (value: number) =>
    name === "tokens" && value === 0
      ? t("limits.tokens.none")
      : t(`limits.${name}.value`, {
          value: new Intl.NumberFormat(locale, {
            maximumFractionDigits: 20,
          }).format(value),
        });

  return (
    <FormRow label={t(`limits.${name}.title`)} hint={t(`limits.${name}.hint`)}>
      {entry.blocked ? (
        <Blocked
          id={`${id}-blocked`}
          env={limit.env}
          refused={t(`limits.${name}.refused`)}
        />
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          ref={controlRef}
          className="max-w-50"
          name={limit.key}
          type="number"
          inputMode={limit.whole ? "numeric" : "decimal"}
          min={limit.min}
          max={limit.max}
          step={limit.whole ? 1 : "any"}
          value={typed}
          aria-label={t(`limits.${name}.label`)}
          aria-invalid={error !== undefined || undefined}
          // Heard on reaching the field, not only when the page loads.
          aria-describedby={describedBy(
            entry.blocked && `${id}-blocked`,
            `${id}-notes`,
            error !== undefined && `${id}-error`,
          )}
          onChange={(event) => onChange(event.target.value)}
        />
        {/* The label already says the unit; this is for sighted readers. */}
        <Text as="span" variant="sub" aria-hidden="true">
          {t(`limits.${name}.unit`)}
        </Text>
        {limitValueOf(limit, typed) === entry.default ? null : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(`${entry.default}`)}
          >
            {t("limits.useDefault")}
          </Button>
        )}
      </div>
      <Notes
        id={`${id}-notes`}
        lines={[
          t(`limits.${name}.detail`),
          t(
            entry.saved || entry.blocked
              ? "limits.defaultIs"
              : "limits.defaultApplies",
            { value: valueText(entry.default) },
          ),
          t(`limits.${name}.applies`),
        ]}
      />
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </FormRow>
  );
}

/** A row's small print under its controls, read as one description. */
function Notes({
  id,
  lines,
}: {
  readonly id: string;
  readonly lines: readonly string[];
}) {
  return (
    <div id={id} className="flex min-w-0 flex-col gap-2">
      {lines.map((line) => (
        <Text key={line} variant="meta">
          {line}
        </Text>
      ))}
    </div>
  );
}

/** The archive's days and what it does, in one row. */
function ArchiveRow({
  config,
  typed,
  dryRun,
  error,
  controlRef,
  onChange,
}: {
  readonly config: InstallationConfig;
  readonly typed: string;
  readonly dryRun: boolean;
  readonly error: string | undefined;
  readonly controlRef: Ref<HTMLInputElement>;
  readonly onChange: (next: Drafts) => void;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const days = config.session_archive_after_days;
  const mode = config.session_archive_dry_run;
  const status = config.session_archive;
  const daysText = (value: number) =>
    value === 0
      ? t("limits.archive.off")
      : t("limits.archive.daysValue", {
          value: new Intl.NumberFormat(locale).format(value),
        });
  const modeText = (chosen: boolean) =>
    t(chosen ? "limits.archive.count" : "limits.archive.move");
  const notice = !status.available && `${id}-notice`;
  const isDefault =
    archiveDaysOf(typed) === days.default && dryRun === mode.default;

  return (
    <FormRow label={t("limits.archive.title")} hint={t("limits.archive.hint")}>
      {status.available ? null : (
        <Alert variant="amber" role="status">
          <AlertDescription id={`${id}-notice`}>
            {t(`limits.archive.unavailable.${status.reason ?? "unversioned"}`)}
          </AlertDescription>
        </Alert>
      )}
      {days.blocked ? (
        <Blocked
          id={`${id}-days-blocked`}
          env={ARCHIVE_DAYS.env}
          refused={t("limits.archive.refused")}
        />
      ) : null}
      {mode.blocked ? (
        <Blocked
          id={`${id}-mode-blocked`}
          env={ARCHIVE_DRY_RUN_ENV}
          refused={t("limits.archive.refused")}
        />
      ) : null}
      <FieldLabel htmlFor={`${id}-days`} className="font-normal">
        {t("limits.archive.daysLabel")}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          ref={controlRef}
          id={`${id}-days`}
          className="max-w-50"
          name="session_archive_after_days"
          type="number"
          inputMode="numeric"
          min={0}
          max={ARCHIVE_DAYS.max}
          step={1}
          value={typed}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={describedBy(
            notice,
            days.blocked && `${id}-days-blocked`,
            `${id}-days-notes`,
            error !== undefined && `${id}-error`,
          )}
          onChange={(event) =>
            onChange({ session_archive_after_days: event.target.value })
          }
        />
        {/* The label already says the unit; this is for sighted readers. */}
        <Text as="span" variant="sub" aria-hidden="true">
          {t("limits.archive.daysUnit")}
        </Text>
      </div>
      <Notes
        id={`${id}-days-notes`}
        lines={[
          t(
            days.saved || days.blocked
              ? "limits.defaultIs"
              : "limits.defaultApplies",
            { value: daysText(days.default) },
          ),
        ]}
      />
      <FieldError id={`${id}-error`}>{error}</FieldError>
      <FieldLabel htmlFor={`${id}-mode`} className="font-normal">
        {t("limits.archive.modeLabel")}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <NativeSelect
          id={`${id}-mode`}
          name="session_archive_dry_run"
          value={dryRun ? "count" : "move"}
          aria-describedby={describedBy(
            notice,
            mode.blocked && `${id}-mode-blocked`,
            `${id}-mode-notes`,
          )}
          onChange={(event) =>
            onChange({
              session_archive_dry_run: event.target.value === "count",
            })
          }
        >
          <NativeSelectOption value="count">
            {modeText(true)}
          </NativeSelectOption>
          <NativeSelectOption value="move">
            {modeText(false)}
          </NativeSelectOption>
        </NativeSelect>
        {isDefault ? null : (
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              onChange({
                session_archive_after_days: `${days.default}`,
                session_archive_dry_run: mode.default,
              })
            }
          >
            {t("limits.useDefault")}
          </Button>
        )}
      </div>
      <Notes
        id={`${id}-mode-notes`}
        lines={[
          t("limits.archive.options"),
          t(
            mode.saved || mode.blocked
              ? "limits.defaultIs"
              : "limits.defaultApplies",
            { value: modeText(mode.default) },
          ),
          t("limits.archive.detail"),
          t("limits.archive.applies"),
        ]}
      />
    </FormRow>
  );
}

function EnforceRow({
  entry,
  chosen,
  error,
  controlRef,
  onChange,
}: {
  readonly entry: InstallationConfig["workspace_enforce"];
  readonly chosen: Enforce;
  readonly error: string | undefined;
  readonly controlRef: Ref<HTMLSelectElement>;
  readonly onChange: (value: Enforce) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const label = (value: Enforce) => t(`limits.enforce.${value}`);

  return (
    <FormRow label={t("limits.enforce.title")} hint={t("limits.enforce.hint")}>
      {entry.blocked ? (
        <Blocked
          id={`${id}-blocked`}
          env={ENFORCE_ENV}
          refused={t("limits.enforce.refused")}
        />
      ) : null}
      <div className="flex items-center gap-2">
        <NativeSelect
          ref={controlRef}
          name="workspace_enforce"
          value={chosen}
          aria-label={t("limits.enforce.label")}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={describedBy(
            entry.blocked && `${id}-blocked`,
            `${id}-notes`,
            error !== undefined && `${id}-error`,
          )}
          onChange={(event) => onChange(event.target.value as Enforce)}
        >
          {ENFORCE_VALUES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {label(value)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {chosen === entry.default ? null : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(entry.default)}
          >
            {t("limits.useDefault")}
          </Button>
        )}
      </div>
      <Notes
        id={`${id}-notes`}
        lines={[
          t("limits.enforce.options"),
          t(
            entry.saved || entry.blocked
              ? "limits.defaultIs"
              : "limits.defaultApplies",
            { value: label(entry.default) },
          ),
          t("limits.enforce.applies"),
        ]}
      />
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </FormRow>
  );
}
