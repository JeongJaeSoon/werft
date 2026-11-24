import { flowJa, formsJa, sessionsJa } from "@werft-ai/react";
import { achievementRulesJa } from "./achievement-rules.ts";
import { achievementsJa } from "./achievements.ts";
import { agentAccessJa } from "./agent-access.ts";
import { agentGitHubJa } from "./agent-github.ts";
import { agentsJa } from "./agents.ts";
import { apiKeysJa } from "./api-keys.ts";
import { auditLogJa } from "./audit-log.ts";
import { authJa } from "./auth.ts";
import { commonJa } from "./common.ts";
import { errorsJa } from "./errors.ts";
import { executionLimitsJa } from "./execution-limits.ts";
import { githubJa } from "./github.ts";
import { githubUserLinkJa } from "./github-user-link.ts";
import { homeJa } from "./home.ts";
import type { MessageKey } from "./ko.ts";
import { linkedJa } from "./linked.ts";
import { loginMethodsJa } from "./login-methods.ts";
import { loginProvidersJa } from "./login-providers.ts";
import { membersJa } from "./members.ts";
import { modelsJa } from "./models.ts";
import { outputsJa } from "./outputs.ts";
import { preferencesJa } from "./preferences.ts";
import { sessionListJa } from "./session-list.ts";
import { settingsJa } from "./settings.ts";
import { shellJa } from "./shell.ts";
import { skillsJa } from "./skills.ts";
import { teamsJa } from "./teams.ts";
import { usageJa } from "./usage.ts";
import { workspaceJa } from "./workspace.ts";
import { workspaceMcpJa } from "./workspace-mcp.ts";

export const slackJa = {
  "slack.error.config":
    "ワークスペースの Slack アプリ作成設定が必要です。オーナーかアドミンに設定を依頼してください。",
  "slack.error.refused":
    "Slack がリクエストを拒否しました(コード: {code})。コードを管理者に伝えてください。",
  "slack.error.noAnswer":
    "Slack から応答がなく、インストールを完了できませんでした。Slack タブからインストールをやり直してください。",
  "slack.error.unknown":
    "リクエストを処理できませんでした。再試行しても変わらない可能性があります(コード: {code})。コードを管理者に伝えてください。",
  "slack.error.consoleOrigin":
    "コンソールの公開アドレス(CONSOLE_ORIGIN)が未設定のため、Slack アプリを作成できません。管理者に設定を依頼してください。",
  "slack.error.eventsUrl":
    "Slack がイベントを送る https アドレスが分かりません。管理者に CONSOLE_ORIGIN の設定を依頼するか、イベントをコンソールと別に受ける場合はオーナーが 設定 > 連携 > Slack のイベントの入口アドレスを入力してください。",
  "slack.error.creating":
    "アプリの作成結果を確認中です。管理者に Slack 上のアプリを確認してもらい、更新してください。",
  "slack.error.notInstalled":
    "チャンネルの接続前に Slack アプリをインストールしてください。",
  "slack.error.denied":
    "Slack のインストールが拒否されました。Slack タブから再インストールできます。",
  "slack.error.expired":
    "インストールリンクは期限切れか使用済みです。Slack タブから再インストールしてください。",
  "slack.error.gone":
    "Slack にこのアプリはもうありません。危険な操作でアプリを削除してからもう一度インストールすると、新しいアプリが作成されます。",
  "slack.error.rejected":
    "Slack アプリまたはワークスペースが一致しません。Slack タブからやり直してください。",
  "slack.error.cursor":
    "チャンネル一覧が更新されました。更新して最初から検索してください。",
  "slack.error.botUnknown":
    "この Slack ワークスペースの有効なボットではありません。削除・無効化されたボットか、人のアカウントです。",
  "slack.error.botOwn": "このエージェント自身のボットは選べません。",
  "slack.error.botWerftAgent":
    "この Werft にあるほかのエージェントのボットです。エージェント同士は Slack で呼び出せません。",
  "slack.error.botOtherTeam":
    "ほかの Slack ワークスペースのボットです。Slack Connect で入ってきたボットは選べません。",
  "agent.tabs.slack": "Slack",
  "agents.flow.channels": "チャンネル接続",
  "slack.app": "Slack アプリ",
  "slack.verifyNeeded":
    "アプリはインストール済みですが、イベント登録の確認が必要です。管理者に確認してください。",
  "slack.joinHintAuto":
    "公開チャンネルは応答をオンにするとボットが自動で参加します。非公開チャンネルには /invite でボットを招待してください。",
  "slack.appId": "アプリ ID",
  "slack.state.none": "作成前",
  "slack.state.pending": "インストール待ち",
  "slack.state.connected": "接続済み",
  "slack.state.reinstall": "再インストールが必要",
  "slack.channelsLocked.title": "Request URL の確認前はチャンネルを選べません",
  "slack.channelsLocked.bodyRecheck":
    "Slack がこのアプリの Request URL を確認するまで、招待・メンション・DM・チャンネルのイベントは届きません。「再確認」は今の URL を Slack にもう一度送るだけで、URL が変わらなければ Slack は再び確認しないことがあります。確認待ちが続く場合は、アプリ設定の Event Subscriptions で Verify(または Retry)を押してください。確認されるとこの案内は自動で消えます。",
  "slack.channelsLocked.body":
    "Slack がこのアプリの Request URL を確認するまで、招待・メンション・DM・チャンネルのイベントは届きません。アプリ設定の Event Subscriptions で Verify(または Retry)を押してください。確認されるとこの案内は自動で消えます。",
  "slack.channelsLocked.open": "Event Subscriptions を開く",
  "slack.eventsUrl.title": "イベントの Request URL",
  "slack.eventsUrl.hint":
    "Slack が招待・メンション・DM を送る先です。再確認するとアプリ設定に今の URL をもう一度送ります。Slack が確認要求を送ると自動で応答します。",
  "slack.eventsUrl.verified": "Slack が確認済み",
  "slack.eventsUrl.pending": "Slack の確認待ち",
  "slack.eventsUrl.failed": "登録に失敗",
  "slack.eventsUrl.unsent": "まだ送っていません",
  "slack.eventsUrl.recheck": "再確認",
  "slack.eventsUrl.done": "Slack が Request URL を確認しました。",
  "slack.eventsUrl.reinstall":
    "manifest を Slack にもう一度送りました。アプリに新しい権限が加わり、アプリを再インストールすると適用されます。",
  "slack.eventsUrl.sent":
    "Request URL を Slack にもう一度送りました。URL が変わらなければ Slack は再び確認しないことがあります。確認待ちが続く場合は、アプリ設定の Event Subscriptions で Retry を押してください。",
  "slack.repositoryRequired.title": "Slack からはセッションを開始できません",
  "slack.repositoryRequired.body":
    "有効なリリース（{release}）では Slack のセッションを開始できません。リリースのリポジトリがカタログから外れているかワークスペースの上限が許可していない、またはエージェントの GitHub 設定を読み取れないためです。Slack のメンションと DM は拒否され、スレッドに案内だけが残ります。接続はできます。GitHub 設定を確認し、「詳細設定」で保存し直すと、新しいリリースが作成されます。",
  "slack.issuerChanged.title": "別の Slack ユーザーが作成したアプリです",
  "slack.issuerChanged.body":
    "アプリを作成した Slack ユーザー（{previous}）と、現在の App Configuration Token のユーザー（{user}）が異なります。このトークンではアプリのインストールや変更ができない場合があります。インストールに失敗したら、{previous} のトークンを登録し直すか、{user} をアプリのコラボレーターに追加してください。Slack でアプリを削除済みの場合は、危険な操作でアプリを削除して、もう一度インストールしてください。",
  "slack.releaseUnavailable.title": "Slack からはセッションを開始できません",
  "slack.releaseUnavailable.body":
    "有効なリリース（{release}）のモデル接続が無効になったか、そのモデルが接続のモデル一覧から外れました。Slack のメンションと DM は拒否され、スレッドに案内だけが残ります。「詳細設定」で使える接続とモデルを選んで保存すると、新しいリリースが作成されます。",
  "slack.noActiveRelease.title": "有効なリリースがありません",
  "slack.noActiveRelease.body":
    "リリースが有効になるまで、Slack のメンションと DM は拒否され、スレッドに案内だけが残ります。「詳細設定」で接続とモデルを選んで保存すると、最初のリリースが作成されます。",
  "slack.state.error": "エラー",
  "slack.createInstall": "Slack アプリを作成してインストール",
  "slack.configToken.unset":
    "ワークスペースに App Configuration Token が登録されていないため、アプリを作成できません。",
  "slack.configToken.needs_reentry":
    "ワークスペースに保存されたトークンを使用できないため、アプリを作成できません。",
  "slack.configToken.settings": "連携 > Slack でトークンを登録",
  "slack.configToken.askAdmin":
    "オーナーかアドミンにトークンの登録を依頼してください。",
  "slack.install": "Slack アプリをインストール",
  "slack.reinstall": "再インストール",
  "slack.working": "準備中…",
  "slack.refresh": "更新",
  "slack.delete": "アプリを削除",
  "slack.deleteTitle": "Slack アプリを削除",
  "slack.deleteWarning":
    "Slack からアプリを削除し、保存した認証情報も削除します。元に戻せません。もう一度接続すると新しいアプリが作られます。",
  "slack.deleted": "Slack アプリを削除しました。",
  "slack.deletedCleanupFailed":
    "Werft では Slack アプリを削除しましたが、Slack 側の後片付けに失敗しました。Slack のアプリ管理画面（api.slack.com/apps）でアプリを削除してください。",
  "slack.revoke": "接続を解除",
  "slack.revokeTitle": "Slack の接続を解除",
  "slack.revokeWarning":
    "このエージェントの Slack ID とチャンネル接続を解除します。以後のイベントは受信しません。Slack アプリは残り、再インストールできます。",
  "slack.revoked": "Slack の接続を解除しました。",
  "slack.activateFirst":
    "Slack アプリの作成前にエージェントを有効にしてください。",
  "slack.channels": "チャンネル",
  "slack.sectionNav": "Slack セクション",
  "slack.manage": "管理",
  "slack.saved": "チャンネルの使用設定を保存しました。",
  "slack.homeSaved": "ホームチャンネルを設定しました。",
  "slack.channelConnected": "チャンネルを接続しました。",
  "slack.dmSaved": "DM の設定を保存しました。",
  "slack.mentionOnlySavedOn": "@メンションされたときだけ応答します。",
  "slack.mentionOnlySavedOff": "メンションがなくても応答します。",
  "slack.home": "ホームチャンネル",
  "slack.setHome": "ホームに設定",
  "slack.homeStep": "ホームチャンネルの設定",
  "slack.pickHome": "ホームチャンネルを選ぶ",
  "slack.homeStepHint":
    "まず、エージェントが紹介やお知らせを投稿するホームチャンネルを選んでください。選んだチャンネルはすぐに使用中になります。非公開チャンネルはチャンネルで /invite を使ってボットを招待してください。",
  "slack.channelHome": "{channel} をホームに設定",
  "slack.channelConnect": "{channel} に接続",
  "slack.connectedChannels": "接続済みチャンネル",
  "slack.channelsAudience":
    "このチャンネルの全員が返信を読めます。担当チーム外の人も含まれます。",
  "slack.noConnectedChannels": "接続済みチャンネルはありません",
  "slack.addChannelHint":
    "「チャンネルを追加」から、このエージェントが応答するチャンネルを選んでください。",
  "slack.addChannel": "チャンネルを追加",
  "slack.cardHint":
    "このエージェントが Slack で使うアプリ、アドレス、チャンネルです。",
  "slack.tokenHint":
    "このエージェントの Slack アプリを作るときに使うワークスペースの {token} です。登録と差し替えは連携 > Slack で行います。",
  "slack.tokenManage": "連携 > Slack で管理",
  "slack.addressesHint":
    "このエージェントのアプリが使うイベントリクエスト URL です。コンソールがアプリを作るときに自動で設定し、Slack がこのアドレスを確認するとチャンネルの投稿を受け取れます。",
  "slack.appsHint":
    "このコンソールがこのエージェントのために作った Slack アプリです。インストールと再インストールはここで、接続解除と削除は危険な操作で行います。",
  "slack.appsEmpty": "このエージェントの Slack アプリはまだありません。",
  "slack.appName": "{name} アプリ",
  "slack.appMenu": "Slack アプリのメニュー",
  "slack.basicHint": "このエージェントが DM とメンションにどう反応するかです。",
  "slack.notice": "告知の承認",
  "slack.noticeHint":
    "このエージェントが Slack チャンネルの投稿を聞く前に、ワークスペースの owner・admin が下の告知を読んで承認します。",
  "slack.notice.state.no_notice": "告知の準備中",
  "slack.notice.state.not_installed": "インストール前",
  "slack.notice.state.not_approved": "未承認",
  "slack.notice.state.reapproval_required": "再承認が必要",
  "slack.notice.state.approved": "承認済み",
  "slack.notice.placeholder":
    "公開された告知はまだありません。告知が公開されると、ここで読んで承認できます。",
  "slack.notice.notInstalled": "Slack アプリをインストールすると承認できます。",
  "slack.notice.reapprovalHint":
    "告知が変わったため、再承認が必要です。再承認するまで、このエージェントはチャンネルの投稿を聞きません。",
  "slack.notice.languageNote": "この告知は日本語と韓国語で提供しています。",
  "slack.notice.language": "告知の言語",
  "slack.notice.version": "告知 第{version}版",
  "slack.notice.approvals": "承認の記録",
  "slack.notice.team": "Slack チーム {team}",
  "slack.notice.older": "以前の版",
  "slack.notice.approve": "承認",
  "slack.notice.reapprove": "再承認",
  "slack.notice.revoke": "承認を取り消す",
  "slack.notice.revokeConsequence":
    "再承認するまで、このエージェントは Slack チャンネルの投稿を聞きません。",
  "slack.notice.adminOnly":
    "承認できるのはワークスペースの owner・admin だけです。",
  "slack.notice.approvedNotice": "告知を承認しました。",
  "slack.notice.revokedNotice": "告知の承認を取り消しました。",
  "slack.rollout": "静かに聞く（shadow）",
  "slack.rolloutHint":
    "オンにすると、このエージェントは聞く設定が「すべての投稿」のチャンネルの投稿を集めて、会話に加わるかを判断し、その記録だけを残します。その判断で Slack に投稿することはありません。オフにすると集めた投稿を削除し、新しい判断を止めます。判断の記録とチャンネルの要約は残ります。",
  "slack.rollout.locked": "告知を承認するとオンにできます。",
  "slack.rollout.adminOnly":
    "ワークスペースの owner・admin だけが変更できます。",
  "slack.rollout.savedOn": "静かに聞くをオンにしました。",
  "slack.rollout.savedOff": "静かに聞くをオフにしました。",
  "slack.notice.stale":
    "その間に告知が変わりました。新しい告知を読んで、もう一度承認してください。",
  "slack.channelColumn": "チャンネル",
  "slack.useColumn": "使用",
  "slack.listenColumn": "聞き取り",
  "slack.listen.free": "すべての投稿",
  "slack.listen.mention": "メンションのみ",
  "slack.listen.off": "聞かない",
  "slack.listenOf": "{channel} の聞き取り",
  "slack.listenHint":
    "聞き取りの設定は、エージェントの会話スイッチをオンにしてから適用されます。",
  "slack.listenSaved": "聞き取りの設定を保存しました。",
  "slack.listenSavedDropped":
    "聞き取りの設定を保存しました。このチャンネルで判断待ちだった投稿は削除しました。",
  "slack.listenRefused": "保存されていません",
  "slack.listenFailed":
    "{channel} の聞き取りの設定を保存できませんでした。{reason}",
  "slack.listenExternalShared":
    "{channel} は外部の組織と共有しているチャンネルのため、メンションのみ聞き取れます。「メンションのみ」か「聞かない」を選んでください。",
  "slack.basic": "基本",
  "slack.advanced": "詳細",
  "slack.homeChannel": "ホームチャンネル",
  "slack.homeUnset": "未選択",
  "slack.channelId": "チャンネル ID: {id}",
  "slack.channelsLoading": "チャンネルを読み込み中",
  "slack.botId": "ボット ID",
  "slack.mentionOnlyHint":
    "オンにすると @メンションされたときだけ、オフにするとメンションがなくてもチャンネルへの投稿に応答します。どちらでも、すでに会話中のスレッドの返信にはメンションなしで応答します。",
  "slack.dm": "ダイレクトメッセージ",
  "slack.dmSetting": "DM を受け取る",
  "slack.dmHint":
    "Slack アプリのメッセージタブで1対1の会話を受け取ります。Slack アカウントを連携したメンバーだけが使えます。",
  "slack.public": "公開",
  "slack.private": "非公開",
  "slack.off": "オフ",
  "slack.on": "オン",
  "slack.inUseOf": "{channel} で使用",
  "slack.mentionOnly": "メンション時のみ応答",
  "slack.bots": "応答するボット",
  "slack.botsHint":
    "選んだボットがこのエージェントを直接 @メンションすると応答します。1 つのスレッドで人を挟まずにボット同士が 5 回やり取りすると止まり、人が書き込むと数え直します。ボットが始めた会話では個人の接続を使いません。",
  "slack.botsNone": "なし",
  "slack.botsCount": "{count} 件",
  "slack.botsEdit": "変更",
  "slack.botsTitle": "応答するボットを選ぶ",
  "slack.botsDialogHint":
    "この Slack ワークスペースのボットだけを選べます。この Werft のほかのエージェントのボットは選べません。",
  "slack.botsEmpty": "選べるボットがありません。",
  "slack.botsSave": "保存",
  "slack.botsSaved": "応答するボットを保存しました。",
  "slack.botGone": "Slack から削除済み",
  "slack.botsTruncated":
    "ワークスペースが大きく、Slack の一覧を最後まで読めませんでした。上にないボットは Slack ユーザー ID で追加してください。追加するとすぐに保存されます。",
  "slack.botAddById": "Slack ユーザー ID で追加",
  "slack.botAdd": "追加",
  "slack.botAdded": "ボットを追加しました。",
  "slack.botIdInvalid":
    "U または W で始まる Slack ユーザー ID を入力してください。",
  "slack.search": "チャンネルを検索",
  "slack.privateInvite": "/invite が必要",
  "slack.pendingApproval": "承認待ち",
  "slack.pendingApprovalHint":
    "オーナーまたはアドミンが承認するまで、このチャンネルのメッセージには返信しません。",
  "slack.approve": "承認",
  "slack.approveChannel": "チャンネルを承認: {channel}",
  "slack.approved": "チャンネルを承認しました。",
  "slack.left": "退出",
  "slack.inactive": "無効",
  "slack.gone": "削除済み",
  "slack.goneHint":
    "Slack でチャンネルが削除されたため、メッセージを受け取りも送りもしません。",
  "slack.leftHint":
    "ボットがチャンネルから退出したため、メッセージの受信も送信もしません。チャンネルに再度招待すると承認待ちに戻ります。",
  "slack.add": "接続",
  "slack.noChannels":
    "一致するチャンネルがありません。非公開チャンネルには、先に /invite でボットを招待してください。",
  "slack.partial":
    "一部のチャンネルが表示されないか、古い結果の可能性があります。",
  "slack.more": "もっと見る",
  "slack.reinstallTitle": "Slack アプリを再インストール",
  "slack.reinstallHint":
    "権限やイベント設定が変わったときに再インストールします。Slack の同意画面に移動します。",
  "slack.installHint":
    "Slack の同意画面に移動して、このワークスペースにアプリをインストールします。",
  "slack.installed": "Slack にアプリをインストールしました。",
  "slack.copyInvite": "/invite コマンドをコピー",
  "slack.inviteCommand": "/invite コマンド",
  "slack.copied": "コピーしました",
  "slack.copy": "コピー",
  "slack.inviteTitle": "チャンネルに招待",
  "slack.inviteHint":
    "Slack のチャンネルのメッセージ欄に貼り付けて送信すると、ボットがそのチャンネルに招待されます。",
  "slack.openInSlack": "Slack で開く",
  "slack.newTab": "(新しいタブで開きます)",
  "slack.copyFailed":
    "クリップボードにコピーできませんでした。選択されたコマンドを手動でコピーしてください。",
  "slack.copyInviteFailed":
    "クリップボードにコピーできませんでした。コマンドの行を選択して手動でコピーしてください。",
} as const;

export const ja: Record<MessageKey, string> = {
  ...slackJa,
  ...commonJa,
  ...shellJa,
  ...authJa,
  ...homeJa,
  ...membersJa,
  ...teamsJa,
  ...agentsJa,
  ...modelsJa,
  ...settingsJa,
  ...sessionsJa,
  ...sessionListJa,
  ...flowJa,
  ...linkedJa,
  ...loginMethodsJa,
  ...loginProvidersJa,
  ...executionLimitsJa,
  ...auditLogJa,
  ...outputsJa,
  ...apiKeysJa,
  ...workspaceJa,
  ...workspaceMcpJa,
  ...skillsJa,
  ...githubJa,
  ...githubUserLinkJa,
  ...agentGitHubJa,
  ...agentAccessJa,
  ...usageJa,
  ...achievementsJa,
  ...achievementRulesJa,
  ...preferencesJa,
  ...errorsJa,
  ...formsJa,
};
