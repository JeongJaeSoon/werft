import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  NativeSelect,
  NativeSelectOption,
} from "@werft-ai/ui";
import { useState } from "react";

// The pinned build's tool catalog, as profiles.stories.tsx lists it.
const CATALOG_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Bash",
  "AskUserQuestion",
  "WebFetch",
  "WebSearch",
] as const;

// The profiles the card editor stories used before, with the tools they run.
// What a profile blocks is the catalog without them.
const PROFILE_TOOLS = {
  "claude-coding-local": [
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash",
    "AskUserQuestion",
  ],
  general: ["Read", "Write", "Edit", "Glob", "Grep", "AskUserQuestion"],
} as const;

const PROFILES = (
  Object.keys(PROFILE_TOOLS) as (keyof typeof PROFILE_TOOLS)[]
).map((id) => ({
  id,
  label: `${id} v1 · claude-sonnet-5`,
  deny: CATALOG_TOOLS.filter(
    (tool) => !(PROFILE_TOOLS[id] as readonly string[]).includes(tool),
  ),
}));

type State = keyof typeof PROFILE_TOOLS;

function AgentCardToolsScreen({ state }: { readonly state: State }) {
  const [previewId, setPreviewId] = useState<string>(state);
  const deny = PROFILES.find((profile) => profile.id === previewId)?.deny ?? [];
  return (
    <form
      key={state}
      className="flex w-full max-w-xl flex-col gap-4 rounded-card border bg-card p-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <FieldSet className="gap-3">
        <FieldLegend variant="label">프로필이 막은 도구</FieldLegend>
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
            이 프로필이 막은 도구를 보여 주고, 새 릴리스도 이 프로필로 만듭니다.
            카드에는 저장하지 않습니다.
          </FieldDescription>
        </Field>
        <ul className="flex flex-wrap gap-1">
          {deny.map((tool) => (
            <li key={tool}>
              <Badge variant="mono">{tool}</Badge>
            </li>
          ))}
        </ul>
        <FieldDescription>
          에이전트가 쓰는 도구는 프로필이 정합니다. 에이전트마다 따로 고르지
          않습니다.
        </FieldDescription>
      </FieldSet>
      <div>
        <Button type="submit">저장</Button>
      </div>
    </form>
  );
}

const meta = {
  title: "Screens/Agent card tools",
  component: AgentCardToolsScreen,
  parameters: { layout: "padded" },
  args: { state: "claude-coding-local" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: PROFILES.map((profile) => profile.id),
    },
  },
} satisfies Meta<typeof AgentCardToolsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const AgentCardToolsBlocked: Story = {
  name: "Tools the profile blocks",
};
export const AgentCardToolsBlockedGeneral: Story = {
  name: "Tools the profile blocks (general)",
  args: { state: "general" },
};
export const AgentCardToolsBlockedMobile: Story = {
  name: "Tools the profile blocks (390px)",
  globals: MOBILE,
};
export const AgentCardToolsBlockedMobileDark: Story = {
  name: "Tools the profile blocks (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};
