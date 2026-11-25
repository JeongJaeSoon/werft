import { DEFAULT_USER_LOCALE, type UserLocale } from "@werft-ai/contracts";

/**
 * One post in the session's thread per checkpoint: a session held again on a
 * later checkpoint tells again, the same hold seen twice does not.
 */
export function runtimeRetiredDedupeKey(
  workspaceId: string,
  sessionId: string,
  checkpointRevision: number,
  sessionLinkId: string,
): string {
  return `runtime-retired:${workspaceId}:${sessionId}:${checkpointRevision}:${sessionLinkId}`;
}

const COPY: Record<UserLocale, (agent: string) => string> = {
  ko: (agent) =>
    `에이전트 ${agent}와(과) 하던 세션이 멈췄어요. 세션의 checkpoint를 복원할 수 있는 worker 이미지가 철회됐고, 대신 쓸 수정 이미지가 아직 없어요. 설치 관리자가 수정 이미지를 넣으면 같은 checkpoint로 다시 복원할 수 있어요. checkpoint 없이 이어 가거나 세션을 닫을 수도 있어요.`,
  ja: (agent) =>
    `エージェント ${agent} とのセッションが止まりました。セッションの checkpoint を復元できる worker イメージが撤回され、代わりに使える修正イメージがまだありません。インストールの管理者が修正イメージを入れると、同じ checkpoint から復元をやり直せます。checkpoint なしで続けることも、セッションを閉じることもできます。`,
  en: (agent) =>
    `Your session with agent ${agent} has stopped. The worker image that restores its checkpoint was retracted, and no fixed image is listed to take its place yet. Once the installation's operator lists a fixed image, the restore can be retried from the same checkpoint. You can also go on without the checkpoint, or close the session.`,
};

/** The session link goes in the row's `link_url`. */
export function runtimeRetiredNoticeText(
  locale: UserLocale | null | undefined,
  agent: string,
): string {
  return COPY[locale ?? DEFAULT_USER_LOCALE](agent);
}
