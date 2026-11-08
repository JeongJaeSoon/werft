import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AgentMcpResponse, Receipt } from "@werft-ai/contracts";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Code,
  Field,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  RelativeTime,
  RowAction,
  RowList,
  RowListItem,
  Section,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { expect } from "storybook/test";

import { AgentPage, RELEASE, RELEASED } from "./agent-detail-parts.tsx";
import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * apps/web routes/agent-detail/access.tsx: GET and PUT
 * /v1/agents/{id}/mcp/settings inside the agent page's Access tab, and the
 * save as the Releases tab lists it (routes/agent-detail/releases.tsx, a
 * `set_agent_mcp` receipt). Words are apps/web's Korean catalog.
 */

const SECTION_BODY = "flex flex-col gap-[var(--werft-space-block)]";

const SAVED: AgentMcpResponse = {
  source: "agent",
  settings: {
    server: "docs",
    allowed_tools: ["mcp__docs__read", "mcp__docs__search"],
    credential_refs: ["docs-key", "wiki-key"],
  },
  settings_revision: 3,
  active_release_id: RELEASE.id,
  bound_credential_refs: ["docs-key"],
  available_servers: ["docs", "wiki"],
};
const FROM_RELEASE: AgentMcpResponse = {
  ...SAVED,
  source: "release",
  settings_revision: null,
  bound_credential_refs: [],
};

type View =
  | "from-release"
  | "saved"
  | "pending"
  | "conflict"
  | "refused"
  | "read-only"
  | "changes";

const NOTE: Readonly<Record<string, string>> = {
  conflict:
    "다른 곳에서 먼저 저장했습니다. 다시 읽은 값에서 고쳐 저장해 주세요.",
  refused:
    "저장하지 못했습니다. 활성 릴리스의 프로필이 막은 도구는 새로 허용할 수 없습니다.",
};

type ChangeReceipt = Pick<
  Receipt,
  "id" | "operation" | "status" | "result" | "created_at"
>;
const CHANGES: readonly ChangeReceipt[] = [
  {
    id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d02",
    operation: "set_agent_mcp",
    status: "succeeded",
    result: {
      before: {
        server: "docs",
        allowed_tools: ["mcp__docs__read"],
        credential_refs: ["docs-key"],
      },
      after: SAVED.settings,
    },
    created_at: "2026-11-02T03:00:00Z",
  },
  {
    id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01",
    operation: "set_agent_mcp",
    status: "succeeded",
    result: {
      before: null,
      after: {
        server: "docs",
        allowed_tools: ["mcp__docs__read"],
        credential_refs: ["docs-key"],
      },
    },
    created_at: "2026-11-01T03:00:00Z",
  },
];

const names = (list: readonly string[]) =>
  list.length > 0 ? list.join(", ") : "없음";
const summary = (side: {
  server: string | null;
  allowed_tools: readonly string[];
  credential_refs: readonly string[];
}) =>
  `서버 ${side.server ?? "없음"} · 도구 ${names(side.allowed_tools)} · 자격 증명 ${names(side.credential_refs)}`;

/** A field's names, one per row. A plain div holds the name: RowLines is a span. */
function NameList({
  label,
  hint,
  listLabel,
  items,
  badge,
  editable,
  input,
  placeholder,
  add,
}: {
  readonly label: string;
  readonly hint: string;
  readonly listLabel: string;
  readonly items: readonly string[];
  readonly badge?: (name: string) => ReactNode;
  readonly editable: boolean;
  readonly input: string;
  readonly placeholder: string;
  readonly add: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Text as="span" weight="medium">
          {label}
        </Text>
        <Text as="span" variant="meta">
          {hint}
        </Text>
      </div>
      <RowList aria-label={listLabel}>
        {items.map((name) => (
          <RowListItem key={name}>
            <div className="min-w-0 flex-1 break-words font-medium">
              <Code size="inherit">{name}</Code>
            </div>
            {badge ? badge(name) : null}
            {editable ? (
              <RowAction variant="danger" aria-label={`${name} 빼기`}>
                빼기
              </RowAction>
            ) : null}
          </RowListItem>
        ))}
      </RowList>
      {editable ? (
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field>
            <FieldLabel>{input}</FieldLabel>
            <Input className="font-mono" placeholder={placeholder} />
          </Field>
          <Button type="button" variant="outline">
            <Plus aria-hidden="true" strokeWidth={1.5} />
            {add}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AccessSection({ view }: { readonly view: View }) {
  const data = view === "from-release" ? FROM_RELEASE : SAVED;
  const manages = view !== "read-only";
  const pending = view === "pending" || view in NOTE;
  const tools = pending
    ? data.settings.allowed_tools.filter((name) => name !== "mcp__docs__search")
    : data.settings.allowed_tools;
  const note = NOTE[view];
  const bound = new Set(data.bound_credential_refs);
  return (
    <Section
      title="MCP 서버와 도구"
      description="MCP 서버와 자격 증명은 에이전트 설정입니다. 바꿔도 릴리스는 만들어지지 않고, 변경은 릴리스 탭의 '접근 변경'에 남습니다. 실행 중인 세션에는 좁히는 변경만 바로 적용됩니다."
    >
      <div className={SECTION_BODY}>
        {data.source === "release" ? (
          <Alert>
            <AlertDescription>
              저장된 설정이 없어 활성 릴리스의 값을 보여줍니다. 저장하면 이
              값부터 에이전트 설정이 됩니다.
            </AlertDescription>
          </Alert>
        ) : null}
        {manages ? null : (
          <Text variant="sub">에이전트 관리자만 고칠 수 있습니다.</Text>
        )}
        <Field>
          <FieldLabel>MCP 서버</FieldLabel>
          <NativeSelect
            defaultValue={data.settings.server ?? ""}
            disabled={!manages}
          >
            <NativeSelectOption value="">서버 없음</NativeSelectOption>
            {(data.available_servers ?? []).map((id) => (
              <NativeSelectOption key={id} value={id}>
                {id}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <NameList
          label="허용할 도구"
          hint="이름은 mcp__서버__도구 형식입니다. 서버를 고르면 입력할 수 있습니다."
          listLabel="허용한 도구"
          items={tools}
          editable={manages}
          input="도구 이름"
          placeholder="mcp__서버__도구"
          add="도구 추가"
        />
        <NameList
          label="필요한 자격 증명 이름"
          hint="값이 아니라 이름입니다. 값은 아래 '자격 증명 연결'에서 에이전트에 연결합니다."
          listLabel="필요한 자격 증명"
          items={data.settings.credential_refs}
          badge={(name) => (
            <Badge variant={bound.has(name) ? "green" : "gray"}>
              {bound.has(name) ? "연결됨" : "연결 안 됨"}
            </Badge>
          )}
          editable={manages}
          input="자격 증명 이름"
          placeholder="docs-key"
          add="이름 추가"
        />
        {manages && (pending || data.source === "release") ? (
          <Alert
            variant={note ? "red" : "blue"}
            role="region"
            aria-label={
              pending
                ? "저장하지 않은 변경이 있습니다"
                : "에이전트 설정으로 저장하지 않았습니다"
            }
          >
            <AlertTitle>
              {pending
                ? "저장하지 않은 변경이 있습니다"
                : "에이전트 설정으로 저장하지 않았습니다"}
            </AlertTitle>
            <AlertDescription>
              저장하면 릴리스 없이 바로 에이전트 설정이 바뀝니다. 새 세션은 이
              값을 읽습니다.
              {note ? (
                <div className="mt-2">
                  <FieldError>{note}</FieldError>
                </div>
              ) : null}
            </AlertDescription>
            <AlertActions>
              <Button type="button" size="sm">
                저장
              </Button>
              {pending ? (
                <Button type="button" size="sm" variant="ghost">
                  {view === "conflict" ? "다시 읽기" : "되돌리기"}
                </Button>
              ) : null}
            </AlertActions>
          </Alert>
        ) : null}
      </div>
    </Section>
  );
}

/** The `set_agent_mcp` receipts as the Releases tab lists them: names only. */
function AccessChanges() {
  return (
    <Section title="릴리스">
      <div className={SECTION_BODY}>
        <RowList aria-label="접근 변경">
          {CHANGES.map((receipt) => {
            const result = receipt.result as {
              before: Parameters<typeof summary>[0] | null;
              after: Parameters<typeof summary>[0];
            };
            return (
              <RowListItem key={receipt.id} data-kind="access">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="blue">접근 변경</Badge>
                    <Text as="span" weight="medium">
                      MCP 설정 저장
                    </Text>
                  </div>
                  <Text as="span" variant="meta" className="wrap-anywhere">
                    {result.before === null
                      ? "처음 저장"
                      : `이전: ${summary(result.before)}`}
                  </Text>
                  <Text as="span" variant="meta" className="wrap-anywhere">
                    {`이후: ${summary(result.after)}`}
                  </Text>
                </div>
                <RelativeTime value={receipt.created_at} locale="ko" />
              </RowListItem>
            );
          })}
        </RowList>
      </div>
    </Section>
  );
}

function AccessScreen({ view }: { readonly view: View }) {
  return (
    <ScreenShell
      current="agents"
      crumb={["에이전트", RELEASED.agent.name]}
      role={view === "read-only" ? "member" : "owner"}
    >
      <AgentPage
        detail={RELEASED}
        tab={view === "changes" ? "release" : "access"}
      >
        {view === "changes" ? <AccessChanges /> : <AccessSection view={view} />}
      </AgentPage>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Agent access",
  component: AccessScreen,
  parameters: { layout: "fullscreen" },
  args: { view: "saved" },
  argTypes: {
    view: {
      control: "inline-radio",
      options: [
        "from-release",
        "saved",
        "pending",
        "conflict",
        "refused",
        "read-only",
        "changes",
      ],
    },
  },
} satisfies Meta<typeof AccessScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = {
  name: "Access tab (saved settings)",
  play: async ({ canvas }) => {
    await expect(canvas.getByText("연결됨")).toBeVisible();
    await expect(canvas.getByText("연결 안 됨")).toBeVisible();
    await expect(
      canvas.queryByRole("region", { name: "저장하지 않은 변경이 있습니다" }),
    ).toBeNull();
  },
};
export const FromRelease: Story = {
  name: "Access tab (no row yet, the active release's values)",
  args: { view: "from-release" },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(/저장된 설정이 없어 활성 릴리스의 값을 보여줍니다/),
    ).toBeVisible();
    await expect(
      canvas.getByRole("region", {
        name: "에이전트 설정으로 저장하지 않았습니다",
      }),
    ).toBeVisible();
  },
};
export const Pending: Story = {
  name: "Access tab (unsaved change)",
  args: { view: "pending" },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("region", { name: "저장하지 않은 변경이 있습니다" }),
    ).toBeVisible();
    await expect(canvas.queryByText("mcp__docs__search")).toBeNull();
  },
};
export const Conflict: Story = {
  name: "Access tab (saved elsewhere first)",
  args: { view: "conflict" },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(/다른 곳에서 먼저 저장했습니다/),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "다시 읽기" }),
    ).toBeVisible();
  },
};
export const Refused: Story = {
  name: "Access tab (tool blocked by the profile)",
  args: { view: "refused" },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(
        /활성 릴리스의 프로필이 막은 도구는 새로 허용할 수 없습니다/,
      ),
    ).toBeVisible();
  },
};
export const ReadOnly: Story = {
  name: "Access tab (not an agent admin)",
  args: { view: "read-only" },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("에이전트 관리자만 고칠 수 있습니다."),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "저장" })).toBeNull();
  },
};
export const Changes: Story = {
  name: "Releases tab (access changes, names only)",
  args: { view: "changes" },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByText("접근 변경").length).toBeGreaterThan(1);
    await expect(canvas.getByText("처음 저장")).toBeVisible();
  },
};
export const SavedDark: Story = {
  name: "Access tab (saved settings, dark)",
  globals: { theme: "dark" },
};
export const PendingMobile: Story = {
  name: "Access tab (unsaved change, 390px)",
  args: { view: "pending" },
  globals: MOBILE,
};
export const ChangesMobile: Story = {
  name: "Releases tab (access changes, 390px)",
  args: { view: "changes" },
  globals: MOBILE,
};
