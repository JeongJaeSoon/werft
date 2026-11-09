import type { Meta, StoryObj } from "@storybook/react-vite";
import { AGENT_DESCRIPTION_MAX_LENGTH } from "@werft-ai/contracts/agent-card";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Textarea,
} from "@werft-ai/ui";
import { useId } from "react";
import { MOBILE } from "./screen-kit.tsx";

/*
 * The card editor's name and description, as apps/web's
 * routes/agent-detail/card-editor.tsx draws them. The copy is
 * apps/web/src/i18n/agents.ts's agent.card.identity, agent.card.identityHint,
 * agents.name and agents.description, picked by the toolbar's locale.
 */

type Locale = "ko" | "en" | "ja";

// agent-card-form.tsx AGENT_FORM: the classes that size the label and the hint.
const AGENT_FORM =
  "flex w-full flex-col gap-4 rounded-card border bg-card p-4 [&_[data-slot=field-description]]:mt-0! [&_[data-slot=field-description]]:text-caption [&_[data-slot=field-label]]:text-control [&_[data-slot=field][data-orientation=vertical]]:gap-2";

const COPY: Record<
  Locale,
  {
    readonly legend: string;
    readonly hint: string;
    readonly name: string;
    readonly description: string;
  }
> = {
  ko: {
    legend: "이름과 설명",
    hint: "새 버전이나 릴리스 없이 바로 바뀝니다. 설치에서 플랫폼 안내를 켜 두었다면 새 세션부터 모델도 이 값을 에이전트의 이름과 설명으로 읽습니다. 맡을 일과 행동 방식은 저장소의 CLAUDE.md나 AGENTS.md에 적으세요.",
    name: "이름",
    description: "설명",
  },
  en: {
    legend: "Name and description",
    hint: "They change at once, with no new version or release. If platform guidance is turned on for this installation, the model also reads them as the agent's name and description, starting with the next new session. Put what it does and how it behaves in the repository's CLAUDE.md or AGENTS.md.",
    name: "Name",
    description: "Description",
  },
  ja: {
    legend: "名前と説明",
    hint: "新しいバージョンやリリースなしですぐに変わります。インストールでプラットフォーム案内を有効にしている場合は、新しいセッションからモデルもこの値をエージェントの名前と説明として読みます。任せる仕事と振る舞い方はリポジトリの CLAUDE.md や AGENTS.md に書いてください。",
    name: "名前",
    description: "説明",
  },
};

function AgentCardIdentityScreen({ locale }: { readonly locale: Locale }) {
  const { legend, hint, name, description } = COPY[locale];
  const nameId = useId();
  const descriptionId = useId();
  return (
    <div className="max-w-2xl">
      <form className={AGENT_FORM} onSubmit={(event) => event.preventDefault()}>
        <FieldSet className="gap-4">
          <FieldLegend>{legend}</FieldLegend>
          <FieldDescription>{hint}</FieldDescription>
          <Field>
            <FieldLabel htmlFor={nameId}>{name}</FieldLabel>
            <Input
              id={nameId}
              required={true}
              maxLength={120}
              defaultValue="결제 담당"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={descriptionId}>{description}</FieldLabel>
            <Textarea
              id={descriptionId}
              maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
              rows={3}
              defaultValue="결제 문의 담당"
            />
          </Field>
        </FieldSet>
      </form>
    </div>
  );
}

const meta = {
  title: "Screens/Agent card identity",
  component: AgentCardIdentityScreen,
  args: { locale: "ko" },
  render: (_args, context) => (
    <AgentCardIdentityScreen
      locale={(context.globals.locale ?? "ko") as Locale}
    />
  ),
} satisfies Meta<typeof AgentCardIdentityScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentCardIdentity: Story = { name: "Name and description" };
export const AgentCardIdentityMobile: Story = {
  name: "Name and description (390px)",
  globals: MOBILE,
};
export const AgentCardIdentityMobileDark: Story = {
  name: "Name and description (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};
export const AgentCardIdentityEnglishMobile: Story = {
  name: "Name and description (English, 390px)",
  globals: { ...MOBILE, locale: "en" },
};
export const AgentCardIdentityJapaneseMobile: Story = {
  name: "Name and description (Japanese, 390px)",
  globals: { ...MOBILE, locale: "ja" },
};
