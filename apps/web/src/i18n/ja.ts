import { flowJa, formsJa, sessionsJa } from "@werft-ai/react";
import { achievementRulesJa } from "./achievement-rules.ts";
import { achievementsJa } from "./achievements.ts";
import { agentGitHubJa } from "./agent-github.ts";
import { agentsJa } from "./agents.ts";
import { apiKeysJa } from "./api-keys.ts";
import { authJa } from "./auth.ts";
import { commonJa } from "./common.ts";
import { errorsJa } from "./errors.ts";
import { githubJa } from "./github.ts";
import { githubUserLinkJa } from "./github-user-link.ts";
import { homeJa } from "./home.ts";
import type { MessageKey } from "./ko.ts";
import { linkedJa } from "./linked.ts";
import { membersJa } from "./members.ts";
import { modelsJa } from "./models.ts";
import { outputsJa } from "./outputs.ts";
import { preferencesJa } from "./preferences.ts";
import { profilesJa } from "./profiles.ts";
import { sessionListJa } from "./session-list.ts";
import { settingsJa } from "./settings.ts";
import { shellJa } from "./shell.ts";
import { teamsJa } from "./teams.ts";
import { usageJa } from "./usage.ts";
import { workspaceJa } from "./workspace.ts";

export const slackJa = {
  "slack.error.config":
    "ワークスペースの Slack アプリ作成設定が必要です。管理者に設定を依頼してください。",
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
  "slack.eventsPending.title": "Slack が Request URL をまだ確認していません",
  "slack.eventsPending.body":
    "Slack がこのアプリの Request URL を確認するまで、招待・メンション・DM のイベントは届きません。詳細の「再確認」で URL をもう一度送ってください。それでも残る場合は、アプリ設定の Event Subscriptions で Request URL の Verify(または Retry)を押してください。確認が届くとこの案内は消えます。",
  "slack.eventsPending.open": "Event Subscriptions を開く",
  "slack.channelsLocked.title": "Request URL の確認前はチャンネルを選べません",
  "slack.channelsLocked.body":
    "Slack がこのアプリの Request URL を確認するまで、チャンネルのイベントは届きません。詳細の「再確認」で URL をもう一度送ってください。確認されるとすぐに解除されます。",
  "slack.channelsLocked.action": "再確認へ移動",
  "slack.eventsUrl.title": "イベントの Request URL",
  "slack.eventsUrl.hint":
    "Slack が招待・メンション・DM を送る先です。再確認するとアプリ設定に URL をもう一度送り、Slack の確認要求に自動で応答します。",
  "slack.eventsUrl.verified": "Slack が確認済み",
  "slack.eventsUrl.pending": "Slack の確認待ち",
  "slack.eventsUrl.failed": "登録に失敗",
  "slack.eventsUrl.unsent": "まだ送っていません",
  "slack.eventsUrl.recheck": "再確認",
  "slack.eventsUrl.done": "Slack が Request URL を確認しました。",
  "slack.eventsUrl.sent":
    "Request URL を Slack にもう一度送りました。Slack が確認すると状態が変わります。",
  "slack.repositoryRequired.title": "Slack からはセッションを開始できません",
  "slack.repositoryRequired.body":
    "有効なリリースのプロファイル（{profile}）はセッションごとにリポジトリが必要ですが、リリースに使えるリポジトリがありません（選ばれていないか、カタログから外れています）。Slack のメンションと DM は拒否され、スレッドに案内だけが残ります。接続はできます。「詳細設定」でリポジトリを使えるプロファイルを選んで保存すると、新しいリリースが作成されます。",
  "slack.issuerChanged.title": "別の Slack ユーザーが作成したアプリです",
  "slack.issuerChanged.body":
    "アプリを作成した Slack ユーザー（{previous}）と、現在の App Configuration Token のユーザー（{user}）が異なります。このトークンではアプリのインストールや変更ができない場合があります。インストールに失敗したら、{previous} のトークンを登録し直すか、{user} をアプリのコラボレーターに追加してください。Slack でアプリを削除済みの場合は、危険な操作でアプリを削除して、もう一度インストールしてください。",
  "slack.profileUnavailable.title": "Slack からはセッションを開始できません",
  "slack.profileUnavailable.body":
    "有効なリリースのプロファイル（{profile}）がカタログにないか、リリース後に変更されたか、運用担当者がブロックしました。Slack のメンションと DM は拒否され、スレッドに案内だけが残ります。「詳細設定」で使えるプロファイルを選んで保存すると、新しいリリースが作成されます。",
  "slack.noActiveRelease.title": "有効なリリースがありません",
  "slack.noActiveRelease.body":
    "リリースが有効になるまで、Slack のメンションと DM は拒否され、スレッドに案内だけが残ります。「詳細設定」でプロファイルを選んで保存すると、最初のリリースが作成されます。",
  "slack.state.error": "エラー",
  "slack.createInstall": "Slack アプリを作成してインストール",
  "slack.configToken.unset":
    "ワークスペースに App Configuration Token が登録されていないため、アプリを作成できません。",
  "slack.configToken.needs_reentry":
    "ワークスペースに保存されたトークンを使用できないため、アプリを作成できません。",
  "slack.configToken.settings": "Slack 接続設定でトークンを登録",
  "slack.configToken.askAdmin":
    "オーナーか管理者にトークンの登録を依頼してください。",
  "slack.install": "Slack アプリをインストール",
  "slack.reinstall": "再インストール",
  "slack.working": "準備中…",
  "slack.refresh": "更新",
  "slack.delete": "アプリを削除",
  "slack.deleteTitle": "Slack アプリを削除",
  "slack.deleteWarning":
    "Slack からアプリを削除し、保存した認証情報も削除します。元に戻せません。もう一度接続すると新しいアプリが作られます。",
  "slack.deleted": "Slack アプリを削除しました。",
  "slack.revoke": "接続解除",
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
  "slack.basic": "基本",
  "slack.advanced": "詳細",
  "slack.connection": "接続",
  "slack.status": "状態",
  "slack.homeChannel": "ホームチャンネル",
  "slack.homeUnset": "未選択",
  "slack.channelId": "チャンネル ID: {id}",
  "slack.channelsLoading": "チャンネルを読み込み中",
  "slack.danger": "危険な操作",
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
  "slack.inUse": "このチャンネルで使用",
  "slack.inUseOf": "{channel} で使用",
  "slack.mentionOnly": "メンション時のみ応答",
  "slack.search": "チャンネルを検索",
  "slack.invite": "参加待ち",
  "slack.privateInvite": "/invite が必要",
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
  "slack.copyAppId": "アプリ ID をコピー",
  "slack.copyAppIdFailed":
    "クリップボードにコピーできませんでした。アプリ ID を選択して手動でコピーしてください。",
  "slack.openInSlack": "Slack で開く",
  "slack.newTab": "(新しいタブで開きます)",
  "slack.copyFailed":
    "クリップボードにコピーできませんでした。選択されたコマンドを手動でコピーしてください。",
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
  ...profilesJa,
  ...settingsJa,
  ...sessionsJa,
  ...sessionListJa,
  ...flowJa,
  ...linkedJa,
  ...outputsJa,
  ...apiKeysJa,
  ...workspaceJa,
  ...githubJa,
  ...githubUserLinkJa,
  ...agentGitHubJa,
  ...usageJa,
  ...achievementsJa,
  ...achievementRulesJa,
  ...preferencesJa,
  ...errorsJa,
  ...formsJa,
};
