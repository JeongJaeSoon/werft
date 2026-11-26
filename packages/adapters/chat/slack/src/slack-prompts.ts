import {
  answerTextInputSchema,
  type PendingQuestion,
  type QuestionAnswer,
  questionAnswerMismatch,
  SLACK_INTERACTION_ACTIONS,
  SLACK_NOTE_VIEW_CALLBACK,
  SLACK_NOTICE_MESSAGES,
  SLACK_QUESTION_VIEW_CALLBACK,
  type SlackInteractionValue,
  type SlackQuestionViewMetadata,
  type UserLocale,
} from "@werft-ai/contracts";
import type {
  PushRequestDisplay,
  SurfacePromptCard,
  ToolSummaryContext,
} from "@werft-ai/platform";
import type { SlackTextGuard } from "./slack-outbox-render.ts";
import { isSafeLink } from "./slack-presentation.ts";
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
  /** Allowing with an instruction the model reads with the call's result. */
  note: {
    button: string;
    title: string;
    label: string;
    loading: string;
    /** Blank or missing: Allow on the card is the way without one. */
    required: string;
    tooLong: string;
    /** The session cannot hand it over; nothing was allowed. */
    refused: string;
    /** With it, the parked turn's answers no longer fit in one message. */
    tooLongForTurn: string;
    /** Another answer settled the request first. */
    lost: string;
  };
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
  /** A typed answer over the API's byte cap. */
  answerTooLong: string;
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
  /** A private channel push whose requester left the channel. */
  pushRequesterLeft: string;
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
    note: {
      button: "지시와 함께 허용",
      title: "지시와 함께 허용",
      label: "에이전트에게 전할 지시",
      loading: "요청을 확인하고 있어요…",
      required:
        "지시를 입력해 주세요. 지시 없이 허용하려면 카드의 허용을 눌러 주세요",
      tooLong: "지시가 너무 길어요. 줄여서 다시 보내 주세요",
      refused:
        "이 세션은 지시를 에이전트에게 전할 수 없어서 허용하지 않았어요. 요청은 아직 열려 있어요. 지시 없이 허용하거나 거부해 주세요",
      tooLongForTurn:
        "이 지시까지 더하면 에이전트에게 보낼 답이 너무 길어져서 허용하지 않았어요. 요청은 아직 열려 있어요. 지시를 줄여 다시 보내 주세요",
      lost: "다른 답이 먼저 처리돼서 이 지시는 에이전트에게 전달되지 않았어요",
    },
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
    answerTooLong: "입력한 답이 너무 길어요. 줄여서 다시 보내 주세요",
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
    pushRequesterLeft: "요청자가 채널을 나갔어요",
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
    note: {
      button: "指示を付けて許可",
      title: "指示を付けて許可",
      label: "エージェントへの指示",
      loading: "リクエストを確認しています…",
      required:
        "指示を入力してください。指示なしで許可するには、カードの「許可」を押してください",
      tooLong: "指示が長すぎます。短くしてもう一度送信してください",
      refused:
        "このセッションは指示をエージェントに渡せないため、許可していません。リクエストはまだ開いています。指示なしで許可するか、拒否してください",
      tooLongForTurn:
        "この指示を加えるとエージェントに送る回答が長くなりすぎるため、許可していません。リクエストはまだ開いています。指示を短くしてもう一度送信してください",
      lost: "別の回答が先に処理されたため、この指示はエージェントに渡されていません",
    },
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
    answerTooLong: "入力した回答が長すぎます。短くしてもう一度送信してください",
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
    pushRequesterLeft: "依頼者がチャンネルを退出しました",
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
    note: {
      button: "Allow with instruction",
      title: "Allow with instruction",
      label: "Instruction for the agent",
      loading: "Checking the request…",
      required:
        "Type an instruction. To allow without one, press Allow on the card",
      tooLong: "The instruction is too long. Shorten it and send again",
      refused:
        "This session cannot hand an instruction to the agent, so nothing was allowed. The request is still open: allow it without an instruction, or deny it",
      tooLongForTurn:
        "With this instruction the answers to the agent would be too long, so nothing was allowed. The request is still open: Shorten the instruction and send again",
      lost: "Another answer was taken first, so this instruction was not handed to the agent",
    },
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
    answerTooLong: "Your answer is too long. Shorten it and send again",
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
    pushRequesterLeft: "The requester left the channel",
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

/**
 * The notice of a turn its worker's lost lease ended: what happened, the
 * button that goes on from it, and the console link. `continued`: the same
 * notice once someone pressed, with no button left to press.
 */
export function slackOwnershipLostNotice(input: {
  locale: UserLocale;
  sessionId: string;
  turnId: number;
  linkUrl?: string;
  continued?: boolean;
}): { text: string; blocks: unknown[] } {
  const copy = SLACK_NOTICE_MESSAGES[input.locale];
  const value: SlackInteractionValue = {
    s: input.sessionId,
    r: String(input.turnId),
  };
  const elements = [
    ...(input.continued
      ? []
      : [
          button(
            copy.ownershipLostContinue,
            SLACK_INTERACTION_ACTIONS.turnContinue,
            JSON.stringify(value),
            "primary",
          ),
        ]),
    ...(input.linkUrl !== undefined && isSafeLink(input.linkUrl)
      ? [
          {
            type: "button",
            action_id: SLACK_OPEN_WEB_ACTION,
            text: plain(
              SLACK_PROMPT_MESSAGES[input.locale].link,
              BUTTON_TEXT_MAX,
            ),
            url: input.linkUrl,
          },
        ]
      : []),
  ];
  return {
    text: copy.ownershipLost,
    blocks: [
      { type: "section", text: plain(copy.ownershipLost) },
      ...(input.continued
        ? [
            {
              type: "context",
              elements: [plain(copy.ownershipLostContinued)],
            },
          ]
        : []),
      ...(elements.length === 0 ? [] : [{ type: "actions", elements }]),
    ],
  };
}

/**
 * The notice of a turn whose outcome is unknown on a session with no
 * committed checkpoint: what happened, what the button gives up, the button
 * that runs the turn again in a new context, and the console link.
 * `continued`: the same notice once someone pressed, with no button left.
 */
export function slackStartFreshNotice(input: {
  locale: UserLocale;
  sessionId: string;
  turnId: number;
  linkUrl?: string;
  continued?: boolean;
}): { text: string; blocks: unknown[] } {
  const copy = SLACK_NOTICE_MESSAGES[input.locale];
  const value: SlackInteractionValue = {
    s: input.sessionId,
    r: String(input.turnId),
  };
  const elements = [
    ...(input.continued
      ? []
      : [
          button(
            copy.startFreshContinue,
            SLACK_INTERACTION_ACTIONS.turnStartFresh,
            JSON.stringify(value),
            "primary",
          ),
        ]),
    ...(input.linkUrl !== undefined && isSafeLink(input.linkUrl)
      ? [
          {
            type: "button",
            action_id: SLACK_OPEN_WEB_ACTION,
            text: plain(
              SLACK_PROMPT_MESSAGES[input.locale].link,
              BUTTON_TEXT_MAX,
            ),
            url: input.linkUrl,
          },
        ]
      : []),
  ];
  return {
    text: copy.startFresh,
    blocks: [
      { type: "section", text: plain(copy.startFresh) },
      {
        type: "context",
        elements: [
          plain(
            input.continued ? copy.startFreshContinued : copy.startFreshWarning,
          ),
        ],
      },
      ...(elements.length === 0 ? [] : [{ type: "actions", elements }]),
    ],
  };
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
  /** Run over the title and lines before they are escaped. */
  guard?: SlackTextGuard;
};

export function slackCardText(parts: SlackCardTextParts): string {
  const copy = SLACK_PROMPT_MESSAGES[parts.locale];
  const who = parts.mentionSlackUserId ? mention(parts.mentionSlackUserId) : "";
  const link =
    parts.linkUrl && isSafeLink(parts.linkUrl)
      ? `<${parts.linkUrl}|${escapeMrkdwn(copy.link)}>`
      : escapeMrkdwn(copy.openConsole);
  const guard =
    parts.guard === undefined ? (text: string) => text : cutAware(parts.guard);
  return [
    `${who ? `${who} ` : ""}${escapeMrkdwn(clip(guard(parts.title), PLAIN_TEXT_MAX))}`,
    ...(parts.lines ?? [])
      .map(guard)
      .filter((line) => line !== "")
      .map((line) => escapeMrkdwn(clip(line, PLAIN_TEXT_MAX))),
    link,
  ].join("\n");
}

/**
 * The blocks with the guard over every plain text in them, where a card's
 * model text goes; its mrkdwn is the platform's own. Slack refuses an
 * empty text, so one the guard empties keeps a mark.
 */
export function guardSlackCardBlocks<T>(node: T, guard?: SlackTextGuard): T {
  if (guard === undefined) return node;
  if (Array.isArray(node)) {
    return node.map((item) => guardSlackCardBlocks(item, guard)) as T;
  }
  if (typeof node !== "object" || node === null) return node;
  const entries = Object.entries(node).map(([key, value]) => [
    key,
    guardSlackCardBlocks(value, guard),
  ]);
  const record = Object.fromEntries(entries) as Record<string, unknown>;
  if (
    (record.type === "plain_text" || record.type === "text") &&
    typeof record.text === "string"
  ) {
    record.text = keptBy(guard)(record.text);
  }
  return record as T;
}

/**
 * A posted card's stored text, escaped as Slack reads it; when the guard
 * would change any of it read unescaped, the platform's words alone. The
 * escapes keep apart what the guard must read whole, so it reads the text
 * as the card was drawn from.
 */
export function slackGuardedCardText(
  stored: string,
  guard: SlackTextGuard,
  card: {
    locale: UserLocale;
    kind: SlackPrompt["kind"];
    linkUrl: string | null;
  },
): string {
  const raw = stored
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  if (cutAware(guard)(raw) === raw) return stored;
  const copy = SLACK_PROMPT_MESSAGES[card.locale];
  return slackCardText({
    locale: card.locale,
    title:
      card.kind === "permission"
        ? copy.permissionTitle
        : card.kind === "question"
          ? copy.questionTitle
          : copy.pushTitle,
    linkUrl: card.linkUrl,
  });
}

// A cut leaves `…` on what it cut, which a link or id it cut through would
// read as part of it: past the whole text, the guard reads each run around a
// mark on its own.
const cutAware = (guard: SlackTextGuard) => (text: string) =>
  guard(text).split("…").map(guard).join("…");

// Slack refuses an empty text, so one the guard empties keeps a mark.
const keptBy = (guard: SlackTextGuard) => (text: string) => {
  const kept = cutAware(guard)(text);
  return kept.trim() === "" && text.trim() !== "" ? "…" : kept;
};

/**
 * The value with its strings guarded. With `keys`, for an input shown as
 * written, its keys too, before JSON escapes them: a key the guard changes
 * takes a numbered name no other key has, so no field is lost or shown under
 * another's name. Read for its meaning (a summary), keys stay as they are.
 */
function guardedStrings(
  value: unknown,
  guard: (text: string) => string,
  keys = false,
): unknown {
  if (typeof value === "string") return guard(value);
  if (Array.isArray(value))
    return value.map((item) => guardedStrings(item, guard, keys));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  const taken = new Set(
    entries.map(([key]) => key).filter((key) => !keys || guard(key) === key),
  );
  return Object.fromEntries(
    entries.map(([key, item], index) => {
      let name = key;
      if (keys && guard(key) !== key) {
        for (let n = index + 1; name === key || taken.has(name); n += 1) {
          name = `${guard(key)} (${n})`;
        }
        taken.add(name);
      }
      return [name, guardedStrings(item, guard, keys)];
    }),
  );
}

function guardedQuestions(
  questions: PendingQuestion[],
  guard: (text: string) => string,
): PendingQuestion[] {
  return questions.map((question) => ({
    ...question,
    prompt: guard(question.prompt),
    options: question.options.map((option) => ({
      ...option,
      label: guard(option.label),
    })),
  }));
}

/** The request with its model-written fields guarded; ids stay as they are. */
function guardedPrompt(
  prompt: SlackPrompt,
  guard?: SlackTextGuard,
): SlackPrompt {
  if (guard === undefined) return prompt;
  const kept = keptBy(guard);
  switch (prompt.kind) {
    case "permission":
      return {
        ...prompt,
        tool: kept(prompt.tool),
        input: guardedStrings(prompt.input, kept),
        context: guardedStrings(prompt.context, kept) as ToolSummaryContext,
        ...(prompt.rememberOffer === undefined
          ? {}
          : {
              rememberOffer: prompt.rememberOffer.map((rule) => ({
                toolName: kept(rule.toolName),
                ...(rule.ruleContent === undefined
                  ? {}
                  : { ruleContent: kept(rule.ruleContent) }),
              })),
            }),
      };
    case "question":
      return { ...prompt, questions: guardedQuestions(prompt.questions, kept) };
    case "push":
      return {
        ...prompt,
        repositoryName:
          prompt.repositoryName === null ? null : kept(prompt.repositoryName),
        targetBranch: kept(prompt.targetBranch),
      };
  }
}

/** A stored request's display with its model-written fields guarded. */
function guardedDisplay(
  display: SurfacePromptCard["display"],
  guard?: SlackTextGuard,
): SurfacePromptCard["display"] {
  if (guard === undefined) return display;
  const kept = keptBy(guard);
  switch (display.kind) {
    case "permission":
      return {
        ...display,
        tool: kept(display.tool),
        input: guardedStrings(display.input, kept),
        context: guardedStrings(display.context, kept) as ToolSummaryContext,
      };
    case "question":
      return {
        ...display,
        questions: guardedQuestions(display.questions, kept),
      };
    case "push":
      return {
        ...display,
        repositoryName:
          display.repositoryName === null ? null : kept(display.repositoryName),
        targetBranch: kept(display.targetBranch),
      };
  }
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
  /** G7 and A3 over the card's text, in its conversation's scope. */
  guard?: SlackTextGuard;
};

export function slackPromptMessage(
  asked: SlackPrompt,
  options: SlackPromptMessageOptions,
): { text: string; blocks: unknown[] } {
  const prompt = guardedPrompt(asked, options.guard);
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
    const preview = inputPreview(
      options.guard === undefined
        ? prompt.input
        : guardedStrings(prompt.input, keptBy(options.guard), true),
    );
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
        button(
          copy.note.button,
          SLACK_INTERACTION_ACTIONS.permissionAllowNote,
          value,
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
      ...(options.guard === undefined ? {} : { guard: options.guard }),
    }),
    blocks: guardSlackCardBlocks(blocks, options.guard),
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
  display: SurfacePromptCard["display"],
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
  display: Exclude<SurfacePromptCard["display"], { kind: "question" }>,
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
  display: Extract<SurfacePromptCard["display"], { kind: "question" }>,
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
export function slackSettledCard(
  card: SurfacePromptCard,
  guard?: SlackTextGuard,
): SlackCard | null {
  const drawn = settledCard(
    { ...card, display: guardedDisplay(card.display, guard) },
    guard,
  );
  return drawn === null
    ? null
    : { text: drawn.text, blocks: guardSlackCardBlocks(drawn.blocks, guard) };
}

function settledCard(
  card: SurfacePromptCard,
  guard: SlackTextGuard | undefined,
): SlackCard | null {
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
    `${title}${slackCardText({ locale: card.locale, title: "", lines, linkUrl: link, ...(guard === undefined ? {} : { guard }) })}`;

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
  card: SurfacePromptCard & {
    display: { kind: "push" } & PushRequestDisplay;
  },
  ids: { sessionId: string; requestId: string },
  guard?: SlackTextGuard,
): SlackCard {
  const copy = SLACK_PROMPT_MESSAGES[card.locale];
  // An intent push never goes stale by a newer commit; it is here because its
  // pinned revision stopped verifying.
  const reason =
    card.pushRevisions?.origin === "intent"
      ? copy.pushPinnedSourceInvalid
      : copy.pushStale;
  const repositoryName =
    card.display.repositoryName === null || guard === undefined
      ? card.display.repositoryName
      : keptBy(guard)(card.display.repositoryName);
  const summary = `${repositoryName ?? card.display.repositoryId} ← ${shortCommit(card.display.gitCommit)}`;
  return {
    text: slackCardText({
      locale: card.locale,
      title: reason,
      lines: [summary],
      linkUrl: linkOf(card.linkUrl),
      ...(guard === undefined ? {} : { guard }),
    }),
    blocks: guardSlackCardBlocks(
      [
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
      guard,
    ),
  };
}

/**
 * A private channel card whose requester left the channel: the card as it
 * was, with a line saying so above its buttons. A session allow a member
 * gives here is bound to that member, as any other.
 */
export function slackRequesterLeftCard(
  card: SlackCard,
  locale: UserLocale,
): SlackCard {
  const label = SLACK_PROMPT_MESSAGES[locale].pushRequesterLeft;
  const note = {
    type: "context",
    elements: [
      { type: "mrkdwn", text: `:information_source: ${escapeMrkdwn(label)}` },
    ],
  };
  const blocks = [...card.blocks];
  const actions = blocks
    .map((block) => (block as { type?: unknown }).type)
    .lastIndexOf("actions");
  blocks.splice(actions === -1 ? blocks.length : actions, 0, note);
  return { text: `${card.text}\n${escapeMrkdwn(label)}`, blocks };
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
  asked: PendingQuestion[],
  metadata: SlackQuestionViewMetadata,
  locale: UserLocale,
  guard?: SlackTextGuard,
): Record<string, unknown> | null {
  const questions =
    guard === undefined ? asked : guardedQuestions(asked, keptBy(guard));
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
    blocks: guardSlackCardBlocks(blocks, guard),
  };
}

/** A modal that only says something: while loading, or why it cannot ask. */
export function slackNoticeView(
  text: string,
  locale: UserLocale,
  title = SLACK_PROMPT_MESSAGES[locale].modalTitle,
): Record<string, unknown> {
  const copy = SLACK_PROMPT_MESSAGES[locale];
  return {
    type: "modal",
    title: plain(title, MODAL_TITLE_MAX),
    close: plain(copy.cancel, MODAL_TITLE_MAX),
    blocks: [{ type: "section", text: plain(text) }],
  };
}

const NOTE_BLOCK = "note";

/**
 * The modal for allowing a permission request with an instruction. The
 * input is optional to Slack so that a blank one gets this platform's words,
 * not Slack's.
 */
export function slackNoteView(
  metadata: SlackQuestionViewMetadata,
  locale: UserLocale,
): Record<string, unknown> {
  const copy = SLACK_PROMPT_MESSAGES[locale];
  return {
    type: "modal",
    callback_id: SLACK_NOTE_VIEW_CALLBACK,
    private_metadata: JSON.stringify(metadata),
    title: plain(copy.note.title, MODAL_TITLE_MAX),
    submit: plain(copy.allow, MODAL_TITLE_MAX),
    close: plain(copy.cancel, MODAL_TITLE_MAX),
    blocks: [
      {
        type: "input",
        block_id: NOTE_BLOCK,
        optional: true,
        label: plain(copy.note.label, LABEL_MAX),
        element: {
          type: "plain_text_input",
          action_id: VALUE_ACTION,
          multiline: true,
        },
      },
    ],
  };
}

/** The instruction a submitted note modal gives, or the error to show. */
export function slackNoteText(
  values: ViewValues,
  locale: UserLocale,
): { ok: true; text: string } | { ok: false; errors: Record<string, string> } {
  const copy = SLACK_PROMPT_MESSAGES[locale].note;
  const typed = (
    values[NOTE_BLOCK]?.[VALUE_ACTION] as { value?: unknown } | undefined
  )?.value;
  const text = typeof typed === "string" ? typed.trim() : "";
  if (text === "")
    return { ok: false, errors: { [NOTE_BLOCK]: copy.required } };
  if (!answerTextInputSchema.safeParse(text).success) {
    return { ok: false, errors: { [NOTE_BLOCK]: copy.tooLong } };
  }
  return { ok: true, text };
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
    if (
      freeText !== null &&
      !answerTextInputSchema.safeParse(freeText).success
    ) {
      errors[textBlock(index)] = copy.answerTooLong;
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
