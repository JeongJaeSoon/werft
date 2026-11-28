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
  progressQueued: "곧 시작해요",
  progressRunning: "작업하고 있어요",
  progressNeedsInput: "확인을 기다리고 있어요",
  progressIdle: "다음 요청을 기다리고 있어요",
  progressStarted: "시작",
  // Its session closed: the message's last word.
  progressClosed: "작업을 마쳤어요",
  // Its task closed as cancelled, by its requester or its pull request.
  progressCancelled: "작업을 취소했어요",
  // Its task closed as abandoned on its time rules (v1-b/C2).
  progressAbandoned: "오래 답이 없어 작업을 닫았어요.",
  // The progress message's buttons that close its task (v1-b/C1).
  taskCloseComplete: "완료",
  taskCloseCancel: "취소",
  // A notify_only thread's one start line, never edited.
  workStarted: "작업을 시작했어요",
  // A person needed where no card asks (v1-b/P2): a request the thread
  // shows no card for, and a recovery decision.
  needsPersonInput: "답이 필요한 요청이 있어요. 세션에서 답해 주세요",
  needsPersonRecovery:
    "작업을 이어 가려면 사람의 결정이 필요해요. 세션에서 정해 주세요",
  noCapacity: "지금 자리가 없어 시작하지 못했어요. 잠시 뒤 다시 요청해 주세요",
  noCapacityPaused:
    "자리가 없어 다시 시작하지 못했어요. 세션은 일시 정지 상태로 두었으니 잠시 뒤 다시 시작해 주세요",
  codexSandboxNotInstalled:
    "이 에이전트의 실행 환경(Codex sandbox)이 이 설치에 없어요. 관리자에게 알려 주세요",
  // A turn its tool call limit ended; the session takes the next reply.
  toolCallLimit:
    "도구를 너무 많이 불러 이번 턴을 멈췄어요. 이어서 하려면 답글을 주세요",
  ownershipLost:
    "작업이 중간에 끊겼어요. 서버 연결이 잠시 끊겼어요. 마지막 저장 지점 뒤에 한 일은 확인이 필요해요.",
  ownershipLostContinue: "이어서 하기",
  ownershipLostContinued: "마지막 저장 지점에서 이어서 하고 있어요",
  startFresh: "작업이 중간에 끊겼어요. 이 대화에는 아직 저장 지점이 없어요.",
  startFreshWarning:
    "이전 대화 문맥 없이 같은 요청을 처음부터 다시 해요. 끊기기 전에 한 일은 확인이 필요해요.",
  startFreshContinue: "새 문맥으로 계속",
  startFreshContinued: "새 문맥에서 같은 요청을 다시 하고 있어요",
  repositoryRequired:
    "이 에이전트의 릴리스에 쓸 수 있는 저장소가 없거나(저장소를 고르지 않았거나, 카탈로그에서 빠졌거나, 워크스페이스 상한이 허용하지 않아요) 에이전트의 GitHub 설정을 읽을 수 없어 시작하지 못했어요. 에이전트 관리자가 웹 콘솔에서 GitHub 설정을 확인하고, 저장소가 필요하면 골라 새 릴리스를 만들고 활성화해야 해요",
  releaseUnavailable:
    "이 에이전트의 릴리스가 쓰는 연결이 꺼졌거나 그 모델이 연결 목록에서 빠져 시작하지 못했어요. 에이전트 관리자가 웹 콘솔에서 쓸 수 있는 연결과 모델로 새 릴리스를 만들고 활성화해야 해요",
  noActiveRelease:
    "이 에이전트는 아직 게시되지 않았어요. 웹 콘솔에서 미리 써 본 뒤 게시하면 Slack에서 쓸 수 있어요",
  agentOwnerless:
    "이 에이전트를 관리할 사람이 없어 새 세션을 시작할 수 없어요. 워크스페이스 관리자에게 에이전트 관리자를 정해 달라고 요청하세요",
  // A mention the agent does not hear (handling table rows 1 and 7, and
  // section 10's agent stops), once a day per person in the channel.
  channelOff: "이 채널에서는 꺼져 있어요",
  agentInactive:
    "이 에이전트는 지금 멈춰 있어요. 에이전트 관리자에게 문의하세요",
  // A mention in a channel the agent has no binding for, once a day per
  // person in the channel; only that person sees it.
  channelUnbound:
    "이 채널은 아직 이 에이전트에 연결되지 않았어요. 워크스페이스 관리자에게 에이전트의 Slack 탭에서 이 채널을 연결해 달라고 요청하세요",
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
  // A stop asked for in the work's thread (handling table row 12); `{count}`
  // is the number of waiting messages it cancelled.
  sessionStopped:
    "요청하신 대로 작업을 멈췄어요. 이어서 하려면 이 스레드에 다시 써 주세요.",
  sessionStoppedQueued:
    "요청하신 대로 작업을 멈췄어요. 기다리던 글 {count}개도 처리하지 않았어요. 이어서 하려면 이 스레드에 다시 써 주세요.",
  // The stop closed a task before its first turn: nothing to carry on.
  // `{count}` is the messages waiting after the task's request.
  taskStoppedBeforeStart:
    "요청하신 대로 작업을 시작하기 전에 멈추고 닫았어요. 다시 하려면 새로 맡겨 주세요.",
  taskStoppedBeforeStartQueued:
    "요청하신 대로 작업을 시작하기 전에 멈추고 닫았어요. 기다리던 글 {count}개도 처리하지 않았어요. 다시 하려면 새로 맡겨 주세요.",
  nothingToStop: "지금 멈출 작업이 없어요.",
  stopNotPermitted: "작업을 맡긴 사람만 멈출 수 있어요",
  taskCloseNotPermitted: "이 작업을 닫을 권한이 없어요",
  // A press whose value is not of the message pressed (surface_mismatch).
  pressMismatch: "이 메시지에서는 그 요청을 처리할 수 없어요",
  // The same refusal on a card that cannot be tied to its message: posted
  // by an earlier version, or its post never came back.
  pressEarlierCard:
    "이 카드는 이전 판에서 올라와 처리할 수 없어요. 웹 콘솔에서 답하거나 새 요청을 기다려 주세요",
  // A budget account's refusal, never the session's own limit: whose
  // monthly limit it is, as the ledger charged the call.
  budgetAccountUser:
    "요청한 사람의 이번 달 예산 한도에 닿아 모델을 부르지 못했어요. 다음 달 1일(UTC)에 풀리고, 그 전에는 워크스페이스 관리자가 한도를 올리면 풀려요",
  budgetAccountTeam:
    "에이전트 팀의 이번 달 예산 한도에 닿아 모델을 부르지 못했어요. 다음 달 1일(UTC)에 풀리고, 그 전에는 워크스페이스 관리자가 한도를 올리면 풀려요",
  // A task a conversation turn would start (v1-b/E3). The three refusals
  // go to the requester alone and name no permission; the rest are the
  // thread's.
  taskConnect: "작업을 시작하려면 웹 콘솔에서 Slack 계정을 연결해 주세요.",
  taskChannel: "이 채널에서는 작업을 시작할 수 없어요",
  taskNoRight: "이 요청으로는 작업을 시작할 권한이 없어요",
  taskFailed: "작업을 시작하지 못했어요.",
  taskLimitConversation:
    "이 대화에 열린 작업이 3개라 새 작업을 시작하지 않았어요. 열린 작업을 닫아 3개보다 적어지면 새로 시작할 수 있어요",
  taskLimitAgent:
    "이 에이전트에 열린 작업이 10개라 새 작업을 시작하지 않았어요. 열린 작업이 끝나면 다시 요청해 주세요",
  taskRepository:
    "고른 저장소는 이 에이전트가 쓸 수 없어서 작업을 시작하지 않았어요",
  // A message a conversation turn hands to an open task (v1-b/E4). The two
  // refusals go to the requester alone and name no permission; the failure
  // and the pointer to the task's thread are the thread's.
  routeConnect:
    "작업에 이어서 맡기려면 웹 콘솔에서 Slack 계정을 연결해 주세요.",
  routeNoRight: "이 작업에 이어서 맡길 권한이 없어요",
  routeFailed: "작업에 넘기지 못했어요.",
  routeMirror: "원래 스레드에서 이어서 할게요 ↗",
  // A DM's message handed to its person's standalone session (v1-b/DM3).
  routeStandalone: "작업으로 시작했어요",
  // A mention's turn that ended with no decision (v1-b/F1): said once as it
  // is tried again, and once when its last try ends with none either.
  mentionRetrying: "지금 답하지 못했어요. 다시 해 볼게요",
  mentionFailed: "세 번 시도했지만 답하지 못했어요. 잠시 뒤 다시 불러 주세요",
  storageLimit:
    "이 설치의 저장 한도에 남은 자리가 모자라 이 요청을 받지 못했어요. 관리자에게 한도를 올려 달라고 요청하세요",
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
    progressQueued: "まもなく始めます",
    progressRunning: "作業しています",
    progressNeedsInput: "確認を待っています",
    progressIdle: "次の依頼を待っています",
    progressStarted: "開始",
    progressClosed: "作業を終えました",
    progressCancelled: "作業を取り消しました",
    progressAbandoned: "長い間動きがないため作業を閉じました。",
    taskCloseComplete: "完了",
    taskCloseCancel: "取り消す",
    workStarted: "作業を始めました",
    needsPersonInput:
      "回答が必要なリクエストがあります。セッションで回答してください",
    needsPersonRecovery:
      "作業を続けるには人の判断が必要です。セッションで決めてください",
    noCapacity:
      "今は空きがなく開始できませんでした。しばらくしてからもう一度リクエストしてください",
    noCapacityPaused:
      "空きがなく再開できませんでした。セッションは一時停止のままにしてあるので、しばらくしてからもう一度再開してください",
    codexSandboxNotInstalled:
      "このエージェントの実行環境（Codex サンドボックス）がこの環境にありません。管理者に知らせてください",
    toolCallLimit:
      "ツールを呼び出しすぎたため、このターンを止めました。続けるには返信してください",
    ownershipLost:
      "作業が途中で途切れました。サーバーとの接続が一時的に切れました。最後の保存地点より後に行ったことは確認が必要です。",
    ownershipLostContinue: "続きから進める",
    ownershipLostContinued: "最後の保存地点から続けています",
    startFresh:
      "作業が途中で途切れました。この会話にはまだ保存地点がありません。",
    startFreshWarning:
      "前の会話の文脈なしで、同じ依頼を最初からやり直します。途切れる前に行ったことは確認が必要です。",
    startFreshContinue: "新しい文脈で続ける",
    startFreshContinued: "新しい文脈で同じ依頼をやり直しています",
    repositoryRequired:
      "このエージェントのリリースで使えるリポジトリがないか(リポジトリが選ばれていない、カタログから外れている、またはワークスペースの上限が許可していません)、エージェントのGitHub設定を読み取れないため、開始できませんでした。エージェントの管理者がWebコンソールでGitHub設定を確認し、リポジトリが必要なら選んで、新しいリリースを作成して有効化する必要があります",
    releaseUnavailable:
      "このエージェントのリリースが使う接続が無効になったか、そのモデルが接続の一覧から外れたため、開始できませんでした。エージェントの管理者がWebコンソールで使える接続とモデルの新しいリリースを作成して有効化する必要があります",
    noActiveRelease:
      "このエージェントはまだ公開されていません。Webコンソールで試してから公開すると、Slackで使えるようになります",
    agentOwnerless:
      "このエージェントを管理する人がいないため、新しいセッションを開始できません。ワークスペースの管理者にエージェントの管理者を決めてもらってください",
    channelOff: "このチャンネルではオフになっています",
    agentInactive:
      "このエージェントは現在停止しています。エージェントの管理者にお問い合わせください",
    channelUnbound:
      "このチャンネルはまだこのエージェントに接続されていません。ワークスペースの管理者に、エージェントのSlackタブでこのチャンネルを接続してもらってください",
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
    sessionStopped:
      "ご依頼どおり作業を止めました。続けるにはこのスレッドにもう一度書いてください。",
    sessionStoppedQueued:
      "ご依頼どおり作業を止めました。待っていた{count}件のメッセージも処理していません。続けるにはこのスレッドにもう一度書いてください。",
    taskStoppedBeforeStart:
      "ご依頼どおり、作業を始める前に止めて閉じました。もう一度行うには、新しく依頼してください。",
    taskStoppedBeforeStartQueued:
      "ご依頼どおり、作業を始める前に止めて閉じました。待っていた{count}件のメッセージも処理していません。もう一度行うには、新しく依頼してください。",
    nothingToStop: "今止める作業はありません。",
    stopNotPermitted: "作業を依頼した人だけが止められます",
    taskCloseNotPermitted: "この作業を閉じる権限がありません",
    pressMismatch: "このメッセージからはその操作はできません",
    pressEarlierCard:
      "このカードは以前のバージョンで投稿されたため処理できません。Webコンソールで回答するか、新しいリクエストをお待ちください",
    budgetAccountUser:
      "依頼した人の今月の予算上限に達したため、モデルを呼び出せませんでした。来月1日（UTC）に解除されます。それより前に使うには、ワークスペースの管理者に上限を上げてもらってください",
    budgetAccountTeam:
      "エージェントのチームの今月の予算上限に達したため、モデルを呼び出せませんでした。来月1日（UTC）に解除されます。それより前に使うには、ワークスペースの管理者に上限を上げてもらってください",
    taskConnect:
      "作業を始めるには、Webコンソールで Slack アカウントを連携してください。",
    taskChannel: "このチャンネルでは作業を始められません",
    taskNoRight: "このリクエストでは作業を始める権限がありません",
    taskFailed: "作業を始められませんでした。",
    taskLimitConversation:
      "この会話には進行中の作業が3件あるため、新しい作業は始めませんでした。進行中の作業を閉じて3件未満になると、新しく始められます",
    taskLimitAgent:
      "このエージェントには進行中の作業が10件あるため、新しい作業は始めませんでした。進行中の作業が終わってから、もう一度依頼してください",
    taskRepository:
      "選ばれたリポジトリはこのエージェントでは使えないため、作業を始めませんでした",
    routeConnect:
      "作業に続けて任せるには、Webコンソールで Slack アカウントを連携してください。",
    routeNoRight: "この作業に続けて任せる権限がありません",
    routeFailed: "作業に引き継げませんでした。",
    routeMirror: "元のスレッドで続けます ↗",
    routeStandalone: "作業として始めました",
    mentionRetrying: "今はお答えできませんでした。もう一度やってみます",
    mentionFailed:
      "3回試しましたが、お答えできませんでした。しばらくしてからもう一度呼んでください",
    storageLimit:
      "この環境の保存容量の上限に空きが足りず、このリクエストを受け付けられませんでした。管理者に上限を上げるよう依頼してください",
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
    progressQueued: "Starting soon",
    progressRunning: "Working on it",
    progressNeedsInput: "Waiting for input",
    progressIdle: "Waiting for the next request",
    progressStarted: "Started",
    progressClosed: "This task is done",
    progressCancelled: "This task was cancelled",
    progressAbandoned:
      "This task was closed after a long time without activity.",
    taskCloseComplete: "Done",
    taskCloseCancel: "Cancel",
    workStarted: "Started working on this",
    needsPersonInput:
      "A request is waiting for your answer. Answer it in the session",
    needsPersonRecovery:
      "This task needs a person's decision to go on. Decide in the session",
    noCapacity:
      "There was no room to start this right now. Please ask again in a little while",
    noCapacityPaused:
      "There was no room to resume this. The session stays paused; please resume it again in a little while",
    codexSandboxNotInstalled:
      "This agent's runtime (the Codex sandbox) is not installed here. Tell an administrator",
    toolCallLimit:
      "This turn called tools too many times, so it was stopped. Reply to continue",
    ownershipLost:
      "The work was cut off partway. The connection to the server dropped for a moment. What it did after the last save point needs checking.",
    ownershipLostContinue: "Continue",
    ownershipLostContinued: "Continuing from the last save point",
    startFresh:
      "The work was cut off partway. This conversation has no save point yet.",
    startFreshWarning:
      "The same request runs again from the start, without the earlier conversation's context. What it did before it was cut off needs checking.",
    startFreshContinue: "Continue in a new context",
    startFreshContinued: "Running the same request again in a new context",
    repositoryRequired:
      "The agent couldn't start because its release has no repository it can use (none was chosen, it was removed from the catalog, or the workspace ceiling does not allow it) or its GitHub settings can't be read. An agent admin needs to check the GitHub settings in the web console and, if a repository is needed, choose one, then create and activate a new release",
    releaseUnavailable:
      "The agent couldn't start because its release's connection was disabled or its model left the connection's list. An agent admin needs to create and activate a new release on an available connection and model in the web console",
    noActiveRelease:
      "This agent is not published yet. Try it in the web console and publish it to use it in Slack",
    agentOwnerless:
      "No one administers this agent, so it can't start a new session. Ask a workspace admin to assign an agent admin",
    channelOff: "This agent is turned off in this channel",
    agentInactive: "This agent is stopped right now. Contact the agent's admin",
    channelUnbound:
      "This channel isn't connected to this agent yet. Ask a workspace admin to connect it in the agent's Slack tab",
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
    sessionStopped:
      "Stopped the task as you asked. Write in this thread again to carry on.",
    sessionStoppedQueued:
      "Stopped the task as you asked. {count} waiting messages were not processed either. Write in this thread again to carry on.",
    taskStoppedBeforeStart:
      "Stopped and closed the task before it started, as you asked. To do it again, ask for it as a new task.",
    taskStoppedBeforeStartQueued:
      "Stopped and closed the task before it started, as you asked. {count} waiting messages were not processed either. To do it again, ask for it as a new task.",
    nothingToStop: "There's nothing to stop right now.",
    stopNotPermitted: "Only the person who asked for this task can stop it",
    taskCloseNotPermitted: "You don't have permission to close this task",
    pressMismatch: "That request can't be made from this message",
    pressEarlierCard:
      "This card was posted by an earlier version and can't be handled. Answer in the web console or wait for a new request",
    budgetAccountUser:
      "The requester's monthly budget limit was reached, so the model could not be called. It lifts on the 1st of next month (UTC), or sooner when a workspace admin raises the limit",
    budgetAccountTeam:
      "The agent team's monthly budget limit was reached, so the model could not be called. It lifts on the 1st of next month (UTC), or sooner when a workspace admin raises the limit",
    taskConnect: "To start a task, link your Slack account in the web console.",
    taskChannel: "Tasks can't be started in this channel",
    taskNoRight: "This request doesn't have permission to start a task",
    taskFailed: "The task couldn't be started.",
    taskLimitConversation:
      "This conversation already has 3 open tasks, so a new one wasn't started. Close open tasks until fewer than 3 remain to start a new one",
    taskLimitAgent:
      "This agent already has 10 open tasks, so a new one wasn't started. Ask again once one of them finishes",
    taskRepository:
      "The chosen repository isn't one this agent can use, so the task wasn't started",
    routeConnect:
      "To hand this to the task, link your Slack account in the web console.",
    routeNoRight: "This request doesn't have permission to add to that task",
    routeFailed: "This couldn't be handed to the task.",
    routeMirror: "Continuing in the original thread ↗",
    routeStandalone: "Started this as a task",
    mentionRetrying: "I couldn't answer just now. I'll try again.",
    mentionFailed:
      "I tried three times but couldn't answer. Please mention me again in a moment.",
    storageLimit:
      "This installation's storage limit has too little room left, so this request was not taken. Ask an administrator to raise the limit",
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
  surface_mismatch: "pressMismatch",
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
  /** What a message's `{count}` stands for. */
  count?: number;
  /** A console page the line points to: where the person links their Slack account, or the agent list. */
  link_url?: string;
};

/** A notice's words in one language, its `{count}` filled in. */
export function slackNoticeText(
  locale: UserLocale,
  notice: Pick<SlackNotice, "message" | "count">,
): string {
  const text = SLACK_NOTICE_MESSAGES[locale][notice.message];
  return notice.count === undefined
    ? text
    : text.replaceAll("{count}", String(notice.count));
}

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
