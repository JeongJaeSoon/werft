import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";

export type ModelMoveNotice =
  | { kind: "moved"; agent: string; from: string; to: string }
  | { kind: "failed"; agent: string; from: string; to: string };

export function modelMoveDedupeKey(
  kind: ModelMoveNotice["kind"],
  agentId: string,
  from: string,
  to: string,
  slackUserId: string,
  revision: number,
): string {
  return `model-move:${kind}:${agentId}:${from}:${to}:${revision}:${slackUserId}`;
}

const COPY: Record<UserLocale, (notice: ModelMoveNotice) => string> = {
  ko: (n) =>
    n.kind === "moved"
      ? `에이전트 ${n.agent}의 모델 ${n.from}이(가) 허용 목록에서 빠져 같은 시리즈의 ${n.to}(으)로 옮겼어요. 새 release가 활성화됐고 이어지는 세션은 다음 턴부터 ${n.to}로 실행돼요. 에이전트 설정에서 자동 이동을 끌 수 있어요.`
      : `에이전트 ${n.agent}의 모델 ${n.from}이(가) 허용 목록에서 빠졌지만 ${n.to}(으)로 옮기지 못했어요. 에이전트는 막힌 채로 있어요. 마지막으로 release를 활성화한 사람이 관리자 권한을 잃었거나 release를 만들 수 없는 상태인지 확인해 주세요.`,
  ja: (n) =>
    n.kind === "moved"
      ? `エージェント ${n.agent} のモデル ${n.from} が許可リストから外れたため、同じシリーズの ${n.to} に移しました。新しいリリースが有効になり、続くセッションは次のターンから ${n.to} で実行されます。エージェント設定で自動移行をオフにできます。`
      : `エージェント ${n.agent} のモデル ${n.from} が許可リストから外れましたが、${n.to} に移せませんでした。エージェントはブロックされたままです。最後にリリースを有効化した人が管理者権限を失っていないか、リリースを作れる状態かを確認してください。`,
  en: (n) =>
    n.kind === "moved"
      ? `Agent ${n.agent}'s model ${n.from} left the allowed list, so it moved to ${n.to}, the next model of the same series. A new release is active, and its sessions run on ${n.to} from their next turn. You can turn the automatic move off in the agent's settings.`
      : `Agent ${n.agent}'s model ${n.from} left the allowed list, but it could not move to ${n.to}. The agent stays blocked. Check whether the person who last activated its release lost admin rights, or whether a release can be made.`,
};

export function modelMoveNoticeText(
  locale: UserLocale | null | undefined,
  notice: ModelMoveNotice,
): string {
  return COPY[locale ?? DEFAULT_USER_LOCALE](notice);
}

export type SessionModelMoveNotice = {
  agent: string;
  from: string;
  to: string;
};

/** One DM per person per session and move; a later move of the same session tells again. */
export function sessionModelMoveDedupeKey(
  workspaceId: string,
  sessionId: string,
  from: string,
  to: string,
  slackUserId: string,
): string {
  return `session-model-move:${workspaceId}:${sessionId}:${from}:${to}:${slackUserId}`;
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
