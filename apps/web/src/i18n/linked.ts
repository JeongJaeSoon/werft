export const linkedKo = {
  "linked.title": "연동 계정",
  "linked.intro":
    "Slack 계정을 연결하면 Slack에서 에이전트에게 요청할 때 내 권한이 적용됩니다. GitHub 계정을 연결하면 내가 요청한 턴의 commit에 공동 작성자로 이름이 들어갑니다. 어느 쪽 토큰도 저장하지 않습니다.",
  "linked.slack": "Slack",
  "linked.connected": "연결됨",
  "linked.notLinked": "연결 안 됨",
  "linked.soon": "준비 중",
  "linked.use.github": "세션 commit에 공동 작성자로 표시",
  "linked.github.unset": "관리자가 사용자 연결을 켜야 해요",
  "linked.github.connect": "GitHub 계정 연결",
  "linked.github.starting": "GitHub로 이동하는 중…",
  "linked.github.coAuthor": "commit에 들어가는 줄: Co-authored-by: {line}",
  "linked.github.unlinked": "GitHub 계정 연결을 해제했습니다.",
  "linked.github.cancelled":
    "GitHub 계정 연결을 마치지 못했습니다 — 다시 시도하세요.",
  "linked.use.slack": "알림과 요청 답변",
  "linked.use.google": "Drive·Docs 읽기·쓰기, Calendar",
  "linked.link": "연결",
  "linked.connect": "Slack 계정 연결",
  "linked.starting": "Slack으로 이동하는 중…",
  "linked.slackAccount": "Slack 사용자 {user} (워크스페이스 {team})",
  "linked.slackNamed": "{user} · {team}",
  "linked.slackIds": "사용자 ID {user} · 워크스페이스 ID {team}",
  "linked.verified": "{at} 확인",
  "linked.stale":
    "Slack에서 이 계정이 비활성화됐다고 알려 와, 이 계정의 요청을 나와 연결하지 않습니다 — 연결을 해제한 뒤 다시 연결하세요.",
  "linked.unlink": "연결 해제",
  "linked.unlinked": "Slack 계정 연결을 해제했습니다.",
  "linked.unlinkTitle": "Slack 계정 연결을 해제할까요?",
  "linked.unlinkHint":
    "Slack에서 보낸 요청이 더 이상 나와 연결되지 않습니다. 다시 쓰려면 Slack 동의를 거쳐 다시 연결하세요.",
  "linked.github.unlinkTitle": "GitHub 계정 연결을 해제할까요?",
  "linked.github.unlinkHint":
    "내가 요청한 턴의 commit에 더 이상 공동 작성자로 들어가지 않습니다. 다시 쓰려면 GitHub 동의를 거쳐 다시 연결하세요.",
  "linked.unavailable":
    "이 설치에서는 Slack 계정 연결을 쓸 수 없습니다 — 운영자에게 문의하세요.",
  "linked.cancelled": "Slack 계정 연결을 마치지 못했습니다 — 다시 시도하세요.",
  "linked.back": "연동 계정으로",
};

export const linkedEn: Record<keyof typeof linkedKo, string> = {
  "linked.title": "Linked accounts",
  "linked.intro":
    "Link your Slack account so that requests you make to agents in Slack use your permissions. Link your GitHub account so that commits of the turns you request name you as co-author. No token of either is stored.",
  "linked.slack": "Slack",
  "linked.connected": "Linked",
  "linked.notLinked": "Not linked",
  "linked.soon": "Coming soon",
  "linked.use.github": "Co-author on your session commits",
  "linked.github.unset": "An admin must turn on user linking first",
  "linked.github.connect": "Link GitHub account",
  "linked.github.starting": "Going to GitHub…",
  "linked.github.coAuthor": "Line in commits: Co-authored-by: {line}",
  "linked.github.unlinked": "Unlinked the GitHub account.",
  "linked.github.cancelled": "GitHub linking was not completed — try again.",
  "linked.use.slack": "Notifications and answering requests",
  "linked.use.google": "Drive and Docs read and write, Calendar",
  "linked.link": "Link",
  "linked.connect": "Link Slack account",
  "linked.starting": "Going to Slack…",
  "linked.slackAccount": "Slack user {user} (workspace {team})",
  "linked.slackNamed": "{user} · {team}",
  "linked.slackIds": "User ID {user} · workspace ID {team}",
  "linked.verified": "Verified {at}",
  "linked.stale":
    "Slack says this account was deactivated, so requests from it are not matched to you — unlink it and link it again.",
  "linked.unlink": "Unlink",
  "linked.unlinked": "Unlinked the Slack account.",
  "linked.unlinkTitle": "Unlink the Slack account?",
  "linked.unlinkHint":
    "Requests you send from Slack are no longer tied to you. To use it again, link it again through Slack's consent screen.",
  "linked.github.unlinkTitle": "Unlink the GitHub account?",
  "linked.github.unlinkHint":
    "Commits of the turns you request no longer name you as co-author. To use it again, link it again through GitHub's consent screen.",
  "linked.unavailable":
    "Slack account linking is not available on this installation — ask your operator.",
  "linked.cancelled": "Slack linking was not completed — try again.",
  "linked.back": "Back to linked accounts",
};

export const linkedJa: Record<keyof typeof linkedKo, string> = {
  "linked.title": "連携アカウント",
  "linked.intro":
    "Slack アカウントを連携すると、Slack でエージェントに依頼したリクエストに自分の権限が使われます。GitHub アカウントを連携すると、自分が依頼したターンのコミットに共同作成者として名前が入ります。どちらのトークンも保存しません。",
  "linked.slack": "Slack",
  "linked.connected": "連携済み",
  "linked.notLinked": "未連携",
  "linked.soon": "準備中",
  "linked.use.github": "セッションのコミットに共同作成者として表示",
  "linked.github.unset": "管理者が有効にすると連携できます",
  "linked.github.connect": "GitHub アカウントを連携",
  "linked.github.starting": "GitHub に移動しています…",
  "linked.github.coAuthor": "コミットに入る行: Co-authored-by: {line}",
  "linked.github.unlinked": "GitHub アカウントの連携を解除しました。",
  "linked.github.cancelled":
    "GitHub 連携が完了しませんでした。もう一度お試しください。",
  "linked.use.slack": "通知とリクエストへの回答",
  "linked.use.google": "Drive・Docs の読み書き、Calendar",
  "linked.link": "連携",
  "linked.connect": "Slack アカウントを連携",
  "linked.starting": "Slack に移動しています…",
  "linked.slackAccount": "Slack ユーザー {user}（ワークスペース {team}）",
  "linked.slackNamed": "{user} · {team}",
  "linked.slackIds": "ユーザー ID {user} · ワークスペース ID {team}",
  "linked.verified": "{at}に確認",
  "linked.stale":
    "Slack でこのアカウントが無効化されたため、このアカウントからのリクエストはあなたと紐付けられません。連携を解除してから、もう一度連携してください。",
  "linked.unlink": "連携を解除",
  "linked.unlinked": "Slack アカウントの連携を解除しました。",
  "linked.unlinkTitle": "Slack アカウントの連携を解除しますか?",
  "linked.unlinkHint":
    "Slack から送ったリクエストはあなたに結び付かなくなります。再び使うには、Slack の同意画面から連携し直してください。",
  "linked.github.unlinkTitle": "GitHub アカウントの連携を解除しますか?",
  "linked.github.unlinkHint":
    "あなたが依頼したターンの commit に共同作成者として入らなくなります。再び使うには、GitHub の同意画面から連携し直してください。",
  "linked.unavailable":
    "この環境では Slack アカウント連携を利用できません。運用担当者にお問い合わせください。",
  "linked.cancelled":
    "Slack 連携が完了しませんでした。もう一度お試しください。",
  "linked.back": "連携アカウントへ戻る",
};
