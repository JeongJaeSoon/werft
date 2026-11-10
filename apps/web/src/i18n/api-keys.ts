export const apiKeysKo = {
  "apiKeys.title": "API 키",
  "apiKeys.guideTitle": "키 종류",
  "apiKeys.guide.personal.actsAs":
    "발급한 사람으로 동작합니다. 이 키로 시작한 세션은 그 사람의 세션입니다.",
  "apiKeys.guide.personal.issuerLeaves":
    "발급한 사람이 워크스페이스를 떠나거나 계정이 정지되면 바로 멈춥니다. 권한도 그 사람의 지금 역할을 넘지 않습니다.",
  "apiKeys.guide.personal.sessions":
    "발급한 사람이 볼 수 있는 세션에 닿습니다.",
  "apiKeys.guide.personal.approve":
    "'요청에 답하기'(sessions:approve) 권한을 넣을 수 있습니다.",
  "apiKeys.guide.agent.actsAs":
    "사람이 아니라 키 자체로 동작합니다. 이 키로 시작한 세션은 키의 세션입니다.",
  "apiKeys.guide.agent.issuerLeaves":
    "발급한 사람이 떠나도 계속 유효합니다. 필요 없어지면 직접 폐기하세요.",
  "apiKeys.guide.agent.sessions":
    "고른 에이전트의 세션에만 닿습니다. 세션을 시작할 때도 그 에이전트의 릴리스를 지정해야 합니다.",
  "apiKeys.guide.agent.startSession":
    "세션을 만들려면 '세션 만들기'와 '세션 보기' 권한을 넣으세요. 이 키로 GET /v1/agents를 부르면 그 에이전트의 active_release_id가 나오고, 그 값을 POST /v1/sessions의 agent_release_id로 보냅니다.",
  "apiKeys.guide.agent.approve":
    "'요청에 답하기'(sessions:approve) 권한을 넣으면 그 에이전트의 세션에서 승인과 질문 답변을 합니다. 이 키로 시작한 세션의 요청은 이 키로 승인하지 못합니다.",
  "apiKeys.docs":
    "API 문서에서 키를 Bearer 칸에 넣고 Test Request로 실제 요청을 보내 볼 수 있습니다.",
  "apiKeys.docsLink": "API 문서 열기",
  "apiKeys.docsNewTab": "(새 탭에서 열림)",
  "apiKeys.nav": "키 목록",
  "apiKeys.navCount": "{count}개",
  "apiKeys.personalTitle": "개인 키",
  "apiKeys.personalIntro":
    "나로 동작하는 키입니다. CLI나 스크립트가 내 권한 안에서 API를 부를 때 씁니다.",
  "apiKeys.agentTitle": "에이전트 키",
  "apiKeys.agentIntro":
    "사람이 아니라 에이전트 하나에 속한 키입니다. 그 에이전트의 세션에만 닿고, 발급한 사람이 떠나도 계속 동작합니다.",
  "apiKeys.orgTitle": "조직 관리 키",
  "apiKeys.orgIntro":
    "사람에 묶이지 않는 조직 소유 키입니다. Terraform·CI·SCIM 같은 자동화가 워크스페이스 관리 API를 부를 때 씁니다.",
  "apiKeys.orgPending": "준비 중입니다",
  "apiKeys.orgPendingBody":
    "아직 발급할 수 없습니다. 세션을 다루는 자동화에는 에이전트 키를 쓰세요. 발급할 수 있게 되면 만료일은 반드시 정해야 합니다.",
  "apiKeys.new": "새 키",
  "apiKeys.newPersonalTitle": "새 개인 키",
  "apiKeys.newAgentTitle": "새 에이전트 키",
  "apiKeys.generate": "키 만들기",
  "apiKeys.emptyPersonal": "아직 만든 개인 키가 없습니다.",
  "apiKeys.emptyAgent": "아직 에이전트 키가 없습니다.",
  "apiKeys.survivesIssuerShort": "발급자가 떠나도 유효",
  "apiKeys.agent": "에이전트",
  "apiKeys.pickAgent": "에이전트를 고르세요",
  "apiKeys.agentSearch": "이름이나 식별자로 에이전트 찾기",
  "apiKeys.agentLoading": "에이전트를 불러오는 중…",
  "apiKeys.agentEmpty": "맞는 에이전트가 없습니다.",
  "apiKeys.agentCount": "{count}개가 있습니다.",
  "apiKeys.agentHint":
    "키를 쓸 에이전트입니다. 발급한 뒤에는 바꿀 수 없습니다.",
  "apiKeys.noAgents": "관리하는 에이전트가 없습니다.",
  "apiKeys.agentNeedsScope": "권한을 하나 이상 고르세요.",
  "apiKeys.selfApproval":
    "'요청에 답하기'를 넣어도 이 키로 시작한 세션의 요청은 이 키로 승인하지 못합니다. 다른 키나 사람이 승인합니다.",
  "apiKeys.name": "이름(필수 아님)",
  "apiKeys.nameHint": "목록에서 이 키를 알아보는 이름입니다. 예: ci-deploy",
  "apiKeys.scopes": "권한",
  "apiKeys.scope.read": "세션 보기",
  "apiKeys.scope.write": "세션 만들기",
  "apiKeys.scope.approve": "요청에 답하기",
  "apiKeys.scope.control": "세션 제어",
  "apiKeys.scope.recover": "세션 복구",
  "apiKeys.scopeHint.read":
    "세션과 그 턴·이벤트·영수증·사용량·공유 설정, 답을 기다리는 요청을 읽습니다.",
  "apiKeys.scopeHint.write": "새 세션을 시작하고 세션에 메시지를 보냅니다.",
  "apiKeys.scopeHint.approve": "세션이 기다리는 권한 요청과 질문에 답합니다.",
  "apiKeys.scopeHint.control": "세션을 멈추고, 다시 잇고, 중단하고, 끝냅니다.",
  "apiKeys.scopeHint.recover":
    "복구가 필요한 세션을 어떻게 이을지 정합니다: 턴 버리기·완료 확정·닫기·새로 시작·복원 재시도.",
  "apiKeys.expires": "만료일(필수 아님)",
  "apiKeys.expiresHint": "비워 두면 폐기할 때까지 유효합니다.",
  "apiKeys.agentExpiresHint":
    "기본은 90일 뒤입니다. 비워 두면 폐기할 때까지 유효합니다.",
  "apiKeys.secretTitle": "새 키",
  "apiKeys.createdTitle": "키를 만들었습니다",
  "apiKeys.secretOnce":
    "지금 복사해 두세요. 이 화면을 떠나면 값을 다시 볼 수 없습니다.",
  "apiKeys.secret": "키 값",
  "apiKeys.copy": "복사",
  "apiKeys.copied": "복사했습니다",
  "apiKeys.copyFailed":
    "복사하지 못했습니다. 위 칸의 값을 직접 선택해 복사하세요.",
  "apiKeys.toList": "목록으로",
  "apiKeys.listTitle": "발급된 키",
  "apiKeys.unnamed": "이름 없음",
  "apiKeys.kind.personal": "개인 키",
  "apiKeys.kind.agent": "에이전트 키",
  "apiKeys.createdAt": "발급 {at}",
  "apiKeys.expiresAt": "만료 {at}",
  "apiKeys.expiresSoon": "곧 만료 · {at}",
  "apiKeys.expiredAt": "만료됨 · {at}",
  "apiKeys.noExpiry": "만료 없음",
  "apiKeys.approveYes": "승인 가능",
  "apiKeys.approveNo": "승인 불가",
  "apiKeys.revokedAt": "폐기됨 {at}",
  "apiKeys.revoke": "폐기",
  "apiKeys.revokeFor": "{key} 폐기",
  "apiKeys.revokeTitle": "ID {id} 키를 폐기할까요?",
  "apiKeys.keyId": "ID {id}",
  "apiKeys.idLabel": "ID",
  "apiKeys.copyIdFailed": "복사하지 못했습니다. ID를 직접 선택해 복사하세요.",
  "apiKeys.revokeConsequence":
    "이 키를 쓰는 곳은 바로 동작을 멈춥니다. 되돌릴 수 없습니다.",
  "apiKeys.revoked": "키를 폐기했습니다.",
};

export const apiKeysEn: Record<keyof typeof apiKeysKo, string> = {
  "apiKeys.title": "API keys",
  "apiKeys.guideTitle": "Key types",
  "apiKeys.guide.personal.actsAs":
    "Acts as the person who issued it. Sessions it starts are that person's.",
  "apiKeys.guide.personal.issuerLeaves":
    "Stops at once when that person leaves the workspace or their account is suspended, and never does more than their current role allows.",
  "apiKeys.guide.personal.sessions":
    "Reaches the sessions that person can see.",
  "apiKeys.guide.personal.approve":
    "Can include Answer requests (sessions:approve).",
  "apiKeys.guide.agent.actsAs":
    "Acts as the key itself, not as a person. Sessions it starts belong to the key.",
  "apiKeys.guide.agent.issuerLeaves":
    "Stays valid after its issuer leaves; revoke it yourself when it is no longer needed.",
  "apiKeys.guide.agent.sessions":
    "Reaches only the chosen agent's sessions, and starts sessions only on that agent's releases.",
  "apiKeys.guide.agent.startSession":
    "To start sessions, include Create sessions and View sessions. GET /v1/agents with this key returns the agent's active_release_id; send it as agent_release_id to POST /v1/sessions.",
  "apiKeys.guide.agent.approve":
    "With Answer requests (sessions:approve), approves and answers in the agent's sessions. It never approves requests of a session it started itself.",
  "apiKeys.docs":
    "In the API reference, put a key in the Bearer field and send a real request with Test Request.",
  "apiKeys.docsLink": "Open the API reference",
  "apiKeys.docsNewTab": "(opens in a new tab)",
  "apiKeys.nav": "Key lists",
  "apiKeys.navCount": "{count} keys",
  "apiKeys.personalTitle": "Personal keys",
  "apiKeys.personalIntro":
    "Keys that act as you. Use them when the CLI or a script calls the API with your permissions.",
  "apiKeys.agentTitle": "Agent keys",
  "apiKeys.agentIntro":
    "Keys that belong to one agent, not a person. They reach that agent's sessions only and keep working after their issuer leaves.",
  "apiKeys.orgTitle": "Organization admin keys",
  "apiKeys.orgIntro":
    "Keys the organization owns, tied to no person, for automation such as Terraform, CI or SCIM that calls the workspace admin API.",
  "apiKeys.orgPending": "Coming soon",
  "apiKeys.orgPendingBody":
    "You can't issue one yet. For automation that works with sessions, use an agent key. Once they're available, every one will need an expiry date.",
  "apiKeys.new": "New key",
  "apiKeys.newPersonalTitle": "New personal key",
  "apiKeys.newAgentTitle": "New agent key",
  "apiKeys.generate": "Generate key",
  "apiKeys.emptyPersonal": "You have no personal keys yet.",
  "apiKeys.emptyAgent": "No agent keys yet.",
  "apiKeys.survivesIssuerShort": "Stays valid after the issuer leaves",
  "apiKeys.agent": "Agent",
  "apiKeys.pickAgent": "Choose an agent",
  "apiKeys.agentSearch": "Search agents by name or slug",
  "apiKeys.agentLoading": "Loading agents…",
  "apiKeys.agentEmpty": "No agent matches.",
  "apiKeys.agentCount": "{count} found.",
  "apiKeys.agentHint":
    "The agent the key works for. It cannot be changed after the key is issued.",
  "apiKeys.noAgents": "You do not administer any agent.",
  "apiKeys.agentNeedsScope": "Choose at least one permission.",
  "apiKeys.selfApproval":
    "Even with Answer requests, this key cannot approve requests of a session it started. Another key or a person approves them.",
  "apiKeys.name": "Name (not required)",
  "apiKeys.nameHint":
    "Shown in the list so you can tell this key apart, for example ci-deploy.",
  "apiKeys.scopes": "Permissions",
  "apiKeys.scope.read": "View sessions",
  "apiKeys.scope.write": "Create sessions",
  "apiKeys.scope.approve": "Answer requests",
  "apiKeys.scope.control": "Control sessions",
  "apiKeys.scope.recover": "Recover sessions",
  "apiKeys.scopeHint.read":
    "Read sessions with their turns, events, receipts, usage and sharing, and the requests waiting for an answer.",
  "apiKeys.scopeHint.write": "Start sessions and send messages to them.",
  "apiKeys.scopeHint.approve":
    "Answer the permission requests and questions a session is waiting on.",
  "apiKeys.scopeHint.control": "Pause, resume, interrupt or end sessions.",
  "apiKeys.scopeHint.recover":
    "Decide how a session that needs recovery goes on: abandon a turn, confirm it completed, close, start fresh or retry the restore.",
  "apiKeys.expires": "Expires on (not required)",
  "apiKeys.expiresHint": "Leave empty to keep the key until you revoke it.",
  "apiKeys.agentExpiresHint":
    "Defaults to 90 days from today. Leave empty to keep the key until you revoke it.",
  "apiKeys.secretTitle": "New key",
  "apiKeys.createdTitle": "Key created",
  "apiKeys.secretOnce":
    "Copy it now. Once you leave this page you won't be able to see it again.",
  "apiKeys.secret": "Key value",
  "apiKeys.copy": "Copy",
  "apiKeys.copied": "Copied",
  "apiKeys.copyFailed":
    "Couldn't copy. Select the value above and copy it yourself.",
  "apiKeys.toList": "Back to keys",
  "apiKeys.listTitle": "Issued keys",
  "apiKeys.unnamed": "Unnamed",
  "apiKeys.kind.personal": "Personal key",
  "apiKeys.kind.agent": "Agent key",
  "apiKeys.createdAt": "Issued {at}",
  "apiKeys.expiresAt": "Expires {at}",
  "apiKeys.expiresSoon": "Expires soon · {at}",
  "apiKeys.expiredAt": "Expired · {at}",
  "apiKeys.noExpiry": "No expiry",
  "apiKeys.approveYes": "Can approve",
  "apiKeys.approveNo": "Cannot approve",
  "apiKeys.revokedAt": "Revoked {at}",
  "apiKeys.revoke": "Revoke",
  "apiKeys.revokeFor": "Revoke {key}",
  "apiKeys.revokeTitle": "Revoke key ID {id}?",
  "apiKeys.keyId": "ID {id}",
  "apiKeys.idLabel": "ID",
  "apiKeys.copyIdFailed": "Couldn't copy. Select the ID and copy it yourself.",
  "apiKeys.revokeConsequence":
    "Anything that uses this key stops working right away. You cannot undo this.",
  "apiKeys.revoked": "Key revoked.",
};

export const apiKeysJa: Record<keyof typeof apiKeysKo, string> = {
  "apiKeys.title": "API キー",
  "apiKeys.guideTitle": "キーの種類",
  "apiKeys.guide.personal.actsAs":
    "発行した人として動作します。このキーで開始したセッションは、その人のものになります。",
  "apiKeys.guide.personal.issuerLeaves":
    "その人がワークスペースを離れるかアカウントが停止されるとすぐに使えなくなり、その人の現在のロールで許可された範囲を超えることはありません。",
  "apiKeys.guide.personal.sessions":
    "その人が閲覧できるセッションにアクセスできます。",
  "apiKeys.guide.personal.approve":
    "「リクエストへの回答」（sessions:approve）を含められます。",
  "apiKeys.guide.agent.actsAs":
    "人ではなく、キー自体として動作します。このキーで開始したセッションはキーのものになります。",
  "apiKeys.guide.agent.issuerLeaves":
    "発行者が離れても有効なままです。不要になったら自分で取り消してください。",
  "apiKeys.guide.agent.sessions":
    "選択したエージェントのセッションにのみアクセスできます。セッションを開始するときも、そのエージェントのリリースを指定する必要があります。",
  "apiKeys.guide.agent.startSession":
    "セッションを作成するには「セッションの作成」と「セッションの閲覧」を含めてください。このキーで GET /v1/agents を呼ぶとエージェントの active_release_id が返るので、その値を POST /v1/sessions の agent_release_id として送ります。",
  "apiKeys.guide.agent.approve":
    "「リクエストへの回答」（sessions:approve）を含めると、そのエージェントのセッションで承認と質問への回答を行います。このキーで開始したセッションのリクエストは、このキーでは承認できません。",
  "apiKeys.docs":
    "API リファレンスでキーを Bearer 欄に入れ、Test Request で実際のリクエストを送れます。",
  "apiKeys.docsLink": "API リファレンスを開く",
  "apiKeys.docsNewTab": "(新しいタブで開きます)",
  "apiKeys.nav": "キーの一覧",
  "apiKeys.navCount": "{count}件",
  "apiKeys.personalTitle": "個人キー",
  "apiKeys.personalIntro":
    "あなたとして動作するキーです。CLI やスクリプトがあなたの権限の範囲で API を呼び出すときに使います。",
  "apiKeys.agentTitle": "エージェントキー",
  "apiKeys.agentIntro":
    "人ではなく、1 つのエージェントに属するキーです。そのエージェントのセッションにのみアクセスでき、発行した人が離れても動作し続けます。",
  "apiKeys.orgTitle": "組織管理キー",
  "apiKeys.orgIntro":
    "人に紐づかない、組織が所有するキーです。Terraform・CI・SCIM などの自動化がワークスペース管理 API を呼び出すときに使います。",
  "apiKeys.orgPending": "準備中です",
  "apiKeys.orgPendingBody":
    "まだ発行できません。セッションを扱う自動化にはエージェントキーを使ってください。発行できるようになったら、有効期限の設定が必須になります。",
  "apiKeys.new": "新しいキー",
  "apiKeys.newPersonalTitle": "新しい個人キー",
  "apiKeys.newAgentTitle": "新しいエージェントキー",
  "apiKeys.generate": "キーを作成",
  "apiKeys.emptyPersonal": "まだ個人キーを作成していません。",
  "apiKeys.emptyAgent": "エージェントキーはまだありません。",
  "apiKeys.survivesIssuerShort": "発行者が離れても有効",
  "apiKeys.agent": "エージェント",
  "apiKeys.pickAgent": "エージェントを選択",
  "apiKeys.agentSearch": "名前または識別子でエージェントを検索",
  "apiKeys.agentLoading": "エージェントを読み込み中…",
  "apiKeys.agentEmpty": "一致するエージェントはありません。",
  "apiKeys.agentCount": "{count}件見つかりました。",
  "apiKeys.agentHint": "キーを使うエージェントです。発行後は変更できません。",
  "apiKeys.noAgents": "管理しているエージェントがありません。",
  "apiKeys.agentNeedsScope": "権限を 1 つ以上選択してください。",
  "apiKeys.selfApproval":
    "「リクエストへの回答」を含めても、このキーで開始したセッションのリクエストはこのキーでは承認できません。別のキーか人が承認します。",
  "apiKeys.name": "名前（任意）",
  "apiKeys.nameHint": "一覧でこのキーを見分けるための名前です。例: ci-deploy",
  "apiKeys.scopes": "権限",
  "apiKeys.scope.read": "セッションの閲覧",
  "apiKeys.scope.write": "セッションの作成",
  "apiKeys.scope.approve": "リクエストへの回答",
  "apiKeys.scope.control": "セッションの操作",
  "apiKeys.scope.recover": "セッションの復旧",
  "apiKeys.scopeHint.read":
    "セッションとそのターン・イベント・レシート・使用量・共有設定、回答待ちのリクエストを閲覧します。",
  "apiKeys.scopeHint.write": "セッションを開始し、メッセージを送信します。",
  "apiKeys.scopeHint.approve":
    "セッションが待っている権限リクエストと質問に回答します。",
  "apiKeys.scopeHint.control": "セッションの一時停止・再開・中断・終了を行います。",
  "apiKeys.scopeHint.recover":
    "復旧が必要なセッションの続け方を決めます。ターンの破棄、完了の確認、クローズ、新規開始、復元の再試行ができます。",
  "apiKeys.expires": "有効期限（任意）",
  "apiKeys.expiresHint": "空欄にすると、取り消すまでキーは有効なままです。",
  "apiKeys.agentExpiresHint":
    "既定は今日から 90 日後です。空欄にすると、取り消すまでキーは有効なままです。",
  "apiKeys.secretTitle": "新しいキー",
  "apiKeys.createdTitle": "キーを作成しました",
  "apiKeys.secretOnce":
    "今すぐコピーしてください。この画面を離れると、値は二度と表示されません。",
  "apiKeys.secret": "キー",
  "apiKeys.copy": "コピー",
  "apiKeys.copied": "コピーしました",
  "apiKeys.copyFailed":
    "コピーできませんでした。上の値を選択して手動でコピーしてください。",
  "apiKeys.toList": "一覧に戻る",
  "apiKeys.listTitle": "発行済みのキー",
  "apiKeys.unnamed": "名前なし",
  "apiKeys.kind.personal": "個人キー",
  "apiKeys.kind.agent": "エージェントキー",
  "apiKeys.createdAt": "{at}に発行",
  "apiKeys.expiresAt": "{at}に期限切れ",
  "apiKeys.expiresSoon": "まもなく期限切れ · {at}",
  "apiKeys.expiredAt": "期限切れ · {at}",
  "apiKeys.noExpiry": "有効期限なし",
  "apiKeys.approveYes": "承認可",
  "apiKeys.approveNo": "承認不可",
  "apiKeys.revokedAt": "{at}に取り消し",
  "apiKeys.revoke": "取り消し",
  "apiKeys.revokeFor": "{key}を取り消し",
  "apiKeys.revokeTitle": "キー ID {id} を取り消しますか？",
  "apiKeys.keyId": "ID {id}",
  "apiKeys.idLabel": "ID",
  "apiKeys.copyIdFailed":
    "コピーできませんでした。ID を選択して手動でコピーしてください。",
  "apiKeys.revokeConsequence":
    "このキーを使っているものはすぐに動作しなくなります。この操作は元に戻せません。",
  "apiKeys.revoked": "キーを取り消しました。",
};
