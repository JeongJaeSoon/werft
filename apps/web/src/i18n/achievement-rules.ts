export const achievementRulesKo = {
  "achievementRules.nav": "성과 규칙",
  "achievementRules.title": "성과 규칙",
  "achievementRules.description":
    "세션이 한 일 가운데 무엇을 성과로 셀지 정합니다. 규칙은 구분 아래 한 줄이고, 제목·성과 type·성과 정의를 하나씩 가집니다.",
  "achievementRules.addRule": "규칙 추가",
  "achievementRules.save": "저장",
  "decisionModel.setup": "판정 모델 설정",
  "decisionModel.title": "판정 모델",
  "decisionModel.description":
    "성과 판정기 Luna가 부르는 OpenAI Decisions API 연결입니다. 켜진 연결이 하나도 없으면 성과 규칙을 바꿀 수 없고, 어떤 세션도 판정하지 않습니다.",
  "decisionModel.add": "판정 모델 연결 추가",
  "decisionModel.addConnection": "연결 추가",
  "decisionModel.model": "모델",
  "decisionModel.lock.title": "사용할 수 없음",
  "decisionModel.lock.body": "판정 모델을 설정해야 성과 규칙을 쓸 수 있습니다",
  "decisionModel.lockedReason":
    "판정 모델을 설정해야 성과 규칙을 바꿀 수 있습니다.",
  "achievementRules.judge.title": "판정 설정",
  "achievementRules.judge.description":
    "판정 시점과 예산은 Luna 판정 규칙에만 쓰입니다. 바로 인정 규칙은 비용 없이 돌지만, 판정 모델이 있어야 돕니다.",
  "achievementRules.judge.judge": "판정기",
  "achievementRules.judge.judgeHint":
    "Luna(OpenAI Decisions API, gpt-6-luna). 예·아니오와 확률만 답합니다.",
  "achievementRules.judge.connection": "Luna 연결",
  "achievementRules.judge.noConnection":
    "연결 없음 · Luna 규칙은 판정하지 않습니다",
  "achievementRules.judge.unavailable": "{id} · 쓸 수 없음",
  "achievementRules.judge.sent":
    "PR 제목·저장소 이름과, 규칙에 따라 out/ 파일 앞부분·최근 대화가 OpenAI로 갑니다.",
  "achievementRules.judge.when": "판정 시점",
  "achievementRules.judge.whenHint": "근거가 없는 세션은 판정하지 않습니다.",
  "achievementRules.judge.onEvidence":
    "근거가 생기거나 바뀔 때 (PR 열림·머지, 리뷰 제출, out/ 파일)",
  "achievementRules.judge.turns": "턴 수",
  "achievementRules.judge.everyTurns": "턴마다",
  "achievementRules.judge.onIdle": "세션이 멈출 때 (대기·일시정지·종료)",
  "achievementRules.judge.transcript": "대화 보내기",
  "achievementRules.judge.transcriptHint":
    "근거 종류가 '대화'인 규칙을 판정할 때만 보냅니다.",
  "achievementRules.judge.transcriptNone": "보내지 않음",
  "achievementRules.judge.transcriptRecent":
    "최근 20턴 (최대 16,000토큰, 도구 결과 제외)",
  "achievementRules.judge.limits": "판정 한도",
  "achievementRules.judge.limitsHint": "판정 비용은 세션 비용과 따로 셉니다.",
  "achievementRules.judge.dailyBudget": "하루 예산",
  "achievementRules.judge.maxPerSession": "세션당 최대",
  "achievementRules.judge.perSessionUnit": "회",
  "achievementRules.judge.cost":
    "오늘 판정 비용 {today} / {budget} · 이번 달 {month} · 판정 1회 예상 약 $0.00025 (근거 요약만)",
  "achievementRules.judge.saved": "판정 설정을 저장했습니다.",
  "achievementRules.category.title": "구분",
  "achievementRules.category.description":
    "규칙을 묶는 대분류입니다. 이름을 바꾸면 지난 성과도 새 이름 아래 보입니다. 규칙이 남은 구분은 보관할 수 없습니다.",
  "achievementRules.category.rules": "규칙 {count}",
  "achievementRules.category.rename": "이름 바꾸기",
  "achievementRules.category.renameOf": "{name} 이름 바꾸기",
  "achievementRules.category.add": "구분 추가",
  "achievementRules.category.name": "이름",
  "achievementRules.category.archive": "보관",
  "achievementRules.category.inUse": "규칙이 남은 구분은 보관할 수 없습니다.",
  "achievementRules.nameTaken": "같은 이름이 이미 있습니다.",
  "achievementRules.typeLimit":
    "보관하지 않은 성과 type은 {max}개까지입니다. type 하나를 보관한 뒤 다시 하세요.",
  "achievementRules.ruleLimit":
    "사용 중인 규칙은 {max}개까지입니다. 규칙 하나의 사용을 멈춘 뒤 다시 하세요.",
  "achievementRules.type.title": "성과 type",
  "achievementRules.type.description":
    "type 하나는 규칙 하나에만 쓰입니다. 사람이 만든 type은 제목·링크·근거만 남기고, PR 상태 같은 정보는 근거에서 읽어 보입니다. key와 근거 종류는 만든 뒤 바꿀 수 없습니다.",
  "achievementRules.type.name": "이름",
  "achievementRules.type.key": "key",
  "achievementRules.type.evidence": "근거 종류",
  "achievementRules.type.fields": "저장되는 칸",
  "achievementRules.type.fieldsShort": "칸",
  "achievementRules.type.rules": "쓰는 규칙",
  "achievementRules.type.rulesShort": "규칙",
  "achievementRules.type.builtin": "내장",
  "achievementRules.type.rename": "이름 바꾸기",
  "achievementRules.type.renameOf": "{name} 이름 바꾸기",
  "achievementRules.type.add": "type 추가",
  "achievementRules.type.kinds": "근거 종류: PR · 리뷰 · out/ 파일 · 대화",
  "achievementRules.type.keyTaken": "같은 key가 이미 있습니다.",
  "achievementRules.evidence.github_pull_request": "PR",
  "achievementRules.evidence.github_review": "리뷰",
  "achievementRules.evidence.out_file": "out/ 파일",
  "achievementRules.evidence.conversation": "대화",
  "achievementRules.fields.pull_request":
    "공통 + 저장소·번호·상태·머지 시각·변경 줄 수",
  "achievementRules.fields.code_review": "공통 + 저장소·번호·event·commit",
  "achievementRules.fields.document": "공통 + 경로·크기",
  "achievementRules.fields.custom": "공통 (제목·링크·근거)",
  "achievementRules.rules.title": "규칙",
  "achievementRules.rules.description":
    "고치면 새 버전이 생깁니다. 이미 센 성과는 그때의 버전으로 남습니다.",
  "achievementRules.rules.ruleTitle": "제목",
  "achievementRules.rules.type": "성과 type",
  "achievementRules.rules.typeShort": "type",
  "achievementRules.rules.judge": "판정",
  "achievementRules.rules.version": "버전",
  "achievementRules.rules.recent": "지난 30일",
  "achievementRules.rules.use": "사용",
  "achievementRules.rules.useOf": "{title} 사용",
  "achievementRules.rules.luna": "Luna 판정",
  "achievementRules.rules.always": "바로 인정",
  "achievementRules.rules.review": "사람 확인",
  "achievementRules.rules.typeInUse": "이 type을 쓰는 다른 규칙이 있습니다.",
  "achievementRules.edit.title": "규칙 편집 — {title}",
  "achievementRules.edit.meta": "v{version} · {date}",
  "achievementRules.edit.metaBy": "v{version} · {date} {name} 만듦",
  "achievementRules.edit.category": "구분",
  "achievementRules.edit.ruleTitle": "제목",
  "achievementRules.edit.type": "성과 type",
  "achievementRules.edit.typeOption": "{key} — {name} (근거: {evidence})",
  "achievementRules.edit.newType": "새 type 만들기…",
  "achievementRules.edit.typeHint":
    "다른 규칙이 쓰지 않는 type만 고를 수 있습니다. 저장되는 칸: {fields}.",
  "achievementRules.edit.customFields": "제목, 링크, 근거({evidence})",
  "achievementRules.edit.prStateHint": "PR 상태는 근거에서 읽어 보입니다.",
  "achievementRules.edit.definition": "성과 정의",
  "achievementRules.edit.length": "{count} / {max}자",
  "achievementRules.edit.prDefinitionHint":
    'Luna는 PR 제목·저장소·상태·변경 규모만 봅니다. PR 본문과 대화는 보내지 않습니다. "머지된 PR만"처럼 상태 조건도 여기에 씁니다.',
  "achievementRules.edit.judge": "판정 방식",
  "achievementRules.edit.always":
    "바로 인정 — 근거가 생기면 조건 없이 셉니다. 비용 없음",
  "achievementRules.edit.luna":
    "Luna 판정 — 위 정의를 읽고 근거마다 예·아니오를 정합니다. 근거가 바뀌면 다시 판정합니다",
  "achievementRules.edit.agents": "적용 에이전트",
  "achievementRules.edit.allAgents": "모든 에이전트",
  "achievementRules.edit.agentsLater": "에이전트별 규칙은 나중에 열립니다.",
  "achievementRules.edit.nextVersion": "저장하면 {version}가 생깁니다.",
  "achievementRules.edit.saveVersion": "새 버전 저장",
  "achievementRules.edit.saved": "{title} v{version}을 저장했습니다.",
};

export const achievementRulesEn: Record<
  keyof typeof achievementRulesKo,
  string
> = {
  "achievementRules.nav": "Achievement rules",
  "achievementRules.title": "Achievement rules",
  "achievementRules.description":
    "Decide which of the things sessions do count as achievements. A rule is one line under a category, with one title, one achievement type and one definition.",
  "achievementRules.addRule": "Add rule",
  "achievementRules.save": "Save",
  "decisionModel.setup": "Set up decision model",
  "decisionModel.title": "Decision model",
  "decisionModel.description":
    "The OpenAI Decisions API connection the achievement judge Luna calls. While no connection is enabled, achievement rules can't change and no session is judged.",
  "decisionModel.add": "Add decision model connection",
  "decisionModel.addConnection": "Add connection",
  "decisionModel.model": "Model",
  "decisionModel.lock.title": "Unavailable",
  "decisionModel.lock.body": "Set up a decision model to use achievement rules",
  "decisionModel.lockedReason":
    "Set up a decision model to change achievement rules.",
  "achievementRules.judge.title": "Judging",
  "achievementRules.judge.description":
    "When to judge and the budget apply only to Luna-judged rules. Rules that count at once run at no cost, but only with a decision model.",
  "achievementRules.judge.judge": "Judge",
  "achievementRules.judge.judgeHint":
    "Luna (OpenAI Decisions API, gpt-6-luna). It answers only yes or no, with a probability.",
  "achievementRules.judge.connection": "Luna connection",
  "achievementRules.judge.noConnection":
    "No connection · Luna rules are not judged",
  "achievementRules.judge.unavailable": "{id} · unavailable",
  "achievementRules.judge.sent":
    "Pull request titles and repository names go to OpenAI, and, depending on the rules, the start of out/ files and the recent conversation.",
  "achievementRules.judge.when": "When to judge",
  "achievementRules.judge.whenHint":
    "Sessions without evidence are not judged.",
  "achievementRules.judge.onEvidence":
    "When evidence appears or changes (pull request opened or merged, review submitted, out/ files)",
  "achievementRules.judge.turns": "Turns",
  "achievementRules.judge.everyTurns": "turns each",
  "achievementRules.judge.onIdle":
    "When the session stops (waiting, paused, closed)",
  "achievementRules.judge.transcript": "Send the conversation",
  "achievementRules.judge.transcriptHint":
    "Sent only when judging a rule whose evidence is the conversation.",
  "achievementRules.judge.transcriptNone": "Don't send",
  "achievementRules.judge.transcriptRecent":
    "Last 20 turns (up to 16,000 tokens, tool results left out)",
  "achievementRules.judge.limits": "Judging limits",
  "achievementRules.judge.limitsHint":
    "Judging cost is counted apart from session cost.",
  "achievementRules.judge.dailyBudget": "Daily budget",
  "achievementRules.judge.maxPerSession": "Per session, at most",
  "achievementRules.judge.perSessionUnit": "times",
  "achievementRules.judge.cost":
    "Judging cost today {today} / {budget} · this month {month} · about $0.00025 per judgment (evidence summary only)",
  "achievementRules.judge.saved": "Judging settings saved.",
  "achievementRules.category.title": "Categories",
  "achievementRules.category.description":
    "The groups rules sit under. Renaming one shows past achievements under the new name too. A category with rules left can't be archived.",
  "achievementRules.category.rules": "{count} rules",
  "achievementRules.category.rename": "Rename",
  "achievementRules.category.renameOf": "Rename {name}",
  "achievementRules.category.add": "Add category",
  "achievementRules.category.name": "Name",
  "achievementRules.category.archive": "Archive",
  "achievementRules.category.inUse":
    "A category with rules left can't be archived.",
  "achievementRules.nameTaken": "That name is already taken.",
  "achievementRules.typeLimit":
    "A workspace keeps at most {max} achievement types that are not archived. Archive one, then try again.",
  "achievementRules.ruleLimit":
    "A workspace has at most {max} rules in use. Stop using one, then try again.",
  "achievementRules.type.title": "Achievement types",
  "achievementRules.type.description":
    "Each type is used by one rule only. A type people made keeps only a title, a link and its evidence; details such as a pull request's state are read from the evidence. A type's key and evidence kind can't change once it is made.",
  "achievementRules.type.name": "Name",
  "achievementRules.type.key": "key",
  "achievementRules.type.evidence": "Evidence kind",
  "achievementRules.type.fields": "Fields kept",
  "achievementRules.type.fieldsShort": "Fields",
  "achievementRules.type.rules": "Used by",
  "achievementRules.type.rulesShort": "Rules",
  "achievementRules.type.builtin": "Built-in",
  "achievementRules.type.rename": "Rename",
  "achievementRules.type.renameOf": "Rename {name}",
  "achievementRules.type.add": "Add type",
  "achievementRules.type.kinds":
    "Evidence kinds: pull request · review · out/ file · conversation",
  "achievementRules.type.keyTaken": "That key is already taken.",
  "achievementRules.evidence.github_pull_request": "Pull request",
  "achievementRules.evidence.github_review": "Review",
  "achievementRules.evidence.out_file": "out/ file",
  "achievementRules.evidence.conversation": "Conversation",
  "achievementRules.fields.pull_request":
    "Common + repository, number, state, merge time, lines changed",
  "achievementRules.fields.code_review":
    "Common + repository, number, event, commit",
  "achievementRules.fields.document": "Common + path, size",
  "achievementRules.fields.custom": "Common (title, link, evidence)",
  "achievementRules.rules.title": "Rules",
  "achievementRules.rules.description":
    "Editing makes a new version. Achievements already counted stay with the version of the time.",
  "achievementRules.rules.ruleTitle": "Title",
  "achievementRules.rules.type": "Achievement type",
  "achievementRules.rules.typeShort": "type",
  "achievementRules.rules.judge": "Judged by",
  "achievementRules.rules.version": "Version",
  "achievementRules.rules.recent": "Last 30 days",
  "achievementRules.rules.use": "In use",
  "achievementRules.rules.useOf": "Use {title}",
  "achievementRules.rules.luna": "Luna",
  "achievementRules.rules.always": "Counted at once",
  "achievementRules.rules.review": "Needs review",
  "achievementRules.rules.typeInUse": "Another rule uses this type.",
  "achievementRules.edit.title": "Edit rule — {title}",
  "achievementRules.edit.meta": "v{version} · {date}",
  "achievementRules.edit.metaBy": "v{version} · made {date} by {name}",
  "achievementRules.edit.category": "Category",
  "achievementRules.edit.ruleTitle": "Title",
  "achievementRules.edit.type": "Achievement type",
  "achievementRules.edit.typeOption": "{key} — {name} (evidence: {evidence})",
  "achievementRules.edit.newType": "Make a new type…",
  "achievementRules.edit.typeHint":
    "Only types no other rule uses can be picked. Fields kept: {fields}.",
  "achievementRules.edit.customFields": "title, link, evidence ({evidence})",
  "achievementRules.edit.prStateHint":
    "The pull request's state is read from the evidence.",
  "achievementRules.edit.definition": "Definition",
  "achievementRules.edit.length": "{count} / {max} characters",
  "achievementRules.edit.prDefinitionHint":
    'Luna sees only the pull request\'s title, repository, state and size of change. Its body and the conversation are not sent. Write state conditions such as "merged pull requests only" here too.',
  "achievementRules.edit.judge": "How it is judged",
  "achievementRules.edit.always":
    "Count at once — counts evidence as it appears, with no condition. No cost",
  "achievementRules.edit.luna":
    "Luna — reads the definition above and decides yes or no for each piece of evidence. Judges again when the evidence changes",
  "achievementRules.edit.agents": "Agents",
  "achievementRules.edit.allAgents": "All agents",
  "achievementRules.edit.agentsLater": "Rules per agent come later.",
  "achievementRules.edit.nextVersion": "Saving makes {version}.",
  "achievementRules.edit.saveVersion": "Save new version",
  "achievementRules.edit.saved": "Saved {title} v{version}.",
};

export const achievementRulesJa: Record<
  keyof typeof achievementRulesKo,
  string
> = {
  "achievementRules.nav": "成果ルール",
  "achievementRules.title": "成果ルール",
  "achievementRules.description":
    "セッションがしたことのうち、何を成果として数えるかを決めます。ルールは区分の下の 1 行で、タイトル・成果 type・成果の定義を 1 つずつ持ちます。",
  "achievementRules.addRule": "ルールを追加",
  "achievementRules.save": "保存",
  "decisionModel.setup": "判定モデルを設定",
  "decisionModel.title": "判定モデル",
  "decisionModel.description":
    "成果判定器 Luna が呼び出す OpenAI Decisions API の接続です。有効な接続が 1 つもない間は、成果ルールを変更できず、どのセッションも判定しません。",
  "decisionModel.add": "判定モデルの接続を追加",
  "decisionModel.addConnection": "接続を追加",
  "decisionModel.model": "モデル",
  "decisionModel.lock.title": "利用できません",
  "decisionModel.lock.body": "判定モデルを設定すると成果ルールを使えます",
  "decisionModel.lockedReason":
    "判定モデルを設定すると成果ルールを変更できます。",
  "achievementRules.judge.title": "判定設定",
  "achievementRules.judge.description":
    "判定のタイミングと予算は Luna 判定のルールにだけ使います。そのまま認定のルールは費用なしで動きますが、判定モデルが必要です。",
  "achievementRules.judge.judge": "判定器",
  "achievementRules.judge.judgeHint":
    "Luna（OpenAI Decisions API、gpt-6-luna）。はい・いいえと確率だけを答えます。",
  "achievementRules.judge.connection": "Luna 接続",
  "achievementRules.judge.noConnection": "接続なし · Luna ルールは判定しません",
  "achievementRules.judge.unavailable": "{id} · 使用不可",
  "achievementRules.judge.sent":
    "PR のタイトル・リポジトリ名と、ルールに応じて out/ ファイルの冒頭・最近の会話が OpenAI に送られます。",
  "achievementRules.judge.when": "判定のタイミング",
  "achievementRules.judge.whenHint": "根拠のないセッションは判定しません。",
  "achievementRules.judge.onEvidence":
    "根拠ができたとき・変わったとき（PR のオープン・マージ、レビューの提出、out/ ファイル）",
  "achievementRules.judge.turns": "ターン数",
  "achievementRules.judge.everyTurns": "ターンごと",
  "achievementRules.judge.onIdle":
    "セッションが止まったとき（待機・一時停止・終了）",
  "achievementRules.judge.transcript": "会話を送る",
  "achievementRules.judge.transcriptHint":
    "根拠の種類が「会話」のルールを判定するときだけ送ります。",
  "achievementRules.judge.transcriptNone": "送らない",
  "achievementRules.judge.transcriptRecent":
    "最近の 20 ターン（最大 16,000 トークン、ツール結果を除く）",
  "achievementRules.judge.limits": "判定の上限",
  "achievementRules.judge.limitsHint":
    "判定費用はセッション費用とは別に数えます。",
  "achievementRules.judge.dailyBudget": "1 日の予算",
  "achievementRules.judge.maxPerSession": "セッションごとに最大",
  "achievementRules.judge.perSessionUnit": "回",
  "achievementRules.judge.cost":
    "今日の判定費用 {today} / {budget} · 今月 {month} · 判定 1 回あたり約 $0.00025（根拠の要約のみ）",
  "achievementRules.judge.saved": "判定設定を保存しました。",
  "achievementRules.category.title": "区分",
  "achievementRules.category.description":
    "ルールをまとめる大分類です。名前を変えると過去の成果も新しい名前で表示されます。ルールが残っている区分はアーカイブできません。",
  "achievementRules.category.rules": "ルール {count}",
  "achievementRules.category.rename": "名前を変更",
  "achievementRules.category.renameOf": "{name} の名前を変更",
  "achievementRules.category.add": "区分を追加",
  "achievementRules.category.name": "名前",
  "achievementRules.category.archive": "アーカイブ",
  "achievementRules.category.inUse":
    "ルールが残っている区分はアーカイブできません。",
  "achievementRules.nameTaken": "同じ名前がすでにあります。",
  "achievementRules.typeLimit":
    "アーカイブしていない成果 type は {max} 個までです。type を 1 つアーカイブしてから、もう一度お試しください。",
  "achievementRules.ruleLimit":
    "使用中のルールは {max} 個までです。ルールを 1 つ使用停止してから、もう一度お試しください。",
  "achievementRules.type.title": "成果 type",
  "achievementRules.type.description":
    "type 1 つは 1 つのルールにだけ使います。人が作った type はタイトル・リンク・根拠だけを残し、PR の状態などは根拠から読んで表示します。key と根拠の種類は作成後に変更できません。",
  "achievementRules.type.name": "名前",
  "achievementRules.type.key": "key",
  "achievementRules.type.evidence": "根拠の種類",
  "achievementRules.type.fields": "保存される項目",
  "achievementRules.type.fieldsShort": "項目",
  "achievementRules.type.rules": "使っているルール",
  "achievementRules.type.rulesShort": "ルール",
  "achievementRules.type.builtin": "組み込み",
  "achievementRules.type.rename": "名前を変更",
  "achievementRules.type.renameOf": "{name} の名前を変更",
  "achievementRules.type.add": "type を追加",
  "achievementRules.type.kinds":
    "根拠の種類: PR · レビュー · out/ ファイル · 会話",
  "achievementRules.type.keyTaken": "同じ key がすでにあります。",
  "achievementRules.evidence.github_pull_request": "PR",
  "achievementRules.evidence.github_review": "レビュー",
  "achievementRules.evidence.out_file": "out/ ファイル",
  "achievementRules.evidence.conversation": "会話",
  "achievementRules.fields.pull_request":
    "共通 + リポジトリ・番号・状態・マージ時刻・変更行数",
  "achievementRules.fields.code_review":
    "共通 + リポジトリ・番号・event・commit",
  "achievementRules.fields.document": "共通 + パス・サイズ",
  "achievementRules.fields.custom": "共通（タイトル・リンク・根拠）",
  "achievementRules.rules.title": "ルール",
  "achievementRules.rules.description":
    "変更すると新しいバージョンができます。すでに数えた成果はその時のバージョンのまま残ります。",
  "achievementRules.rules.ruleTitle": "タイトル",
  "achievementRules.rules.type": "成果 type",
  "achievementRules.rules.typeShort": "type",
  "achievementRules.rules.judge": "判定",
  "achievementRules.rules.version": "バージョン",
  "achievementRules.rules.recent": "過去 30 日",
  "achievementRules.rules.use": "使用",
  "achievementRules.rules.useOf": "{title} を使用",
  "achievementRules.rules.luna": "Luna 判定",
  "achievementRules.rules.always": "そのまま認定",
  "achievementRules.rules.review": "人の確認",
  "achievementRules.rules.typeInUse": "この type を使う別のルールがあります。",
  "achievementRules.edit.title": "ルールを編集 — {title}",
  "achievementRules.edit.meta": "v{version} · {date}",
  "achievementRules.edit.metaBy": "v{version} · {date} {name} が作成",
  "achievementRules.edit.category": "区分",
  "achievementRules.edit.ruleTitle": "タイトル",
  "achievementRules.edit.type": "成果 type",
  "achievementRules.edit.typeOption": "{key} — {name}（根拠: {evidence}）",
  "achievementRules.edit.newType": "新しい type を作る…",
  "achievementRules.edit.typeHint":
    "他のルールが使っていない type だけを選べます。保存される項目: {fields}。",
  "achievementRules.edit.customFields": "タイトル、リンク、根拠（{evidence}）",
  "achievementRules.edit.prStateHint": "PR の状態は根拠から読んで表示します。",
  "achievementRules.edit.definition": "成果の定義",
  "achievementRules.edit.length": "{count} / {max} 文字",
  "achievementRules.edit.prDefinitionHint":
    "Luna が見るのは PR のタイトル・リポジトリ・状態・変更規模だけです。PR の本文と会話は送りません。「マージされた PR のみ」のような状態の条件もここに書きます。",
  "achievementRules.edit.judge": "判定方式",
  "achievementRules.edit.always":
    "そのまま認定 — 根拠ができたら条件なしで数えます。費用なし",
  "achievementRules.edit.luna":
    "Luna 判定 — 上の定義を読んで根拠ごとにはい・いいえを決めます。根拠が変わると判定し直します",
  "achievementRules.edit.agents": "対象エージェント",
  "achievementRules.edit.allAgents": "すべてのエージェント",
  "achievementRules.edit.agentsLater":
    "エージェント別のルールは今後対応します。",
  "achievementRules.edit.nextVersion": "保存すると {version} ができます。",
  "achievementRules.edit.saveVersion": "新しいバージョンを保存",
  "achievementRules.edit.saved": "{title} v{version} を保存しました。",
};
