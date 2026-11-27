import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AuditRetentionRequest,
  SlackGuestRequest,
  WebFetchPreflightResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  buttonVariants,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Page,
  SecretField,
  SettingRow,
  SettingsSection,
  Switch,
  Text,
} from "@werft-ai/ui";
import { Lock } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { queryKeys } from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import { DiskQuotaNotice } from "../components/installation-notices.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { useI18n } from "../i18n/i18n.tsx";

// The server's bounds; the web takes contracts as types only, so a test
// keeps these equal to the contract's values.
export const AUDIT_RETENTION_MIN_DAYS = 30;
export const AUDIT_RETENTION_MAX_DAYS = 3650;

// GitHub-style settings (V4-SETTINGS-LAYOUT A): one column of sections, each
// a title over a rule, labels above their fields and help under them.
export const SECTIONS = "flex flex-col gap-[var(--werft-space-section)]";
const ICON = "size-3.5 shrink-0";
export const SETTINGS_CARD = "flex flex-col gap-4";

export type OnOutcome = (outcome: Outcome | null) => void;

export function WorkspacePage({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const workspaceManage = useHasPermission("workspace.manage");
  const retentionManage = useHasPermission("audit_retention.manage");
  const editable = workspaceManage || retentionManage;
  return (
    <Page
      title={t("workspace.general")}
      description={t(editable ? "workspace.description" : "workspace.readOnly")}
    >
      <div className={SECTIONS}>{children}</div>
    </Page>
  );
}

/** Workspace-wide settings an owner or admin opens from the menu. */
export function WorkspaceSettingsScreen() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const workspaceManage = useHasPermission("workspace.manage");
  const retentionManage = useHasPermission("audit_retention.manage");
  const editable = workspaceManage || retentionManage;
  return (
    <WorkspacePage>
      <DiskQuotaNotice />
      <OutcomeLine outcome={outcome} />
      <Basics />
      {editable ? (
        <>
          <AuditRetention onOutcome={setOutcome} />
          <WebFetchPreflight onOutcome={setOutcome} />
        </>
      ) : (
        <ReadOnlySettings />
      )}
    </WorkspacePage>
  );
}

export function ReadOnlyMark() {
  const { t } = useI18n();
  return (
    <Text
      as="div"
      variant="meta"
      className="inline-flex shrink-0 items-center gap-1"
    >
      <Lock aria-hidden="true" className={ICON} strokeWidth={1.5} />
      {t("workspace.readOnlyMark")}
    </Text>
  );
}

/**
 * The name and id only read: no API renames a workspace yet.
 * Labels sit above the values and help under them.
 */
function Basics() {
  const { t } = useI18n();
  const workspace = useMe()?.workspace;
  const inputId = useId();
  return (
    <SettingsSection title={t("workspace.basics")} box foot={<ReadOnlyMark />}>
      <Field>
        <FieldLabel htmlFor={inputId}>{t("workspace.name")}</FieldLabel>
        <Input
          id={inputId}
          className="max-w-80"
          value={workspace?.name ?? ""}
          readOnly
        />
        <FieldDescription>
          {t("workspace.nameHint")} {t("workspace.nameFoot")}
        </FieldDescription>
      </Field>
      <Field>
        <p className="m-0 font-medium text-sm leading-snug">
          {t("workspace.id")}
        </p>
        <SecretField
          className="max-w-105"
          value={workspace?.id ?? ""}
          copyLabel={t("apiKeys.copy")}
          copiedMessage={t("workspace.idCopied")}
          copyFailedMessage={t("apiKeys.copyIdFailed")}
        />
        <FieldDescription>{t("workspace.idHint")}</FieldDescription>
      </Field>
    </SettingsSection>
  );
}

/** The settings as they stand, for someone who may change none of them. */
function ReadOnlySettings() {
  const { t } = useI18n();
  const settings = useMe()?.workspace?.settings;
  return (
    <>
      <SettingsSection
        title={t("workspace.retention")}
        description={t("workspace.retentionHint")}
        box
      >
        <div>
          {settings
            ? t("workspace.retentionValue", {
                days: settings.audit_retention_days,
              })
            : "—"}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("workspace.guest")}
        description={t("workspace.guestHint")}
        box
      >
        <div>
          {t(
            settings?.slack_guest_enabled
              ? "workspace.guestValueOn"
              : "workspace.guestValueOff",
          )}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("workspace.webFetch")}
        description={t("workspace.webFetchHint")}
        box
      >
        <div>
          {t(
            (settings?.web_fetch_preflight ?? true)
              ? "workspace.webFetchValueOn"
              : "workspace.webFetchValueOff",
          )}
        </div>
      </SettingsSection>
    </>
  );
}

/**
 * How long refused and allowed decisions are kept. Only an owner changes it;
 * a value outside the server's bounds is refused here, before the request.
 * The mockup's output retention (7/30/90 days) has no API yet;
 * this card is the audit retention, a different value.
 */
function AuditRetention({ onOutcome }: { readonly onOutcome: OnOutcome }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const me = useMe();
  const role = useRole();
  const workspaceId = me?.workspace?.id ?? "";
  const current = me?.workspace?.settings.audit_retention_days;
  // Untouched, the field follows the server's value as it refreshes.
  const [draft, setDraft] = useState<string | null>(null);
  const days = draft ?? (current === undefined ? "" : `${current}`);
  const inputId = useId();
  const reason = useHasPermission("audit_retention.manage")
    ? undefined
    : permissionReason(t, "audit_retention.manage", role);

  const save = useMutation<AuditRetentionRequest, ApiError, number>({
    mutationFn: (value) =>
      unwrap(
        client.POST("/v1/workspaces/{id}/audit-retention", {
          params: { path: { id: workspaceId } },
          body: { audit_retention_days: value },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async ({ audit_retention_days }, sent) => {
      onOutcome({
        kind: "notice",
        text: t("workspace.retentionSaved", { days: audit_retention_days }),
      });
      // Keep anything typed while the save was in flight.
      setDraft((typed) =>
        typed !== null && Number(typed) !== sent ? typed : null,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error, sent) =>
      onOutcome({
        kind: "error",
        text:
          error.code !== "BAD_REQUEST"
            ? refusalText(t, error, "audit_retention.manage", role)
            : sent > AUDIT_RETENTION_MAX_DAYS
              ? t("workspace.retentionCeiling", {
                  max: AUDIT_RETENTION_MAX_DAYS,
                })
              : t("workspace.retentionFloor"),
      }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    const value = Number(days);
    const refusal = !Number.isInteger(value)
      ? t("workspace.retentionWhole")
      : value < AUDIT_RETENTION_MIN_DAYS
        ? t("workspace.retentionFloor")
        : value > AUDIT_RETENTION_MAX_DAYS
          ? t("workspace.retentionCeiling", { max: AUDIT_RETENTION_MAX_DAYS })
          : null;
    if (refusal !== null) {
      onOutcome({ kind: "error", text: refusal });
      return;
    }
    save.mutate(value);
  };

  return (
    <SettingsSection
      title={t("workspace.retention")}
      box
      onSubmit={submit}
      foot={
        <ReasonButton
          type="submit"
          className={buttonVariants({ size: "sm" })}
          reason={reason}
          // aria-disabled, not disabled: a disabled button drops its focus.
          aria-disabled={save.isPending || undefined}
          disabled={days.trim() === ""}
        >
          {t("workspace.save")}
        </ReasonButton>
      }
    >
      <Field>
        <FieldLabel htmlFor={inputId}>
          {t("workspace.retentionDays")}
        </FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            className="max-w-50"
            type="number"
            inputMode="numeric"
            step={1}
            min={AUDIT_RETENTION_MIN_DAYS}
            max={AUDIT_RETENTION_MAX_DAYS}
            value={days}
            disabled={reason !== undefined}
            onChange={(event) => setDraft(event.target.value)}
          />
          {/* The label already says the unit; this is for sighted readers. */}
          <Text as="span" variant="sub" aria-hidden="true">
            {t("workspace.retentionUnit")}
          </Text>
        </div>
        <FieldDescription>{t("workspace.retentionHint")}</FieldDescription>
        <FieldDescription>{t("workspace.retentionFoot")}</FieldDescription>
      </Field>
    </SettingsSection>
  );
}

/**
 * Whether the engine checks a WebFetch host with Anthropic first. On by
 * default; owners and admins flip it, and the switch sends the opposite of
 * what the server last said, as the Slack guest switch does.
 */
function WebFetchPreflight({ onOutcome }: { readonly onOutcome: OnOutcome }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const me = useMe();
  const role = useRole();
  const workspaceId = me?.workspace?.id ?? "";
  const enabled = me?.workspace?.settings.web_fetch_preflight ?? true;
  const hintId = useId();
  const reasonId = useId();
  const reason = useHasPermission("workspace.manage")
    ? undefined
    : permissionReason(t, "workspace.manage", role);

  const save = useMutation<WebFetchPreflightResponse, ApiError, boolean>({
    mutationFn: (value) =>
      unwrap(
        client.POST("/v1/workspaces/{id}/web-fetch-preflight", {
          params: { path: { id: workspaceId } },
          body: { web_fetch_preflight: value },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async ({ web_fetch_preflight }) => {
      onOutcome({
        kind: "notice",
        text: t(
          web_fetch_preflight
            ? "workspace.webFetchSavedOn"
            : "workspace.webFetchSavedOff",
        ),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "workspace.manage", role),
      }),
  });

  return (
    <SettingsSection
      title={t("workspace.webFetch")}
      description={t("workspace.webFetchHint")}
      descriptionId={hintId}
      rows={
        <SettingRow
          title={t("workspace.webFetchLabel")}
          meta={
            reason === undefined ? null : (
              <Text as="div" variant="meta" id={reasonId}>
                {reason}
              </Text>
            )
          }
          status={
            <Text
              as="div"
              variant="meta"
              aria-hidden="true"
              className="min-w-6 text-right"
            >
              {t(enabled ? "workspace.guestOn" : "workspace.guestOff")}
            </Text>
          }
          control={
            <Switch
              checked={enabled}
              aria-describedby={reason === undefined ? hintId : reasonId}
              aria-disabled={save.isPending || undefined}
              disabled={reason !== undefined || me?.workspace === undefined}
              onCheckedChange={(next) => save.mutate(next)}
            />
          }
        />
      }
    />
  );
}

/**
 * Whether Slack guests may call agents. Owners and admins flip it; the switch
 * sends the opposite of what the server last said, so a stale screen cannot
 * undo a change it never saw.
 */
export function SlackGuest({ onOutcome }: { readonly onOutcome: OnOutcome }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const me = useMe();
  const role = useRole();
  const workspaceId = me?.workspace?.id ?? "";
  const enabled = me?.workspace?.settings.slack_guest_enabled ?? false;
  const hintId = useId();
  const reasonId = useId();
  const reason = useHasPermission("workspace.manage")
    ? undefined
    : permissionReason(t, "workspace.manage", role);

  const save = useMutation<SlackGuestRequest, ApiError, boolean>({
    mutationFn: (value) =>
      unwrap(
        client.POST("/v1/workspaces/{id}/slack-guest", {
          params: { path: { id: workspaceId } },
          body: { slack_guest_enabled: value },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async ({ slack_guest_enabled }) => {
      onOutcome({
        kind: "notice",
        text: t(
          slack_guest_enabled
            ? "workspace.guestSavedOn"
            : "workspace.guestSavedOff",
        ),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "workspace.manage", role),
      }),
  });

  return (
    <SettingsSection
      title={t("workspace.guest")}
      description={t("workspace.guestHint")}
      descriptionId={hintId}
      rows={
        <SettingRow
          title={t("workspace.guestLabel")}
          meta={
            reason === undefined ? null : (
              <Text as="div" variant="meta" id={reasonId}>
                {reason}
              </Text>
            )
          }
          status={
            // aria-checked already says it; the words are for sighted users.
            // min-w-6: wide enough for the longer of On/Off, so the label
            // does not reflow on a flip.
            <Text
              as="div"
              variant="meta"
              aria-hidden="true"
              className="min-w-6 text-right"
            >
              {t(enabled ? "workspace.guestOn" : "workspace.guestOff")}
            </Text>
          }
          control={
            <Switch
              checked={enabled}
              aria-describedby={reason === undefined ? hintId : reasonId}
              aria-disabled={save.isPending || undefined}
              disabled={reason !== undefined || me?.workspace === undefined}
              onCheckedChange={(next) => save.mutate(next)}
            />
          }
        />
      }
    />
  );
}
