import {
  DEFAULT_USER_LOCALE,
  type ModelCutCause,
  type UserLocale,
} from "@werft-ai/contracts";

/**
 * One DM per person per session, however many attempts the proxy cuts after
 * the model left the connection's list. Someone who becomes an administrator
 * between two cuts is told at the next one.
 */
export function modelCutDedupeKey(
  workspaceId: string,
  sessionId: string,
  slackUserId: string,
): string {
  return `model-not-allowed:${workspaceId}:${sessionId}:${slackUserId}`;
}

const COPY: Record<
  UserLocale,
  Record<ModelCutCause, (model: string) => string>
> = {
  ko: {
    model_removed: (model) =>
      `세션이 멈췄어요. 모델 ${model}이(가) 에이전트의 허용 목록에서 빠져 모델 요청이 막혔어요. 허용 목록에 다시 넣거나 다른 모델로 바꿔 주세요.`,
    connection_removed: (model) =>
      `세션이 멈췄어요. 모델 ${model}을(를) 쓰던 모델 연결이 꺼지거나 없어져 모델 요청이 막혔어요. 연결을 되살리거나 다른 연결로 새 릴리스를 만들어 새 세션을 시작해 주세요.`,
  },
  ja: {
    model_removed: (model) =>
      `セッションが止まりました。モデル ${model} がエージェントの許可リストから外れたため、モデルへのリクエストがブロックされました。許可リストに戻すか、別のモデルに変更してください。`,
    connection_removed: (model) =>
      `セッションが止まりました。モデル ${model} を使っていたモデル接続が無効になったかなくなったため、モデルへのリクエストがブロックされました。接続を戻すか、別の接続で新しいリリースを作って新しいセッションを始めてください。`,
  },
  en: {
    model_removed: (model) =>
      `The session stopped. Model ${model} was taken off the agent's allowed list, so its model requests were blocked. Add it back or switch the session to another model.`,
    connection_removed: (model) =>
      `The session stopped. The model connection that served ${model} was disabled or is gone, so its model requests were blocked. Restore the connection, or release the agent on another connection and start a new session.`,
  },
};

/**
 * The notice's words in the reader's language (English when unknown). `model`
 * is an id from the connection's list; the outbox escapes Slack controls anyway.
 * The session link goes in the row's `link_url`.
 */
export function modelCutNoticeText(
  locale: UserLocale | null | undefined,
  model: string,
  cause: ModelCutCause = "model_removed",
): string {
  return COPY[locale ?? DEFAULT_USER_LOCALE][cause](model);
}

/** The `error` event's own message, in the language API errors use. */
export function modelCutEventMessage(
  model: string,
  cause: ModelCutCause,
): string {
  return cause === "model_removed"
    ? `The model ${model} is no longer on its connection's model list, so its model requests were blocked`
    : `The model connection that served ${model} is gone, so its model requests were blocked`;
}
