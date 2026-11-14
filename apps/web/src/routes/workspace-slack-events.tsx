import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  SlackSettings,
  UpdateSlackSettingsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
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
import { type FormEvent, useEffect, useRef, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import type { OnOutcome } from "./workspace-settings.tsx";

const PERMISSION = "installation.settings.manage";
const EVENTS_PATH = "/v1/slack/events/{agent_id}";
// As the server keeps it (SLACK_EVENTS_PUBLIC_URL_MAX).
const MAX_LENGTH = 2048;

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
 * be sent before it is.
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
  const inputRef = useRef<HTMLInputElement>(null);
  // The field starts from what is saved, and follows it after a save.
  useEffect(() => {
    setDraft(saved ?? "");
  }, [saved]);

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
    },
    onSuccess: (answer) => {
      const { receipt_id: _receipt, ...next } = answer;
      queryClient.setQueryData<SlackSettings>(settingsKey(client), next);
      onOutcome({
        kind: "notice",
        text: t(
          next.events_public_url === null
            ? "workspace.eventsCleared"
            : "workspace.eventsSaved",
        ),
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

  if (read.isPending) {
    return (
      <SettingsSection titleAs="h3" title={t("workspace.eventsTitle")} box>
        <Skeleton width="50%" />
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

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending || unchanged) return;
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
        <FormActions>
          {saved === null ? null : (
            <Button
              type="button"
              variant="ghost"
              aria-disabled={save.isPending || undefined}
              onClick={() => {
                if (!save.isPending) save.mutate(null);
              }}
            >
              {t("workspace.eventsClear")}
            </Button>
          )}
          <Button
            type="submit"
            aria-disabled={save.isPending || unchanged || undefined}
          >
            {t("workspace.eventsSave")}
          </Button>
        </FormActions>
      </form>
    </SettingsSection>
  );
}
