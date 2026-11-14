import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  InstallationConfig,
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

// The server's range; the web takes contracts as types only, so a test
// keeps this equal to the contract's value.
export const PENDING_REQUEST_TTL_SEC_MAX = 604_800;

const configKey = (client: ApiClient) =>
  scopedKey(client, "installation-config");

/** Whole seconds in range, else null. */
export function waitSecondsOf(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return seconds >= 1 && seconds <= PENDING_REQUEST_TTL_SEC_MAX
    ? seconds
    : null;
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
        <OutcomeLine outcome={outcome} />
        <PendingWait onOutcome={setOutcome} />
      </div>
    </Page>
  );
}

function PendingWait({
  onOutcome,
}: {
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const read = useQuery({
    queryKey: configKey(client),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation-config"),
      ) as Promise<InstallationConfig>,
    retry: false,
  });
  // Untouched, the field follows the server's value as it refreshes.
  const [draft, setDraft] = useState<string | null>(null);
  const [shownError, setShownError] = useState<string | null>(null);

  const save = useMutation<UpdateInstallationConfigResponse, ApiError, number>({
    mutationFn: (seconds) =>
      unwrap(
        client.PATCH("/v1/installation-config", {
          body: { pending_request_ttl_sec: seconds },
        }),
      ),
    onMutate: () => {
      onOutcome(null);
      setShownError(null);
    },
    onSuccess: (answer, sent) => {
      const { receipt_id: _receipt, ...next } = answer;
      queryClient.setQueryData<InstallationConfig>(configKey(client), next);
      // Keep anything typed while the save was in flight.
      setDraft((typed) =>
        typed !== null && waitSecondsOf(typed) !== sent ? typed : null,
      );
      onOutcome({ kind: "notice", text: t("limits.waitSaved") });
    },
    onError: (error) => {
      setShownError(
        error.code === "BAD_REQUEST"
          ? t("limits.waitInvalid", { max: PENDING_REQUEST_TTL_SEC_MAX })
          : refusalText(t, error, PERMISSION, role),
      );
      inputRef.current?.focus();
    },
  });

  if (read.isPending) {
    return (
      <SettingsSection title={t("limits.waitTitle")} box>
        <Skeleton width="50%" />
      </SettingsSection>
    );
  }
  if (read.isError) {
    return (
      <SettingsSection title={t("limits.waitTitle")} box>
        <LoadFailure error={read.error} onRetry={() => void read.refetch()} />
      </SettingsSection>
    );
  }

  const entry = read.data.pending_request_ttl_sec;
  const typed = draft ?? `${entry.value}`;
  const seconds = waitSecondsOf(typed);
  // A blocked key takes any valid value, the default shown included.
  const unchanged = seconds === entry.value && !entry.blocked;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending || unchanged) return;
    if (seconds === null) {
      setShownError(
        t("limits.waitInvalid", { max: PENDING_REQUEST_TTL_SEC_MAX }),
      );
      inputRef.current?.focus();
      return;
    }
    save.mutate(seconds);
  };

  return (
    <SettingsSection
      title={t("limits.waitTitle")}
      description={t("limits.waitHint")}
      box
    >
      <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
        {entry.blocked ? (
          <Alert variant="amber" role="status">
            <AlertDescription>{t("limits.waitBlocked")}</AlertDescription>
          </Alert>
        ) : null}
        <Field>
          <FieldLabel htmlFor={inputId}>{t("limits.waitLabel")}</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              ref={inputRef}
              id={inputId}
              className="max-w-50"
              name="pending_request_ttl_sec"
              type="number"
              inputMode="numeric"
              min={1}
              max={PENDING_REQUEST_TTL_SEC_MAX}
              step={1}
              value={typed}
              aria-invalid={shownError !== null || undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                setShownError(null);
              }}
            />
            {/* The label already says the unit; this is for sighted readers. */}
            <Text as="span" variant="sub" aria-hidden="true">
              {t("limits.seconds")}
            </Text>
          </div>
          <FieldDescription>
            {t(
              entry.saved || entry.blocked
                ? "limits.defaultIs"
                : "limits.defaultApplies",
              { seconds: entry.default },
            )}
          </FieldDescription>
          <FieldDescription>{t("limits.waitApplies")}</FieldDescription>
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
