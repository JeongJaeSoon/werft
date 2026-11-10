import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";

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

const COPY: Record<UserLocale, Copy> = {
  ko: {
    pushed: (n) => `push했어요: ${n.repository} ${n.branch} (${short(n)})`,
    push_failed: (n) =>
      `push하지 못했어요: ${n.repository} ${n.branch} (${code(n)})`,
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
    push_failed: (n) =>
      `pushできませんでした: ${n.repository} ${n.branch} (${code(n)})`,
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
    push_failed: (n) =>
      `Could not push ${n.repository} ${n.branch} (${code(n)})`,
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
  return COPY[locale ?? DEFAULT_USER_LOCALE][notice.result](notice);
}
