import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";

/**
 * One DM per Slack account per launch that moved off a retracted image. A
 * Slack user id is unique only within its installation's team.
 */
export function workerImageReplacedDedupeKey(
  workspaceId: string,
  sessionId: string,
  generation: number,
  installationId: string,
  slackUserId: string,
): string {
  return `worker-image-replaced:${workspaceId}:${sessionId}:${generation}:${installationId}:${slackUserId}`;
}

const COPY: Record<UserLocale, (agent: string) => string> = {
  ko: (agent) =>
    `에이전트 ${agent}와(과) 하던 세션이 쓰던 worker 이미지가 철회됐어요. 세션은 같은 계열의 수정된 이미지로 옮겨 이어 가요. 따로 할 일은 없어요. 옮긴 기록은 세션 기록에 남아요.`,
  ja: (agent) =>
    `エージェント ${agent} とのセッションが使っていた worker イメージが撤回されました。セッションは同じ系列の修正イメージに移って続きます。何もする必要はありません。移した記録はセッションの記録に残ります。`,
  en: (agent) =>
    `The worker image your session with agent ${agent} ran on was retracted. The session moves to a fixed image of the same line and carries on; there is nothing you need to do. The move is in the session's record.`,
};

/** The session link goes in the row's `link_url`. */
export function workerImageReplacedNoticeText(
  locale: UserLocale | null | undefined,
  agent: string,
): string {
  return COPY[locale ?? DEFAULT_USER_LOCALE](agent);
}
