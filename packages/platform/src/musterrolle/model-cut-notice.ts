import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";

/**
 * One DM per person per session, however many attempts the proxy cuts after
 * the model left the profile's list. Someone who becomes an administrator
 * between two cuts is told at the next one.
 */
export function modelCutDedupeKey(
  workspaceId: string,
  sessionId: string,
  slackUserId: string,
): string {
  return `model-not-allowed:${workspaceId}:${sessionId}:${slackUserId}`;
}

const COPY: Record<UserLocale, (model: string) => string> = {
  ko: (model) =>
    `세션이 멈췄어요. 모델 ${model}이(가) 에이전트의 허용 목록에서 빠져 모델 요청이 막혔어요. 허용 목록에 다시 넣거나 다른 모델로 바꿔 주세요.`,
  ja: (model) =>
    `セッションが止まりました。モデル ${model} がエージェントの許可リストから外れたため、モデルへのリクエストがブロックされました。許可リストに戻すか、別のモデルに変更してください。`,
  en: (model) =>
    `The session stopped. Model ${model} was taken off the agent's allowed list, so its model requests were blocked. Add it back or switch the session to another model.`,
};

/**
 * The notice's words in the reader's language (Korean when unknown). `model`
 * is an id from the profile's list; the outbox escapes Slack controls anyway.
 * The session link goes in the row's `link_url`.
 */
export function modelCutNoticeText(
  locale: UserLocale | null | undefined,
  model: string,
): string {
  return COPY[locale ?? DEFAULT_USER_LOCALE](model);
}
