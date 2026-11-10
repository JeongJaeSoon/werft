import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  type Agent,
  API_KEY_NAME_MAX,
  type ApiKeyView,
  type CreateApiKeyResponse,
  type SessionScope,
  scopesForRole,
} from "@werft-ai/contracts";
import {
  Alert,
  Badge,
  type BadgeProps,
  buttonVariants,
  Card,
  CardFooter,
  Checkbox,
  Code,
  Combobox,
  CopyButton,
  cn,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Heading,
  Input,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import {
  type ButtonHTMLAttributes,
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { MOBILE, type Role, ScreenShell, VIEWER } from "./screen-kit.tsx";

/*
 * Making a key, apps/web routes/api-keys.tsx NewKeyScreen
 * (/settings/api-keys/new, /settings/api-keys/agents/new): the form, then
 * the secret shown once in its place.
 */

type KeyKind = ApiKeyView["kind"];
type State = "form" | "failed" | "issued";

const SEARCH_MAX = 200;
const SEARCH_SETTLE_MS = 300;
const AGENT_KEY_DEFAULT_DAYS = 90;
const WORKSPACE = "5b0e8f3a-2c41-4d7e-9a16-3f8b2c7d4e10";

const SCOPE_NAME: Record<SessionScope, string> = {
  "sessions:read": "세션 보기",
  "sessions:write": "세션 만들기",
  "sessions:approve": "요청에 답하기",
  "sessions:control": "세션 제어",
  "sessions:recover": "세션 복구",
};

const SCOPE_HINT: Record<SessionScope, string> = {
  "sessions:read":
    "세션과 그 턴·이벤트·영수증·사용량·공유 설정, 답을 기다리는 요청을 읽습니다.",
  "sessions:write": "새 세션을 시작하고 세션에 메시지를 보냅니다.",
  "sessions:approve": "세션이 기다리는 권한 요청과 질문에 답합니다.",
  "sessions:control": "세션을 멈추고, 다시 잇고, 중단하고, 끝냅니다.",
  "sessions:recover":
    "복구가 필요한 세션을 어떻게 이을지 정합니다: 턴 버리기·완료 확정·닫기·새로 시작·복원 재시도.",
};

const KIND_NAME: Record<KeyKind, string> = {
  personal: "개인 키",
  agent: "에이전트 키",
};

const KIND_BADGE: Record<KeyKind, BadgeProps["variant"]> = {
  personal: "gray",
  agent: "blue",
};

const SCREEN: Record<
  KeyKind,
  { readonly title: string; readonly intro: string; readonly newTitle: string }
> = {
  personal: {
    title: "개인 키",
    intro:
      "나로 동작하는 키입니다. CLI나 스크립트가 내 권한 안에서 API를 부를 때 씁니다.",
    newTitle: "새 개인 키",
  },
  agent: {
    title: "에이전트 키",
    intro:
      "사람이 아니라 에이전트 하나에 속한 키입니다. 그 에이전트의 세션에만 닿고, 발급한 사람이 떠나도 계속 동작합니다.",
    newTitle: "새 에이전트 키",
  },
};

// GET /v1/agents for an owner; a member picks from the agents they administer.
const AGENTS: readonly Pick<Agent, "id" | "name" | "slug">[] = [
  {
    id: "3c9a1e7b-5d2f-4a8c-b6e0-1f2d3c4b5a69",
    name: "배포 봇",
    slug: "deploy",
  },
  {
    id: "6e2b8d4f-0a1c-4e3b-9d5f-7a8b9c0d1e2f",
    name: "리뷰 봇",
    slug: "review",
  },
];

function issued(kind: KeyKind): CreateApiKeyResponse {
  return {
    key: {
      id: "4f6a8c0e-2b4d-4e6f-8a0b-1c2d3e4f5a6b",
      kind,
      name: "ci-deploy",
      workspace_id: WORKSPACE,
      agent_id: kind === "agent" ? (AGENTS[0]?.id ?? null) : null,
      created_by: VIEWER.id,
      created_by_user: { id: VIEWER.id, display_name: VIEWER.name },
      scopes: ["sessions:read"],
      created_at: new Date().toISOString(),
      // The form's default: none for a personal key, 90 days for an agent's.
      expires_at:
        kind === "agent"
          ? new Date(
              `${localDay(AGENT_KEY_DEFAULT_DAYS)}T23:59:59`,
            ).toISOString()
          : null,
      revoked_at: null,
      last_used_at: null,
    },
    secret: "storybook-example-not-a-real-key-000000000000",
    receipt_id: "0192f0c4-7d3a-7b4e-9f00-0000000000a1",
  };
}

/** A local calendar day, `days` from today, as a date input's value. */
function localDay(days = 0): string {
  const day = new Date();
  day.setDate(day.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** The route's ReasonButton (auth/reason-button.tsx). */
function ReasonButton({
  reason,
  disabled,
  className,
  onClick,
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
            if (!withheld) return onClick?.(event);
            if (event.currentTarget.type === "submit") event.preventDefault();
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  );
}

/** The route's FormError (components/auth-page.tsx). */
function FormError({ children }: { readonly children: string }) {
  return (
    <Text className="text-destructive" role="alert">
      {children}
    </Text>
  );
}

function KindBadge({ kind }: { readonly kind: KeyKind }) {
  return (
    <Badge variant={KIND_BADGE[kind]} data-kind={kind}>
      {KIND_NAME[kind]}
    </Badge>
  );
}

function ScopePicker({
  available,
  chosen,
  onChange,
}: {
  readonly available: readonly SessionScope[];
  readonly chosen: readonly SessionScope[];
  readonly onChange: (scopes: SessionScope[]) => void;
}) {
  return (
    <FieldSet className="w-full gap-3">
      <FieldLegend variant="label" className="mb-0">
        권한
      </FieldLegend>
      {available.map((scope) => (
        <Field key={scope} orientation="horizontal">
          <Checkbox
            checked={chosen.includes(scope)}
            onCheckedChange={(checked) =>
              onChange(
                checked === true
                  ? [...chosen, scope]
                  : chosen.filter((s) => s !== scope),
              )
            }
          />
          <FieldContent>
            <FieldLabel>
              {SCOPE_NAME[scope]} <Code>{scope}</Code>
            </FieldLabel>
            <FieldDescription>{SCOPE_HINT[scope]}</FieldDescription>
          </FieldContent>
        </Field>
      ))}
      <FieldDescription>
        '요청에 답하기'를 넣어도 이 키로 시작한 세션의 요청은 이 키로 승인하지
        못합니다. 다른 키나 사람이 승인합니다.
      </FieldDescription>
    </FieldSet>
  );
}

function ExpiryField({
  value,
  onChange,
  hint,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint: string;
}) {
  return (
    <Field>
      <FieldLabel>만료일(필수 아님)</FieldLabel>
      <div>
        <Input
          type="date"
          className="w-auto"
          min={localDay()}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  );
}

function NameField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field className="w-full">
      <FieldLabel>이름(필수 아님)</FieldLabel>
      <Input
        className="max-w-sm"
        autoComplete="off"
        maxLength={API_KEY_NAME_MAX}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>
        목록에서 이 키를 알아보는 이름입니다. 예: ci-deploy
      </FieldDescription>
    </Field>
  );
}

const FORM_BODY = "flex flex-col items-start gap-4 p-4";

function FormFoot({
  reason,
  disabled,
}: {
  readonly reason?: string | undefined;
  readonly disabled: boolean;
}) {
  return (
    <CardFooter variant="form" className="flex-wrap items-start justify-end">
      <a
        href="#list"
        data-slot="button"
        className={buttonVariants({ variant: "outline" })}
      >
        취소
      </a>
      <ReasonButton
        type="submit"
        className={buttonVariants()}
        reason={reason}
        disabled={disabled}
      >
        키 만들기
      </ReasonButton>
    </CardFooter>
  );
}

const stop = (event: FormEvent<HTMLFormElement>) => event.preventDefault();

function PersonalKeyForm({ held }: { readonly held: readonly SessionScope[] }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<SessionScope[]>(["sessions:read"]);
  const [expires, setExpires] = useState("");
  const granted = scopes.filter((scope) => held.includes(scope));
  return (
    <Card flush>
      <form onSubmit={stop}>
        <div className={FORM_BODY}>
          <NameField value={name} onChange={setName} />
          <ScopePicker available={held} chosen={scopes} onChange={setScopes} />
          <ExpiryField
            value={expires}
            onChange={setExpires}
            hint="비워 두면 폐기할 때까지 유효합니다."
          />
        </div>
        <FormFoot disabled={granted.length === 0} />
      </form>
    </Card>
  );
}

function AgentKeyForm({
  held,
  agents,
  picked,
  everywhere,
}: {
  readonly held: readonly SessionScope[];
  readonly agents: readonly Pick<Agent, "id" | "name" | "slug">[];
  readonly picked: boolean;
  /** An owner or admin searches every agent on the server. */
  readonly everywhere: boolean;
}) {
  const [term, setTerm] = useState("");
  const q = term.trim().toLowerCase() || undefined;
  // GET /v1/agents?q= stands in as a filter over the fixture.
  const searched = everywhere
    ? agents.filter(
        (agent) =>
          q === undefined ||
          agent.name.toLowerCase().includes(q) ||
          agent.slug.includes(q),
      )
    : agents;
  const first = picked ? agents[0] : undefined;
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<SessionScope[]>(["sessions:read"]);
  const [text, setText] = useState(first?.name ?? "");
  const [chosenAgent, setChosenAgent] = useState<{
    id: string;
    name: string;
  } | null>(first ? { id: first.id, name: first.name } : null);
  const [expires, setExpires] = useState(() =>
    localDay(AGENT_KEY_DEFAULT_DAYS),
  );
  const pickerId = useId();
  const granted = scopes.filter((scope) => held.includes(scope));
  // Only an unsearched list proves there is no agent at all.
  const noAgents = searched.length === 0 && (!everywhere || q === undefined);
  const reason =
    noAgents && chosenAgent === null
      ? "관리하는 에이전트가 없습니다."
      : chosenAgent === null
        ? "에이전트를 고르세요"
        : granted.length === 0
          ? "권한을 하나 이상 고르세요."
          : undefined;
  return (
    <Card flush>
      <form onSubmit={stop}>
        <div className={FORM_BODY}>
          <Field>
            <FieldLabel htmlFor={pickerId}>에이전트</FieldLabel>
            <div className="w-full max-w-sm">
              <Combobox
                id={pickerId}
                options={searched.map((agent) => ({
                  value: agent.id,
                  label: agent.name,
                  description: agent.slug,
                }))}
                value={chosenAgent?.id ?? null}
                inputValue={text}
                onInputValueChange={(next) => {
                  setText(next);
                  setChosenAgent((current) =>
                    current && current.name !== next ? null : current,
                  );
                }}
                onValueChange={(value, option) =>
                  setChosenAgent({ id: value, name: option.label })
                }
                maxLength={SEARCH_MAX}
                filter={everywhere ? "none" : "internal"}
                onQueryChange={everywhere ? setTerm : undefined}
                debounceMs={SEARCH_SETTLE_MS}
                hasMore={false}
                loading={false}
                placeholder="이름이나 식별자로 에이전트 찾기"
                loadingMessage="에이전트를 불러오는 중…"
                emptyMessage={
                  noAgents
                    ? "관리하는 에이전트가 없습니다."
                    : "맞는 에이전트가 없습니다."
                }
                resultCountMessage={(count) => `${count}개가 있습니다.`}
              />
            </div>
            <FieldDescription>
              키를 쓸 에이전트입니다. 발급한 뒤에는 바꿀 수 없습니다.
            </FieldDescription>
          </Field>
          <NameField value={name} onChange={setName} />
          <ScopePicker available={held} chosen={scopes} onChange={setScopes} />
          <ExpiryField
            value={expires}
            onChange={setExpires}
            hint="기본은 90일 뒤입니다. 비워 두면 폐기할 때까지 유효합니다."
          />
        </div>
        <FormFoot
          reason={reason}
          disabled={granted.length === 0 || chosenAgent === null}
        />
      </form>
    </Card>
  );
}

function IssuedSecret({ issued }: { readonly issued: CreateApiKeyResponse }) {
  const secretRef = useRef<HTMLInputElement>(null);
  const kind = issued.key.kind;
  useEffect(() => {
    secretRef.current?.focus();
  }, []);
  return (
    <section
      className="flex flex-col gap-4 rounded-card border p-4"
      data-status="secret"
      aria-label="새 키"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading>키를 만들었습니다</Heading>
        <KindBadge kind={kind} />
      </div>
      <Alert variant="amber">
        <div>
          지금 복사해 두세요. 이 화면을 떠나면 값을 다시 볼 수 없습니다.
        </div>
      </Alert>
      <Field>
        <FieldLabel>키 값</FieldLabel>
        <div className="flex max-w-[var(--werft-layout-reading-width)] items-center gap-2">
          <Input
            ref={secretRef}
            className="min-w-0 flex-1 font-mono"
            type="text"
            readOnly
            value={issued.secret}
            onFocus={(event) => event.target.select()}
          />
          <CopyButton
            value={issued.secret}
            className="shrink-0"
            label="복사"
            copiedLabel="복사했습니다"
            copiedMessage="복사했습니다"
            iconClassName="size-4"
            fallbackField={secretRef}
          />
        </div>
      </Field>
      <Text variant="meta" className="[overflow-wrap:anywhere]">
        ID {issued.key.id}
      </Text>
      <div>
        <a
          href="#list"
          data-slot="button"
          className={buttonVariants({ variant: "outline" })}
        >
          목록으로
        </a>
      </div>
    </section>
  );
}

function NewKeyScreen({
  kind,
  role,
  state,
  picked,
  administers,
}: {
  readonly kind: KeyKind;
  readonly role: Role;
  readonly state: State;
  /** Whether the agent form starts with its first agent chosen. */
  readonly picked: boolean;
  /** A member who administers no agent finds none to pick. */
  readonly administers: boolean;
}) {
  const screen = SCREEN[kind];
  // GET /v1/auth/me: the scopes the viewer's role holds.
  const held = scopesForRole(role);
  const agents =
    role === "member" && !administers
      ? []
      : role === "member"
        ? AGENTS.slice(0, 1)
        : AGENTS;
  return (
    <ScreenShell
      current="settings"
      crumb={["API 키"]}
      role={role}
      settings="apiKeys"
    >
      <Page
        title={screen.newTitle}
        description={screen.intro}
        breadcrumb={
          <PageBreadcrumb label="위치">
            <PageBreadcrumbLink href="#list">{screen.title}</PageBreadcrumbLink>
            <PageBreadcrumbCurrent>{screen.newTitle}</PageBreadcrumbCurrent>
          </PageBreadcrumb>
        }
      >
        {state === "failed" ? (
          <FormError>처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.</FormError>
        ) : null}
        {state === "issued" ? (
          <IssuedSecret issued={issued(kind)} />
        ) : kind === "personal" ? (
          <PersonalKeyForm held={held} />
        ) : (
          <AgentKeyForm
            held={held}
            agents={agents}
            picked={picked}
            everywhere={role !== "member"}
          />
        )}
      </Page>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/New API key (v4)",
  component: NewKeyScreen,
  parameters: { layout: "fullscreen" },
  args: {
    kind: "personal",
    role: "owner",
    state: "form",
    picked: false,
    administers: true,
  },
  argTypes: {
    kind: { control: "inline-radio", options: ["personal", "agent"] },
    role: { control: "inline-radio", options: ["owner", "admin", "member"] },
    state: {
      control: "inline-radio",
      options: ["form", "failed", "issued"],
    },
  },
} satisfies Meta<typeof NewKeyScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewPersonalKey: Story = { name: "Owner · new personal key" };
export const NewPersonalKeyMember: Story = {
  name: "Member · new personal key (no recovery scope)",
  args: { role: "member" },
};
export const NewAgentKey: Story = {
  name: "Owner · new agent key (no agent chosen yet)",
  args: { kind: "agent" },
};
export const NewAgentKeySearch: Story = {
  name: "Owner · agent search (server, filter none)",
  args: { kind: "agent" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(
      canvas.getByRole("combobox", { name: "에이전트" }),
      "review",
    );
    await waitFor(() =>
      expect(page.queryByRole("option", { name: /배포 봇/ })).toBeNull(),
    );
    await expect(page.getByRole("option", { name: /리뷰 봇/ })).toBeVisible();
  },
};
export const NewAgentKeyPicked: Story = {
  name: "Owner · new agent key, agent chosen",
  args: { kind: "agent", picked: true },
};
export const NewAgentKeyNoAgents: Story = {
  name: "Member without agents · new agent key",
  args: { kind: "agent", role: "member", administers: false },
};
export const NewKeyNoScope: Story = {
  name: "No scope picked (generate disabled)",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "세션 보기 sessions:read" }),
    );
    await expect(
      canvas.getByRole("button", { name: "키 만들기" }),
    ).toBeDisabled();
  },
};
export const NewKeyFailed: Story = {
  name: "Generate failed",
  args: { state: "failed" },
};
export const NewKeyIssued: Story = {
  name: "Issued · secret shown once",
  args: { state: "issued" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("textbox", { name: "키 값" })).toHaveFocus();
  },
};
export const NewAgentKeyIssued: Story = {
  name: "Issued agent key",
  args: { kind: "agent", state: "issued" },
};
export const NewKeyDark: Story = {
  name: "Owner (dark)",
  globals: { theme: "dark" },
};
export const NewKeyMobile: Story = {
  name: "Owner (390px)",
  globals: MOBILE,
};
export const NewKeyMobileDark: Story = {
  name: "Owner (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};
export const NewAgentKeyMobile: Story = {
  name: "Owner · new agent key (390px)",
  args: { kind: "agent", picked: true },
  globals: MOBILE,
};
