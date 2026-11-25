import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  GitHubWebhookSettings,
  GitHubWebhookUpdate,
  GitHubWebhookUpdateFailure,
  RetryGitHubWebhookUpdatesResponse,
  UpdateGitHubWebhookSettingsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
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
import { eventsBaseOf } from "./workspace-slack-events.tsx";

const PERMISSION = "installation.settings.manage";
const WEBHOOK_PATH = "/v1/github/webhook";
// GITHUB_WEBHOOK_RETRY_MAX; contracts are type-only in the web app.
const RETRY_BATCH = 100;

const settingsKey = (client: ApiClient) =>
  scopedKey(client, "github-webhook-settings");

const REASON = {
  github_rejected: "github.webhook.reason.githubRejected",
  url_refused: "github.webhook.reason.urlRefused",
  github_unreachable: "github.webhook.reason.githubUnreachable",
  key_unreadable: "github.webhook.reason.keyUnreadable",
  not_found: "github.webhook.reason.notFound",
} as const satisfies Record<GitHubWebhookUpdateFailure, string>;

type Failed = Extract<GitHubWebhookUpdate, { outcome: "failed" }>;

/**
 * Where GitHub's App webhooks enter, for the whole installation: the
 * owner's, in the GitHub card. Saving says first which Apps GitHub is asked
 * to change, other workspaces' included; an App GitHub did not change stays
 * listed with its reason and a retry.
 */
export function GitHubWebhookSetting({
  onOutcome,
}: {
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const read = useQuery({
    queryKey: settingsKey(client),
    queryFn: () =>
      unwrap(
        client.GET("/v1/github-webhook-settings"),
      ) as Promise<GitHubWebhookSettings>,
    retry: false,
  });
  const saved = read.data?.webhook_public_url ?? null;
  const [draft, setDraft] = useState("");
  const [shownError, setShownError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failed[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const failedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setDraft(saved ?? "");
  }, [saved]);

  // The list replaces the button that was pressed; the reader lands on it
  // once it is drawn.
  const focusFailed = useRef(false);
  useEffect(() => {
    if (focusFailed.current && failed.length > 0) failedRef.current?.focus();
    focusFailed.current = false;
  }, [failed]);

  const settle = (updates: GitHubWebhookUpdate[]) => {
    const left = updates.filter(
      (update): update is Failed => update.outcome === "failed",
    );
    focusFailed.current = left.length > 0;
    setFailed(left);
    return left;
  };

  const save = useMutation<
    UpdateGitHubWebhookSettingsResponse,
    ApiError,
    string | null
  >({
    mutationFn: (value) =>
      unwrap(
        client.PUT("/v1/github-webhook-settings", {
          body: { webhook_public_url: value },
        }),
      ),
    onMutate: () => {
      onOutcome(null);
      setShownError(null);
      setFailed([]);
    },
    onSuccess: (answer) => {
      const { receipt_id: _receipt, updates, ...next } = answer;
      queryClient.setQueryData<GitHubWebhookSettings>(
        settingsKey(client),
        next,
      );
      const left = settle(updates);
      const changed = updates.length - left.length;
      onOutcome({
        kind: "notice",
        text:
          next.webhook_public_url === null
            ? t("github.webhook.cleared")
            : changed > 0
              ? t("github.webhook.savedApps", { count: changed })
              : t("github.webhook.saved"),
      });
    },
    onError: (error) => {
      setShownError(
        (error.details as { reason_code?: unknown } | null)?.reason_code ===
          "webhook_url_invalid"
          ? t("github.webhook.invalid")
          : refusalText(t, error, PERMISSION, role),
      );
      inputRef.current?.focus();
    },
  });

  const retry = useMutation<
    RetryGitHubWebhookUpdatesResponse,
    ApiError,
    number[]
  >({
    mutationFn: async (appIds) => {
      const updates: GitHubWebhookUpdate[] = [];
      for (let at = 0; at < appIds.length; at += RETRY_BATCH) {
        const part = await unwrap(
          client.POST("/v1/github-webhook-settings/retry", {
            body: { app_ids: appIds.slice(at, at + RETRY_BATCH) },
          }),
        );
        updates.push(...part.updates);
      }
      return { updates };
    },
    onMutate: () => onOutcome(null),
    onSuccess: ({ updates }) => {
      if (settle(updates).length === 0) {
        onOutcome({ kind: "notice", text: t("github.webhook.retried") });
        // The retry button leaves with the list.
        inputRef.current?.focus();
      }
    },
    onError: (error) => {
      onOutcome({
        kind: "error",
        text:
          (error.details as { reason_code?: unknown } | null)?.reason_code ===
          "webhook_url_unset"
            ? t("github.webhook.unset")
            : refusalText(t, error, PERMISSION, role),
      });
    },
  });

  if (read.isPending) {
    return (
      <SettingsSection titleAs="h3" title={t("github.webhook.title")} box>
        <Skeleton width="50%" label={t("status.loading.title")} />
      </SettingsSection>
    );
  }
  if (read.isError) {
    return (
      <SettingsSection titleAs="h3" title={t("github.webhook.title")} box>
        <LoadFailure error={read.error} onRetry={() => void read.refetch()} />
      </SettingsSection>
    );
  }

  const { apps } = read.data;
  const base = eventsBaseOf(draft);
  const unchanged = base !== null && (base === "" ? null : base) === saved;
  const invalid = base === null;
  // A save that would ask GitHub to change the Apps.
  const sends = !invalid && !unchanged && base !== "";
  const shared = apps.filter((app) => app.other_workspaces > 0);
  const busy = save.isPending || retry.isPending;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || unchanged) return;
    if (invalid) {
      setShownError(t("github.webhook.invalid"));
      inputRef.current?.focus();
      return;
    }
    save.mutate(base === "" ? null : base);
  };

  return (
    <SettingsSection
      titleAs="h3"
      title={t("github.webhook.title")}
      description={t("github.webhook.hint")}
      box
    >
      <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
        <Field>
          <FieldLabel>{t("github.webhook.label")}</FieldLabel>
          <Input
            ref={inputRef}
            className="font-mono"
            name="webhook_public_url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://hooks.example.com"
            value={draft}
            aria-invalid={shownError !== null || undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setShownError(null);
            }}
          />
          <FieldError>{shownError}</FieldError>
        </Field>
        <div className="flex min-w-0 flex-col gap-1">
          <Text variant="meta">{t("github.webhook.preview")}</Text>
          {invalid ? (
            shownError === null ? (
              <Text variant="sub">{t("github.webhook.invalid")}</Text>
            ) : null
          ) : base === "" ? (
            <Text variant="sub">{t("github.webhook.previewNone")}</Text>
          ) : (
            <Text className="font-mono break-all">{`${base}${WEBHOOK_PATH}`}</Text>
          )}
        </div>
        {sends ? (
          <div className="flex min-w-0 flex-col gap-1">
            <FieldDescription>
              {apps.length === 0
                ? t("github.webhook.appsNone")
                : t("github.webhook.apps", { count: apps.length })}
            </FieldDescription>
            {apps.length === 0 ? null : (
              <ul className="flex list-disc flex-col gap-0.5 ps-5">
                {apps.map((app) => (
                  <li key={app.app_id}>
                    <Text variant="sub">
                      {app.other_workspaces > 0
                        ? t("github.webhook.appShared", {
                            name: app.name,
                            count: app.other_workspaces,
                          })
                        : app.name}
                    </Text>
                  </li>
                ))}
              </ul>
            )}
            {shared.length === 0 ? null : (
              <Alert variant="amber" role="note">
                <AlertDescription>
                  {t("github.webhook.otherWorkspaces")}
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : null}
        {failed.length === 0 ? null : (
          <div ref={failedRef} tabIndex={-1} className="outline-none">
            <Alert variant="red" role="alert">
              <AlertTitle>{t("github.webhook.failedTitle")}</AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-2">
                  <Text variant="sub">{t("github.webhook.failedHint")}</Text>
                  <ul className="flex list-disc flex-col gap-0.5 ps-5">
                    {failed.map((one) => (
                      <li key={one.app_id}>
                        {t("github.webhook.failedLine", {
                          name: one.name ?? String(one.app_id),
                          reason: t(REASON[one.reason_code]),
                        })}
                      </li>
                    ))}
                  </ul>
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      aria-disabled={busy || undefined}
                      onClick={() => {
                        if (!busy) {
                          retry.mutate(failed.map((one) => one.app_id));
                        }
                      }}
                    >
                      {t("github.webhook.retry")}
                    </Button>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
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
              {t("github.webhook.clear")}
            </Button>
          )}
          <Button type="submit" aria-disabled={busy || unchanged || undefined}>
            {t("github.webhook.save")}
          </Button>
        </FormActions>
      </form>
    </SettingsSection>
  );
}
