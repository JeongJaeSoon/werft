export const outputsKo = {
  "session.outputs.title": "성과물",
  "session.outputs.download": "{name} 내려받기",
  "session.outputs.tooLarge": "너무 커서 보관하지 않음",
  "session.outputs.files": "out/ 파일",
  "session.outputs.empty": "아직 성과물이 없습니다.",
  "session.outputs.emptyHint":
    "성과물은 이 세션이 연 GitHub PR과 작업 공간의 out/ 폴더에 남긴 파일을 셉니다. 저장소 파일을 고친 내역은 진행 탭의 도구 호출에서 볼 수 있습니다.",
  "session.achievements.title": "성과",
  "session.achievements.description":
    "워크스페이스 성과 규칙으로 판정한 것입니다. PR·리뷰가 근거인 성과는 바로 집계되고, out/ 파일이나 대화가 근거인 성과는 확인해야 집계됩니다.",
  "session.achievements.state.auto": "집계됨",
  "session.achievements.state.confirmed": "확인됨",
  "session.achievements.state.needs_review": "확인 필요",
  "session.achievements.state.rejected": "거절됨",
  "session.achievements.probability": "정의에 맞을 확률 {probability}",
  "session.achievements.probabilityThreshold":
    "정의에 맞을 확률 {probability} (문턱 {threshold})",
  "session.achievements.evidence": "근거",
  "session.achievements.fileNeedsReview": "(에이전트가 쓴 파일이라 확인 필요)",
  "session.achievements.rule": "규칙 v{version}",
  "session.achievements.judge.luna": "Luna 판정",
  "session.achievements.judge.always": "바로 인정",
  "session.achievements.reject": "거절",
  "session.achievements.rejectNamed": "{name} 성과 거절",
  "session.achievements.confirm": "확인",
  "session.achievements.confirmNamed": "{name} 성과 확인",
  "session.achievements.lastJudged": "마지막 판정",
  "session.achievements.status.queued": "판정 대기",
  "session.achievements.status.running": "판정 중",
  "session.achievements.status.deferred": "하루 판정 예산을 넘어 다음 날 판정",
  "session.achievements.status.failed": "판정 실패",
  "session.achievements.status.skipped": "판정 건너뜀",
  "session.achievements.trigger.evidence": "근거 바뀜",
  "session.achievements.trigger.pr_merged": "근거 바뀜(PR 머지)",
  "session.achievements.rejudgedAfterMerge": "머지 뒤 다시 판정",
  "session.achievements.trigger.turns": "턴 주기",
  "session.achievements.trigger.idle": "세션 멈춤",
  "session.achievements.trigger.manual": "다시 판정 요청",
  "session.achievements.count": "판정 {count}회",
  "session.achievements.cost": "판정 비용 {cost} (세션 비용과 별도)",
  "session.achievements.rejudge": "다시 판정",
  "session.achievements.error.judge_unavailable": "판정기 없음",
  "session.achievements.error.outputs_unavailable":
    "out/ 파일 목록을 읽지 못함",
  "session.achievements.error.session_limit": "세션 판정 횟수 상한에 닿음",
  "session.achievements.error.judge_refused": "판정기가 답을 거부함",
  "session.achievements.error.judge_timeout": "판정기가 10초 안에 답하지 않음",
  "session.achievements.error.judge_http_error": "판정기 요청이 실패함",
  "session.achievements.error.judge_bad_response":
    "판정기 답의 모양이 맞지 않음",
  "session.outcomes.title": "근거",
  "session.outcomes.description":
    "플랫폼이 직접 본 사실입니다. GitHub 상태는 주기적으로 다시 읽습니다.",
  "session.outcomes.kind.pullRequest": "PR",
  "session.outcomes.kind.review": "리뷰",
  "session.outcomes.event.APPROVE": "승인",
  "session.outcomes.event.REQUEST_CHANGES": "변경 요청",
  "session.outcomes.event.COMMENT": "코멘트",
  "session.outcomes.submittedAt": "제출",
  "session.outcomes.otherSessionPullRequest": "다른 세션이 연 PR",
  "session.outcomes.state.open": "열림",
  "session.outcomes.state.merged": "머지됨",
  "session.outcomes.state.closed": "닫힘",
  "session.outcomes.mergedAt": "머지",
  "session.outcomes.closedAt": "닫음",
  "session.outcomes.checkedAt": "상태 확인",
  "session.outcomes.notChecked": "아직 상태를 확인하지 않음",
  "session.outcomes.checkError.not_found":
    "마지막 확인에서 GitHub가 이 PR을 찾지 못했습니다. 상태는 그 전에 확인한 값입니다.",
  "session.outcomes.checkError.forge_failed":
    "마지막 확인에서 GitHub 요청이 실패했습니다. 상태는 그 전에 확인한 값입니다.",
  "session.outcomes.checkError.github_refused":
    "마지막 확인이 GitHub 설정에서 거절됐습니다. 상태는 그 전에 확인한 값입니다.",
  "session.outcomes.usage": "이 세션이 쓴 토큰 {tokens} · 추정 비용 {cost}",
  "session.outcomes.usageUnmetered":
    "이 세션이 쓴 토큰 {tokens} · 토큰별 과금 없음",
  "session.refusals.title": "최근 GitHub 거절",
  "session.github.title": "GitHub 작업",
  "session.github.description":
    "이 세션이 GitHub에 올린 push와 PR입니다. 작업이 끝나면 올리기로 한 push도 여기에 나옵니다.",
  "session.github.state.requested": "승인 대기",
  "session.github.state.approved": "승인됨",
  "session.github.state.rejected": "거절됨",
  "session.github.state.pushing": "push 중",
  "session.github.state.pushed": "push됨",
  "session.github.state.failed": "push 실패",
  "session.github.showEarlier": "같은 브랜치의 이전 push {count}건 보기",
  "session.github.hideEarlier": "이전 push 접기",
  "session.github.intent.deferred": "작업이 끝나기를 기다리는 중",
  "session.github.intent.requested": "요청 생성됨",
  "session.github.intent.pinned": "요청을 만드는 중",
  "session.github.intent.failed": "요청을 만들지 못함",
  "session.github.intent.cancelled": "취소됨",
  "session.github.prState.due": "PR 대기",
  "session.github.prState.opening": "PR 여는 중",
  "session.github.prState.opened": "PR 열림",
  "session.github.prState.closed_unrecorded": "PR 닫힘",
  "session.github.prState.uncertain": "PR 확인 필요",
  "session.github.prState.failed": "PR 실패",
  "session.github.prState.cancelled": "PR 취소됨",
  "session.github.prError.head_moved":
    "브랜치가 push한 commit이 아닌 곳을 가리켜 PR을 기록하지 않았습니다.",
  "session.github.prError.closed_unrecorded":
    "이 push의 PR이 기록되기 전에 닫혔거나 머지됐습니다.",
  "session.github.prError.duplicate_pull_request":
    "맞는 PR이 둘 이상이라 고르지 않았습니다. GitHub에서 확인해 주세요.",
  "session.github.prError.catalog_changed":
    "저장소 설정이 요청 때와 달라졌습니다.",
  "session.github.prError.target_refused": "이 브랜치로는 PR을 열 수 없습니다.",
  "session.github.prError.github_refused":
    "GitHub 설정이 PR 열기를 막았습니다.",
  "session.github.prError.no_forge": "GitHub에 연결할 수 없습니다.",
  "session.github.prError.forge_failed": "GitHub 호출이 실패했습니다.",
  "session.github.prError.lookup_failed":
    "PR이 이미 있는지 확인하지 못했습니다.",
  "session.github.prError.lease_expired": "PR 열기가 제때 끝나지 않았습니다.",
  "session.github.prError.intent_invalid":
    "저장된 PR 요청 내용을 읽을 수 없습니다.",
  "session.github.prNumber": "PR #{number}",
  "session.github.reason.turn_ended_without_checkpoint":
    "턴이 체크포인트 없이 끝났습니다.",
  "session.github.reason.turn_finalized_without_pin":
    "턴이 끝났지만 push할 체크포인트를 고정하지 못했습니다.",
  "session.github.reason.superseded_by_turn":
    "답변을 기다리는 사이 다른 턴이 먼저 실행돼 push를 취소했습니다.",
  "session.github.reason.session_closed": "세션이 닫혔습니다.",
  "session.github.reason.rejected_before": "같은 커밋을 이미 거절했습니다.",
  "session.github.reason.request_open":
    "같은 대상의 앞선 요청이 아직 열려 있습니다.",
  "session.github.reason.github_disabled":
    "에이전트의 GitHub 설정이 꺼져 있습니다.",
  "session.github.reason.over_workspace_ceiling":
    "워크스페이스 상한을 넘는 요청입니다.",
  "session.github.reason.repository_not_allowed":
    "이 저장소는 릴리스가 허용하지 않습니다.",
  "session.github.reason.checkpoint_unavailable":
    "고정한 체크포인트를 읽을 수 없습니다.",
  "session.github.reason.source_missing": "push할 소스가 없습니다.",
  "session.github.reason.attribution_mismatch":
    "commit 작성자 표기가 세션과 맞지 않습니다.",
  "session.github.reason.uncommitted_changes":
    "commit되지 않은 변경이 남아 있습니다.",
  "session.github.reason.pinned_source_invalid":
    "고정한 체크포인트를 더는 확인할 수 없습니다.",
  "session.attribution.coAuthor": "commit 공동 작성자: {login}",
  "session.attribution.unlinked":
    "시작한 사람의 GitHub 계정이 연결되지 않아 commit에 공동 작성자가 없습니다.",
  "session.attribution.link": "연동 계정",
  "session.attribution.appOnly":
    "시작한 사람이 없는 세션이라 commit은 App 이름으로만 남습니다.",
};

export const outputsJa: Record<keyof typeof outputsKo, string> = {
  "session.outputs.title": "成果物",
  "session.outputs.download": "{name} をダウンロード",
  "session.outputs.tooLarge": "大きすぎるため保存されていません",
  "session.outputs.files": "out/ のファイル",
  "session.outputs.empty": "まだ成果物はありません。",
  "session.outputs.emptyHint":
    "成果物として数えるのは、このセッションが開いた GitHub PR と、作業スペースの out/ フォルダに残したファイルです。リポジトリのファイルを変更した内容は、経過タブのツール呼び出しで確認できます。",
  "session.achievements.title": "成果",
  "session.achievements.description":
    "ワークスペースの成果ルールで判定したものです。PR・レビューが根拠の成果はすぐに集計され、out/ ファイルや会話が根拠の成果は確認すると集計されます。",
  "session.achievements.state.auto": "集計済み",
  "session.achievements.state.confirmed": "確認済み",
  "session.achievements.state.needs_review": "要確認",
  "session.achievements.state.rejected": "却下",
  "session.achievements.probability": "定義に合う確率 {probability}",
  "session.achievements.probabilityThreshold":
    "定義に合う確率 {probability} (しきい値 {threshold})",
  "session.achievements.evidence": "根拠",
  "session.achievements.fileNeedsReview":
    "(エージェントが書いたファイルのため要確認)",
  "session.achievements.rule": "ルール v{version}",
  "session.achievements.judge.luna": "Luna 判定",
  "session.achievements.judge.always": "そのまま認定",
  "session.achievements.reject": "却下",
  "session.achievements.rejectNamed": "{name} の成果を却下",
  "session.achievements.confirm": "確認",
  "session.achievements.confirmNamed": "{name} の成果を確認",
  "session.achievements.lastJudged": "最後の判定",
  "session.achievements.status.queued": "判定待ち",
  "session.achievements.status.running": "判定中",
  "session.achievements.status.deferred":
    "1 日の判定予算を超えたため翌日に判定",
  "session.achievements.status.failed": "判定失敗",
  "session.achievements.status.skipped": "判定スキップ",
  "session.achievements.trigger.evidence": "根拠の変化",
  "session.achievements.trigger.pr_merged": "根拠の変化(PRマージ)",
  "session.achievements.rejudgedAfterMerge": "マージ後に再判定",
  "session.achievements.trigger.turns": "ターン周期",
  "session.achievements.trigger.idle": "セッション停止",
  "session.achievements.trigger.manual": "再判定の依頼",
  "session.achievements.count": "判定 {count} 回",
  "session.achievements.cost": "判定コスト {cost} (セッションのコストとは別)",
  "session.achievements.rejudge": "再判定",
  "session.achievements.error.judge_unavailable": "判定器なし",
  "session.achievements.error.outputs_unavailable":
    "out/ ファイルの一覧を読めませんでした",
  "session.achievements.error.session_limit":
    "セッションの判定回数の上限に達しました",
  "session.achievements.error.judge_refused": "判定器が回答を拒否しました",
  "session.achievements.error.judge_timeout":
    "判定器が 10 秒以内に応答しませんでした",
  "session.achievements.error.judge_http_error":
    "判定器へのリクエストが失敗しました",
  "session.achievements.error.judge_bad_response":
    "判定器の応答の形式が想定と違いました",
  "session.outcomes.title": "根拠",
  "session.outcomes.description":
    "プラットフォームが直接確認した事実です。GitHub の状態は定期的に読み直します。",
  "session.outcomes.kind.pullRequest": "PR",
  "session.outcomes.kind.review": "レビュー",
  "session.outcomes.event.APPROVE": "承認",
  "session.outcomes.event.REQUEST_CHANGES": "変更依頼",
  "session.outcomes.event.COMMENT": "コメント",
  "session.outcomes.submittedAt": "提出",
  "session.outcomes.otherSessionPullRequest": "別のセッションが開いた PR",
  "session.outcomes.state.open": "オープン",
  "session.outcomes.state.merged": "マージ済み",
  "session.outcomes.state.closed": "クローズ",
  "session.outcomes.mergedAt": "マージ",
  "session.outcomes.closedAt": "クローズ",
  "session.outcomes.checkedAt": "状態確認",
  "session.outcomes.notChecked": "まだ状態を確認していません",
  "session.outcomes.checkError.not_found":
    "前回の確認で GitHub がこの PR を見つけられませんでした。状態はその前に確認した値です。",
  "session.outcomes.checkError.forge_failed":
    "前回の確認で GitHub へのリクエストが失敗しました。状態はその前に確認した値です。",
  "session.outcomes.checkError.github_refused":
    "前回の確認は GitHub の設定で拒否されました。状態はその前に確認した値です。",
  "session.outcomes.usage":
    "このセッションのトークン {tokens} · 推定コスト {cost}",
  "session.outcomes.usageUnmetered":
    "このセッションのトークン {tokens} · トークン課金なし",
  "session.refusals.title": "最近の GitHub 拒否",
  "session.github.title": "GitHub 作業",
  "session.github.description":
    "このセッションが GitHub に送った push とプルリクエストです。作業の終了後に送る予定の push もここに出ます。",
  "session.github.state.requested": "承認待ち",
  "session.github.state.approved": "承認済み",
  "session.github.state.rejected": "却下済み",
  "session.github.state.pushing": "push 中",
  "session.github.state.pushed": "push 済み",
  "session.github.state.failed": "push 失敗",
  "session.github.showEarlier": "同じブランチの以前の push を {count} 件表示",
  "session.github.hideEarlier": "以前の push を閉じる",
  "session.github.intent.deferred": "作業の終了を待っています",
  "session.github.intent.requested": "リクエスト作成済み",
  "session.github.intent.pinned": "リクエストを作成中",
  "session.github.intent.failed": "リクエストを作れませんでした",
  "session.github.intent.cancelled": "キャンセル済み",
  "session.github.prState.due": "PR 待ち",
  "session.github.prState.opening": "PR を作成中",
  "session.github.prState.opened": "PR 作成済み",
  "session.github.prState.closed_unrecorded": "PR クローズ",
  "session.github.prState.uncertain": "PR 要確認",
  "session.github.prState.failed": "PR 失敗",
  "session.github.prState.cancelled": "PR キャンセル",
  "session.github.prError.head_moved":
    "ブランチが push した commit を指していないため、PR を記録しませんでした。",
  "session.github.prError.closed_unrecorded":
    "この push の PR は、記録される前にクローズまたはマージされました。",
  "session.github.prError.duplicate_pull_request":
    "当てはまる PR が複数あるため選びませんでした。GitHub で確認してください。",
  "session.github.prError.catalog_changed":
    "リポジトリの設定がリクエスト時と変わりました。",
  "session.github.prError.target_refused":
    "このブランチでは PR を作成できません。",
  "session.github.prError.github_refused":
    "GitHub の設定により PR の作成が拒否されました。",
  "session.github.prError.no_forge": "GitHub に接続できません。",
  "session.github.prError.forge_failed": "GitHub の呼び出しに失敗しました。",
  "session.github.prError.lookup_failed":
    "PR がすでにあるか確認できませんでした。",
  "session.github.prError.lease_expired":
    "PR の作成が時間内に終わりませんでした。",
  "session.github.prError.intent_invalid":
    "保存された PR のリクエスト内容を読み取れません。",
  "session.github.prNumber": "PR #{number}",
  "session.github.reason.turn_ended_without_checkpoint":
    "ターンがチェックポイントなしで終了しました。",
  "session.github.reason.turn_finalized_without_pin":
    "ターンは終了しましたが、push するチェックポイントを固定できませんでした。",
  "session.github.reason.superseded_by_turn":
    "回答待ちの間に別のターンが先に実行されたため、push を取り消しました。",
  "session.github.reason.session_closed": "セッションが閉じられました。",
  "session.github.reason.rejected_before":
    "同じコミットをすでに却下しています。",
  "session.github.reason.request_open":
    "同じ対象の前のリクエストがまだ開いています。",
  "session.github.reason.github_disabled":
    "エージェントの GitHub 設定が無効です。",
  "session.github.reason.over_workspace_ceiling":
    "ワークスペースの上限を超えるリクエストです。",
  "session.github.reason.repository_not_allowed":
    "このリポジトリはリリースで許可されていません。",
  "session.github.reason.checkpoint_unavailable":
    "固定したチェックポイントを読み取れません。",
  "session.github.reason.source_missing": "push するソースがありません。",
  "session.github.reason.attribution_mismatch":
    "コミットの作成者表記がセッションと一致しません。",
  "session.github.reason.uncommitted_changes":
    "コミットされていない変更が残っています。",
  "session.github.reason.pinned_source_invalid":
    "固定したチェックポイントをもう確認できません。",
  "session.attribution.coAuthor": "コミットの共同作成者: {login}",
  "session.attribution.unlinked":
    "開始した人の GitHub アカウントが連携されていないため、コミットに共同作成者はいません。",
  "session.attribution.link": "連携アカウント",
  "session.attribution.appOnly":
    "開始した人がいないセッションのため、コミットは App の名前だけで残ります。",
};

export const outputsEn: Record<keyof typeof outputsKo, string> = {
  "session.outputs.title": "Outputs",
  "session.outputs.download": "Download {name}",
  "session.outputs.tooLarge": "Too large to keep",
  "session.outputs.files": "out/ files",
  "session.outputs.empty": "No outputs yet.",
  "session.outputs.emptyHint":
    "Outputs are the GitHub pull requests this session opened and the files left in the workspace's out/ folder. Changes to repository files show up as tool calls on the Timeline tab.",
  "session.achievements.title": "Achievements",
  "session.achievements.description":
    "Judged by the workspace's achievement rules. Achievements from pull requests and reviews count at once; those from out/ files or the conversation count once confirmed.",
  "session.achievements.state.auto": "Counted",
  "session.achievements.state.confirmed": "Confirmed",
  "session.achievements.state.needs_review": "Needs review",
  "session.achievements.state.rejected": "Rejected",
  "session.achievements.probability":
    "Probability it fits the definition {probability}",
  "session.achievements.probabilityThreshold":
    "Probability it fits the definition {probability} (threshold {threshold})",
  "session.achievements.evidence": "Evidence",
  "session.achievements.fileNeedsReview":
    "(a file the agent wrote, so it needs review)",
  "session.achievements.rule": "Rule v{version}",
  "session.achievements.judge.luna": "Judged by Luna",
  "session.achievements.judge.always": "Counted as it appears",
  "session.achievements.reject": "Reject",
  "session.achievements.rejectNamed": "Reject the {name} achievement",
  "session.achievements.confirm": "Confirm",
  "session.achievements.confirmNamed": "Confirm the {name} achievement",
  "session.achievements.lastJudged": "Last judged",
  "session.achievements.status.queued": "Waiting to be judged",
  "session.achievements.status.running": "Being judged",
  "session.achievements.status.deferred":
    "Over the day's judging budget; judged tomorrow",
  "session.achievements.status.failed": "Judgment failed",
  "session.achievements.status.skipped": "Judgment skipped",
  "session.achievements.trigger.evidence": "evidence changed",
  "session.achievements.trigger.pr_merged": "evidence changed (PR merged)",
  "session.achievements.rejudgedAfterMerge": "judged again after the merge",
  "session.achievements.trigger.turns": "turn interval",
  "session.achievements.trigger.idle": "session stopped",
  "session.achievements.trigger.manual": "rejudge requested",
  "session.achievements.count": "{count} judgments",
  "session.achievements.cost": "judging cost {cost} (apart from the session's)",
  "session.achievements.rejudge": "Judge again",
  "session.achievements.error.judge_unavailable": "no judge",
  "session.achievements.error.outputs_unavailable":
    "could not read the out/ file list",
  "session.achievements.error.session_limit":
    "the session reached its judgment limit",
  "session.achievements.error.judge_refused": "the judge refused to answer",
  "session.achievements.error.judge_timeout":
    "the judge did not answer within 10 seconds",
  "session.achievements.error.judge_http_error":
    "the request to the judge failed",
  "session.achievements.error.judge_bad_response":
    "the judge's answer had an unexpected shape",
  "session.outcomes.title": "Evidence",
  "session.outcomes.description":
    "Facts the platform saw itself. GitHub states are read again periodically.",
  "session.outcomes.kind.pullRequest": "PR",
  "session.outcomes.kind.review": "review",
  "session.outcomes.event.APPROVE": "Approved",
  "session.outcomes.event.REQUEST_CHANGES": "Changes requested",
  "session.outcomes.event.COMMENT": "Commented",
  "session.outcomes.submittedAt": "Submitted",
  "session.outcomes.otherSessionPullRequest": "PR opened by another session",
  "session.outcomes.state.open": "Open",
  "session.outcomes.state.merged": "Merged",
  "session.outcomes.state.closed": "Closed",
  "session.outcomes.mergedAt": "Merged",
  "session.outcomes.closedAt": "Closed",
  "session.outcomes.checkedAt": "Checked",
  "session.outcomes.notChecked": "Not checked yet",
  "session.outcomes.checkError.not_found":
    "At the last check GitHub could not find this pull request. The state shown is from the check before.",
  "session.outcomes.checkError.forge_failed":
    "At the last check the request to GitHub failed. The state shown is from the check before.",
  "session.outcomes.checkError.github_refused":
    "The last check was refused by the GitHub settings. The state shown is from the check before.",
  "session.outcomes.usage": "This session used {tokens} tokens · est. {cost}",
  "session.outcomes.usageUnmetered":
    "This session used {tokens} tokens · not billed per token",
  "session.refusals.title": "Recent GitHub refusals",
  "session.github.title": "GitHub work",
  "session.github.description":
    "The pushes and pull requests this session sent to GitHub. A push planned for when the work ends is listed here too.",
  "session.github.state.requested": "Awaiting approval",
  "session.github.state.approved": "Approved",
  "session.github.state.rejected": "Rejected",
  "session.github.state.pushing": "Pushing",
  "session.github.state.pushed": "Pushed",
  "session.github.state.failed": "Push failed",
  "session.github.showEarlier": "Show {count} earlier pushes to this branch",
  "session.github.hideEarlier": "Hide earlier pushes",
  "session.github.intent.deferred": "Waiting for the work to end",
  "session.github.intent.requested": "Request created",
  "session.github.intent.pinned": "Creating the request",
  "session.github.intent.failed": "Could not create the request",
  "session.github.intent.cancelled": "Cancelled",
  "session.github.prState.due": "PR pending",
  "session.github.prState.opening": "Opening PR",
  "session.github.prState.opened": "PR opened",
  "session.github.prState.closed_unrecorded": "PR closed",
  "session.github.prState.uncertain": "PR needs a check",
  "session.github.prState.failed": "PR failed",
  "session.github.prState.cancelled": "PR cancelled",
  "session.github.prError.head_moved":
    "The branch no longer points at the pushed commit, so the PR was not recorded.",
  "session.github.prError.closed_unrecorded":
    "This push's PR was closed or merged before it was recorded.",
  "session.github.prError.duplicate_pull_request":
    "More than one PR fits, so none was chosen. Check GitHub.",
  "session.github.prError.catalog_changed":
    "The repository settings changed since the request.",
  "session.github.prError.target_refused":
    "A PR cannot be opened from this branch.",
  "session.github.prError.github_refused":
    "The GitHub settings refused opening a PR.",
  "session.github.prError.no_forge": "GitHub could not be reached.",
  "session.github.prError.forge_failed": "The GitHub call failed.",
  "session.github.prError.lookup_failed":
    "Could not check whether a PR already exists.",
  "session.github.prError.lease_expired":
    "Opening the PR did not finish in time.",
  "session.github.prError.intent_invalid":
    "The stored PR request could not be read.",
  "session.github.prNumber": "PR #{number}",
  "session.github.reason.turn_ended_without_checkpoint":
    "The turn ended without a checkpoint.",
  "session.github.reason.turn_finalized_without_pin":
    "The turn ended but no checkpoint could be pinned to push.",
  "session.github.reason.superseded_by_turn":
    "Another turn ran while the answer was pending, so the push was cancelled.",
  "session.github.reason.session_closed": "The session was closed.",
  "session.github.reason.rejected_before": "This commit was already rejected.",
  "session.github.reason.request_open":
    "An earlier request for the same target is still open.",
  "session.github.reason.github_disabled": "The agent's GitHub setting is off.",
  "session.github.reason.over_workspace_ceiling":
    "The request exceeds the workspace ceiling.",
  "session.github.reason.repository_not_allowed":
    "The release does not allow this repository.",
  "session.github.reason.checkpoint_unavailable":
    "The pinned checkpoint cannot be read.",
  "session.github.reason.source_missing": "There is no source to push.",
  "session.github.reason.attribution_mismatch":
    "A commit's author does not match the session.",
  "session.github.reason.uncommitted_changes": "Uncommitted changes remain.",
  "session.github.reason.pinned_source_invalid":
    "The pinned checkpoint can no longer be verified.",
  "session.attribution.coAuthor": "Commit co-author: {login}",
  "session.attribution.unlinked":
    "The person who started it has not linked a GitHub account, so commits have no co-author.",
  "session.attribution.link": "Linked accounts",
  "session.attribution.appOnly":
    "No person started this session, so commits carry only the App's name.",
};
