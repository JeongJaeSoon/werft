import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertActions,
  AlertDescription,
  type AlertProps,
  AlertTitle,
  Button,
  SecretField,
} from "@werft-ai/ui";
import { Clock, Lock } from "lucide-react";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    keyTitle: "key 종류",
    keyText:
      "개인 key로 시작한 세션은 사람 세션으로 셉니다. 에이전트 key는 그 에이전트의 세션만 시작할 수 있고, 요청을 승인할 수 없습니다.",
    outputsTitle: "성과물은 턴이 끝날 때 저장됩니다",
    outputsText: "같은 이름의 파일은 새 버전으로 쌓이고 30일 동안 보관됩니다.",
    secretTitle: "ci-deploy key를 만들었습니다",
    secretText:
      "지금 복사해 두세요. 이 화면을 떠나면 값을 다시 볼 수 없습니다.",
    copy: "복사",
    copied: "복사했습니다",
    copyFailed: "복사하지 못했습니다. 위 칸의 값을 직접 선택해 복사하세요.",
    modelTitle: "기본 모델 claude-opus-5-5를 쓸 수 없습니다",
    modelText: "설치 설정 기준입니다. 다른 모델을 고르세요.",
    blockedTitle: "이 질문에는 답할 수 없습니다",
    blockedText: "질문을 받은 사람만 답할 수 있습니다.",
    usageTitle: "사용량은 매시 정각에 집계됩니다",
    retry: "다시 시도",
    long: "확인하지 못한 변경이 있습니다: ",
  },
  ja: {
    keyTitle: "key の種類",
    keyText:
      "個人 key で始めたセッションは人のセッションとして数えます。エージェント key はそのエージェントのセッションだけを開始でき、要求を承認できません。",
    outputsTitle: "成果物はターンの終わりに保存されます",
    outputsText:
      "同じ名前のファイルは新しいバージョンとして積み重なり、30 日間保管されます。",
    secretTitle: "ci-deploy key を作成しました",
    secretText:
      "今コピーしてください。この画面を離れると値を再表示できません。",
    copy: "コピー",
    copied: "コピーしました",
    copyFailed:
      "コピーできませんでした。上の欄の値を選択して手動でコピーしてください。",
    modelTitle: "既定モデル claude-opus-5-5 を使えません",
    modelText: "インストール設定に基づきます。別のモデルを選んでください。",
    blockedTitle: "この質問には回答できません",
    blockedText: "質問を受けた人だけが回答できます。",
    usageTitle: "使用量は毎正時に集計されます",
    retry: "再試行",
    long: "確認できていない変更があります: ",
  },
  en: {
    keyTitle: "Key types",
    keyText:
      "Sessions started with a personal key count as a person's sessions. An agent key starts only its agent's sessions and can't approve requests.",
    outputsTitle: "Outputs are saved when a turn ends",
    outputsText:
      "A file with the same name is kept as a new version for 30 days.",
    secretTitle: "Created the ci-deploy key",
    secretText:
      "Copy it now. Once you leave this page you won't be able to see it again.",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Couldn't copy. Select the value above and copy it yourself.",
    modelTitle: "The default model claude-opus-5-5 is not available",
    modelText: "Set in the install settings. Pick another model.",
    blockedTitle: "You can't answer this question",
    blockedText: "Only the person it was asked of can answer.",
    usageTitle: "Usage is counted on the hour",
    retry: "Try again",
    long: "There are changes not yet confirmed: ",
  },
} as const;

type Copy = (typeof COPY)[keyof typeof COPY];

function copyFor(locale: string): Copy {
  return COPY[locale === "ja" || locale === "en" ? locale : "ko"];
}

// A placeholder shaped like a key, not a real one.
const SAMPLE_KEY = `ak_example_${"0".repeat(40)}`;

const meta = {
  title: "Primitives/Alert",
  component: Alert,
  args: { variant: "default" },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "blue", "amber", "red"],
    },
  },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A standing note, such as an API key's. No `role`: a note that is there
 * every time the page opens is not announced. The title carries the meaning;
 * colour never does it alone.
 */
export const Default: Story = {
  render: (args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <Alert {...args}>
        <AlertTitle>{copy.keyTitle}</AlertTitle>
        <AlertDescription>{copy.keyText}</AlertDescription>
      </Alert>
    );
  },
};

/** The outputs tab's note (v4 blue banner). */
export const Blue: Story = {
  ...Default,
  args: { variant: "blue" },
  render: (args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <Alert {...args}>
        <AlertTitle>{copy.outputsTitle}</AlertTitle>
        <AlertDescription>{copy.outputsText}</AlertDescription>
      </Alert>
    );
  },
};

/**
 * A new key shown once (v4 amber banner). The value and its copy button sit
 * in `AlertActions`, 8px under the text. `role="status"`: the box appears
 * after the key is made and is announced once.
 */
export const AmberWithAction: Story = {
  name: "Amber with action",
  args: { variant: "amber", role: "status" },
  render: (args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <Alert {...args}>
        <AlertTitle>{copy.secretTitle}</AlertTitle>
        <AlertDescription>{copy.secretText}</AlertDescription>
        <AlertActions>
          <SecretField
            className="w-full"
            value={SAMPLE_KEY}
            copyLabel={copy.copy}
            copiedMessage={copy.copied}
            copyFailedMessage={copy.copyFailed}
          />
        </AlertActions>
      </Alert>
    );
  },
};

/**
 * An error that blocks the form (v4's default-model error). The caller adds
 * `role="alert"` because it interrupts.
 */
export const RedAlert: Story = {
  name: "Red (role=alert)",
  args: { variant: "red", role: "alert" },
  render: (args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <Alert {...args}>
        <AlertTitle>{copy.modelTitle}</AlertTitle>
        <AlertDescription>{copy.modelText}</AlertDescription>
        <AlertActions>
          <Button type="button" size="sm" variant="outline">
            {copy.retry}
          </Button>
        </AlertActions>
      </Alert>
    );
  },
};

/** `icon` replaces the variant's icon; `icon={null}` draws none. */
export const Icons: Story = {
  render: (args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <div className="flex flex-col gap-4">
        <Alert {...args} icon={<Lock strokeWidth={1.5} />}>
          <AlertTitle>{copy.blockedTitle}</AlertTitle>
          <AlertDescription>{copy.blockedText}</AlertDescription>
        </Alert>
        <Alert {...args} icon={<Clock strokeWidth={1.5} />}>
          <AlertTitle>{copy.usageTitle}</AlertTitle>
        </Alert>
        <Alert {...args} icon={null}>
          <AlertTitle>{copy.keyTitle}</AlertTitle>
          <AlertDescription>{copy.keyText}</AlertDescription>
        </Alert>
      </div>
    );
  },
};

/** A title alone, and a description alone. */
export const TitleOrDescriptionOnly: Story = {
  name: "Title or description only",
  render: (args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <div className="flex flex-col gap-4">
        <Alert {...args} variant="blue">
          <AlertTitle>{copy.outputsTitle}</AlertTitle>
        </Alert>
        <Alert {...args}>
          <AlertDescription>{copy.keyText}</AlertDescription>
        </Alert>
      </div>
    );
  },
};

/** An unbreakable identifier and a long title wrap inside the box. */
export const LongText: Story = {
  name: "Long text",
  args: { variant: "amber" },
  render: (args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <Alert {...args}>
        <AlertTitle>
          {copy.secretTitle} — {copy.outputsTitle} — {copy.keyTitle}
        </AlertTitle>
        <AlertDescription>
          {copy.long}
          <span className="font-mono">{`ses_${"0123456789abcdef".repeat(6)}`}</span>
        </AlertDescription>
        <AlertActions>
          <Button type="button" size="sm" variant="outline">
            {copy.retry}
          </Button>
          <Button type="button" size="sm" variant="ghost">
            {copy.copy}
          </Button>
        </AlertActions>
      </Alert>
    );
  },
};

const CALLOUT: [string, NonNullable<AlertProps["variant"]>][] = [
  ["(none)", "default"],
  ["info", "blue"],
  ["warning", "amber"],
  ["danger", "red"],
];

/**
 * The Callout request's tones map to these variants: info → `blue`,
 * warning → `amber`, danger → `red`; a plain note is `default` (grey).
 */
export const CalloutTones: Story = {
  name: "Callout tones",
  render: (args) => (
    <div className="flex flex-col gap-4">
      {CALLOUT.map(([tone, variant]) => (
        <Alert key={variant} {...args} variant={variant}>
          <AlertTitle>
            {tone} → variant="{variant}"
          </AlertTitle>
          <AlertDescription>
            Only the icon takes the tone's colour; the text stays the same.
          </AlertDescription>
        </Alert>
      ))}
    </div>
  ),
};

export const AllDark: Story = {
  name: "All variants (dark)",
  render: (args, ctx) => (
    <div className="flex flex-col gap-4">
      {Default.render?.({ ...args, variant: "default" }, ctx)}
      {Blue.render?.({ ...args, variant: "blue" }, ctx)}
      {AmberWithAction.render?.(
        { ...args, variant: "amber", role: "status" },
        ctx,
      )}
      {RedAlert.render?.({ ...args, variant: "red", role: "alert" }, ctx)}
    </div>
  ),
  globals: { theme: "dark" },
};

export const AllMobile: Story = {
  ...AllDark,
  name: "All variants (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const Japanese: Story = {
  ...AmberWithAction,
  name: "Amber with action (ja)",
  globals: { locale: "ja" },
};

export const English: Story = {
  ...RedAlert,
  name: "Red (en)",
  globals: { locale: "en" },
};

export const Korean: Story = {
  ...Blue,
  name: "Blue (ko)",
  globals: { locale: "ko" },
};

/**
 * `asChild` keeps the caller's element: apps/web's notices are `<output>`
 * (role status) and its credential warning is a `<section>` with an `<h3>`.
 */
export const AsChild: Story = {
  name: "asChild (output, section + h3)",
  render: (_args, { globals }) => {
    const copy = copyFor(globals.locale);
    return (
      <div className="flex flex-col gap-4">
        <Alert asChild variant="blue">
          <output>{copy.copied}</output>
        </Alert>
        <Alert asChild variant="amber" role="alert">
          <section>
            <AlertTitle asChild>
              <h3>{copy.blockedTitle}</h3>
            </AlertTitle>
            <AlertDescription>{copy.blockedText}</AlertDescription>
          </section>
        </Alert>
      </div>
    );
  },
};
