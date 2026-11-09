import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  ListWorkspaceSlackAppsResponse,
  SlackConfigTokenSummary,
  SlackSecretSummary,
  Workspace,
  WorkspaceSettings as WorkspaceSettingsValues,
} from "@werft-ai/contracts";
import {
  Alert,
  Badge,
  Button,
  buttonVariants,
  Code,
  ConfirmDialog,
  CopyButton,
  cn,
  ErrorState,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FormActions,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Heading,
  IconTile,
  Input,
  Link,
  LinkTab,
  LinkTabs,
  linkVariants,
  Page,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  RelativeTime,
  RowLines,
  RowList,
  RowListItem,
  SecretField,
  SettingRow,
  SettingsSection,
  Skeleton,
  Steps,
  Switch,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import { Ellipsis, Hash, Lock } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { MOBILE, type Role, ScreenShell, VIEWER } from "./screen-kit.tsx";

/*
 * apps/web routes/workspace-settings.tsx (설정 › 일반) and
 * routes/workspace-slack.tsx with workspace-slack-apps.tsx (설정 › 연동 ›
 * Slack). Owners hold workspace.manage and audit_retention.manage, admins only
 * workspace.manage, members neither (packages/platform musterrolle/policy.ts).
 */

type Models = "ready" | "loading" | "empty" | "error";
type TokenRead = SlackConfigTokenSummary["state"] | "loading" | "storeOff";
type MadeApp = ListWorkspaceSlackAppsResponse["items"][number];
type Outcome = { readonly kind: "notice" | "error"; readonly text: string };

const WORKSPACE: Pick<Workspace, "id" | "name"> = {
  id: "6d4c1f5e-4c39-4d7a-9a51-0f4f3c7a2b10",
  name: "Acme",
};
const SETTINGS: Pick<
  WorkspaceSettingsValues,
  "audit_retention_days" | "slack_guest_enabled"
> = { audit_retention_days: 90, slack_guest_enabled: false };
// The distinct `model` of GET /v1/profiles items.
const MODELS = ["claude-haiku-5", "claude-sonnet-5"];

// The signed-in owner registered the token.
const OWNER = { user_id: VIEWER.id, display_name: VIEWER.name };
const ISSUER = { user_id: "U07QF3K2M1A", team_id: "T07QF3J8Z4B" };
const CHECKED_AT = "2026-10-23T04:58:00Z";

const ADDRESSES = {
  redirect_url: "https://werft.example/settings/linked-accounts/slack",
  events_url_template: "https://werft.example/v1/slack/events/{agent_id}",
};

type Addresses = "ready" | "noConsole" | "noHttps";

// A console with no public origin has neither address; an http one has only
// the redirect, since Slack calls https events addresses only.
const ADDRESS_STATES: Record<Addresses, SlackConfigTokenSummary["urls"]> = {
  ready: ADDRESSES,
  noConsole: { redirect_url: null, events_url_template: null },
  noHttps: {
    redirect_url: "http://werft.example/settings/linked-accounts/slack",
    events_url_template: null,
  },
};

// GET /v1/workspaces/{id}/slack/config-token.
const TOKEN: Record<SlackConfigTokenSummary["state"], SlackConfigTokenSummary> =
  {
    active: {
      urls: ADDRESSES,
      state: "active",
      configured: true,
      last4: "a9Qe",
      updated_at: CHECKED_AT,
      updated_by: OWNER,
      expires_at: "2026-10-23T16:58:00Z",
      issuer: ISSUER,
    },
    needs_reentry: {
      urls: ADDRESSES,
      state: "needs_reentry",
      configured: true,
      last4: "a9Qe",
      updated_at: CHECKED_AT,
      updated_by: OWNER,
      expires_at: "2026-10-23T16:58:00Z",
      issuer: ISSUER,
    },
    unset: {
      urls: ADDRESSES,
      state: "unset",
      configured: false,
      last4: null,
      updated_at: null,
      updated_by: null,
      expires_at: null,
      issuer: null,
    },
  };

const STORED: SlackSecretSummary = {
  configured: true,
  last4: null,
  updated_at: "2026-10-01T00:20:00Z",
  updated_by: null,
};
const NONE: SlackSecretSummary = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
};

function madeApp(
  id: string,
  kind: "agent" | "link",
  appId: string,
  clientId: string,
  updatedAt: string,
  agent: MadeApp["agent"],
): MadeApp {
  return {
    slack_app: {
      id,
      kind,
      agent_id: agent?.id ?? null,
      state: "created",
      app_id: appId,
      client_id: clientId,
      redirect_url: "https://console.example.com/v1/slack/oauth/callback",
      created_by_token_user: ISSUER.user_id,
      created_at: "2026-10-01T00:20:00Z",
      updated_at: updatedAt,
      secrets: {
        slack_signing_secret: STORED,
        slack_client_secret: STORED,
        slack_bot_token: kind === "agent" && agent?.installed ? STORED : NONE,
      },
    },
    agent,
  };
}

// GET /v1/workspaces/{id}/slack/apps.
const SLACK_APPS: readonly MadeApp[] = [
  madeApp(
    "3c1d9e2a-0f4b-4a6c-8e1d-5b7a9c2e4f60",
    "link",
    "A07LINK0001",
    "7712045893021.7745320118650",
    "2026-10-01T00:20:00Z",
    null,
  ),
  madeApp(
    "8e2f4a6c-1b3d-4e5f-9a7b-0c2d4e6f8a10",
    "agent",
    "A07RNOTES01",
    "7712045893021.7798114502377",
    "2026-10-23T12:48:00Z",
    {
      id: "5a7c9e1b-3d5f-4a7b-8c9d-1e3f5a7b9c20",
      name: "Release Notes",
      slug: "release-notes",
      installed: true,
    },
  ),
  madeApp(
    "1f3e5d7c-9b2a-4c6e-8f0a-2b4d6f8a0c30",
    "agent",
    "A07TRIAGE01",
    "7712045893021.7801529936441",
    "2026-10-24T02:05:00Z",
    {
      id: "7b9d1f3a-5c7e-4b9d-0f1a-3c5e7a9b1d40",
      name: "Triage",
      slug: "triage",
      installed: false,
    },
  ),
];

const SECTIONS = "flex flex-col gap-10";
// workspace-settings.tsx SETTINGS_CARD.
const CARD = "flex flex-col gap-4 rounded-card border bg-card p-4";
const TOKEN_NAME = "App Configuration Token";
// The server's ceiling (workspace-settings.tsx AUDIT_RETENTION_MAX_DAYS).
const AUDIT_RETENTION_MAX_DAYS = 3650;
const ICON = "size-3.5 shrink-0";
const SLACK_APPS_URL = "https://api.slack.com/apps";
// The page's link target for the app list (workspace-slack-apps.tsx).
const SLACK_APPS_ANCHOR = "slack-apps";
const ROLE_LABEL: Record<Role, string> = {
  owner: "소유자",
  admin: "관리자",
  member: "구성원",
};

const manageReason = (viewer: Role) =>
  `워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금 역할: ${ROLE_LABEL[viewer]}.`;
const retentionReason = (viewer: Role) =>
  `감사 기록 보존 기간 변경 권한이 있어야 할 수 있습니다. 지금 역할: ${ROLE_LABEL[viewer]}.`;

/** components/auth-page.tsx Notice and FormError. */
function OutcomeLine({ outcome }: { readonly outcome: Outcome | null }) {
  if (!outcome) return null;
  return outcome.kind === "error" ? (
    <Text className="text-destructive" role="alert">
      {outcome.text}
    </Text>
  ) : (
    <Alert asChild variant="blue">
      <output>{outcome.text}</output>
    </Alert>
  );
}

/** auth/reason-button.tsx: kept in place, inert, saying why on a tooltip. */
function ReasonButton({
  reason,
  disabled,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly reason: string | undefined;
}) {
  const withheld = reason !== undefined;
  return (
    <Tooltip {...(!withheld && { open: false })}>
      <TooltipTrigger asChild={true}>
        <button
          type="button"
          {...rest}
          {...(withheld && { "aria-disabled": true })}
          className={cn(className, "aria-disabled:cursor-not-allowed")}
          disabled={withheld ? undefined : disabled}
          onClick={(event) => {
            if (withheld && event.currentTarget.type === "submit")
              event.preventDefault();
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  );
}

function ReadOnlyMark() {
  return (
    <Text
      as="div"
      variant="meta"
      className="inline-flex shrink-0 items-center gap-1"
    >
      <Lock aria-hidden="true" className={ICON} strokeWidth={1.5} />
      읽기 전용
    </Text>
  );
}

function Basics() {
  const inputId = useId();
  return (
    <SettingsSection title="기본 정보" foot={<ReadOnlyMark />}>
      <Field>
        <FieldLabel htmlFor={inputId}>워크스페이스 이름</FieldLabel>
        <Input
          id={inputId}
          className="max-w-80"
          value={WORKSPACE.name}
          readOnly
        />
        <FieldDescription>
          콘솔과 알림에 보이는 이름입니다. 콘솔에서는 아직 바꿀 수 없습니다.
        </FieldDescription>
      </Field>
      <Field>
        <Text weight="medium" className="text-sm leading-snug">
          워크스페이스 ID
        </Text>
        <SecretField
          className="max-w-105"
          value={WORKSPACE.id}
          copyLabel="복사"
          copiedMessage="워크스페이스 ID를 복사했습니다."
          copyFailedMessage="복사하지 못했습니다. ID를 직접 선택해 복사하세요."
        />
        <FieldDescription>
          API와 CLI에서 이 워크스페이스를 가리킬 때 씁니다.
        </FieldDescription>
      </Field>
    </SettingsSection>
  );
}

function AllowedModels({ models }: { readonly models: Models }) {
  return (
    <SettingsSection
      title="모델 허용 목록"
      description="세션에서 고를 수 있는 모델의 상한입니다. 에이전트 제한과 프로필이 여기서 더 좁힙니다."
      foot={
        <>
          <Text as="div" variant="meta">
            설정의 모델 연결에서 관리합니다
          </Text>
          <ReadOnlyMark />
        </>
      }
    >
      {models === "loading" ? (
        <Skeleton width="50%" />
      ) : models === "error" ? (
        <ErrorState
          title="불러오지 못했습니다"
          message="처리하지 못했습니다 — 잠시 뒤 다시 시도하세요."
          retry={() => {}}
          retryLabel="다시 시도"
        />
      ) : models === "empty" ? (
        <Text as="div" variant="meta">
          이 설치에 등록된 모델이 없습니다.
        </Text>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {MODELS.map((model) => (
            <li key={model}>
              <Badge variant="mono">{model}</Badge>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function ReadOnlySettings() {
  return (
    <>
      <SettingsSection
        title="감사 기록 보존 기간"
        description="허용·거절한 요청 기록을 이 기간 동안 보관합니다."
      >
        <div>감사 기록을 {SETTINGS.audit_retention_days}일 보존합니다.</div>
      </SettingsSection>
      <SettingsSection
        title="Slack 게스트"
        description="켜도 게스트는 먼저 웹에서 자기 Slack 계정을 연결해야 합니다. Slack Connect로 들어온 다른 조직 사람은 켜져 있어도 에이전트를 쓸 수 없습니다. 소유자나 관리자가 바꿀 수 있습니다."
      >
        <div>
          {SETTINGS.slack_guest_enabled
            ? "Slack 게스트도 에이전트를 쓸 수 있습니다."
            : "Slack 게스트는 에이전트를 쓸 수 없습니다."}
        </div>
      </SettingsSection>
    </>
  );
}

type AccessKey = "agent_outsider_access" | "agent_outsider_session_visibility";

// routes/workspace-settings.tsx AGENT_ACCESS: the contract's values in order.
const AGENT_ACCESS: Record<
  AccessKey,
  {
    readonly legend: string;
    readonly foot: string;
    readonly choices: readonly {
      readonly value: string;
      readonly label: string;
      readonly help: string;
    }[];
  }
> = {
  agent_outsider_access: {
    legend: "담당 팀 밖 구성원의 에이전트 접근",
    foot: "모든 에이전트에 적용됩니다.",
    choices: [
      {
        value: "use",
        label: "보고 실행",
        help: "에이전트 정보(이름·설명·담당 팀)를 보고 세션을 시작합니다. 설정은 보지 못합니다.",
      },
      {
        value: "view",
        label: "보기만",
        help: "에이전트 정보를 보지만 세션을 시작하지 못합니다.",
      },
      {
        value: "none",
        label: "숨김",
        help: "에이전트 목록에 보이지 않고 세션도 시작하지 못합니다.",
      },
    ],
  },
  agent_outsider_session_visibility: {
    legend: "워크스페이스 공개 세션",
    foot: "모든 에이전트의 세션에 적용됩니다. 다만 담당 팀이 필수가 되기 전에 팀이 없던 에이전트를 맡은 보관 팀에 아직 남아 있는 에이전트는 예외라, 실제 담당 팀으로 옮기기 전에는 이전처럼 모두에게 보입니다. 바꾸면 이미 있는 세션에도 바로 적용됩니다.",
    choices: [
      {
        value: "managing_team",
        label: "담당 팀 안에만",
        help: "공유 범위가 워크스페이스인 세션을 소유자·관리자, 에이전트 관리자, 담당 팀 구성원만 봅니다. 담당 팀 밖 구성원은 자기 세션과 이름·팀으로 공유받은 세션만 봅니다.",
      },
      {
        value: "workspace",
        label: "모든 구성원",
        help: "공유 범위가 워크스페이스인 세션을 모든 구성원이 봅니다.",
      },
    ],
  },
};
const ACCESS_KEYS = Object.keys(AGENT_ACCESS) as AccessKey[];
// The defaults GET /v1/auth/me reads when neither key was ever saved.
const ACCESS_DEFAULT: Record<AccessKey, string> = {
  agent_outsider_access: "use",
  agent_outsider_session_visibility: "managing_team",
};
const ACCESS_HINT =
  "담당 팀 밖 구성원이 에이전트와 그 세션을 어디까지 다루는지 정합니다. 소유자·관리자, 에이전트 관리자, 담당 팀 구성원에게는 적용되지 않습니다.";

function AgentAccess({
  onOutcome,
}: {
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const [draft, setDraft] = useState<Partial<Record<AccessKey, string>>>({});
  const changed = ACCESS_KEYS.some(
    (key) => draft[key] !== undefined && draft[key] !== ACCESS_DEFAULT[key],
  );
  return (
    <SettingsSection
      title="에이전트 접근"
      description={ACCESS_HINT}
      onSubmit={(event) => {
        event.preventDefault();
        onOutcome({
          kind: "notice",
          text: "에이전트 접근 설정을 저장했습니다.",
        });
      }}
      foot={
        <ReasonButton
          type="submit"
          className={buttonVariants({ size: "sm" })}
          reason={undefined}
          disabled={!changed}
        >
          저장
        </ReasonButton>
      }
    >
      {ACCESS_KEYS.map((key) => (
        <AgentAccessChoice
          key={key}
          setting={key}
          value={draft[key] ?? ACCESS_DEFAULT[key]}
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
  onChange,
}: {
  readonly setting: AccessKey;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const legendId = useId();
  const footId = useId();
  const text = AGENT_ACCESS[setting];
  return (
    <FieldSet>
      <FieldLegend id={legendId} variant="label">
        {text.legend}
      </FieldLegend>
      <RadioGroup
        value={value}
        onValueChange={onChange}
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
              <FieldLabel>{choice.label}</FieldLabel>
              <FieldDescription>{choice.help}</FieldDescription>
            </FieldContent>
          </Field>
        ))}
      </RadioGroup>
      <FieldDescription id={footId}>{text.foot}</FieldDescription>
    </FieldSet>
  );
}

function AgentAccessValues() {
  return (
    <SettingsSection title="에이전트 접근" description={ACCESS_HINT}>
      {ACCESS_KEYS.map((key) => {
        const { legend, choices } = AGENT_ACCESS[key];
        const chosen = choices.find(
          (choice) => choice.value === ACCESS_DEFAULT[key],
        );
        return <div key={key}>{`${legend}: ${chosen?.label ?? ""}`}</div>;
      })}
    </SettingsSection>
  );
}

function AuditRetention({
  viewer,
  onOutcome,
}: {
  readonly viewer: Role;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const [days, setDays] = useState(`${SETTINGS.audit_retention_days}`);
  const inputId = useId();
  const reason = viewer === "owner" ? undefined : retentionReason(viewer);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(days);
    onOutcome(
      value > AUDIT_RETENTION_MAX_DAYS
        ? {
            kind: "error",
            text: `감사 기록은 최대 ${AUDIT_RETENTION_MAX_DAYS}일까지 보존할 수 있습니다. ${AUDIT_RETENTION_MAX_DAYS}일 이하로 정하세요.`,
          }
        : value < 30
          ? {
              kind: "error",
              text: "감사 기록은 30일보다 짧게 보존할 수 없습니다. 30일 이상(최대 3650일)으로 정하세요.",
            }
          : { kind: "notice", text: `감사 기록을 ${value}일 보존합니다.` },
    );
  };
  return (
    <SettingsSection
      title="감사 기록 보존 기간"
      onSubmit={submit}
      foot={
        <ReasonButton
          type="submit"
          className={buttonVariants({ size: "sm" })}
          reason={reason}
          disabled={days.trim() === ""}
        >
          저장
        </ReasonButton>
      }
    >
      <Field>
        <FieldLabel htmlFor={inputId}>보존 기간(일)</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            className="max-w-50"
            type="number"
            inputMode="numeric"
            step={1}
            value={days}
            disabled={reason !== undefined}
            onChange={(event) => setDays(event.target.value)}
          />
          <Text as="span" variant="sub" aria-hidden="true">
            일
          </Text>
        </div>
        <FieldDescription>
          허용·거절한 요청 기록을 이 기간 동안 보관합니다.
        </FieldDescription>
        <FieldDescription>
          30일보다 짧게 할 수 없고, 소유자만 바꿀 수 있습니다.
        </FieldDescription>
      </Field>
    </SettingsSection>
  );
}

function GeneralPage({
  viewer,
  models,
}: {
  readonly viewer: Role;
  readonly models: Models;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const editable = viewer !== "member";
  return (
    <Page
      title="일반"
      description={
        editable
          ? "워크스페이스 전체에 적용되는 설정입니다."
          : "지금 설정입니다. 바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요."
      }
    >
      <div className={SECTIONS}>
        <OutcomeLine outcome={outcome} />
        <Basics />
        <AllowedModels models={models} />
        {editable ? (
          <>
            <AgentAccess onOutcome={setOutcome} />
            <AuditRetention viewer={viewer} onOutcome={setOutcome} />
          </>
        ) : (
          <>
            <AgentAccessValues />
            <ReadOnlySettings />
          </>
        )}
      </div>
    </Page>
  );
}

function SlackGuest({
  viewer,
  saving,
  onOutcome,
}: {
  readonly viewer: Role;
  readonly saving: boolean;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const [enabled, setEnabled] = useState(SETTINGS.slack_guest_enabled);
  const titleId = useId();
  const hintId = useId();
  const reasonId = useId();
  const reason = viewer === "member" ? manageReason(viewer) : undefined;
  return (
    <section aria-labelledby={titleId} className={CARD}>
      <div className="flex flex-col gap-1">
        <Heading id={titleId} level={2}>
          Slack 게스트
        </Heading>
        <Text variant="sub" id={hintId}>
          켜도 게스트는 먼저 웹에서 자기 Slack 계정을 연결해야 합니다. Slack
          Connect로 들어온 다른 조직 사람은 켜져 있어도 에이전트를 쓸 수
          없습니다. 소유자나 관리자가 바꿀 수 있습니다.
        </Text>
      </div>
      <RowList variant="joined">
        <SettingRow
          title="Slack 게스트도 에이전트를 쓸 수 있게 하기"
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
              {enabled ? "켜짐" : "꺼짐"}
            </Text>
          }
          control={
            <Switch
              checked={enabled}
              aria-describedby={reason === undefined ? hintId : reasonId}
              aria-disabled={saving || undefined}
              disabled={reason !== undefined}
              onCheckedChange={(next) => {
                if (saving) return;
                setEnabled(next);
                onOutcome({
                  kind: "notice",
                  text: next
                    ? "이제 Slack 게스트도 에이전트를 쓸 수 있습니다."
                    : "이제 Slack 게스트는 에이전트를 쓸 수 없습니다.",
                });
              }}
            />
          }
        />
      </RowList>
    </section>
  );
}

function TokenForm({
  onCancel,
  onSubmit,
}: {
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}) {
  const [missing, setMissing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("token");
    const value = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!value) {
      setMissing(true);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setMissing(false);
    if (input instanceof HTMLInputElement) input.value = "";
    onSubmit();
  };
  return (
    <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
      <Steps
        items={[
          {
            id: "open",
            title: (
              <Link
                href={SLACK_APPS_URL}
                target="_blank"
                newTabLabel="(새 탭에서 열림)"
              >
                api.slack.com/apps를 엽니다.
              </Link>
            ),
          },
          {
            id: "generate",
            title:
              "Your App Configuration Tokens에서 이 Slack 워크스페이스의 Generate Token을 누릅니다.",
          },
          {
            id: "paste",
            title:
              "만들어진 두 값 중 Refresh Token(xoxe-1-로 시작)을 복사해 아래에 붙여 넣습니다. Access Token이 아닙니다.",
          },
        ]}
      />
      <Field>
        <FieldLabel>Refresh Token</FieldLabel>
        <Input
          ref={inputRef}
          className="max-w-105"
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            if (event.target.value.trim()) setMissing(false);
          }}
        />
        <FieldDescription>
          등록하면 Slack에서 바로 새 토큰으로 바꾸므로 붙여 넣은 값은 다시 쓸 수
          없습니다. 값은 암호화해 저장하고 다시 보여 주지 않습니다. 이 토큰을
          만든 Slack 사용자가 이 콘솔이 만드는 앱의 협업자가 됩니다.
        </FieldDescription>
        <FieldError>
          {missing ? "등록하려면 Refresh Token을 붙여 넣어 주세요." : null}
        </FieldError>
      </Field>
      <FormActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          취소
        </Button>
        <Button type="submit">등록</Button>
      </FormActions>
    </form>
  );
}

function TokenBadge({
  summary,
}: {
  readonly summary: SlackConfigTokenSummary;
}) {
  if (summary.state === "active") {
    return <Badge variant="green">토큰 확인됨</Badge>;
  }
  if (summary.state === "needs_reentry") {
    return <Badge variant="red">재등록 필요</Badge>;
  }
  return <Badge>등록 안 됨</Badge>;
}

/** routes/workspace-slack.tsx tokenLine, in the ko catalog's words. */
function tokenLine(summary: SlackConfigTokenSummary): string | undefined {
  if (summary.state === "unset") {
    return "이미 만든 앱은 계속 동작합니다. 새 앱을 만들려면 토큰을 등록하세요.";
  }
  if (!summary.updated_at) return undefined;
  return [
    summary.last4 ? `••••${summary.last4}` : null,
    summary.issuer ? `팀 ${summary.issuer.team_id}` : null,
    summary.issuer ? `발급자 ${summary.issuer.user_id}` : null,
    `마지막 토큰 확인 ${formatTimestamp(summary.updated_at, "ko")}`,
    summary.updated_by
      ? `마지막 등록자 ${summary.updated_by.display_name}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

function AppState({ item }: { readonly item: MadeApp }) {
  const { kind, secrets } = item.slack_app;
  const link = kind === "link";
  const connected = link
    ? secrets.slack_client_secret.configured
    : !!item.agent?.installed;
  return (
    <RowLines>
      {connected ? (
        <Badge variant="green">연결됨</Badge>
      ) : link ? (
        <Badge>비밀값 없음</Badge>
      ) : (
        <Badge>설치 전</Badge>
      )}
      {connected ? (
        <Text as="span" variant="meta">
          {link ? "Sign in with Slack" : `@${item.agent?.slug}`}
        </Text>
      ) : null}
    </RowLines>
  );
}

function AppTable({ items }: { readonly items: readonly MadeApp[] }) {
  return (
    <GridTable
      aria-label="앱 목록"
      columns={APP_COLUMNS[0]}
      narrowAt={640}
      narrowColumns={APP_COLUMNS[1]}
      framed={true}
    >
      <GridTableHeader>
        <GridTableColumnHeader>앱</GridTableColumnHeader>
        <GridTableColumnHeader hideNarrow>에이전트</GridTableColumnHeader>
        <GridTableColumnHeader>상태</GridTableColumnHeader>
        <GridTableColumnHeader align="end" hideNarrow>
          갱신
        </GridTableColumnHeader>
        <GridTableColumnHeader>
          <Text as="span" className="sr-only">
            자세히
          </Text>
        </GridTableColumnHeader>
      </GridTableHeader>
      {items.map((item) => {
        const name =
          item.slack_app.kind === "link"
            ? "계정 연결 앱"
            : `${item.agent?.name ?? "없음"} 앱`;
        const updated = (
          <RelativeTime value={item.slack_app.updated_at} locale="ko" />
        );
        return (
          <GridTableRow key={item.slack_app.id}>
            <GridTableCell>
              <RowLines>
                <Text
                  as="span"
                  weight="medium"
                  className="[overflow-wrap:anywhere]"
                >
                  {name}
                </Text>
                <Code className="text-muted-foreground">
                  {item.slack_app.app_id ?? "앱 ID 없음"}
                </Code>
                <Text
                  as="span"
                  variant="meta"
                  className="hidden [@container(max-width:640px)]:block"
                >
                  {item.agent?.name ?? "없음"}
                  {" · "}
                  {updated}
                </Text>
              </RowLines>
            </GridTableCell>
            <GridTableCell hideNarrow className="text-muted-foreground">
              {item.agent ? (
                <a
                  href="#nav"
                  className={cn(linkVariants(), "[overflow-wrap:anywhere]")}
                >
                  {item.agent.name}
                </a>
              ) : (
                "없음"
              )}
            </GridTableCell>
            <GridTableCell>
              <AppState item={item} />
            </GridTableCell>
            <GridTableCell
              align="end"
              hideNarrow
              className="text-caption text-muted-foreground"
            >
              {updated}
            </GridTableCell>
            <GridTableCell align="end">
              {item.agent ? (
                <a href="#nav" className={linkVariants()}>
                  자세히
                  <Text as="span" className="sr-only">
                    : {name}
                  </Text>
                </a>
              ) : null}
            </GridTableCell>
          </GridTableRow>
        );
      })}
    </GridTable>
  );
}

// workspace-slack-apps.tsx COLUMNS.
const APP_COLUMNS = [
  "minmax(0,1.4fr) minmax(0,1fr) 136px 120px 64px",
  "minmax(0,1fr) 120px 64px",
] as const;

function SlackApps({ apps }: { readonly apps: readonly MadeApp[] }) {
  const titleId = useId();
  return (
    <section
      id={SLACK_APPS_ANCHOR}
      aria-labelledby={titleId}
      className="flex flex-col gap-2"
    >
      <Heading id={titleId} level={3}>
        자동으로 만든 Slack 앱
      </Heading>
      {apps.length === 0 ? (
        <Text variant="sub" className="rounded-card border border-dashed p-4">
          이 콘솔이 만든 Slack 앱이 아직 없습니다.
        </Text>
      ) : (
        <AppTable items={apps} />
      )}
      <Text variant="meta">
        여기서는 앱의 상태만 봅니다. 에이전트 앱의 설치, 연결 해제, 삭제는 그
        에이전트의 Slack 탭에서 합니다.
      </Text>
    </section>
  );
}

/** components/row-menu.tsx RowMenu: the ⋯ button and its items. */
function TokenMenu({
  active,
  onReplace,
  onDelete,
}: {
  readonly active: boolean;
  readonly onReplace: () => void;
  readonly onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const item = (text: string, danger: boolean, onSelect: () => void) => (
    <Button
      type="button"
      variant="ghost"
      role="menuitem"
      className={cn(
        "w-full justify-start font-normal",
        danger && "text-(color:--werft-tone-danger-fg)",
      )}
      onClick={() => {
        setOpen(false);
        onSelect();
      }}
    >
      {text}
    </Button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`${TOKEN_NAME} 메뉴`}
          aria-haspopup="menu"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        role="menu"
        aria-label={`${TOKEN_NAME} 메뉴`}
        align="end"
        className="flex min-w-44 flex-col gap-0.5 p-1"
      >
        {active ? item("토큰 교체", false, onReplace) : null}
        {item(`${TOKEN_NAME} 삭제`, true, onDelete)}
      </PopoverContent>
    </Popover>
  );
}

function AddressField({
  label,
  value,
  unset,
  hint,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly unset: string;
  readonly hint?: string;
}) {
  if (value === null) {
    return (
      <Field>
        <FieldLabel>{label}</FieldLabel>
        <Text variant="sub">{unset}</Text>
      </Field>
    );
  }
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          className="font-mono sm:flex-1"
          type="text"
          readOnly
          value={value}
        />
        <CopyButton
          value={value}
          variant="outline"
          label="복사"
          description={label}
        />
      </div>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

function SlackAddresses({
  urls,
}: {
  readonly urls: SlackConfigTokenSummary["urls"];
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <Heading id={titleId} level={3}>
        Slack 앱에 넣을 주소
      </Heading>
      <Text variant="sub">
        콘솔의 공개 주소(CONSOLE_ORIGIN)에서 계산한 주소입니다. 콘솔이 만드는
        앱에는 자동으로 들어가므로, Slack 앱을 직접 만들었을 때만 복사해서
        넣으세요.
      </Text>
      <AddressField
        label="Sign in with Slack 리디렉션 URL"
        value={urls.redirect_url}
        unset="콘솔의 공개 주소(CONSOLE_ORIGIN)가 설정되지 않아 주소를 만들 수 없습니다. 운영자에게 설정을 요청하세요."
      />
      <AddressField
        label="이벤트 요청 URL"
        value={urls.events_url_template}
        unset="Slack은 https 주소만 부릅니다. 콘솔의 공개 주소가 https가 아니어서 이벤트 주소를 만들 수 없습니다."
        hint="에이전트마다 다릅니다. {agent_id} 자리에 에이전트 ID를 넣으세요."
      />
    </section>
  );
}

function SlackPage({
  viewer,
  token: firstRead,
  appsEmpty,
  addresses,
  editing: initialEditing,
  guestSaving,
}: {
  readonly viewer: Role;
  readonly token: TokenRead;
  readonly appsEmpty: boolean;
  readonly addresses: Addresses;
  readonly editing: boolean;
  readonly guestSaving: boolean;
}) {
  const canManage = viewer !== "member";
  const titleId = useId();
  const tokenTitleId = useId();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [read, setRead] = useState<TokenRead>(firstRead);
  const [editing, setEditing] = useState(initialEditing && canManage);
  const [deleting, setDeleting] = useState(false);
  const apps = appsEmpty ? [] : SLACK_APPS;
  // Members' token read never runs, so it stays pending (useConfigToken).
  const summary =
    canManage && read !== "loading" && read !== "storeOff"
      ? TOKEN[read]
      : undefined;
  const unready = summary !== undefined && summary.state !== "active";
  const tokenOnly = unready && apps.length === 0;
  const start = tokenOnly && summary?.state === "unset";
  const guest = (
    <SlackGuest viewer={viewer} saving={guestSaving} onOutcome={setOutcome} />
  );
  const form = editing ? (
    <TokenForm
      onCancel={() => setEditing(false)}
      onSubmit={() => {
        setEditing(false);
        setRead("active");
        setOutcome({
          kind: "notice",
          text: `Slack이 토큰을 확인했습니다. 팀 ${ISSUER.team_id}, 발급자 ${ISSUER.user_id}.`,
        });
      }}
    />
  ) : null;

  const status = !canManage
    ? manageReason(viewer)
    : start
      ? "연결 없음"
      : `앱 ${apps.length}개`;

  const tokenRow =
    read === "loading" ? (
      <RowListItem>
        <Skeleton width="50%" />
      </RowListItem>
    ) : read === "storeOff" || summary === undefined ? (
      <RowListItem>
        <ErrorState
          title="불러오지 못했습니다"
          message="비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요."
        />
      </RowListItem>
    ) : (
      <RowListItem className="flex-col flex-nowrap items-stretch gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <Text as="span" weight="medium" truncate>
              {TOKEN_NAME}
            </Text>
            <Text variant="meta">{tokenLine(summary)}</Text>
          </div>
          <TokenBadge summary={summary} />
          {summary.state === "active" || editing ? null : (
            <Button type="button" size="sm" onClick={() => setEditing(true)}>
              {summary.state === "needs_reentry" ? "토큰 재등록" : "토큰 등록"}
            </Button>
          )}
          {summary.configured ? (
            <TokenMenu
              active={summary.state === "active"}
              onReplace={() => setEditing(true)}
              onDelete={() => setDeleting(true)}
            />
          ) : null}
        </div>
        {summary.state === "needs_reentry" ? (
          <Text className="text-(color:--werft-tone-danger-fg)">
            저장된 토큰을 사용할 수 없습니다. 새 토큰을 등록해 주세요. 등록할
            때까지 새 Slack 앱을 만들 수 없습니다. 이미 만든 앱은 계속
            동작합니다.
          </Text>
        ) : null}
        {form}
      </RowListItem>
    );

  const body = !canManage ? null : start ? (
    <div className="flex flex-col items-start gap-3 rounded-card border border-dashed p-4">
      <Text weight="medium">아직 등록된 토큰이 없습니다</Text>
      <Text variant="sub">
        Slack에서 {TOKEN_NAME}을 만들어 등록하세요. 등록하면 에이전트의 Slack
        탭에서 그 에이전트의 앱을 만들고 설치할 수 있습니다.
      </Text>
      {form ?? (
        <Button type="button" onClick={() => setEditing(true)}>
          토큰 등록
        </Button>
      )}
    </div>
  ) : (
    <>
      <section aria-labelledby={tokenTitleId} className="flex flex-col gap-2">
        <Heading id={tokenTitleId} level={3}>
          Slack 앱 생성
        </Heading>
        <RowList variant="joined" aria-labelledby={tokenTitleId}>
          {tokenRow}
        </RowList>
        {summary?.updated_at ? (
          <Text variant="meta">
            마지막 토큰 확인은 등록이나 자동 갱신 때 Slack이 토큰을 받은
            시각입니다.
          </Text>
        ) : null}
      </section>
      {summary ? <SlackAddresses urls={ADDRESS_STATES[addresses]} /> : null}
      {tokenOnly ? null : <SlackApps apps={apps} />}
    </>
  );

  return (
    <Page
      title="연동"
      description="에이전트를 Slack에서 쓸 수 있게 이 콘솔이 Slack 앱을 만들 때 쓰는 연결입니다. 에이전트마다 앱 설치와 채널은 에이전트의 Slack 탭에서 정합니다."
    >
      <LinkTabs aria-label="연동 종류">
        <LinkTab href="#slack" current>
          Slack
        </LinkTab>
        <LinkTab href="#github">GitHub</LinkTab>
      </LinkTabs>
      <div className={SECTIONS}>
        <OutcomeLine outcome={outcome} />
        {canManage ? null : guest}
        <section aria-labelledby={titleId} className={CARD}>
          <div className="flex items-center gap-3">
            <IconTile icon={Hash} hue="slate" size="two-line" />
            <div className="flex min-w-0 flex-1 flex-col">
              <Heading id={titleId} level={2}>
                Slack
              </Heading>
              <Text variant="sub">{status}</Text>
            </div>
          </div>
          <Text variant="sub">
            이 콘솔이 계정 연결 앱과 에이전트마다 쓸 Slack 앱을 만듭니다. 앱을
            만들려면 Slack의 {TOKEN_NAME}이 있어야 합니다.
          </Text>
          {body}
        </section>
        {canManage && !tokenOnly ? guest : null}
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`${TOKEN_NAME}을 삭제할까요?`}
          consequence="새 Slack 앱을 만들 수 없게 됩니다. 이미 만든 앱과 설치, 게스트 설정은 그대로입니다."
          target={summary?.last4 ? `••••${summary.last4}` : undefined}
          confirmLabel="삭제"
          cancelLabel="취소"
          tone="danger"
          onConfirm={() => {
            setDeleting(false);
            setRead("unset");
            setOutcome({
              kind: "notice",
              text: `${TOKEN_NAME}을 삭제했습니다.`,
            });
          }}
        />
      </div>
    </Page>
  );
}

function WorkspaceSettingsScreen({
  page,
  viewer,
  models = "ready",
  token = "active",
  appsEmpty = false,
  addresses = "ready",
  editing = false,
  guestSaving = false,
}: {
  readonly page: "general" | "slack";
  readonly viewer: Role;
  readonly models?: Models | undefined;
  readonly token?: TokenRead | undefined;
  readonly appsEmpty?: boolean | undefined;
  readonly addresses?: Addresses | undefined;
  readonly editing?: boolean | undefined;
  readonly guestSaving?: boolean | undefined;
}) {
  return (
    <ScreenShell
      current="settings"
      crumb={[page === "general" ? "일반" : "연동"]}
      role={viewer}
      settings={page}
    >
      {page === "general" ? (
        <GeneralPage viewer={viewer} models={models} />
      ) : (
        <SlackPage
          viewer={viewer}
          token={token}
          appsEmpty={appsEmpty}
          addresses={addresses}
          editing={editing}
          guestSaving={guestSaving}
        />
      )}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Workspace settings (v4)",
  component: WorkspaceSettingsScreen,
  parameters: { layout: "fullscreen" },
  args: { page: "general", viewer: "owner", models: "ready" },
  argTypes: {
    page: { control: "inline-radio", options: ["general", "slack"] },
    viewer: { control: "inline-radio", options: ["owner", "admin", "member"] },
    models: {
      control: "inline-radio",
      options: ["ready", "loading", "empty", "error"],
    },
    token: {
      control: "inline-radio",
      options: ["active", "needs_reentry", "unset", "loading", "storeOff"],
    },
    addresses: {
      control: "inline-radio",
      options: ["ready", "noConsole", "noHttps"],
    },
  },
} satisfies Meta<typeof WorkspaceSettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" };

export const WorkspaceSettings: Story = { name: "일반 › 소유자" };
export const WorkspaceSettingsAdmin: Story = {
  name: "일반 › 관리자 (보존 기간 변경 권한 없음)",
  args: { viewer: "admin" },
};
export const WorkspaceSettingsMember: Story = {
  name: "일반 › 구성원 (읽기 전용)",
  args: { viewer: "member" },
};
export const WorkspaceSettingsModelsLoading: Story = {
  name: "일반 › 모델 불러오는 중",
  args: { models: "loading" },
};
export const WorkspaceSettingsModelsEmpty: Story = {
  name: "일반 › 모델 없음",
  args: { models: "empty" },
};
export const WorkspaceSettingsModelsError: Story = {
  name: "일반 › 모델 읽기 실패",
  args: { models: "error" },
};
export const WorkspaceSettingsDark: Story = {
  name: "일반 › 소유자 (dark)",
  globals: DARK,
};
export const WorkspaceSettingsMobile: Story = {
  name: "일반 › 소유자 (390px)",
  globals: MOBILE,
};
export const WorkspaceSettingsMobileDark: Story = {
  name: "일반 › 소유자 (390px, dark)",
  globals: { ...MOBILE, ...DARK },
};

export const WorkspaceSettingsSlackSlack: Story = {
  name: "Slack › 토큰 확인됨",
  args: { page: "slack" },
};
export const WorkspaceSettingsSlackNoConsole: Story = {
  name: "Slack › 콘솔 공개 주소 없음",
  args: { page: "slack", addresses: "noConsole" },
};
export const WorkspaceSettingsSlackNoHttps: Story = {
  name: "Slack › 콘솔 공개 주소가 https 아님",
  args: { page: "slack", addresses: "noHttps" },
};
export const WorkspaceSettingsSlackNoHttpsMobile: Story = {
  ...WorkspaceSettingsSlackNoHttps,
  name: "Slack › 콘솔 공개 주소가 https 아님 (390px)",
  globals: MOBILE,
};
export const WorkspaceSettingsSlackSlackDark: Story = {
  ...WorkspaceSettingsSlackSlack,
  name: "Slack › 토큰 확인됨 (dark)",
  globals: DARK,
};
export const WorkspaceSettingsSlackSlackMobile: Story = {
  ...WorkspaceSettingsSlackSlack,
  name: "Slack › 토큰 확인됨 (390px)",
  globals: MOBILE,
};
export const WorkspaceSettingsSlackReplace: Story = {
  name: "Slack › 토큰 교체 중",
  args: { page: "slack", editing: true },
};
export const WorkspaceSettingsSlackReentry: Story = {
  name: "Slack › 재등록 필요",
  args: { page: "slack", token: "needs_reentry" },
};
export const WorkspaceSettingsSlackReentryMobile: Story = {
  ...WorkspaceSettingsSlackReentry,
  name: "Slack › 재등록 필요 (390px)",
  globals: MOBILE,
};
export const WorkspaceSettingsSlackReentryNoApps: Story = {
  name: "Slack › 재등록 필요, 만든 앱 없음",
  args: { page: "slack", token: "needs_reentry", appsEmpty: true },
};
export const WorkspaceSettingsSlackUnset: Story = {
  name: "Slack › 토큰 삭제됨, 만든 앱 있음",
  args: { page: "slack", token: "unset" },
};
export const WorkspaceSettingsSlackStart: Story = {
  name: "Slack › 처음 연결",
  args: { page: "slack", token: "unset", appsEmpty: true },
};
export const WorkspaceSettingsSlackStartMobile: Story = {
  ...WorkspaceSettingsSlackStart,
  name: "Slack › 처음 연결 (390px)",
  globals: MOBILE,
};
export const WorkspaceSettingsSlackUnsetEdit: Story = {
  name: "Slack › 처음 연결: 토큰 등록 중",
  args: { page: "slack", token: "unset", appsEmpty: true, editing: true },
};
export const WorkspaceSettingsSlackUnsetEditMobile: Story = {
  ...WorkspaceSettingsSlackUnsetEdit,
  name: "Slack › 처음 연결: 토큰 등록 중 (390px)",
  globals: MOBILE,
};
export const WorkspaceSettingsSlackAppsEmpty: Story = {
  name: "Slack › 만든 앱 없음",
  args: { page: "slack", appsEmpty: true },
};
export const WorkspaceSettingsSlackLoading: Story = {
  name: "Slack › 토큰 불러오는 중",
  args: { page: "slack", token: "loading" },
};
export const WorkspaceSettingsSlackStoreOff: Story = {
  name: "Slack › 비밀 저장소 꺼짐",
  args: { page: "slack", token: "storeOff" },
};
/** The guest switch while its save is in flight: focusable, but refuses. */
export const WorkspaceSettingsSlackGuestSaving: Story = {
  name: "Slack › 게스트 저장 중",
  args: { page: "slack", guestSaving: true },
};
export const WorkspaceSettingsSlackReadOnly: Story = {
  name: "Slack › 구성원 (읽기 전용)",
  args: { page: "slack", viewer: "member" },
};
export const WorkspaceSettingsSlackReadOnlyMobile: Story = {
  ...WorkspaceSettingsSlackReadOnly,
  name: "Slack › 구성원 (읽기 전용, 390px)",
  globals: MOBILE,
};
