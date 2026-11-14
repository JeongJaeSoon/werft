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
    `에이전트 ${agent}와(과) 하던 세션의 worker 이미지가 철회되어, 세션을 철회되지 않은 다른 이미지로 띄워요. 따로 할 일은 없어요. 옮긴 기록은 세션 기록에 남아요.`,
  ja: (agent) =>
    `エージェント ${agent} とのセッションの worker イメージが撤回されたため、セッションを撤回されていない別のイメージで起動します。何もする必要はありません。移した記録はセッションの記録に残ります。`,
  en: (agent) =>
    `The worker image for your session with agent ${agent} was retracted, so the session launches on another, unretracted image. There is nothing you need to do; the move is in the session's record.`,
};

/** The session link goes in the row's `link_url`. */
export function workerImageReplacedNoticeText(
  locale: UserLocale | null | undefined,
  agent: string,
): string {
  return COPY[locale ?? DEFAULT_USER_LOCALE](agent);
}
