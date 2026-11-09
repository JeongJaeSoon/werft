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
      : `에이전트 ${n.agent}의 모델 ${n.from}이(가) 허용 목록에서 빠졌지만 ${n.to}(으)로 옮기지 못했어요. 에이전트는 막힌 채로 있어요. 마지막으로 release를 승인한 사람이 관리자 권한을 잃었거나 release를 만들 수 없는 상태인지 확인해 주세요.`,
  ja: (n) =>
    n.kind === "moved"
      ? `エージェント ${n.agent} のモデル ${n.from} が許可リストから外れたため、同じシリーズの ${n.to} に移しました。新しいリリースが有効になり、続くセッションは次のターンから ${n.to} で実行されます。エージェント設定で自動移行をオフにできます。`
      : `エージェント ${n.agent} のモデル ${n.from} が許可リストから外れましたが、${n.to} に移せませんでした。エージェントはブロックされたままです。最後にリリースを承認した人が管理者権限を失っていないか、リリースを作れる状態かを確認してください。`,
  en: (n) =>
    n.kind === "moved"
      ? `Agent ${n.agent}'s model ${n.from} left the allowed list, so it moved to ${n.to}, the next model of the same series. A new release is active, and its sessions run on ${n.to} from their next turn. You can turn the automatic move off in the agent's settings.`
      : `Agent ${n.agent}'s model ${n.from} left the allowed list, but it could not move to ${n.to}. The agent stays blocked. Check whether the person who last approved its release lost admin rights, or whether a release can be made.`,
};

export function modelMoveNoticeText(
  locale: UserLocale | null | undefined,
  notice: ModelMoveNotice,
): string {
  return COPY[locale ?? DEFAULT_USER_LOCALE](notice);
}
