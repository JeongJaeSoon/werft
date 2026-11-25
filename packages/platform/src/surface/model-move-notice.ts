import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";

export type SessionModelMoveNotice = {
  agent: string;
  from: string;
  to: string;
};

/** One post in the session's thread per move; a later move tells again. */
export function sessionModelMoveDedupeKey(
  workspaceId: string,
  sessionId: string,
  from: string,
  to: string,
  sessionLinkId: string,
): string {
  return `session-model-move:${workspaceId}:${sessionId}:${from}:${to}:${sessionLinkId}`;
}

const SESSION_COPY: Record<
  UserLocale,
  (notice: SessionModelMoveNotice) => string
> = {
  ko: (n) =>
    `에이전트 ${n.agent}와(과) 하던 세션의 모델 ${n.from}이(가) 허용 목록에서 빠져 같은 시리즈의 ${n.to}(으)로 옮겼어요. 세션은 다음 턴부터 ${n.to}(으)로 이어져요.`,
  ja: (n) =>
    `エージェント ${n.agent} とのセッションのモデル ${n.from} が許可リストから外れたため、同じシリーズの ${n.to} に移しました。セッションは次のターンから ${n.to} で続きます。`,
  en: (n) =>
    `Your session with agent ${n.agent} was on model ${n.from}, which left the allowed list, so it moved to ${n.to}, the next model of the same series. The session goes on on ${n.to} from its next turn.`,
};

/** The session link goes in the row's `link_url`. */
export function sessionModelMoveNoticeText(
  locale: UserLocale | null | undefined,
  notice: SessionModelMoveNotice,
): string {
  return SESSION_COPY[locale ?? DEFAULT_USER_LOCALE](notice);
}
