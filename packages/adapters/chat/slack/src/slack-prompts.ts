import {
  type PendingQuestion,
  type QuestionAnswer,
  questionAnswerMismatch,
  SLACK_INTERACTION_ACTIONS,
  SLACK_QUESTION_VIEW_CALLBACK,
  type SlackInteractionValue,
  type SlackQuestionViewMetadata,
  type UserLocale,
} from "@werft-ai/contracts";
import type {
  PushRequestDisplay,
  SlackPromptCard,
  ToolSummaryContext,
} from "@werft-ai/platform";
import { summarizeToolRequest } from "./slack-prompt-summary.ts";

/** A request a session waits on that a person can settle in its thread. */
export type SlackPrompt =
  | {
      kind: "permission";
      sessionId: string;
      requestId: string;
      tool: string;
      input: unknown;
      context: ToolSummaryContext;
      /** Present, the card also offers to allow these rules for the session. */
      rememberOffer?: readonly { toolName: string; ruleContent?: string }[];
      expiresAt: string;
    }
  | {
      kind: "question";
      sessionId: string;
      requestId: string;
      questions: PendingQuestion[];
      expiresAt: string;
    }
  | {
      kind: "push";
      sessionId: string;
      requestId: string;
      repositoryId: string;
      /** The catalog's owner/name; null shows the id. */
      repositoryName: string | null;
      targetBranch: string;
      gitCommit: string;
    };

/** How a request ended, as its card says once it is settled. */
export type SlackPromptResult =
  | "allowed"
  | "allowedSession"
  | "denied"
  | "answered"
  | "approved"
  | "rejected"
  | "expired"
  | "closed";

/** A result a person chose, as opposed to one the request ran out to. */
export type SlackDecidedResult = Exclude<
  SlackPromptResult,
  "expired" | "closed"
>;

/** Where a request was settled, when the caller knows. */
export type SlackDecisionPath = "slack" | "web";

type PromptCopy = {
  permissionTitle: string;
  questionTitle: string;
  pushTitle: string;
  tool: string;
  repository: string;
  branch: string;
  commit: string;
  allow: string;
  /** Keeps the engine's proposed rules until the session ends. */
  allowSession: string;
  /** The confirm dialog's text; `{rule}` is the rules, in plain words. */
  allowSessionConfirm: string;
  deny: string;
  approve: string;
  reject: string;
  answer: string;
  freeText: string;
  modalTitle: string;
  submit: string;
  cancel: string;
  freeTextLabel: string;
  pushConfirm: string;
  expires: string;
  link: string;
  answerRequired: string;
  loading: string;
  /** The form closed on a request this person cannot answer here. */
  unavailable: string;
  retry: string;
  /** A push was decided, but the session could not be told. */
  followUpFailed: string;
  /** The folded raw input's title; `{tool}` is the tool's name. */
  rawInput: string;
  details: string;
  /** How a settled card ended, decided in Slack or by no one. */
  settled: Record<SlackPromptResult, string>;
  /** How a settled card ended, decided on the web. */
  settledOnWeb: Record<SlackDecidedResult, string>;
  /** A question's answer under it: `{answer}` is the chosen labels. */
  chosen: Record<SlackDecisionPath, string>;
  /** Stands in for a typed answer, whose words the thread never shows. */
  typedAnswer: string;
  /** A push card left with Reject only. */
  pushStale: string;
  /** An intent push whose pinned revision no longer verifies. */
  pushPinnedSourceInvalid: string;
  /** A turn's notice from before the cards, once its turn waits no more. */
  done: string;
  answerOnWeb: string;
  openConsole: string;
  /** Shown when the card is pressed after someone else settled it. */
  already: Record<SlackPromptResult, string>;
};

// Product copy: plain words, no internal module names.
export const SLACK_PROMPT_MESSAGES: Readonly<Record<UserLocale, PromptCopy>> = {
  ko: {
    permissionTitle: "도구 사용 허용이 필요해요",
    questionTitle: "답이 필요한 질문이 있어요",
    pushTitle: "push 승인이 필요해요",
    tool: "도구",
    repository: "저장소",
    branch: "브랜치",
    commit: "커밋",
    allow: "허용",
    allowSession: "이 세션 동안 허용",
    allowSessionConfirm:
      "이 세션이 끝날 때까지 다음을 묻지 않고 허용해요: {rule}",
    deny: "거부",
    approve: "승인",
    reject: "거절",
    answer: "답하기",
    freeText: "직접 입력",
    modalTitle: "질문에 답하기",
    submit: "보내기",
    cancel: "취소",
    freeTextLabel: "직접 입력한 답",
    pushConfirm: "이 커밋을 브랜치에 push해요",
    expires: "답하지 않으면 {time}에 만료돼요",
    link: "웹에서 열기",
    answerRequired: "답을 고르거나 입력해 주세요",
    loading: "질문을 불러오고 있어요…",
    unavailable:
      "이 요청은 여기서 답할 수 없어요. 스레드의 안내를 확인해 주세요",
    retry: "잠시 뒤 다시 제출해 주세요",
    followUpFailed:
      "결정은 반영됐지만 세션에 알리지 못했어요. 이 스레드에 답글을 달면 세션이 이어져요",
    rawInput: "입력 원본 ({tool})",
    details: "자세히",
    settled: {
      allowed: "허용됨",
      allowedSession: "이 세션 동안 허용됨",
      denied: "거부됨",
      answered: "답함",
      approved: "push 승인됨",
      rejected: "push 거절됨",
      expired: "만료됨",
      closed: "더 이상 답할 수 없어요",
    },
    settledOnWeb: {
      allowed: "웹에서 허용됨",
      allowedSession: "웹에서 이 세션 동안 허용됨",
      denied: "웹에서 거부됨",
      answered: "웹에서 답함",
      approved: "웹에서 push 승인됨",
      rejected: "웹에서 push 거절됨",
    },
    chosen: { slack: "{answer} 선택됨", web: "웹에서 {answer} 선택됨" },
    typedAnswer: "직접 입력",
    pushStale: "새 커밋이 생겨 이 push는 승인할 수 없어요",
    pushPinnedSourceInvalid:
      "이 push가 가리키는 체크포인트를 더는 확인할 수 없어 승인할 수 없어요",
    done: "처리됐어요",
    answerOnWeb: "이 요청은 웹에서 답해 주세요",
    openConsole: "웹 콘솔에서 확인해 주세요",
    already: {
      allowed: "이미 허용된 요청이에요",
      allowedSession: "이미 이 세션 동안 허용된 요청이에요",
      denied: "이미 거부된 요청이에요",
      answered: "이미 답한 요청이에요",
      approved: "이미 승인된 push 요청이에요",
      rejected: "이미 거절된 push 요청이에요",
      expired: "만료된 요청이에요",
      closed: "만료됐거나 더 이상 답할 수 없는 요청이에요",
    },
  },
  ja: {
    permissionTitle: "ツールの使用許可が必要です",
    questionTitle: "回答が必要な質問があります",
    pushTitle: "pushの承認が必要です",
    tool: "ツール",
    repository: "リポジトリ",
    branch: "ブランチ",
    commit: "コミット",
    allow: "許可",
    allowSession: "このセッション中は許可",
    allowSessionConfirm:
      "このセッションが終わるまで、次を確認せずに許可します: {rule}",
    deny: "拒否",
    approve: "承認",
    reject: "却下",
    answer: "回答する",
    freeText: "直接入力",
    modalTitle: "質問に回答",
    submit: "送信",
    cancel: "キャンセル",
    freeTextLabel: "直接入力した回答",
    pushConfirm: "このコミットをブランチにpushします",
    expires: "回答がない場合、{time}に期限切れになります",
    link: "Webで開く",
    answerRequired: "回答を選ぶか入力してください",
    loading: "質問を読み込んでいます…",
    unavailable:
      "このリクエストにはここで回答できません。スレッドの案内を確認してください",
    retry: "しばらくしてからもう一度送信してください",
    followUpFailed:
      "決定は反映されましたが、セッションに伝えられませんでした。このスレッドに返信するとセッションが続きます",
    rawInput: "入力の原文 ({tool})",
    details: "詳細",
    settled: {
      allowed: "許可済み",
      allowedSession: "セッション中は許可",
      denied: "拒否済み",
      answered: "回答済み",
      approved: "push承認済み",
      rejected: "push却下済み",
      expired: "期限切れ",
      closed: "もう回答できません",
    },
    settledOnWeb: {
      allowed: "Webで許可済み",
      allowedSession: "Webでセッション中は許可",
      denied: "Webで拒否済み",
      answered: "Webで回答済み",
      approved: "Webでpush承認済み",
      rejected: "Webでpush却下済み",
    },
    chosen: { slack: "{answer}を選択", web: "Webで{answer}を選択" },
    typedAnswer: "直接入力",
    pushStale: "新しいコミットがあるため、このpushは承認できません",
    pushPinnedSourceInvalid:
      "このpushが指すチェックポイントを確認できないため、承認できません",
    done: "対応済みです",
    answerOnWeb: "このリクエストはWebで回答してください",
    openConsole: "Webコンソールで確認してください",
    already: {
      allowed: "すでに許可されたリクエストです",
      allowedSession: "すでにセッション中は許可されたリクエストです",
      denied: "すでに拒否されたリクエストです",
      answered: "すでに回答したリクエストです",
      approved: "すでに承認されたpushリクエストです",
      rejected: "すでに却下されたpushリクエストです",
      expired: "期限切れのリクエストです",
      closed: "期限切れか、もう回答できないリクエストです",
    },
  },
  en: {
    permissionTitle: "A tool needs your permission",
    questionTitle: "A question needs your answer",
    pushTitle: "A push needs your approval",
    tool: "Tool",
    repository: "Repository",
    branch: "Branch",
    commit: "Commit",
    allow: "Allow",
    allowSession: "Allow for session",
    allowSessionConfirm:
      "Until this session ends, this is allowed without asking: {rule}",
    deny: "Deny",
    approve: "Approve",
    reject: "Reject",
    answer: "Answer",
    freeText: "Type an answer",
    modalTitle: "Answer the question",
    submit: "Send",
    cancel: "Cancel",
    freeTextLabel: "Your own answer",
    pushConfirm: "This pushes the commit to the branch",
    expires: "Expires at {time} if no one answers",
    link: "Open on the web",
    answerRequired: "Choose or type an answer",
    loading: "Loading the question…",
    unavailable:
      "This request can't be answered here. See the note in the thread",
    retry: "Please submit again in a moment",
    followUpFailed:
      "The decision is recorded, but the session could not be told. Reply in this thread to continue it",
    rawInput: "Raw input ({tool})",
    details: "Details",
    settled: {
      allowed: "Allowed",
      allowedSession: "Allowed for session",
      denied: "Denied",
      answered: "Answered",
      approved: "Push approved",
      rejected: "Push rejected",
      expired: "Expired",
      closed: "Can no longer be answered",
    },
    settledOnWeb: {
      allowed: "Allowed on the web",
      allowedSession: "Allowed for session on the web",
      denied: "Denied on the web",
      answered: "Answered on the web",
      approved: "Push approved on the web",
      rejected: "Push rejected on the web",
    },
    chosen: { slack: "Chose {answer}", web: "Chose {answer} on the web" },
    typedAnswer: "a typed answer",
    pushStale: "A newer commit means this push can no longer be approved",
    pushPinnedSourceInvalid:
      "The checkpoint this push points at can no longer be verified, so it cannot be approved",
    done: "Handled",
    answerOnWeb: "Please answer this request on the web",
    openConsole: "Check it in the web console",
    already: {
      allowed: "This request was already allowed",
      allowedSession: "This request was already allowed for the session",
      denied: "This request was already denied",
      answered: "This request was already answered",
      approved: "This push request was already approved",
      rejected: "This push request was already rejected",
      expired: "This request has expired",
      closed: "This request expired or can no longer be answered",
    },
  },
};

// Slack's limits on the fields used here.
const PLAIN_TEXT_MAX = 3000;
const BUTTON_TEXT_MAX = 75;
const OPTION_TEXT_MAX = 75;
const LABEL_MAX = 2000;
const MODAL_TITLE_MAX = 24;
const INPUT_PREVIEW_MAX = 2500;
const OPTIONS_MAX = 100;
const QUESTIONS_MAX = 10;
const OPTION_BUTTONS_MAX = 5;
const CONTAINER_TITLE_MAX = 150;
const FIELD_MAX = 2000;
const CONTEXT_TEXT_MAX = 3000;
const BRANCH_MAX = 40;
const QUESTION_HEAD_MAX = 200;
// The confirm dialog's 300 characters, less the longest sentence around the rule.
const RULE_SENTENCE_MAX = 200;

const SLACK_ID = /^[A-Z0-9]{1,64}$/;

const clip = (value: string, max: number) => {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
};
const plain = (text: string, max = PLAIN_TEXT_MAX) => ({
  type: "plain_text",
  text: clip(text, max),
  emoji: false,
});
const mention = (slackUserId: string) =>
  SLACK_ID.test(slackUserId) ? `<@${slackUserId}>` : "";

function isSafeLink(url: string): boolean {
  if (/[<>|\s]/.test(url)) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function slackPromptValue(
  prompt: Pick<SlackPrompt, "sessionId" | "requestId">,
  option?: number,
): string {
  const value: SlackInteractionValue = {
    s: prompt.sessionId,
    r: prompt.requestId,
    ...(option === undefined ? {} : { o: String(option) }),
  };
  return JSON.stringify(value);
}

function button(
  text: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger",
  confirm?: Record<string, unknown>,
) {
  return {
    type: "button",
    action_id: actionId,
    text: plain(text, BUTTON_TEXT_MAX),
    value,
    ...(style === undefined ? {} : { style }),
    ...(confirm === undefined ? {} : { confirm }),
  };
}

function answersByButton(questions: PendingQuestion[]): boolean {
  const [only] = questions;
  return (
    questions.length === 1 &&
    only !== undefined &&
    !only.multi_select &&
    only.options.length > 0 &&
    only.options.length <= OPTION_BUTTONS_MAX
  );
}

function slackDate(iso: string): string {
  const seconds = Math.floor(Date.parse(iso) / 1000);
  return Number.isFinite(seconds)
    ? `<!date^${seconds}^{date_short_pretty} {time}|${iso}>`
    : iso;
}

/**
 * The raw input as a person reads it: an object's fields one by one, a
 * string field's own line breaks kept rather than shown as `\n`. An input
 * with nothing to list (`{}`, `""`, `null`) shows as JSON, so the card says
 * the input was empty; null only when there is no JSON form at all.
 */
function inputPreview(input: unknown): string | null {
  if (input === undefined) return null;
  let text: string;
  try {
    if (input === null) {
      text = "null";
    } else if (typeof input === "string") {
      text = input;
    } else if (typeof input === "object" && !Array.isArray(input)) {
      text = Object.entries(input)
        .map(([key, value]) => {
          if (typeof value !== "string") {
            return `${key}: ${JSON.stringify(value, null, 2) ?? String(value)}`;
          }
          return value.includes("\n")
            ? `${key}:\n${value}`
            : `${key}: ${value}`;
        })
        .join("\n");
    } else {
      text = JSON.stringify(input, null, 2) ?? "";
    }
    if (text === "") text = JSON.stringify(input) ?? "";
  } catch {
    return null;
  }
  return text === "" ? null : clip(text, INPUT_PREVIEW_MAX);
}

/** The three characters Slack reads as controls in mrkdwn. */
const escapeMrkdwn = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A card's top-level `text`: what notifications, screen readers and clients
 * that cannot draw blocks show. Slack reads it as mrkdwn, so every piece is
 * escaped but a checked mention and a link the platform made; without a
 * link it says to look in the web console.
 */
export type SlackCardTextParts = {
  locale: UserLocale;
  title: string;
  mentionSlackUserId?: string | null;
  lines?: readonly string[];
  linkUrl?: string | null;
};

export function slackCardText(parts: SlackCardTextParts): string {
  const copy = SLACK_PROMPT_MESSAGES[parts.locale];
  const who = parts.mentionSlackUserId ? mention(parts.mentionSlackUserId) : "";
  const link =
    parts.linkUrl && isSafeLink(parts.linkUrl)
      ? `<${parts.linkUrl}|${escapeMrkdwn(copy.link)}>`
      : escapeMrkdwn(copy.openConsole);
  return [
    `${who ? `${who} ` : ""}${escapeMrkdwn(clip(parts.title, PLAIN_TEXT_MAX))}`,
    ...(parts.lines ?? [])
      .filter((line) => line !== "")
      .map((line) => escapeMrkdwn(clip(line, PLAIN_TEXT_MAX))),
    link,
  ].join("\n");
}

function preformatted(text: string) {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_preformatted",
        elements: [{ type: "text", text }],
      },
    ],
  };
}

/** Folded by default: what a person may open, never what they decide on. */
function folded(title: string, child: unknown) {
  return {
    type: "container",
    is_collapsible: true,
    default_collapsed: true,
    title: plain(title, CONTAINER_TITLE_MAX),
    child_blocks: [child],
  };
}

const summaryLine = ({
  verb,
  target,
}: {
  verb: string;
  target: string | null;
}) => (target === null ? verb : `${verb}: ${target}`);

const shortCommit = (commit: string) => commit.slice(0, 7);

/** Long branch names lose their middle, where agent branches differ least. */
function shortBranch(branch: string): string {
  const chars = [...branch];
  if (chars.length <= BRANCH_MAX) return branch;
  const head = Math.floor((BRANCH_MAX - 1) / 2);
  const tail = BRANCH_MAX - 1 - head;
  return `${chars.slice(0, head).join("")}…${chars.slice(-tail).join("")}`;
}

/** Too many questions or options for the modal: answered on the web. */
function drawable(questions: PendingQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.length <= QUESTIONS_MAX &&
    questions.every((question) => question.options.length <= OPTIONS_MAX)
  );
}

/**
 * The card for a request: a fixed title, the request in plain words, the
 * raw input folded, its buttons, and when it expires. Model-written text
 * never goes in a mrkdwn field, so it cannot mention anyone or hide a link.
 */
export type SlackPromptMessageOptions = {
  locale: UserLocale;
  requesterSlackUserId: string | null;
  linkUrl?: string;
};

export function slackPromptMessage(
  prompt: SlackPrompt,
  options: SlackPromptMessageOptions,
): { text: string; blocks: unknown[] } {
  const copy = SLACK_PROMPT_MESSAGES[options.locale];
  const title =
    prompt.kind === "permission"
      ? copy.permissionTitle
      : prompt.kind === "question"
        ? copy.questionTitle
        : copy.pushTitle;
  const who =
    options.requesterSlackUserId === null
      ? ""
      : mention(options.requesterSlackUserId);
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${who ? `${who} ` : ""}*${title}*` },
    },
  ];
  const value = slackPromptValue(prompt);
  const link =
    options.linkUrl !== undefined && isSafeLink(options.linkUrl)
      ? options.linkUrl
      : null;
  let line: string;

  if (prompt.kind === "permission") {
    const summary = summarizeToolRequest(
      prompt.tool,
      prompt.input,
      prompt.context,
      options.locale,
    );
    line = summaryLine(summary);
    blocks.push({ type: "section", text: plain(line) });
    if (summary.excerpt !== null) blocks.push(preformatted(summary.excerpt));
    const preview = inputPreview(prompt.input);
    if (preview !== null) {
      blocks.push(
        folded(
          copy.rawInput.replace("{tool}", prompt.tool),
          preformatted(preview),
        ),
      );
    }
    blocks.push({
      type: "actions",
      elements: [
        button(
          copy.allow,
          SLACK_INTERACTION_ACTIONS.permissionAllow,
          value,
          "primary",
        ),
        // Agreeing covers every offered rule, so the dialog must be able to
        // name all of them; a longer offer gets no button.
        ...(prompt.rememberOffer === undefined ||
        prompt.rememberOffer.length === 0 ||
        ruleSentence(prompt.rememberOffer).length > RULE_SENTENCE_MAX
          ? []
          : [
              button(
                copy.allowSession,
                SLACK_INTERACTION_ACTIONS.permissionAllowSession,
                value,
                undefined,
                {
                  title: plain(copy.allowSession, 100),
                  text: plain(
                    // A function, so `$'` or `$$` in a rule is not read as a
                    // replacement pattern.
                    copy.allowSessionConfirm.replace("{rule}", () =>
                      ruleSentence(prompt.rememberOffer ?? []),
                    ),
                    300,
                  ),
                  confirm: plain(copy.allowSession, 30),
                  deny: plain(copy.cancel, 30),
                },
              ),
            ]),
        button(
          copy.deny,
          SLACK_INTERACTION_ACTIONS.permissionDeny,
          value,
          "danger",
        ),
      ],
    });
    // The rules the session button keeps, in the card itself and not only in
    // the dialog behind the button.
    if (
      prompt.rememberOffer !== undefined &&
      prompt.rememberOffer.length > 0 &&
      ruleSentence(prompt.rememberOffer).length <= RULE_SENTENCE_MAX
    ) {
      blocks.push({
        type: "context",
        elements: [
          plain(
            `${copy.allowSession}: ${copy.allowSessionConfirm.replace("{rule}", () => ruleSentence(prompt.rememberOffer ?? []))}`,
            300,
          ),
        ],
      });
    }
  } else if (prompt.kind === "question" && !drawable(prompt.questions)) {
    line = clip(prompt.questions[0]?.prompt ?? "", QUESTION_HEAD_MAX);
    blocks.push({ type: "section", text: plain(copy.answerOnWeb) });
    if (link !== null) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: SLACK_OPEN_WEB_ACTION,
            text: plain(copy.link, BUTTON_TEXT_MAX),
            url: link,
          },
        ],
      });
    }
  } else if (prompt.kind === "question") {
    line = clip(prompt.questions[0]?.prompt ?? "", QUESTION_HEAD_MAX);
    for (const question of prompt.questions) {
      const listed = answersByButton(prompt.questions)
        ? ""
        : question.options
            .slice(0, OPTIONS_MAX)
            .map((option) => `\n• ${option.label}`)
            .join("");
      blocks.push({
        type: "section",
        text: plain(`${question.prompt}${listed}`),
      });
    }
    const [only] = prompt.questions;
    if (answersByButton(prompt.questions) && only !== undefined) {
      blocks.push({
        type: "actions",
        elements: [
          ...only.options.map((option, index) =>
            button(
              option.label,
              `${SLACK_INTERACTION_ACTIONS.questionOption}:${index}`,
              slackPromptValue(prompt, index),
            ),
          ),
          ...(only.allow_free_text
            ? [
                button(
                  copy.freeText,
                  SLACK_INTERACTION_ACTIONS.questionOpen,
                  value,
                ),
              ]
            : []),
        ],
      });
    } else {
      blocks.push({
        type: "actions",
        elements: [
          button(
            copy.answer,
            SLACK_INTERACTION_ACTIONS.questionOpen,
            value,
            "primary",
          ),
        ],
      });
    }
  } else {
    const repository = prompt.repositoryName ?? prompt.repositoryId;
    line = `${repository} · ${prompt.targetBranch}`;
    blocks.push({
      type: "section",
      fields: [
        plain(copy.repository, FIELD_MAX),
        plain(repository, FIELD_MAX),
        plain(copy.branch, FIELD_MAX),
        plain(shortBranch(prompt.targetBranch), FIELD_MAX),
        plain(copy.commit, FIELD_MAX),
        plain(shortCommit(prompt.gitCommit), FIELD_MAX),
      ],
    });
    blocks.push(
      folded(
        copy.details,
        preformatted(
          `${copy.branch}: ${prompt.targetBranch}\n${copy.commit}: ${prompt.gitCommit}`,
        ),
      ),
    );
    blocks.push({
      type: "actions",
      elements: [
        button(
          copy.approve,
          SLACK_INTERACTION_ACTIONS.pushApprove,
          value,
          "primary",
          {
            title: plain(copy.pushTitle, 100),
            text: plain(
              `${copy.pushConfirm}\n${prompt.targetBranch} ← ${prompt.gitCommit.slice(0, 12)}`,
              300,
            ),
            confirm: plain(copy.approve, 30),
            deny: plain(copy.cancel, 30),
          },
        ),
        button(
          copy.reject,
          SLACK_INTERACTION_ACTIONS.pushReject,
          value,
          "danger",
        ),
      ],
    });
  }

  const meta = [
    ...("expiresAt" in prompt
      ? [copy.expires.replace("{time}", slackDate(prompt.expiresAt))]
      : []),
    ...(link === null ? [] : [`<${link}|${copy.link}>`]),
  ];
  if (meta.length > 0) {
    blocks.push({
      type: "context",
      block_id: PROMPT_META_BLOCK,
      elements: [{ type: "mrkdwn", text: meta.join(" · ") }],
    });
  }
  return {
    text: slackCardText({
      locale: options.locale,
      title,
      mentionSlackUserId: options.requesterSlackUserId,
      lines: [line],
      linkUrl: link,
    }),
    blocks,
  };
}

const PROMPT_META_BLOCK = "prompt.meta";
/** A link button: Slack opens the URL and sends a press nothing acts on. */
const SLACK_OPEN_WEB_ACTION = "prompt.open_web";

/**
 * The offered rules in plain words for the confirm dialog, which takes
 * plain_text only. The rules arrive redacted like the card's input, so
 * nothing here needs hiding; the text is cut to fit what is left of the
 * dialog's 300 characters.
 */
function ruleSentence(
  rules: readonly { toolName: string; ruleContent?: string }[],
): string {
  return rules
    .map((rule) =>
      rule.ruleContent === undefined
        ? rule.toolName
        : `${rule.toolName}(${rule.ruleContent})`,
    )
    .join(", ");
}

const SETTLED_MARK: Record<SlackPromptResult, string> = {
  allowed: ":white_check_mark:",
  allowedSession: ":white_check_mark:",
  denied: ":no_entry_sign:",
  answered: ":speech_balloon:",
  approved: ":white_check_mark:",
  rejected: ":no_entry_sign:",
  expired: ":hourglass:",
  closed: ":white_circle:",
};

/** How a request ended, or null while a person can still settle it. */
export function slackSettledResult(
  display: SlackPromptCard["display"],
): SlackPromptResult | null {
  if (display.kind === "push") {
    if (display.state === "requested") return null;
    return display.state === "rejected" ? "rejected" : "approved";
  }
  if (display.state === "open") return null;
  if (display.state === "closed") {
    return display.closedReason === "expired" ? "expired" : "closed";
  }
  if (display.kind === "question") return "answered";
  if (display.decision !== "allow") return "denied";
  return display.remember === "session" ? "allowedSession" : "allowed";
}

/** A permission or push in one line, as a settled card keeps it. */
function settledSummary(
  display: Exclude<SlackPromptCard["display"], { kind: "question" }>,
  locale: UserLocale,
): string {
  if (display.kind === "push") {
    return `${display.repositoryName ?? display.repositoryId} ← ${shortCommit(display.gitCommit)} · ${shortBranch(display.targetBranch)}`;
  }
  return summaryLine(
    summarizeToolRequest(display.tool, display.input, display.context, locale),
  );
}

/**
 * The labels a person chose for one question, or null when they chose
 * none. A typed answer was seen by whoever typed it only; the thread is
 * told one was given, never its words.
 */
function chosenLabels(
  display: Extract<SlackPromptCard["display"], { kind: "question" }>,
  question: PendingQuestion,
  locale: UserLocale,
): string | null {
  const answer = display.answers.find(
    (item) => item.question_id === question.question_id,
  );
  if (answer === undefined) return null;
  const given = [
    ...answer.selected_option_ids.flatMap((id) => {
      const option = question.options.find((item) => item.option_id === id);
      return option === undefined ? [] : [option.label];
    }),
    ...(answer.typed ? [SLACK_PROMPT_MESSAGES[locale].typedAnswer] : []),
  ];
  return given.length === 0 ? null : given.join(", ");
}

type SlackCard = { text: string; blocks: unknown[] };

const linkOf = (url: string | null) =>
  url !== null && isSafeLink(url) ? url : null;

const linkElements = (link: string | null, locale: UserLocale) =>
  link === null
    ? []
    : [
        {
          type: "mrkdwn",
          text: `<${link}|${escapeMrkdwn(SLACK_PROMPT_MESSAGES[locale].link)}>`,
        },
      ];

/**
 * The settled card, drawn from the request as stored rather than from a
 * pressed message, so the press and the redraw of a card settled elsewhere
 * draw the same blocks: how it ended and where (`웹에서 허용됨`), the
 * decider's mention, the request and the web link. A question keeps its
 * full text with the answer under it. Null while the request is open.
 */
export function slackSettledCard(card: SlackPromptCard): SlackCard | null {
  const result = slackSettledResult(card.display);
  if (result === null) return null;
  const copy = SLACK_PROMPT_MESSAGES[card.locale];
  const decided = result !== "expired" && result !== "closed";
  // A decision whose path was not recorded reads as Slack's, unnamed.
  const via: SlackDecisionPath = card.decidedVia ?? "slack";
  const decider =
    decided &&
    card.deciderSlackUserId !== null &&
    SLACK_ID.test(card.deciderSlackUserId)
      ? card.deciderSlackUserId
      : null;
  const label =
    decided && via === "web"
      ? copy.settledOnWeb[result as SlackDecidedResult]
      : copy.settled[result];
  // Platform copy, escaped, with only a checked mention.
  const head = `*${escapeMrkdwn(label)}*${decider === null ? "" : ` · ${mention(decider)}`}`;
  const mark = SETTLED_MARK[result];
  const link = linkOf(card.linkUrl);
  const textOf = (lines: string[], title = head) =>
    `${title}${slackCardText({ locale: card.locale, title: "", lines, linkUrl: link })}`;

  if (card.display.kind !== "question") {
    const summary = settledSummary(card.display, card.locale);
    return {
      text: textOf([summary]),
      blocks: [
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `${mark} ${head}` },
            ...(summary === "" ? [] : [plain(summary, CONTEXT_TEXT_MAX)]),
            ...linkElements(link, card.locale),
          ],
        },
      ],
    };
  }

  const display = card.display;
  const questions = display.questions.slice(0, QUESTIONS_MAX);
  const blocks: unknown[] = [];
  const lines: string[] = [];
  const answers = questions.map((question) => {
    const labels =
      result === "answered"
        ? chosenLabels(display, question, card.locale)
        : null;
    return labels === null
      ? null
      : copy.chosen[questions.length === 1 ? via : "slack"].replace(
          "{answer}",
          () => labels,
        );
  });
  const [onlyAnswer] = answers;
  // One answered question folds the path and decider into its answer line:
  // `웹에서 <label> 선택됨 · @who`.
  if (
    questions.length === 1 &&
    onlyAnswer !== null &&
    onlyAnswer !== undefined
  ) {
    const [question] = questions;
    const prompt = question?.prompt ?? "";
    lines.push(prompt, onlyAnswer);
    return {
      text: textOf(lines),
      blocks: [
        { type: "section", text: plain(prompt) },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: mark },
            plain(onlyAnswer, CONTEXT_TEXT_MAX),
            ...(decider === null
              ? []
              : [{ type: "mrkdwn", text: `· ${mention(decider)}` }]),
            ...linkElements(link, card.locale),
          ],
        },
      ],
    };
  }
  questions.forEach((question, index) => {
    blocks.push({ type: "section", text: plain(question.prompt) });
    lines.push(question.prompt);
    const answer = answers[index];
    if (answer !== null && answer !== undefined) {
      blocks.push({
        type: "context",
        elements: [plain(answer, CONTEXT_TEXT_MAX)],
      });
      lines.push(answer);
    }
  });
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `${mark} ${head}` },
      ...linkElements(link, card.locale),
    ],
  });
  return { text: textOf(lines), blocks };
}

/**
 * A push card the latest checkpoint has moved past: it can still be
 * rejected, never approved, so only Reject stays.
 */
export function slackRejectOnlyCard(
  card: SlackPromptCard & {
    display: { kind: "push" } & PushRequestDisplay;
  },
  ids: { sessionId: string; requestId: string },
): SlackCard {
  const copy = SLACK_PROMPT_MESSAGES[card.locale];
  // An intent push never goes stale by a newer commit; it is here because its
  // pinned revision stopped verifying.
  const reason =
    card.pushRevisions?.origin === "intent"
      ? copy.pushPinnedSourceInvalid
      : copy.pushStale;
  const summary = `${card.display.repositoryName ?? card.display.repositoryId} ← ${shortCommit(card.display.gitCommit)}`;
  return {
    text: slackCardText({
      locale: card.locale,
      title: reason,
      lines: [summary],
      linkUrl: linkOf(card.linkUrl),
    }),
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `:warning: *${escapeMrkdwn(reason)}*`,
          },
          plain(summary, CONTEXT_TEXT_MAX),
        ],
      },
      {
        type: "actions",
        elements: [
          button(
            copy.reject,
            SLACK_INTERACTION_ACTIONS.pushReject,
            slackPromptValue(ids),
            "danger",
          ),
        ],
      },
    ],
  };
}

/** A turn's notice from before the cards, once its turn waits no more. */
export function slackDoneCard(
  locale: UserLocale,
  linkUrl: string | null,
): SlackCard {
  const copy = SLACK_PROMPT_MESSAGES[locale];
  const link = linkOf(linkUrl);
  return {
    text: slackCardText({ locale, title: copy.done, linkUrl: link }),
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `:white_circle: *${escapeMrkdwn(copy.done)}*`,
          },
          ...linkElements(link, locale),
        ],
      },
    ],
  };
}

const VALUE_ACTION = "v";
const choiceBlock = (index: number) => `q${index}`;
const textBlock = (index: number) => `q${index}.text`;

/** The modal for a question request; null when it has too many to show. */
export function slackQuestionView(
  questions: PendingQuestion[],
  metadata: SlackQuestionViewMetadata,
  locale: UserLocale,
): Record<string, unknown> | null {
  if (questions.length === 0 || questions.length > QUESTIONS_MAX) return null;
  const copy = SLACK_PROMPT_MESSAGES[locale];
  const blocks: unknown[] = [];
  for (const [index, question] of questions.entries()) {
    if (question.options.length > OPTIONS_MAX) return null;
    if (question.options.length > 0) {
      blocks.push({
        type: "input",
        block_id: choiceBlock(index),
        optional: question.allow_free_text,
        label: plain(question.prompt, LABEL_MAX),
        element: {
          type: question.multi_select ? "multi_static_select" : "static_select",
          action_id: VALUE_ACTION,
          options: question.options.map((option, optionIndex) => ({
            text: plain(option.label, OPTION_TEXT_MAX),
            value: String(optionIndex),
          })),
        },
      });
    }
    if (question.allow_free_text) {
      blocks.push({
        type: "input",
        block_id: textBlock(index),
        optional: question.options.length > 0,
        label: plain(
          question.options.length > 0 ? copy.freeTextLabel : question.prompt,
          LABEL_MAX,
        ),
        element: {
          type: "plain_text_input",
          action_id: VALUE_ACTION,
          multiline: true,
        },
      });
    }
  }
  return {
    type: "modal",
    callback_id: SLACK_QUESTION_VIEW_CALLBACK,
    private_metadata: JSON.stringify(metadata),
    title: plain(copy.modalTitle, MODAL_TITLE_MAX),
    submit: plain(copy.submit, MODAL_TITLE_MAX),
    close: plain(copy.cancel, MODAL_TITLE_MAX),
    blocks,
  };
}

/** A modal that only says something: while loading, or why it cannot ask. */
export function slackNoticeView(
  text: string,
  locale: UserLocale,
): Record<string, unknown> {
  const copy = SLACK_PROMPT_MESSAGES[locale];
  return {
    type: "modal",
    title: plain(copy.modalTitle, MODAL_TITLE_MAX),
    close: plain(copy.cancel, MODAL_TITLE_MAX),
    blocks: [{ type: "section", text: plain(text) }],
  };
}

type ViewValues = Record<string, Record<string, unknown>>;

function selectedIndexes(state: unknown): number[] {
  const element = state as {
    selected_option?: { value?: unknown } | null;
    selected_options?: { value?: unknown }[] | null;
  } | null;
  const picked = [
    ...(element?.selected_option ? [element.selected_option] : []),
    ...(element?.selected_options ?? []),
  ];
  return picked.map((option) =>
    typeof option.value === "string" && /^\d{1,3}$/.test(option.value)
      ? Number(option.value)
      : -1,
  );
}

/**
 * The answers a submitted modal gives, or the message to show under the
 * block that needs fixing. The options are those of the request as stored,
 * so a value the modal never offered cannot become an answer.
 */
export function slackQuestionAnswers(
  questions: PendingQuestion[],
  values: ViewValues,
  locale: UserLocale,
):
  | { ok: true; answers: QuestionAnswer[] }
  | { ok: false; errors: Record<string, string> } {
  const copy = SLACK_PROMPT_MESSAGES[locale];
  const answers: QuestionAnswer[] = [];
  const errors: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const picked = selectedIndexes(values[choiceBlock(index)]?.[VALUE_ACTION]);
    const selected = picked.map((at) => question.options[at]?.option_id);
    const typed = (
      values[textBlock(index)]?.[VALUE_ACTION] as
        | { value?: unknown }
        | undefined
    )?.value;
    const freeText =
      typeof typed === "string" && typed.trim() !== "" ? typed.trim() : null;
    const where =
      question.options.length > 0 ? choiceBlock(index) : textBlock(index);
    if (selected.some((id) => id === undefined)) {
      errors[where] = copy.answerRequired;
      continue;
    }
    if (selected.length === 0 && freeText === null) {
      errors[where] = copy.answerRequired;
      continue;
    }
    answers.push({
      question_id: question.question_id,
      selected_option_ids: selected as string[],
      ...(freeText === null ? {} : { free_text: freeText }),
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const mismatch = questionAnswerMismatch(questions, answers);
  if (mismatch !== null) {
    return {
      ok: false,
      errors: {
        [questions[0]?.options.length ? choiceBlock(0) : textBlock(0)]:
          copy.answerRequired,
      },
    };
  }
  return { ok: true, answers };
}

/** The answer one option button gives, or null for an index not offered. */
export function slackOptionAnswer(
  questions: PendingQuestion[],
  option: string | undefined,
): QuestionAnswer[] | null {
  const [only] = questions;
  if (
    !answersByButton(questions) ||
    only === undefined ||
    option === undefined ||
    !/^\d{1,3}$/.test(option)
  ) {
    return null;
  }
  const picked = only.options[Number(option)];
  return picked === undefined
    ? null
    : [
        {
          question_id: only.question_id,
          selected_option_ids: [picked.option_id],
        },
      ];
}
