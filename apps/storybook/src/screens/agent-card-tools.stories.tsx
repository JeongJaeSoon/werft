import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@werft-ai/ui";
import { useState } from "react";

/*
 * The card editor's tools (agent-wizard-rework.md 3b): one checklist of the
 * preview profile's tools, as apps/web/src/components/agent-card-form.tsx
 * draws it.
 */

const PROFILES = [
  {
    id: "claude-coding-local",
    label: "claude-coding-local v1 · claude-sonnet-5",
    tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "AskUserQuestion"],
  },
  {
    id: "general",
    label: "general v1 · claude-sonnet-5",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "AskUserQuestion"],
  },
] as const;

// apps/web/src/routes/operations-tool-notes.ts, ko.
const NOTES: Readonly<Record<string, string>> = {
  AskUserQuestion: "사용자에게 묻는다",
  Bash: "셸 명령",
  Edit: "파일 일부를 고친다",
  Glob: "이름 패턴으로 파일을 찾는다",
  Grep: "파일 내용을 검색한다",
  Read: "파일을 읽는다",
  Write: "파일을 쓴다",
};

type State = "all" | "list" | "outsideForbidden";

const START: Record<
  State,
  {
    readonly all: boolean;
    readonly tools: readonly string[];
    readonly forbidden: readonly string[];
  }
> = {
  all: { all: true, tools: [], forbidden: [] },
  list: {
    all: false,
    tools: ["Read", "Edit", "Write", "Glob", "Grep", "AskUserQuestion"],
    forbidden: [],
  },
  outsideForbidden: {
    all: false,
    tools: ["Read", "Grep", "WebFetch"],
    forbidden: ["Bash"],
  },
};

function AgentCardToolsScreen({ state }: { readonly state: State }) {
  const [draft, setDraft] = useState(START[state]);
  const [previewId, setPreviewId] = useState<string>(PROFILES[0].id);
  const preview =
    PROFILES.find((profile) => profile.id === previewId) ?? PROFILES[0];
  const offered: readonly string[] = preview.tools;
  const outside = draft.all
    ? []
    : draft.tools.filter((tool) => !offered.includes(tool));
  const runs = (tool: string) =>
    (draft.all || draft.tools.includes(tool)) &&
    !draft.forbidden.includes(tool);
  const allowing = PROFILES.filter(
    (profile) =>
      draft.all ||
      draft.tools.every((tool) =>
        (profile.tools as readonly string[]).includes(tool),
      ),
  ).length;
  const check = (tool: string, on: boolean) => {
    const rest = draft.tools.filter((item) => item !== tool);
    setDraft({
      ...draft,
      tools: on ? [...rest, tool] : rest,
    });
  };
  const row = (tool: string, note: string | undefined, outsider: boolean) => (
    <Field key={tool} orientation="horizontal">
      <Checkbox
        checked={outsider || runs(tool)}
        disabled={!outsider && (draft.all || draft.forbidden.includes(tool))}
        onCheckedChange={(on) => {
          if (!outsider || on !== true) check(tool, on === true);
        }}
      />
      <FieldContent>
        <FieldLabel className="font-mono">{tool}</FieldLabel>
        {note ? <FieldDescription>{note}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
  return (
    <form
      key={state}
      className="flex w-full max-w-xl flex-col gap-4 rounded-card border bg-card p-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <FieldSet className="gap-3">
        <FieldLegend variant="label">쓸 수 있는 도구</FieldLegend>
        <Field>
          <FieldLabel>프로필</FieldLabel>
          <NativeSelect
            value={previewId}
            onChange={(event) => setPreviewId(event.target.value)}
          >
            {PROFILES.map((profile) => (
              <NativeSelectOption key={profile.id} value={profile.id}>
                {profile.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            이 프로필의 도구에서 고르고, 새 릴리스도 이 프로필로 만듭니다.
            카드에는 저장하지 않습니다.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Switch
            checked={draft.all}
            onCheckedChange={(on) =>
              setDraft({
                ...draft,
                all: on,
                tools:
                  on || draft.tools.length > 0
                    ? draft.tools
                    : offered.filter((tool) => !draft.forbidden.includes(tool)),
              })
            }
          />
          <FieldContent>
            <FieldLabel>릴리스할 때 프로필이 막지 않은 도구 전부</FieldLabel>
            <FieldDescription>
              릴리스를 만들 때 그 프로필이 막지 않은 도구로 정해집니다. 프로필
              새 버전에서 막기를 푼 도구는 새 릴리스부터 들어갑니다. 끄면
              아래에서 체크한 도구만 씁니다.
            </FieldDescription>
          </FieldContent>
        </Field>
        {offered.map((tool) =>
          row(
            tool,
            draft.forbidden.includes(tool)
              ? "금지 도구 · 아래에서 지우면 고를 수 있습니다"
              : NOTES[tool],
            false,
          ),
        )}
        {outside.map((tool) =>
          row(tool, "프로필에 없는 도구 · 끌 수만 있습니다", true),
        )}
        <FieldDescription>
          고른 도구를 모두 허용하는 프로필 {allowing}개
        </FieldDescription>
        <FieldError>
          {allowing === 0
            ? "고른 도구를 모두 허용하는 프로필이 없어 저장할 수 없습니다. 체크를 줄이거나 다른 모델을 고르세요."
            : undefined}
        </FieldError>
        {draft.forbidden.length > 0 ? (
          <FieldSet className="gap-2">
            <FieldLegend variant="label" className="mb-0">
              금지 도구
            </FieldLegend>
            <ul className="flex flex-wrap gap-1">
              {draft.forbidden.map((tool) => (
                <li key={tool}>
                  <Badge variant="mono">{tool}</Badge>
                </li>
              ))}
            </ul>
            <FieldDescription>
              전에 적어 둔 금지 도구입니다. 지우기 전에는 체크할 수 없고 쓰지
              않습니다.
            </FieldDescription>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft({ ...draft, forbidden: [] })}
              >
                금지 도구 지우기
              </Button>
            </div>
          </FieldSet>
        ) : null}
      </FieldSet>
      <div>
        <Button type="submit" disabled={allowing === 0}>
          저장
        </Button>
      </div>
    </form>
  );
}

const meta = {
  title: "Screens/Agent card tools",
  component: AgentCardToolsScreen,
  parameters: { layout: "padded" },
  args: { state: "all" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["all", "list", "outsideForbidden"],
    },
  },
} satisfies Meta<typeof AgentCardToolsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const AgentCardToolsAll: Story = { name: "Every tool (switch on)" };
export const AgentCardToolsList: Story = {
  name: "Checked tools (Bash off)",
  args: { state: "list" },
};
export const AgentCardToolsOutsideForbidden: Story = {
  name: "Not in the profile, blocked tools, cannot save",
  args: { state: "outsideForbidden" },
};
export const AgentCardToolsOutsideForbiddenMobile: Story = {
  name: "Not in the profile, blocked tools (390px)",
  args: { state: "outsideForbidden" },
  globals: MOBILE,
};
export const AgentCardToolsOutsideForbiddenMobileDark: Story = {
  name: "Not in the profile, blocked tools (390px, dark)",
  args: { state: "outsideForbidden" },
  globals: { ...MOBILE, theme: "dark" },
};
