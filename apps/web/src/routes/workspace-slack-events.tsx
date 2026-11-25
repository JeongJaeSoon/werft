import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  RetrySlackEventsUpdatesResponse,
  SlackEventsUpdate,
  SlackEventsUpdateFailure,
  SlackSettings,
  UpdateSlackSettingsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FormActions,
  Input,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import type { OnOutcome } from "./workspace-settings.tsx";

const PERMISSION = "installation.settings.manage";
const EVENTS_PATH = "/v1/slack/events/{agent_id}";
// As the server keeps it (SLACK_EVENTS_PUBLIC_URL_MAX).
const MAX_LENGTH = 2048;
// SLACK_EVENTS_RETRY_MAX; contracts are type-only in the web app.
const RETRY_BATCH = 100;

const REASON = {
  config_token_inactive: "workspace.eventsReason.config_token_inactive",
  events_url_unset: "workspace.eventsReason.events_url_unset",
  slack_refused: "workspace.eventsReason.slack_refused",
  no_answer: "workspace.eventsReason.no_answer",
  not_found: "workspace.eventsReason.not_found",
} as const satisfies Record<SlackEventsUpdateFailure, string>;

const settingsKey = (client: ApiClient) => scopedKey(client, "slack-settings");

/**
 * The base the server would keep for what was typed: "" for nothing (the
 * console's address applies), null when the server would refuse it.
 */
export function eventsBaseOf(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed.length > MAX_LENGTH || /[?#]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return null;
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  // Percent-encoding can lengthen what was typed; the limit is on what is kept.
  return base.length > MAX_LENGTH ? null : base;
}

/**
 * Where Slack's events enter, for the whole installation: the owner's, in
 * the Slack card whatever state the token is in. Saving says what Slack will
 * be sent before it is; after it, what each app was sent, with a retry for
 * the apps that were not.
 */
export function SlackEventsSetting({
  onOutcome,
  onSaved,
}: {
  readonly onOutcome: OnOutcome;
  /** The other addresses on the page are computed from this one. */
  readonly onSaved: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const read = useQuery({
    queryKey: settingsKey(client),
    queryFn: () =>
      unwrap(client.GET("/v1/slack-settings")) as Promise<SlackSettings>,
    retry: false,
  });
  const saved = read.data?.events_public_url ?? null;
  const [draft, setDraft] = useState("");
  const [shownError, setShownError] = useState<string | null>(null);
  const [results, setResults] = useState<SlackEventsUpdate[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsId = useId();
  // The field starts from what is saved, and follows it after a save.
  useEffect(() => {
    setDraft(saved ?? "");
  }, [saved]);

  // An app left unsent draws the list where the reader lands.
  const focusResults = useRef(false);
  useEffect(() => {
    if (focusResults.current && results.length > 0) resultsRef.current?.focus();
    focusResults.current = false;
  }, [results]);

  const save = useMutation<
    UpdateSlackSettingsResponse,
    ApiError,
    string | null
  >({
    mutationFn: (value) =>
      unwrap(
        client.PUT("/v1/slack-settings", {
          body: { events_public_url: value },
        }),
      ),
    onMutate: () => {
      onOutcome(null);
      setShownError(null);
      setResults([]);
    },
    onSuccess: (answer) => {
      const { receipt_id: _receipt, updates, ...next } = answer;
      queryClient.setQueryData<SlackSettings>(settingsKey(client), next);
      const sent = updates.filter((one) => one.outcome === "updated").length;
      focusResults.current = sent < updates.length;
      setResults(updates);
      onOutcome({
        kind: "notice",
        text:
          next.events_public_url === null
            ? sent > 0
              ? t("workspace.eventsClearedApps", { count: sent })
              : next.computed_events_base === null
                ? t("workspace.eventsClearedNone")
                : t("workspace.eventsCleared")
            : sent > 0
              ? t("workspace.eventsSavedApps", { count: sent })
              : t("workspace.eventsSaved"),
      });
      onSaved();
    },
    onError: (error) => {
      setShownError(
        (error.details as { reason_code?: unknown } | null)?.reason_code ===
          "events_url_invalid"
          ? t("workspace.eventsInvalid")
          : refusalText(t, error, PERMISSION, role),
      );
      inputRef.current?.focus();
    },
  });

  const retry = useMutation<
    RetrySlackEventsUpdatesResponse,
    ApiError,
    string[]
  >({
    mutationFn: async (ids) => {
      const updates: SlackEventsUpdate[] = [];
      for (let at = 0; at < ids.length; at += RETRY_BATCH) {
        const part = await unwrap(
          client.POST("/v1/slack-settings/retry", {
            body: { slack_app_ids: ids.slice(at, at + RETRY_BATCH) },
          }),
        );
        updates.push(...part.updates);
      }
      return { updates };
    },
    onMutate: () => onOutcome(null),
    onSuccess: ({ updates }) => {
      const again = new Map(updates.map((one) => [one.slack_app_id, one]));
      const left = updates.some((one) => one.outcome === "failed");
      const waiting = updates.some((one) => one.outcome === "sending");
      focusResults.current = left || waiting;
      setResults((shown) =>
        shown.map((one) => again.get(one.slack_app_id) ?? one),
      );
      if (waiting && !left) {
        onOutcome({ kind: "notice", text: t("workspace.eventsRetryWaiting") });
      } else if (!left) {
        onOutcome({ kind: "notice", text: t("workspace.eventsRetried") });
        // The retry button leaves with the last failure.
        inputRef.current?.focus();
      }
    },
    onError: (error) => {
      onOutcome({
        kind: "error",
        text: refusalText(t, error, PERMISSION, role),
      });
    },
  });

  if (read.isPending) {
    return (
      <SettingsSection titleAs="h3" title={t("workspace.eventsTitle")} box>
        <Skeleton width="50%" label={t("status.loading.title")} />
      </SettingsSection>
    );
  }
  if (read.isError) {
    return (
      <SettingsSection titleAs="h3" title={t("workspace.eventsTitle")} box>
        <LoadFailure error={read.error} onRetry={() => void read.refetch()} />
      </SettingsSection>
    );
  }

  const computed = read.data.computed_events_base;
  const base = eventsBaseOf(draft);
  const effective = base === "" ? computed : base;
  const unchanged = base !== null && (base === "" ? null : base) === saved;
  const invalid = base === null;
  const busy = save.isPending || retry.isPending;
  const failed = results.filter((one) => one.outcome === "failed");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || unchanged) return;
    if (invalid) {
      setShownError(t("workspace.eventsInvalid"));
      inputRef.current?.focus();
      return;
    }
    save.mutate(base === "" ? null : base);
  };

  return (
    <SettingsSection
      titleAs="h3"
      title={t("workspace.eventsTitle")}
      description={t("workspace.eventsHint")}
      box
    >
      <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
        <Field>
          <FieldLabel>{t("workspace.eventsLabel")}</FieldLabel>
          <Input
            ref={inputRef}
            className="font-mono"
            name="events_public_url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://events.example.com"
            value={draft}
            aria-invalid={shownError !== null || undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setShownError(null);
            }}
          />
          <FieldDescription>
            {computed === null
              ? t("workspace.eventsComputedNone")
              : t("workspace.eventsComputed", { url: computed })}
          </FieldDescription>
          <FieldError>{shownError}</FieldError>
        </Field>
        <div className="flex min-w-0 flex-col gap-1">
          <Text variant="meta">{t("workspace.eventsPreview")}</Text>
          {invalid ? (
            // After a refused save the field's error says it already.
            shownError === null ? (
              <Text variant="sub">{t("workspace.eventsInvalid")}</Text>
            ) : null
          ) : effective === null ? (
            <Text variant="sub">{t("workspace.eventsPreviewNone")}</Text>
          ) : (
            <Text className="font-mono break-all">{`${effective}${EVENTS_PATH}`}</Text>
          )}
        </div>
        {results.length === 0 ? null : (
          <div
            ref={resultsRef}
            tabIndex={-1}
            className="flex min-w-0 flex-col gap-2 outline-none"
          >
            <Text variant="meta" id={resultsId}>
              {t("workspace.eventsResults")}
            </Text>
            <ul
              aria-labelledby={resultsId}
              className="flex min-w-0 flex-col gap-2"
            >
              {results.map((one) => (
                <li key={one.slack_app_id} className="flex min-w-0 flex-col">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Text className="min-w-0 break-words">
                      {one.name ?? one.slack_app_id}
                    </Text>
                    {one.outcome === "updated" ? (
                      <Badge variant="green">
                        {t("workspace.eventsUpdated")}
                      </Badge>
                    ) : one.outcome === "sending" ? (
                      <Badge>{t("workspace.eventsSending")}</Badge>
                    ) : (
                      <Badge variant="red">{t("workspace.eventsFailed")}</Badge>
                    )}
                  </div>
                  {one.outcome === "failed" ? (
                    <Text variant="sub">{t(REASON[one.reason_code])}</Text>
                  ) : one.outcome === "sending" ? (
                    <Text variant="sub">
                      {t("workspace.eventsSendingHint")}
                    </Text>
                  ) : one.reinstall_required ? (
                    <Text variant="sub">{t("workspace.eventsReinstall")}</Text>
                  ) : null}
                </li>
              ))}
            </ul>
            {failed.length === 0 ? null : (
              <div className="flex min-w-0 flex-col items-start gap-2">
                <Text variant="sub">{t("workspace.eventsFailedHint")}</Text>
                <Button
                  type="button"
                  variant="outline"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) {
                      retry.mutate(failed.map((one) => one.slack_app_id));
                    }
                  }}
                >
                  {t("workspace.eventsRetry")}
                </Button>
              </div>
            )}
          </div>
        )}
        <FormActions>
          {saved === null ? null : (
            <Button
              type="button"
              variant="ghost"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) save.mutate(null);
              }}
            >
              {t("workspace.eventsClear")}
            </Button>
          )}
          <Button type="submit" aria-disabled={busy || unchanged || undefined}>
            {t("workspace.eventsSave")}
          </Button>
        </FormActions>
      </form>
    </SettingsSection>
  );
}
