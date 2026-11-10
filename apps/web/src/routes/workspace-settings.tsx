import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AgentAccessResponse,
  AgentAccessSettings,
  AuditRetentionRequest,
  AuthMeResponse,
  SlackGuestRequest,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  buttonVariants,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Page,
  RadioGroup,
  RadioGroupItem,
  SecretField,
  SettingRow,
  SettingsSection,
  Skeleton,
  Switch,
  Text,
} from "@werft-ai/ui";
import { Lock } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { profilesQuery, queryKeys } from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { WorkspaceEngineSettings } from "./workspace-engine-settings.tsx";

// The server's ceiling; the web takes contracts as types only, so a test
// keeps this equal to the contract's value.
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
      <OutcomeLine outcome={outcome} />
      <Basics />
      <AllowedModels />
      <WorkspaceEngineSettings />
      {editable ? (
        <>
          <AgentAccess onOutcome={setOutcome} />
          <AuditRetention onOutcome={setOutcome} />
        </>
      ) : (
        <>
          <AgentAccessValues />
          <ReadOnlySettings />
        </>
      )}
    </WorkspacePage>
  );
}

// The GitHub settings screens still import it by this name.
export { SettingsSection as SettingsCard };

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
 * The name and id only read: no API renames a workspace yet (94S-817).
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

/**
 * The models this installation's profiles run: the ceiling a session picks
 * under. The operator's catalog sets it, so the console only reads it.
 */
function AllowedModels() {
  const { t } = useI18n();
  const { client } = useWerft();
  const profiles = useQuery(profilesQuery(client));
  const models = [...new Set(profiles.data?.items.map((p) => p.model))];
  return (
    <SettingsSection
      title={t("workspace.models")}
      description={t("workspace.modelsHint")}
      box
      foot={
        <>
          <Text as="div" variant="meta">
            {t("workspace.modelsFoot")}
          </Text>
          <ReadOnlyMark />
        </>
      }
    >
      {profiles.isPending ? (
        <Skeleton width="50%" />
      ) : profiles.isError ? (
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      ) : models.length === 0 ? (
        <Text as="div" variant="meta">
          {t("workspace.modelsEmpty")}
        </Text>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {models.map((model) => (
            <li key={model}>
              <Badge variant="mono">{model}</Badge>
            </li>
          ))}
        </ul>
      )}
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
    </>
  );
}

/**
 * How long refused and allowed decisions are kept. Only an owner changes it;
 * the floor is the server's, so a short value goes there and comes back as
 * the refusal. The mockup's output retention (7/30/90 days) has no API yet
 * (94S-817); this card is the audit retention, a different value.
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
    save.mutate(Number(days));
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

type AgentAccessKey = keyof AgentAccessSettings;

interface AccessChoice<V extends string> {
  readonly value: V;
  readonly label: MessageKey;
  readonly help: MessageKey;
}

// The contract's values in the order the card lists them.
const AGENT_ACCESS: {
  readonly [K in AgentAccessKey]: {
    readonly legend: MessageKey;
    readonly foot: MessageKey;
    readonly choices: readonly AccessChoice<AgentAccessSettings[K]>[];
  };
} = {
  agent_outsider_access: {
    legend: "workspace.accessAgent",
    foot: "workspace.accessAgentFoot",
    choices: [
      {
        value: "use",
        label: "workspace.accessAgent.use",
        help: "workspace.accessAgent.use.help",
      },
      {
        value: "view",
        label: "workspace.accessAgent.view",
        help: "workspace.accessAgent.view.help",
      },
      {
        value: "none",
        label: "workspace.accessAgent.none",
        help: "workspace.accessAgent.none.help",
      },
    ],
  },
  agent_outsider_session_visibility: {
    legend: "workspace.accessSessions",
    foot: "workspace.accessSessionsFoot",
    choices: [
      {
        value: "managing_team",
        label: "workspace.accessSessions.managing_team",
        help: "workspace.accessSessions.managing_team.help",
      },
      {
        value: "workspace",
        label: "workspace.accessSessions.workspace",
        help: "workspace.accessSessions.workspace.help",
      },
    ],
  },
};

const AGENT_ACCESS_KEYS = Object.keys(AGENT_ACCESS) as AgentAccessKey[];

// Web takes the contracts as types only, so a test keeps these equal to theirs.
export const AGENT_ACCESS_CHOICES = Object.fromEntries(
  AGENT_ACCESS_KEYS.map((key) => [
    key,
    AGENT_ACCESS[key].choices.map((choice) => choice.value),
  ]),
);

/** What `picked` holds that `from` does not. */
function differing(
  picked: Partial<AgentAccessSettings>,
  from: Partial<AgentAccessSettings>,
): Partial<AgentAccessSettings> {
  const out: Partial<AgentAccessSettings> = {};
  if (
    picked.agent_outsider_access !== undefined &&
    picked.agent_outsider_access !== from.agent_outsider_access
  )
    out.agent_outsider_access = picked.agent_outsider_access;
  if (
    picked.agent_outsider_session_visibility !== undefined &&
    picked.agent_outsider_session_visibility !==
      from.agent_outsider_session_visibility
  )
    out.agent_outsider_session_visibility =
      picked.agent_outsider_session_visibility;
  return out;
}

function agentAccessOf(me: ReturnType<typeof useMe>): AgentAccessSettings {
  const settings = me?.workspace?.settings;
  return {
    agent_outsider_access: settings?.agent_outsider_access ?? "use",
    agent_outsider_session_visibility:
      settings?.agent_outsider_session_visibility ?? "managing_team",
  };
}

/**
 * What members outside an agent's managing team may do with it, and whether
 * its workspace-shared sessions reach them (agent-rbac (c)). Both radios save
 * together with 저장: an arrow key moves the choice, and a save per step
 * would leave a receipt for every value passed on the way.
 */
function AgentAccess({ onOutcome }: { readonly onOutcome: OnOutcome }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const me = useMe();
  const role = useRole();
  const workspaceId = me?.workspace?.id ?? "";
  const current = agentAccessOf(me);
  // Untouched, each choice follows the server's value as it refreshes.
  const [draft, setDraft] = useState<Partial<AgentAccessSettings>>({});
  const changed = differing(draft, current);
  const reason = useHasPermission("workspace.manage")
    ? undefined
    : permissionReason(t, "workspace.manage", role);

  const save = useMutation<
    AgentAccessResponse,
    ApiError,
    Partial<AgentAccessSettings>
  >({
    mutationFn: (body) =>
      unwrap(
        client.PATCH("/v1/workspaces/{id}/agent-access", {
          params: { path: { id: workspaceId } },
          body,
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (saved, sent) => {
      onOutcome({ kind: "notice", text: t("workspace.accessSaved") });
      // The saved values show even when the /me refetch below fails.
      queryClient.setQueryData<AuthMeResponse>(queryKeys.me, (old) =>
        old?.workspace
          ? {
              ...old,
              workspace: {
                ...old.workspace,
                settings: {
                  ...old.workspace.settings,
                  agent_outsider_access: saved.agent_outsider_access,
                  agent_outsider_session_visibility:
                    saved.agent_outsider_session_visibility,
                },
              },
            }
          : old,
      );
      // Keep a choice made while the save was in flight.
      setDraft((picked) => differing(picked, sent));
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "workspace.manage", role),
      }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending || Object.keys(changed).length === 0) return;
    save.mutate(changed);
  };

  return (
    <SettingsSection
      title={t("workspace.access")}
      description={t("workspace.accessHint")}
      box
      onSubmit={submit}
      foot={
        <ReasonButton
          type="submit"
          className={buttonVariants({ size: "sm" })}
          reason={reason}
          aria-disabled={save.isPending || undefined}
          disabled={Object.keys(changed).length === 0}
        >
          {t("workspace.save")}
        </ReasonButton>
      }
    >
      {AGENT_ACCESS_KEYS.map((key) => (
        <AgentAccessChoice
          key={key}
          setting={key}
          value={draft[key] ?? current[key]}
          disabled={reason !== undefined || me?.workspace === undefined}
          onChange={(value) =>
            setDraft((picked) => ({ ...picked, [key]: value }))
          }
        />
      ))}
    </SettingsSection>
  );
}

function AgentAccessChoice({
  setting,
  value,
  disabled,
  onChange,
}: {
  readonly setting: AgentAccessKey;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const legendId = useId();
  const footId = useId();
  const text = AGENT_ACCESS[setting];
  return (
    <FieldSet>
      <FieldLegend id={legendId} variant="label">
        {t(text.legend)}
      </FieldLegend>
      <RadioGroup
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        aria-labelledby={legendId}
        aria-describedby={footId}
      >
        {text.choices.map((choice) => (
          <Field
            key={choice.value}
            orientation="horizontal"
            className="items-start"
          >
            <RadioGroupItem value={choice.value} />
            <FieldContent className="gap-1">
              <FieldLabel>{t(choice.label)}</FieldLabel>
              <FieldDescription>{t(choice.help)}</FieldDescription>
            </FieldContent>
          </Field>
        ))}
      </RadioGroup>
      <FieldDescription id={footId}>{t(text.foot)}</FieldDescription>
    </FieldSet>
  );
}

/** The agent access settings as they stand, for someone who may not change them. */
function AgentAccessValues() {
  const { t } = useI18n();
  const current = agentAccessOf(useMe());
  return (
    <SettingsSection
      title={t("workspace.access")}
      description={t("workspace.accessHint")}
      box
    >
      {AGENT_ACCESS_KEYS.map((key) => {
        const { legend, choices } = AGENT_ACCESS[key];
        const chosen = choices.find((choice) => choice.value === current[key]);
        return (
          <div key={key}>
            {t("workspace.accessValue", {
              setting: t(legend),
              value: chosen ? t(chosen.label) : current[key],
            })}
          </div>
        );
      })}
    </SettingsSection>
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
