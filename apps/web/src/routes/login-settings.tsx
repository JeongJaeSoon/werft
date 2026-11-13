import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  LoginSettingsResponse,
  UpdateLoginSettingsResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  ConfirmDialog,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  SettingRow,
  SettingsSection,
  Skeleton,
} from "@werft-ai/ui";
import { useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useMe, useRole } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { Action } from "../components/setting-action.tsx";
import { type Translate, useI18n } from "../i18n/i18n.tsx";
import { FormDialog } from "./settings-entries.tsx";

const PERMISSION = "installation.settings.manage";

export const loginSettingsKey = (client: ApiClient) =>
  scopedKey(client, "login-settings");

export function loginSettingsQuery(client: ApiClient, enabled = true) {
  return queryOptions({
    queryKey: loginSettingsKey(client),
    queryFn: () =>
      unwrap(
        client.GET("/v1/login-settings"),
      ) as Promise<LoginSettingsResponse>,
    enabled,
    retry: false,
  });
}

/** The words for a refused change: the server's reason first. */
function refusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
): string {
  const reason = (error.details as { reason_code?: unknown } | null)
    ?.reason_code;
  if (error.code === "REVISION_CONFLICT") {
    if (reason === "no_provider")
      return t("loginProviders.access.reason.noProvider");
    // Named when the page was read, or the button would have said so.
    if (reason === "no_emergency_admin")
      return t("loginProviders.access.reason.lapsed");
    if (reason === "locks_out_actor")
      return t("loginProviders.access.error.locksOut");
    if (reason === "not_eligible")
      return t("loginProviders.emergency.error.notEligible");
  }
  return refusalText(t, error, PERMISSION, role);
}

type Editing = "close" | "open" | "admin" | null;
/** One change a request, as the server takes them. */
type Change =
  | { readonly password_login: "on" | "emergency_only" }
  | { readonly emergency_admin_user_id: string };

/**
 * Who may sign in with a password, and the emergency admin who always may.
 * What the server would refuse for a reason the page can see is withheld
 * with that reason; the rest it refuses in the dialog.
 */
export function PasswordLoginSettings() {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const me = useMe();
  const read = useQuery(loginSettingsQuery(client));
  const [editing, setEditing] = useState<Editing>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const change = useMutation<UpdateLoginSettingsResponse, ApiError, Change>({
    mutationFn: (body) => unwrap(client.PATCH("/v1/login-settings", { body })),
    onSuccess: (answer, body) => {
      setEditing(null);
      setOutcome({
        kind: "notice",
        text: !("password_login" in body)
          ? t("loginProviders.emergency.done", {
              name: answer.settings.emergency_admin?.display_name ?? "",
            })
          : body.password_login === "emergency_only"
            ? t("loginProviders.access.done.closed", {
                count: answer.sessions_revoked,
              })
            : t("loginProviders.access.done.opened"),
      });
    },
    onError: (error) => setDialogError(refusal(t, error, role)),
    // A refusal is often news: a provider went off, another owner was named.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: loginSettingsKey(client) }),
  });

  const open = (next: Editing, button?: HTMLElement) => {
    setDialogError(null);
    if (next !== null) setOutcome(null);
    if (button) setOpener(button);
    setEditing(next);
  };

  if (read.isPending) return <Skeleton width="40%" />;
  if (read.isError)
    return (
      <LoadFailure error={read.error} onRetry={() => void read.refetch()} />
    );

  const { settings, emergency_admin_candidates: candidates } = read.data;
  const admin = settings.emergency_admin;
  const closed = settings.password_login === "emergency_only";
  const others = candidates.filter((owner) => owner.user_id !== admin?.user_id);
  const closeReason =
    settings.enabled_providers === 0
      ? t("loginProviders.access.reason.noProvider")
      : admin === null
        ? t("loginProviders.access.reason.noAdmin")
        : admin.eligible
          ? undefined
          : t("loginProviders.access.reason.lapsed");
  const failure = dialogError ? (
    <Alert variant="red" role="alert">
      <AlertDescription>{dialogError}</AlertDescription>
    </Alert>
  ) : null;

  return (
    <div className="flex flex-col gap-[var(--werft-space-block)]">
      <OutcomeLine outcome={outcome} live />
      <SettingsSection
        title={t("loginProviders.access.title")}
        description={t("loginProviders.access.description")}
        rows={
          <>
            <SettingRow
              title={t("loginProviders.access.state")}
              meta={t(`loginProviders.access.state.${settings.password_login}`)}
              actions={
                closed ? (
                  <Action
                    label={t("loginProviders.access.open")}
                    name={t("loginProviders.access.open.name")}
                    busy={change.isPending}
                    onClick={(button) => open("open", button)}
                  />
                ) : (
                  <Action
                    label={t("loginProviders.access.close")}
                    name={t("loginProviders.access.close.name")}
                    reason={closeReason}
                    busy={change.isPending}
                    onClick={(button) => open("close", button)}
                  />
                )
              }
            />
            <SettingRow
              title={t("loginProviders.emergency.title")}
              meta={
                admin ? (
                  <>
                    {admin.display_name} · {admin.email}
                    {admin.eligible ? null : (
                      <>
                        {" "}
                        <Badge variant="amber">
                          {t("loginProviders.emergency.lapsed")}
                        </Badge>
                      </>
                    )}
                  </>
                ) : (
                  t("loginProviders.emergency.none")
                )
              }
              actions={
                <Action
                  label={t("loginProviders.emergency.change")}
                  name={t("loginProviders.emergency.change.name")}
                  reason={
                    others.length === 0
                      ? t("loginProviders.emergency.reason.noCandidate")
                      : undefined
                  }
                  busy={change.isPending}
                  onClick={(button) => open("admin", button)}
                />
              }
            />
          </>
        }
      />
      <ConfirmDialog
        open={editing === "close"}
        onOpenChange={(next) => open(next ? "close" : null)}
        title={t("loginProviders.access.closeTitle")}
        consequence={
          admin?.user_id === me?.user?.id
            ? t("loginProviders.access.closeConsequence.self")
            : t("loginProviders.access.closeConsequence.other", {
                name: admin?.display_name ?? "",
              })
        }
        confirmLabel={t("loginProviders.access.close")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={change.isPending}
        onConfirm={() => change.mutate({ password_login: "emergency_only" })}
      >
        {failure}
      </ConfirmDialog>
      <ConfirmDialog
        open={editing === "open"}
        onOpenChange={(next) => open(next ? "open" : null)}
        title={t("loginProviders.access.openTitle")}
        consequence={t("loginProviders.access.openConsequence")}
        confirmLabel={t("loginProviders.access.open")}
        cancelLabel={t("common.cancel")}
        busy={change.isPending}
        onConfirm={() => change.mutate({ password_login: "on" })}
      >
        {failure}
      </ConfirmDialog>
      <FormDialog
        open={editing === "admin"}
        onOpenChange={(next) => open(next ? "admin" : null)}
        opener={opener}
        pending={change.isPending}
        title={t("loginProviders.emergency.change.name")}
        description={
          closed
            ? `${t("loginProviders.emergency.changeDescription")} ${t("loginProviders.emergency.changeClosed")}`
            : t("loginProviders.emergency.changeDescription")
        }
        error={dialogError}
        submitLabel={t("settings.save")}
        pendingLabel={t("settings.saving")}
        onSubmit={(form) => {
          setDialogError(null);
          change.mutate({
            emergency_admin_user_id: String(form.get("user_id")),
          });
        }}
      >
        <Field>
          <FieldLabel>{t("loginProviders.emergency.field")}</FieldLabel>
          <NativeSelect name="user_id" required>
            {others.map((owner) => (
              <NativeSelectOption key={owner.user_id} value={owner.user_id}>
                {owner.display_name} ({owner.email})
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </FormDialog>
    </div>
  );
}
