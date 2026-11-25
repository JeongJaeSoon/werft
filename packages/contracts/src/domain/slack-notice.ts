import { z } from "zod";

import { INT4_MAX } from "../shared/index.ts";

export const slackNoticeApprovalIdSchema = z
  .uuid()
  .brand<"SlackNoticeApprovalId">();
export type SlackNoticeApprovalId = z.infer<typeof slackNoticeApprovalIdSchema>;
export const slackNoticeVersionSchema = z
  .number()
  .int()
  .min(1)
  .max(INT4_MAX)
  .brand<"SlackNoticeVersion">();
export type SlackNoticeVersion = z.infer<typeof slackNoticeVersionSchema>;

/** The languages every notice version is written in. */
export const SLACK_NOTICE_LOCALE_VALUES = ["ko", "ja"] as const;
export const slackNoticeLocaleSchema = z.enum(SLACK_NOTICE_LOCALE_VALUES);
export type SlackNoticeLocale = z.infer<typeof slackNoticeLocaleSchema>;

/** A version's words in one language, drawn as written. */
export type SlackNoticeText = {
  readonly body: readonly string[];
  readonly policyLink: { readonly label: string; readonly href: string };
};

/**
 * One version of the notice a workspace owner or admin approves for an
 * agent's Slack app before the agent listens there.
 */
export type SlackNoticeVersionEntry = {
  readonly version: SlackNoticeVersion;
  readonly text: Readonly<Record<SlackNoticeLocale, SlackNoticeText>>;
  /**
   * False for a version that only rewords the one before: approvals of the
   * earlier versions still count.
   */
  readonly requiresReapproval: boolean;
};

/**
 * The docs page each version links to, in the notice's language. The page
 * carries the same version number as the notice that links to it.
 */
export function slackDataPolicyUrl(locale: SlackNoticeLocale): string {
  return `https://jeongjaesoon.github.io/werft/${locale}/integrations/slack-data/`;
}

/**
 * Oldest first, versions increasing. Publishing a version is adding an entry
 * here; the words of a published version never change.
 */
export const SLACK_NOTICE_VERSIONS: readonly SlackNoticeVersionEntry[] = [
  {
    version: slackNoticeVersionSchema.parse(1),
    requiresReapproval: true,
    text: {
      ko: {
        body: [
          "Werft는 Slack에서 읽은 글로 어떤 AI 모델도 학습시키지 않아요.",
          "에이전트는 이 조직이 연결한 모델 키로 모델을 부르고, 그 글은 그 모델 제공자의 데이터 정책을 따라요.",
          "에이전트가 Slack 글에서 무엇을 저장하고 언제 지우는지는 아래 문서에 적었어요.",
        ],
        policyLink: {
          label: "데이터 처리와 저장 (1판)",
          href: slackDataPolicyUrl("ko"),
        },
      },
      ja: {
        body: [
          "Werft は、Slack で読んだメッセージでどの AI モデルも学習させません。",
          "エージェントはこの組織が接続したモデルキーでモデルを呼び出し、そのメッセージはそのモデル提供元のデータポリシーに従います。",
          "エージェントが Slack のメッセージから何を保存し、いつ削除するかは、下のドキュメントに記載しています。",
        ],
        policyLink: {
          label: "データの取り扱いと保存（第1版）",
          href: slackDataPolicyUrl("ja"),
        },
      },
    },
  },
];

/** The versions an approval must fall within to count. */
export type SlackNoticeWindow = {
  readonly current: SlackNoticeVersion;
  /** The latest version that asked for a new approval, or the first one. */
  readonly oldestCounted: SlackNoticeVersion;
};

/** Null when there is no notice yet. Throws on a list whose versions do not increase. */
export function slackNoticeWindow(
  versions: readonly SlackNoticeVersionEntry[],
): SlackNoticeWindow | null {
  const [first] = versions;
  if (first === undefined) return null;
  let current = first.version;
  let oldestCounted = first.version;
  for (const entry of versions.slice(1)) {
    if (entry.version <= current) {
      throw new Error("Slack notice versions must increase");
    }
    current = entry.version;
    if (entry.requiresReapproval) oldestCounted = entry.version;
  }
  return { current, oldestCounted };
}
