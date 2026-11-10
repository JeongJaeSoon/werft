import type { SlackSurfaceAction } from "../kollegium/surfaces.ts";
import type { UserLocale } from "./auth.ts";
import type {
  AuthorizationDecision,
  AuthorizationReason,
} from "./authorization.ts";

// What the person a Slack decision refused sees, only them and once per
// thread (design 3.3). Product copy: plain words, no internal module names.
const SLACK_NOTICE_MESSAGES_KO = {
  connect: "웹에서 Slack 계정을 연결해 주세요",
  noRequestRight: "이 채널에서 이 에이전트에게 요청할 권한이 없어요",
  noApproveRight: "이 요청을 승인할 권한이 없어요",
  guestDisabled: "이 워크스페이스는 게스트의 에이전트 사용을 허용하지 않아요",
  membersOnly: "이 에이전트는 이 워크스페이스 구성원만 쓸 수 있어요",
  outOfShare:
    "이 세션은 공유 범위 밖이라 요청할 수 없어요. 세션을 시작한 사람에게 공유를 요청하세요",
  credentialUnbound:
    "연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요",
  failed: "지금은 요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요",
  repositoryRequired:
    "이 에이전트의 릴리스에 쓸 수 있는 저장소가 없거나(저장소를 고르지 않았거나, 카탈로그에서 빠졌거나, 워크스페이스 상한이 허용하지 않아요) 에이전트의 GitHub 설정을 읽을 수 없어 시작하지 못했어요. 에이전트 관리자가 웹 콘솔에서 GitHub 설정을 확인하고, 저장소가 필요하면 골라 새 릴리스를 만들고 활성화해야 해요",
  releaseUnavailable:
    "이 에이전트의 릴리스가 쓰는 연결이 꺼졌거나 그 모델이 연결 목록에서 빠져 시작하지 못했어요. 에이전트 관리자가 웹 콘솔에서 쓸 수 있는 연결과 모델로 새 릴리스를 만들고 활성화해야 해요",
  noActiveRelease:
    "이 에이전트는 아직 활성화된 릴리스가 없어요. 에이전트 관리자가 웹 콘솔에서 릴리스를 활성화해야 해요",
  pendingApproval: "이 채널은 관리자 승인을 기다리고 있어요",
} as const;

export type SlackNoticeMessage = keyof typeof SLACK_NOTICE_MESSAGES_KO;

export const SLACK_NOTICE_MESSAGES: Readonly<
  Record<UserLocale, Readonly<Record<SlackNoticeMessage, string>>>
> = {
  ko: SLACK_NOTICE_MESSAGES_KO,
  ja: {
    connect: "WebでSlackアカウントを連携してください",
    noRequestRight:
      "このチャンネルでこのエージェントにリクエストする権限がありません",
    noApproveRight: "このリクエストを承認する権限がありません",
    guestDisabled:
      "このワークスペースでは、ゲストによるエージェントの利用が許可されていません",
    membersOnly:
      "このエージェントはこのワークスペースのメンバーのみ利用できます",
    outOfShare:
      "このセッションは共有範囲外のため、リクエストできません。セッションを開始した人に共有を依頼してください",
    credentialUnbound:
      "接続設定が変更されたため、開始できませんでした。エージェントの管理者にお問い合わせください",
    failed:
      "現在リクエストを処理できませんでした。しばらくしてからもう一度お試しください",
    repositoryRequired:
      "このエージェントのリリースで使えるリポジトリがないか(リポジトリが選ばれていない、カタログから外れている、またはワークスペースの上限が許可していません)、エージェントのGitHub設定を読み取れないため、開始できませんでした。エージェントの管理者がWebコンソールでGitHub設定を確認し、リポジトリが必要なら選んで、新しいリリースを作成して有効化する必要があります",
    releaseUnavailable:
      "このエージェントのリリースが使う接続が無効になったか、そのモデルが接続の一覧から外れたため、開始できませんでした。エージェントの管理者がWebコンソールで使える接続とモデルの新しいリリースを作成して有効化する必要があります",
    noActiveRelease:
      "このエージェントにはまだ有効なリリースがありません。エージェントの管理者がWebコンソールでリリースを有効化する必要があります",
    pendingApproval: "このチャンネルは管理者の承認を待っています",
  },
  en: {
    connect: "Link your Slack account on the web",
    noRequestRight:
      "You don't have permission to make requests to this agent in this channel",
    noApproveRight: "You don't have permission to approve this request",
    guestDisabled: "This workspace doesn't allow guests to use agents",
    membersOnly: "Only members of this workspace can use this agent",
    outOfShare:
      "This session isn't shared with you, so you can't make requests in it. Ask the person who started the session to share it",
    credentialUnbound:
      "The connection settings changed, so the agent couldn't start. Contact the agent's admin",
    failed: "We couldn't process the request right now. Try again shortly",
    repositoryRequired:
      "The agent couldn't start because its release has no repository it can use (none was chosen, it was removed from the catalog, or the workspace ceiling does not allow it) or its GitHub settings can't be read. An agent admin needs to check the GitHub settings in the web console and, if a repository is needed, choose one, then create and activate a new release",
    releaseUnavailable:
      "The agent couldn't start because its release's connection was disabled or its model left the connection's list. An agent admin needs to create and activate a new release on an available connection and model in the web console",
    noActiveRelease:
      "This agent has no active release yet. An agent admin needs to activate a release in the web console",
    pendingApproval: "This channel is waiting for an admin's approval",
  },
};

// Every refusal has a notice, so a new reason code cannot reach Slack as
// silence. A missing right reads differently for whoever pressed approve.
const NOTICE_FOR: Record<
  Exclude<AuthorizationReason, "ok">,
  SlackNoticeMessage | "noRight"
> = {
  unlinked: "connect",
  // Linking again is what clears a link that went stale.
  stale_link: "connect",
  role: "noRight",
  surface_ceiling: "noRight",
  agent_ceiling: "noRight",
  agent_private: "noRight",
  disabled: "noRight",
  guest_disabled: "guestDisabled",
  external_user: "membersOnly",
  not_found: "outOfShare",
  // Slack has no field for a reason, so a reason-gated action is out of reach.
  justification_required: "noRight",
  credential_unbound: "credentialUnbound",
  self_approval: "noRight",
  no_requester: "failed",
  error: "failed",
};

/** A notice before its reader is known: the words come in their language. */
export type SlackNotice = {
  message: SlackNoticeMessage;
  /** The web page where the person links their Slack account. */
  link_url?: string;
};

/**
 * The notice for a decision, or null when there is nothing to tell: an
 * allow, or a redact, whose summary and web link the channel shows instead.
 */
export function slackNoticeFor(
  decision: Pick<AuthorizationDecision, "outcome" | "reason_code">,
  action: SlackSurfaceAction,
  links: { connectUrl: string },
): SlackNotice | null {
  if (decision.outcome !== "deny" || decision.reason_code === "ok") {
    return null;
  }
  const key = NOTICE_FOR[decision.reason_code];
  if (key === "connect") {
    return { message: "connect", link_url: links.connectUrl };
  }
  if (key === "noRight") {
    return {
      message:
        action === "session.approve" ? "noApproveRight" : "noRequestRight",
    };
  }
  return { message: key };
}
