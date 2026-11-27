import {
  DEFAULT_USER_LOCALE,
  type UserLocale,
  type WorkflowsPushReason,
} from "@werft-ai/contracts";

/**
 * What an `action_notice` row tells the thread. One row per result, keyed
 * `action:<push request id>:<result>`, so a result is told at most once. A
 * push that ends before it became a request (`push_cancelled`) has no push
 * request id and is keyed by its intent instead (`intentNoticeDedupeKey`).
 */
export const ACTION_NOTICE_RESULTS = [
  "pushed",
  "push_failed",
  "opened",
  "pr_updated",
  "pr_failed",
  "pr_closed",
  "pr_uncertain",
  "push_cancelled",
] as const;
export type ActionNoticeResult = (typeof ACTION_NOTICE_RESULTS)[number];

export function actionNoticeDedupeKey(
  pushRequestId: string,
  result: ActionNoticeResult,
): string {
  return `action:${pushRequestId}:${result}`;
}

/** An intent ends once, so its notice is keyed by the intent alone. */
export function intentNoticeDedupeKey(pushIntentId: string): string {
  return `intent:${pushIntentId}:ended`;
}

/**
 * The facts a notice states. Only platform-made values go in: ids, branch
 * names, numbers, and the public codes of a refusal or a stage error. No
 * text an agent or a forge wrote reaches a notice.
 */
export type ActionNotice = {
  result: ActionNoticeResult;
  /** `owner/name` from the catalog; the catalog id when it has none. */
  repository: string;
  branch: string;
  /** Absent for a push that ended before a commit was pinned to a request. */
  commit?: string;
  number?: number;
  url?: string;
  /** A refusal or stage error code. */
  reason?: string;
};

type Copy = Record<ActionNoticeResult, (notice: ActionNotice) => string>;

const short = (notice: ActionNotice) => (notice.commit ?? "").slice(0, 7);
const code = (notice: ActionNotice) => notice.reason ?? "unknown";

/** The refusals a notice puts in words; any other keeps its code. */
type ExplainedPushReason =
  | WorkflowsPushReason
  | "default_branch"
  | "non_fast_forward"
  | "repository_not_allowed";

/**
 * A push that was refused for one of these says why, and whom to ask, in
 * place of the code: the reader is the person who asked for the change, not
 * the one who can turn a permission on.
 */
const PUSH_WHY: Record<UserLocale, Record<ExplainedPushReason, string>> = {
  ko: {
    workflows_off:
      'workflow 파일을 push하려면 Werft에서 "workflow 파일 수정과 CI 결과 보기"를 켜야 해요. 워크스페이스 관리자에게 에이전트 GitHub 설정에서 켜 달라고 요청하세요.',
    workflows_permission_missing:
      "workflow 파일을 push하려면 GitHub App에 Workflows 권한이 필요해요. 워크스페이스 관리자에게 요청하세요.",
    workflows_refused:
      "workflow 파일을 push하려면 Workflows 권한이 필요해요. 워크스페이스 관리자에게 에이전트 GitHub 설정과 GitHub App 권한을 확인해 달라고 요청하세요.",
    default_branch:
      "기본 브랜치에는 바로 push하지 않아요. 에이전트에게 작업 브랜치로 push하고 PR을 열어 달라고 요청하세요.",
    non_fast_forward:
      "원격 브랜치가 앞서 있어서 덮어쓰지 않았어요. 에이전트에게 원격 변경을 받아 온 뒤 다시 push해 달라고 요청하세요.",
    repository_not_allowed:
      "이 에이전트는 이 저장소에 push할 수 없어요. 에이전트 관리자에게 에이전트 GitHub 설정에서 저장소와 push 허용을 확인해 달라고 요청하세요.",
  },
  ja: {
    workflows_off:
      "workflowファイルをpushするには、Werftで「ワークフローファイルの変更と CI 結果の確認」をオンにする必要があります。ワークスペース管理者に、エージェントのGitHub設定でオンにするよう依頼してください。",
    workflows_permission_missing:
      "workflowファイルをpushするには、GitHub AppにWorkflows権限が必要です。ワークスペース管理者に依頼してください。",
    workflows_refused:
      "workflowファイルをpushするには、Workflows権限が必要です。ワークスペース管理者に、エージェントのGitHub設定とGitHub Appの権限を確認するよう依頼してください。",
    default_branch:
      "デフォルトブランチには直接pushしません。エージェントに、作業ブランチへpushしてPRを作成するよう依頼してください。",
    non_fast_forward:
      "リモートブランチが先に進んでいるため、上書きしませんでした。エージェントに、リモートの変更を取り込んでからもう一度pushするよう依頼してください。",
    repository_not_allowed:
      "このエージェントはこのリポジトリにpushできません。エージェントの管理者に、エージェントのGitHub設定でリポジトリとpushの許可を確認するよう依頼してください。",
  },
  en: {
    workflows_off:
      'Pushing a workflow file needs "Edit workflow files and see CI results" turned on in Werft. Ask a workspace admin to turn it on in the agent\'s GitHub settings.',
    workflows_permission_missing:
      "Pushing a workflow file needs the Workflows permission on the GitHub App. Ask a workspace admin for it.",
    workflows_refused:
      "Pushing a workflow file needs the Workflows permission. Ask a workspace admin to check the agent's GitHub settings and the GitHub App's permissions.",
    default_branch:
      "Werft does not push straight to the default branch. Ask the agent to push a work branch and open a pull request.",
    non_fast_forward:
      "The remote branch is ahead, so it was not overwritten. Ask the agent to bring in the remote changes and push again.",
    repository_not_allowed:
      "This agent cannot push to this repository. Ask a person who manages the agent to check the repository and its push setting in the agent's GitHub settings.",
  },
};

const pushWhy = (locale: UserLocale, notice: ActionNotice) =>
  Object.hasOwn(PUSH_WHY[locale], notice.reason ?? "")
    ? PUSH_WHY[locale][notice.reason as ExplainedPushReason]
    : undefined;

const PUSH_FAILED: Record<UserLocale, (notice: ActionNotice) => string> = {
  ko: (n) => `push하지 못했어요: ${n.repository} ${n.branch}`,
  ja: (n) => `pushできませんでした: ${n.repository} ${n.branch}`,
  en: (n) => `Could not push ${n.repository} ${n.branch}`,
};

const COPY: Record<UserLocale, Copy> = {
  ko: {
    pushed: (n) => `push했어요: ${n.repository} ${n.branch} (${short(n)})`,
    push_failed: (n) => `${PUSH_FAILED.ko(n)} (${code(n)})`,
    opened: (n) => `PR #${n.number}을 열었어요: ${n.repository}`,
    pr_updated: (n) =>
      `열려 있던 PR #${n.number}에 새 push(${short(n)})를 반영했어요: ${n.repository}`,
    pr_failed: (n) =>
      `PR을 열지 못했어요: ${n.repository} ${n.branch} (${code(n)})`,
    pr_closed: (n) =>
      `이 push의 PR #${n.number}이 이미 닫혔어요: ${n.repository}`,
    pr_uncertain: (n) =>
      `PR이 열렸는지 확인하지 못했어요 (${code(n)}). GitHub에서 ${n.repository} ${n.branch}를 확인해 주세요.`,
    push_cancelled: (n) =>
      `push 요청이 진행되지 않고 끝났어요: ${n.repository} ${n.branch} (${code(n)}). 다시 push하려면 다시 요청해 주세요.`,
  },
  ja: {
    pushed: (n) => `pushしました: ${n.repository} ${n.branch} (${short(n)})`,
    push_failed: (n) => `${PUSH_FAILED.ja(n)} (${code(n)})`,
    opened: (n) => `PR #${n.number} を作成しました: ${n.repository}`,
    pr_updated: (n) =>
      `作成済みの PR #${n.number} に新しい push (${short(n)}) を反映しました: ${n.repository}`,
    pr_failed: (n) =>
      `PRを作成できませんでした: ${n.repository} ${n.branch} (${code(n)})`,
    pr_closed: (n) =>
      `このpushのPR #${n.number} はすでにクローズされています: ${n.repository}`,
    pr_uncertain: (n) =>
      `PRが作成されたか確認できませんでした (${code(n)})。GitHubで ${n.repository} ${n.branch} を確認してください。`,
    push_cancelled: (n) =>
      `pushリクエストは実行されずに終了しました: ${n.repository} ${n.branch} (${code(n)})。pushするにはもう一度依頼してください。`,
  },
  en: {
    pushed: (n) => `Pushed ${n.repository} ${n.branch} (${short(n)})`,
    push_failed: (n) => `${PUSH_FAILED.en(n)} (${code(n)})`,
    opened: (n) => `Opened PR #${n.number} in ${n.repository}`,
    pr_updated: (n) =>
      `Updated the open PR #${n.number} in ${n.repository} with the new push (${short(n)})`,
    pr_failed: (n) =>
      `Could not open a PR for ${n.repository} ${n.branch} (${code(n)})`,
    pr_closed: (n) =>
      `PR #${n.number} for this push was already closed in ${n.repository}`,
    pr_uncertain: (n) =>
      `Could not confirm whether a PR was opened (${code(n)}). Check ${n.repository} ${n.branch} on GitHub.`,
    push_cancelled: (n) =>
      `The push request ended without a push: ${n.repository} ${n.branch} (${code(n)}). Ask again to push.`,
  },
};

/**
 * The notice's words in the reader's language (English when unknown). The
 * link goes in the row's `link_url`, which the outbox labels itself.
 */
export function actionNoticeText(
  locale: UserLocale | null | undefined,
  notice: ActionNotice,
): string {
  const language = locale ?? DEFAULT_USER_LOCALE;
  const why =
    notice.result === "push_failed" || notice.result === "push_cancelled"
      ? pushWhy(language, notice)
      : undefined;
  return why === undefined
    ? COPY[language][notice.result](notice)
    : `${PUSH_FAILED[language](notice)}\n${why}`;
}
