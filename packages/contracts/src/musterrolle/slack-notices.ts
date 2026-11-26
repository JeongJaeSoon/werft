import type { SlackSurfaceAction } from "../kollegium/surfaces.ts";
import type { UserLocale } from "./auth.ts";
import type {
  AuthorizationDecision,
  AuthorizationReason,
} from "./authorization.ts";

// What the person a Slack decision refused sees, only them and once per
// thread. Product copy: plain words, no internal module names.
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
  capacityWait: "작업 자리를 기다리는 중이에요. 자리가 나면 바로 시작해요",
  noCapacity: "지금 자리가 없어 시작하지 못했어요. 잠시 뒤 다시 요청해 주세요",
  noCapacityPaused:
    "자리가 없어 다시 시작하지 못했어요. 세션은 일시 정지 상태로 두었으니 잠시 뒤 다시 시작해 주세요",
  codexSandboxNotInstalled:
    "이 에이전트의 실행 환경(Codex sandbox)이 이 설치에 없어요. 관리자에게 알려 주세요",
  ownershipLost:
    "작업이 중간에 끊겼어요. 서버 연결이 잠시 끊겼어요. 마지막 저장 지점 뒤에 한 일은 확인이 필요해요.",
  ownershipLostContinue: "이어서 하기",
  ownershipLostContinued: "마지막 저장 지점에서 이어서 하고 있어요",
  repositoryRequired:
    "이 에이전트의 릴리스에 쓸 수 있는 저장소가 없거나(저장소를 고르지 않았거나, 카탈로그에서 빠졌거나, 워크스페이스 상한이 허용하지 않아요) 에이전트의 GitHub 설정을 읽을 수 없어 시작하지 못했어요. 에이전트 관리자가 웹 콘솔에서 GitHub 설정을 확인하고, 저장소가 필요하면 골라 새 릴리스를 만들고 활성화해야 해요",
  releaseUnavailable:
    "이 에이전트의 릴리스가 쓰는 연결이 꺼졌거나 그 모델이 연결 목록에서 빠져 시작하지 못했어요. 에이전트 관리자가 웹 콘솔에서 쓸 수 있는 연결과 모델로 새 릴리스를 만들고 활성화해야 해요",
  noActiveRelease:
    "이 에이전트는 아직 게시되지 않았어요. 웹 콘솔에서 미리 써 본 뒤 게시하면 Slack에서 쓸 수 있어요",
  agentOwnerless:
    "이 에이전트를 관리할 사람이 없어 새 세션을 시작할 수 없어요. 워크스페이스 관리자에게 에이전트 관리자를 정해 달라고 요청하세요",
  pendingApproval: "이 채널은 어드민 승인을 기다리고 있어요",
  callerLimitedRepository:
    "이 에이전트를 쓰는 사람에게 걸린 제한 때문에 이 저장소로는 시작할 수 없어요",
  callerLimitedCredential:
    "이 에이전트를 쓰는 사람에게 걸린 제한 때문에 이 에이전트의 자격 설정을 쓸 수 없어요",
  callerLimitedMcpServer:
    "이 에이전트를 쓰는 사람에게 걸린 제한 때문에 이 세션의 MCP 서버를 쓸 수 없어요",
  callerLimitedTool:
    "이 에이전트를 쓰는 사람에게 걸린 제한 때문에 이 세션이 쓰는 도구를 쓸 수 없어요",
  botTurnLimit:
    "사람 없이 봇끼리 5번 주고받아 여기서 멈춰요. 사람이 이어 가야 해요",
  // A budget account's refusal, never the session's own limit: whose
  // monthly limit it is, as the ledger charged the call.
  budgetAccountUser:
    "요청한 사람의 이번 달 예산 한도에 닿아 모델을 부르지 못했어요. 다음 달 1일(UTC)에 풀리고, 그 전에는 워크스페이스 관리자가 한도를 올리면 풀려요",
  budgetAccountTeam:
    "에이전트 팀의 이번 달 예산 한도에 닿아 모델을 부르지 못했어요. 다음 달 1일(UTC)에 풀리고, 그 전에는 워크스페이스 관리자가 한도를 올리면 풀려요",
  storageLimit:
    "이 설치의 저장 한도가 다 차서 요청을 받지 못했어요. 관리자가 한도를 올려야 다시 받을 수 있어요",
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
    capacityWait: "作業の空きを待っています。空きが出しだい始めます",
    noCapacity:
      "今は空きがなく開始できませんでした。しばらくしてからもう一度リクエストしてください",
    noCapacityPaused:
      "空きがなく再開できませんでした。セッションは一時停止のままにしてあるので、しばらくしてからもう一度再開してください",
    codexSandboxNotInstalled:
      "このエージェントの実行環境（Codex サンドボックス）がこの環境にありません。管理者に知らせてください",
    ownershipLost:
      "作業が途中で途切れました。サーバーとの接続が一時的に切れました。最後の保存地点より後に行ったことは確認が必要です。",
    ownershipLostContinue: "続きから進める",
    ownershipLostContinued: "最後の保存地点から続けています",
    repositoryRequired:
      "このエージェントのリリースで使えるリポジトリがないか(リポジトリが選ばれていない、カタログから外れている、またはワークスペースの上限が許可していません)、エージェントのGitHub設定を読み取れないため、開始できませんでした。エージェントの管理者がWebコンソールでGitHub設定を確認し、リポジトリが必要なら選んで、新しいリリースを作成して有効化する必要があります",
    releaseUnavailable:
      "このエージェントのリリースが使う接続が無効になったか、そのモデルが接続の一覧から外れたため、開始できませんでした。エージェントの管理者がWebコンソールで使える接続とモデルの新しいリリースを作成して有効化する必要があります",
    noActiveRelease:
      "このエージェントはまだ公開されていません。Webコンソールで試してから公開すると、Slackで使えるようになります",
    agentOwnerless:
      "このエージェントを管理する人がいないため、新しいセッションを開始できません。ワークスペースの管理者にエージェントの管理者を決めてもらってください",
    pendingApproval: "このチャンネルはアドミンの承認を待っています",
    callerLimitedRepository:
      "このエージェントを使う人に設定された制限のため、このリポジトリでは開始できません",
    callerLimitedCredential:
      "このエージェントを使う人に設定された制限のため、このエージェントの認証情報設定は使えません",
    callerLimitedMcpServer:
      "このエージェントを使う人に設定された制限のため、このセッションのMCPサーバーは使えません",
    callerLimitedTool:
      "このエージェントを使う人に設定された制限のため、このセッションが使うツールは使えません",
    botTurnLimit:
      "人を挟まずにボット同士で5回やり取りしたため、ここで止まります。続きは人が進めてください",
    budgetAccountUser:
      "依頼した人の今月の予算上限に達したため、モデルを呼び出せませんでした。来月1日（UTC）に解除されます。それより前に使うには、ワークスペースの管理者に上限を上げてもらってください",
    budgetAccountTeam:
      "エージェントのチームの今月の予算上限に達したため、モデルを呼び出せませんでした。来月1日（UTC）に解除されます。それより前に使うには、ワークスペースの管理者に上限を上げてもらってください",
    storageLimit:
      "この環境の保存容量の上限に達したため、リクエストを受け付けられませんでした。管理者が上限を上げると、また受け付けられます",
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
    capacityWait:
      "Waiting for room to run this. It starts as soon as room frees up",
    noCapacity:
      "There was no room to start this right now. Please ask again in a little while",
    noCapacityPaused:
      "There was no room to resume this. The session stays paused; please resume it again in a little while",
    codexSandboxNotInstalled:
      "This agent's runtime (the Codex sandbox) is not installed here. Tell an administrator",
    ownershipLost:
      "The work was cut off partway. The connection to the server dropped for a moment. What it did after the last save point needs checking.",
    ownershipLostContinue: "Continue",
    ownershipLostContinued: "Continuing from the last save point",
    repositoryRequired:
      "The agent couldn't start because its release has no repository it can use (none was chosen, it was removed from the catalog, or the workspace ceiling does not allow it) or its GitHub settings can't be read. An agent admin needs to check the GitHub settings in the web console and, if a repository is needed, choose one, then create and activate a new release",
    releaseUnavailable:
      "The agent couldn't start because its release's connection was disabled or its model left the connection's list. An agent admin needs to create and activate a new release on an available connection and model in the web console",
    noActiveRelease:
      "This agent is not published yet. Try it in the web console and publish it to use it in Slack",
    agentOwnerless:
      "No one administers this agent, so it can't start a new session. Ask a workspace admin to assign an agent admin",
    pendingApproval: "This channel is waiting for an admin's approval",
    callerLimitedRepository:
      "A limit set on the people who use this agent doesn't allow starting with this repository",
    callerLimitedCredential:
      "A limit set on the people who use this agent doesn't allow this agent's credential settings",
    callerLimitedMcpServer:
      "A limit set on the people who use this agent doesn't allow this session's MCP server",
    callerLimitedTool:
      "A limit set on the people who use this agent doesn't allow a tool this session uses",
    botTurnLimit:
      "Bots went back and forth 5 times with no person in between, so this stops here. A person needs to take it from here",
    budgetAccountUser:
      "The requester's monthly budget limit was reached, so the model could not be called. It lifts on the 1st of next month (UTC), or sooner when a workspace admin raises the limit",
    budgetAccountTeam:
      "The agent team's monthly budget limit was reached, so the model could not be called. It lifts on the 1st of next month (UTC), or sooner when a workspace admin raises the limit",
    storageLimit:
      "This installation's storage limit is full, so the request was not taken. An administrator needs to raise the limit before requests are taken again",
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
  caller_limited: "noRight",
  disabled: "noRight",
  guest_disabled: "guestDisabled",
  external_user: "membersOnly",
  not_found: "outOfShare",
  // Slack has no field for a reason, so a reason-gated action is out of reach.
  justification_required: "noRight",
  credential_unbound: "credentialUnbound",
  self_approval: "noRight",
  // A key's refusal: no key acts on Slack, and it reads as not_found.
  private_channel_key: "outOfShare",
  // Member and key rules: decided on the web, never for a Slack action.
  owner_protected: "noRight",
  self_protected: "noRight",
  last_owner: "noRight",
  emergency_admin: "noRight",
  scope_not_grantable: "noRight",
  // Conversation posts: judged on the web only until Slack opens them.
  conversation_archived: "noRight",
  listening_off: "noRight",
  // Access decisions: a person whose basis is missing or no longer valid
  // gets it back by linking again; the rest read as a missing right, and a
  // policy or membership that could not be read as a passing failure.
  requester_unresolved: "connect",
  requester_revoked: "connect",
  access_policy_denied: "noRight",
  personal_scope_unavailable: "noRight",
  personal_connection_unavailable: "noRight",
  delivery_audience_outside: "noRight",
  access_policy_unavailable: "failed",
  membership_stale: "failed",
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
