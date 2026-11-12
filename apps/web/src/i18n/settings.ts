/**
 * The installation settings screens: the model settings' connections, the
 * MCP servers and the home screen's setup steps.
 */
export const settingsKo = {
  "settings.state.active": "사용 중",
  "settings.state.needs_value": "값 필요",
  "settings.state.unresolved": "자격 증명 확인 안 됨",
  "settings.state.disabled": "사용 중지됨",
  "settings.credential.stored": "저장 값 ••••{last4}",
  "settings.credential.storedEmpty": "저장 값 없음",
  "settings.credential.env": "환경 변수 {name}",
  "settings.credential.secret": "Secrets Manager {name}",
  "settings.credential.none": "인증 없음",
  "settings.externalRow":
    "운영자 참조입니다. 콘솔에서는 보기와 사용 중지만 됩니다.",
  "settings.immutable":
    "주소와 자격 증명 출처는 만든 뒤 바꿀 수 없습니다. 바꾸려면 새 id로 만드세요.",
  "settings.id": "id",
  "settings.idHint":
    "소문자·숫자와 . _ - 로 64자까지. 한 번 쓴 id는 사용 중지한 뒤에도 다시 쓸 수 없습니다.",
  "settings.valueHint":
    "저장하면 바로 암호화되고 다시 보이지 않습니다. 끝 네 글자만 남습니다.",
  "settings.column.id": "id",
  "settings.column.credential": "자격 증명",
  "settings.column.state": "상태",
  "settings.column.actions": "동작",
  "settings.setValue": "값 바꾸기",
  "settings.setFirstValue": "값 넣기",
  "settings.setValueFor": "{id} 값 바꾸기",
  "settings.setValueTitle": "{id}의 값 바꾸기",
  "settings.setValueDescription":
    "새 값은 이 항목에만 묶여 저장됩니다. 도는 세션은 멈추지 않습니다.",
  "settings.convert": "화면에서 키 넣기",
  "settings.convertFor": "{id} 화면에서 키 넣기",
  "settings.convertTitle": "{id}의 키를 화면에서 넣기",
  "settings.convertDescription":
    "이 연결은 서버의 환경 변수나 Secrets Manager에 있는 키를 씁니다. 키를 여기에 붙여 넣으면 DB에 봉인해 저장하고, 이 연결은 저장한 키로 돕니다. 서버가 기존 값을 읽어 옮기지는 않습니다. 도는 세션은 멈추지 않습니다.",
  "settings.done.converted": "{id}의 키를 저장했습니다.",
  "settings.error.not_external":
    "이미 화면에서 넣은 키를 쓰는 항목입니다. 값 바꾸기를 쓰세요.",
  "settings.error.alias_taken":
    "다른 연결이 이 연결의 옛 정의와 같아 키를 옮길 수 없습니다.",
  "settings.value": "값",
  "settings.save": "저장",
  "settings.saving": "저장 중…",
  "settings.create": "만들기",
  "settings.creating": "만드는 중…",
  "settings.disable": "사용 중지",
  "settings.disableFor": "{id} 사용 중지",
  "settings.disableTitle": "{id}를 사용 중지할까요?",
  "settings.disableConsequence":
    "되돌릴 수 없습니다. 이 id는 다시 쓸 수 없고, 이 항목을 쓰는 에이전트는 더 이상 실행되지 않습니다.",
  "settings.connections.disableConsequence":
    "이 id는 다른 연결에 쓸 수 없습니다. 이 연결로 모델을 부르는 에이전트와 세션은 다시 켤 때까지 실행되지 않습니다.",
  "settings.connections.disableReenable":
    "나중에 같은 화면에서 다시 켤 수 있습니다.",
  "settings.enable": "다시 켜기",
  "settings.enableFor": "{id} 다시 켜기",
  "settings.enableTitle": "{id}를 다시 켤까요?",
  "settings.connections.enableConsequence":
    "이 연결을 다시 쓸 수 있게 됩니다. 설정을 다시 읽은 뒤, 이 연결로 만든 릴리스가 다시 실행됩니다. 키를 읽지 못하면 목록에 그 상태로 표시됩니다.",
  "settings.done.enabled": "{id}를 다시 켰습니다.",
  "settings.error.not_disabled": "이미 사용 중인 연결입니다.",
  "settings.error.definition_active":
    "같은 정의의 다른 연결이 사용 중이라 켤 수 없습니다. 그 연결을 먼저 사용 중지하세요.",
  "settings.error.needs_value":
    "저장된 키가 없어 다시 켤 수 없습니다. 새 연결을 만드세요.",
  "settings.connections.impact.checking": "영향을 확인하는 중…",
  "settings.connections.impact.failed":
    "영향 수를 확인하지 못했습니다. 그래도 사용 중지할 수 있습니다.",
  "settings.connections.impact.warning":
    "이 연결을 사용 중지하면 아래 대상은 이후 모델 호출이 거절되거나 끊길 수 있습니다.",
  "settings.connections.impact.agents":
    "이 연결로 도는 활성 릴리스의 에이전트: {count}개",
  "settings.connections.impact.sessions": "끝나지 않은 세션: {count}개",
  "settings.connections.impact.judge":
    "성과 판정 설정이 이 연결을 가리키고 있습니다.",
  "settings.done.created": "{id}를 만들었습니다.",
  "settings.done.value": "{id}의 값을 바꿨습니다.",
  "settings.done.disabled": "{id}를 사용 중지했습니다.",
  "settings.done.changed": "{id}를 바꿨습니다.",
  "settings.error.already_exists":
    "이미 쓴 id입니다. 사용 중지한 id도 다시 쓸 수 없습니다.",
  "settings.error.not_stored":
    "운영자 참조는 콘솔에서 보기와 사용 중지만 됩니다.",
  "settings.error.disabled": "사용 중지된 항목입니다.",
  "settings.error.invalid_entry": "입력이 올바르지 않습니다: {detail}",

  "settings.connections.title": "모델 연결",
  "settings.connections.description":
    "이 설치의 모든 워크스페이스가 쓰는, 에이전트가 모델을 부르는 주소와 키, 그리고 에이전트가 고를 수 있는 모델입니다. 콘솔에서 넣은 키는 암호화해 저장하고 끝 네 글자만 보입니다.",
  "settings.connections.add": "연결 추가",
  "settings.connections.empty":
    "모델 연결이 없습니다. 연결을 추가하고 모델 목록을 정하면 에이전트가 고를 수 있습니다.",
  "settings.connections.kind": "종류",
  "settings.connections.kindHint.openai_responses":
    "OpenAI Responses API로 부르는 연결입니다. 이 연결을 쓰는 에이전트는 Codex 엔진으로 실행됩니다.",
  "settings.connections.endpoint": "엔드포인트",
  "settings.connections.endpointDefault":
    "공식 주소가 채워져 있습니다. 비우면 같은 주소로 저장되고, 프록시나 호환 서버를 쓸 때만 바꿉니다.",
  "settings.connections.endpointRequired":
    "litellm에는 기본 주소가 없습니다. 엔드포인트를 입력하세요.",
  "settings.connections.billing": "비용 집계",
  "settings.connections.billing.per_token": "토큰당 비용 집계",
  "settings.connections.billing.none": "비용 집계 안 함",
  "settings.connections.authKind": "인증 방식",
  "settings.connections.authKind.api_key": "API 키",
  "settings.connections.authKind.bearer": "Bearer 토큰",
  "settings.connections.key": "키 값",
  "settings.autoMode.column": "자동 모드",
  "settings.autoMode.supported": "지원함",
  "settings.autoMode.unsupported": "지원 안 함",
  "settings.autoMode.unknown": "모름",
  "settings.autoMode.set": "자동 모드 판정",
  "settings.autoMode.setFor": "{id}의 자동 모드 판정",
  "settings.autoMode.title": "자동 모드 판정",
  "settings.autoMode.description":
    "이 연결의 모델이 자동 모드(auto) 분류기를 실행하는지 기록합니다. '지원함'이면 실행 모드가 기본·편집 허용·묻지 않음·계획인 에이전트가 각 세션의 다음 claim부터 auto로 실행됩니다. 실행 중인 세션은 현재 실행을 마칠 때까지 그대로입니다. '지원 안 함'과 '모름'은 지금 방식(기본 모드와 승인)을 유지합니다.",
  "settings.autoMode.label": "판정",
  "settings.autoMode.save": "저장",
  "settings.autoMode.saving": "저장하는 중",
  "settings.done.autoMode": "{id}의 자동 모드를 '{value}'(으)로 기록했습니다.",
  "settings.connections.egressWarning":
    "{host}는 egress 자격 증명 허용 목록에 없습니다. 저장은 되지만, 세션이 이 키로 나가려면 운영자가 EGRESS_CREDENTIAL_ALLOWLIST에 더해야 합니다.",

  "settings.connections.nav": "모델 연결",
  "settings.mcp.nav": "MCP 서버",
  "settings.mcp.title": "MCP 서버",
  "settings.mcp.description":
    "에이전트 카드가 이름으로 부르는 원격 MCP 서버입니다. 서버의 도구는 세션이 서버에 닿을 때 알려지며, 이름은 서버마다 아래 이름 공간을 씁니다.",
  "settings.mcp.add": "MCP 서버 추가",
  "settings.mcp.empty": "MCP 서버가 없습니다.",
  "settings.mcp.url": "URL",
  "settings.mcp.credentialRef": "자격 증명 이름",
  "settings.mcp.credentialRefHint":
    "에이전트 카드의 credential_refs와 맞춰 보는 이름입니다. 소문자로 씁니다.",
  "settings.mcp.workspaces": "워크스페이스",
  "settings.mcp.workspacesHint": "쓸 수 있는 워크스페이스의 slug, 쉼표로 구분",
  "settings.mcp.bearer": "Bearer 토큰 값",
  "settings.mcp.tools": "도구 이름 공간",
  "settings.mcp.editWorkspaces": "워크스페이스 바꾸기",
  "settings.mcp.editWorkspacesFor": "{id} 워크스페이스 바꾸기",
  "settings.mcp.editWorkspacesTitle": "{id}를 쓸 워크스페이스",

  "home.setup.connection": "모델 연결 추가하기",
  "home.setup.connectionHint":
    "설정의 모델 연결에서 엔드포인트와 키를 넣습니다.",
  "home.setup.toConnections": "모델 연결",
  "settings.connections.models": "모델",
  "settings.connections.noModels": "모델 없음",
  "settings.models.set": "모델",
  "settings.models.setFor": "{id}의 모델 목록",
  "settings.models.title": "에이전트가 고를 수 있는 모델",
  "settings.models.description":
    "이 연결에서 에이전트 카드가 고를 수 있는 모델입니다. 목록에서 뺀 모델로 도는 세션은 다음 모델 호출에서 멈춥니다.",
  "settings.models.label": "모델 (한 줄에 하나)",
  "settings.models.hint":
    "공급자가 쓰는 모델 이름 그대로 적습니다. 쉼표로 나눠도 됩니다.",
  "settings.models.save": "모델 저장",
  "settings.models.saving": "저장 중…",
  "settings.done.models": "{id}의 모델 {count}개를 저장했습니다.",
  "home.setup.models": "모델 연결에 모델 정하기",
  "home.setup.modelsHint": "연결마다 에이전트가 고를 수 있는 모델을 적습니다.",
} as const;

export const settingsEn: Record<keyof typeof settingsKo, string> = {
  "settings.state.active": "Active",
  "settings.state.needs_value": "Needs a value",
  "settings.state.unresolved": "Credential unresolved",
  "settings.state.disabled": "Disabled",
  "settings.credential.stored": "Stored value ••••{last4}",
  "settings.credential.storedEmpty": "No stored value",
  "settings.credential.env": "Env {name}",
  "settings.credential.secret": "Secrets Manager {name}",
  "settings.credential.none": "No authentication",
  "settings.externalRow":
    "An operator's reference. The console only shows and disables it.",
  "settings.immutable":
    "The address and where the credential comes from cannot change after it is made. To change them, make a new id.",
  "settings.id": "id",
  "settings.idHint":
    "Lowercase letters, digits and . _ -, up to 64. An id once used is never used again, even after it is disabled.",
  "settings.valueHint":
    "Encrypted as soon as it is saved and never shown again; only the last four characters stay.",
  "settings.column.id": "id",
  "settings.column.credential": "Credential",
  "settings.column.state": "State",
  "settings.column.actions": "Actions",
  "settings.setValue": "Replace value",
  "settings.setFirstValue": "Set value",
  "settings.setValueFor": "Replace the value of {id}",
  "settings.setValueTitle": "Replace the value of {id}",
  "settings.setValueDescription":
    "The new value is stored for this entry alone. Running sessions keep running.",
  "settings.convert": "Enter key on screen",
  "settings.convertFor": "Enter the key of {id} on screen",
  "settings.convertTitle": "Enter the key of {id} on screen",
  "settings.convertDescription":
    "This connection uses a key from the server's environment or Secrets Manager. Paste the key here and it is sealed in the database; the connection then runs on the stored key. The server does not read the old value and copy it. Running sessions keep running.",
  "settings.done.converted": "The key of {id} was stored.",
  "settings.error.not_external":
    "This entry already keeps a key entered on screen. Use Replace value.",
  "settings.error.alias_taken":
    "Another connection is exactly what this one was, so its key cannot be moved.",
  "settings.value": "Value",
  "settings.save": "Save",
  "settings.saving": "Saving…",
  "settings.create": "Create",
  "settings.creating": "Creating…",
  "settings.disable": "Disable",
  "settings.disableFor": "Disable {id}",
  "settings.disableTitle": "Disable {id}?",
  "settings.disableConsequence":
    "This cannot be undone. The id is never used again, and the agents that use this entry stop running.",
  "settings.connections.disableConsequence":
    "The id stays taken and cannot go to another connection. Agents and sessions that call their model through this connection do not run until it is turned back on.",
  "settings.connections.disableReenable":
    "You can turn it back on later from this screen.",
  "settings.enable": "Enable again",
  "settings.enableFor": "Enable {id} again",
  "settings.enableTitle": "Enable {id} again?",
  "settings.connections.enableConsequence":
    "This connection can be used again. Once the settings are read again, releases made on it run again. If its key cannot be read, the list shows it in that state.",
  "settings.done.enabled": "{id} is enabled again.",
  "settings.error.not_disabled": "This connection is already in use.",
  "settings.error.definition_active":
    "Another connection in use is exactly what this one is, so it cannot be enabled. Disable that one first.",
  "settings.error.needs_value":
    "Its stored key is gone, so it cannot be enabled again. Make a new connection.",
  "settings.connections.impact.checking": "Checking what this affects…",
  "settings.connections.impact.failed":
    "Could not check what this affects. You can still disable it.",
  "settings.connections.impact.warning":
    "If you disable this connection, model calls from the following can be refused or cut off from then on.",
  "settings.connections.impact.agents":
    "Agents whose active release runs on this connection: {count}",
  "settings.connections.impact.sessions": "Sessions not yet ended: {count}",
  "settings.connections.impact.judge":
    "A workspace's achievement judge setting points at this connection.",
  "settings.done.created": "{id} was created.",
  "settings.done.value": "The value of {id} was replaced.",
  "settings.done.disabled": "{id} was disabled.",
  "settings.done.changed": "{id} was changed.",
  "settings.error.already_exists":
    "This id was used already. A disabled id is never used again either.",
  "settings.error.not_stored":
    "An operator's reference can only be shown and disabled in the console.",
  "settings.error.disabled": "This entry is disabled.",
  "settings.error.invalid_entry": "The entry is invalid: {detail}",

  "settings.connections.title": "Model connections",
  "settings.connections.description":
    "Where agents reach a model, and with which key, for every workspace on this installation, and the models agents may pick on each. A key entered here is stored encrypted; only its last four characters show.",
  "settings.connections.add": "Add connection",
  "settings.connections.empty":
    "No model connections. Add one and list its models, and agents can pick it.",
  "settings.connections.kind": "Kind",
  "settings.connections.kindHint.openai_responses":
    "Calls the OpenAI Responses API. Agents on this connection run on the Codex engine.",
  "settings.connections.endpoint": "Endpoint",
  "settings.connections.endpointDefault":
    "The official address is filled in. Leave it empty to store the same address; change it only for a proxy or a compatible server.",
  "settings.connections.endpointRequired":
    "litellm has no default address. Enter an endpoint.",
  "settings.connections.billing": "Cost tracking",
  "settings.connections.billing.per_token": "Per-token cost tracking",
  "settings.connections.billing.none": "No cost tracking",
  "settings.connections.authKind": "Authentication",
  "settings.connections.authKind.api_key": "API key",
  "settings.connections.authKind.bearer": "Bearer token",
  "settings.connections.key": "Key",
  "settings.autoMode.column": "Auto mode",
  "settings.autoMode.supported": "Supported",
  "settings.autoMode.unsupported": "Not supported",
  "settings.autoMode.unknown": "Unknown",
  "settings.autoMode.set": "Set auto mode",
  "settings.autoMode.setFor": "Set the auto mode of {id}",
  "settings.autoMode.title": "Auto mode support",
  "settings.autoMode.description":
    "Record whether this connection's models run the auto-mode classifier. With 'Supported', agents whose mode is default, accept edits, don't ask or plan run as auto from the next claim of each session. Running sessions keep their current run. 'Not supported' and 'Unknown' keep today's behaviour (default mode with approvals).",
  "settings.autoMode.label": "Support",
  "settings.autoMode.save": "Save",
  "settings.autoMode.saving": "Saving",
  "settings.done.autoMode": "Recorded auto mode '{value}' for {id}.",
  "settings.connections.egressWarning":
    "{host} is not on the egress credential allowlist. It saves, but for a session to go out with this key the operator must add it to EGRESS_CREDENTIAL_ALLOWLIST.",

  "settings.connections.nav": "Model connections",
  "settings.mcp.nav": "MCP servers",
  "settings.mcp.title": "MCP servers",
  "settings.mcp.description":
    "Remote MCP servers an agent card names. A server's tools are known once a session reaches it, and are named in the server's namespace below.",
  "settings.mcp.add": "Add MCP server",
  "settings.mcp.empty": "No MCP servers.",
  "settings.mcp.url": "URL",
  "settings.mcp.credentialRef": "Credential name",
  "settings.mcp.credentialRefHint":
    "The name an agent card's credential_refs is matched against. Lowercase.",
  "settings.mcp.workspaces": "Workspaces",
  "settings.mcp.workspacesHint":
    "The slugs of the workspaces that may use it, comma-separated",
  "settings.mcp.bearer": "Bearer token",
  "settings.mcp.tools": "Tool namespace",
  "settings.mcp.editWorkspaces": "Change workspaces",
  "settings.mcp.editWorkspacesFor": "Change the workspaces of {id}",
  "settings.mcp.editWorkspacesTitle": "Workspaces that may use {id}",

  "home.setup.connection": "Add a model connection",
  "home.setup.connectionHint":
    "Enter an endpoint and a key under Model connections in Settings.",
  "home.setup.toConnections": "Model connections",
  "settings.connections.models": "Models",
  "settings.connections.noModels": "No models",
  "settings.models.set": "Models",
  "settings.models.setFor": "Models of {id}",
  "settings.models.title": "Models agents may pick",
  "settings.models.description":
    "The models an agent's card may name on this connection. A session on a model taken off the list stops at its next model call.",
  "settings.models.label": "Models (one per line)",
  "settings.models.hint":
    "Write each model the way the provider names it. Commas work too.",
  "settings.models.save": "Save models",
  "settings.models.saving": "Saving…",
  "settings.done.models": "Saved {count} models for {id}.",
  "home.setup.models": "List models on a connection",
  "home.setup.modelsHint":
    "For each connection, list the models agents may pick.",
};

export const settingsJa: Record<keyof typeof settingsKo, string> = {
  "settings.state.active": "使用中",
  "settings.state.needs_value": "値が必要",
  "settings.state.unresolved": "資格情報を確認できない",
  "settings.state.disabled": "使用停止",
  "settings.credential.stored": "保存値 ••••{last4}",
  "settings.credential.storedEmpty": "保存値なし",
  "settings.credential.env": "環境変数 {name}",
  "settings.credential.secret": "Secrets Manager {name}",
  "settings.credential.none": "認証なし",
  "settings.externalRow":
    "運用者の参照です。コンソールでは表示と使用停止だけできます。",
  "settings.immutable":
    "アドレスと資格情報の出どころは作成後に変えられません。変えるには新しい id で作ります。",
  "settings.id": "id",
  "settings.idHint":
    "小文字・数字と . _ - で 64 文字まで。一度使った id は使用停止後も再利用できません。",
  "settings.valueHint":
    "保存するとすぐ暗号化され、二度と表示されません。末尾 4 文字だけが残ります。",
  "settings.column.id": "id",
  "settings.column.credential": "資格情報",
  "settings.column.state": "状態",
  "settings.column.actions": "操作",
  "settings.setValue": "値を変える",
  "settings.setFirstValue": "値を入れる",
  "settings.setValueFor": "{id} の値を変える",
  "settings.setValueTitle": "{id} の値を変える",
  "settings.setValueDescription":
    "新しい値はこの項目だけに結びつけて保存します。実行中のセッションは止まりません。",
  "settings.convert": "画面でキーを入れる",
  "settings.convertFor": "{id} のキーを画面で入れる",
  "settings.convertTitle": "{id} のキーを画面で入れる",
  "settings.convertDescription":
    "この接続は、サーバーの環境変数または Secrets Manager にあるキーを使っています。ここにキーを貼り付けると DB に封印して保存し、この接続は保存したキーで動きます。サーバーが古い値を読んで移すことはありません。実行中のセッションは止まりません。",
  "settings.done.converted": "{id} のキーを保存しました。",
  "settings.error.not_external":
    "すでに画面で入れたキーを使う項目です。値を変えるを使ってください。",
  "settings.error.alias_taken":
    "別の接続がこの接続の元の定義と同じため、キーを移せません。",
  "settings.value": "値",
  "settings.save": "保存",
  "settings.saving": "保存中…",
  "settings.create": "作成",
  "settings.creating": "作成中…",
  "settings.disable": "使用停止",
  "settings.disableFor": "{id} を使用停止",
  "settings.disableTitle": "{id} を使用停止しますか？",
  "settings.disableConsequence":
    "元に戻せません。この id は再利用できず、この項目を使うエージェントは動かなくなります。",
  "settings.connections.disableConsequence":
    "この id は別の接続には使えません。この接続でモデルを呼ぶエージェントとセッションは、再び有効にするまで動きません。",
  "settings.connections.disableReenable":
    "あとからこの画面で再び有効にできます。",
  "settings.enable": "再び有効にする",
  "settings.enableFor": "{id} を再び有効にする",
  "settings.enableTitle": "{id} を再び有効にしますか？",
  "settings.connections.enableConsequence":
    "この接続を再び使えるようになります。設定を読み直したあと、この接続で作ったリリースが再び動きます。キーを読めない場合は、一覧にその状態で表示されます。",
  "settings.done.enabled": "{id} を再び有効にしました。",
  "settings.error.not_disabled": "すでに使用中の接続です。",
  "settings.error.definition_active":
    "同じ定義の別の接続が使用中のため、有効にできません。先にその接続を使用停止してください。",
  "settings.error.needs_value":
    "保存したキーがないため、再び有効にできません。新しい接続を作成してください。",
  "settings.connections.impact.checking": "影響を確認しています…",
  "settings.connections.impact.failed":
    "影響の数を確認できませんでした。それでも使用停止できます。",
  "settings.connections.impact.warning":
    "この接続を使用停止すると、以下の対象は以後のモデル呼び出しが拒否されたり切断されたりすることがあります。",
  "settings.connections.impact.agents":
    "この接続で動く有効なリリースのエージェント: {count}件",
  "settings.connections.impact.sessions": "終了していないセッション: {count}件",
  "settings.connections.impact.judge":
    "成果判定の設定がこの接続を指しています。",
  "settings.done.created": "{id} を作成しました。",
  "settings.done.value": "{id} の値を変えました。",
  "settings.done.disabled": "{id} を使用停止しました。",
  "settings.done.changed": "{id} を変更しました。",
  "settings.error.already_exists":
    "使用済みの id です。使用停止した id も再利用できません。",
  "settings.error.not_stored":
    "運用者の参照はコンソールでは表示と使用停止だけできます。",
  "settings.error.disabled": "使用停止した項目です。",
  "settings.error.invalid_entry": "入力が正しくありません: {detail}",

  "settings.connections.title": "モデル接続",
  "settings.connections.description":
    "このインストールのすべてのワークスペースが使う、エージェントがモデルを呼ぶアドレスとキー、そしてエージェントが選べるモデルです。コンソールで入れたキーは暗号化して保存し、末尾 4 文字だけ表示します。",
  "settings.connections.add": "接続を追加",
  "settings.connections.empty":
    "モデル接続がありません。接続を追加してモデル一覧を決めると、エージェントが選べます。",
  "settings.connections.kind": "種類",
  "settings.connections.kindHint.openai_responses":
    "OpenAI Responses API を呼び出す接続です。この接続を使うエージェントは Codex エンジンで実行されます。",
  "settings.connections.endpoint": "エンドポイント",
  "settings.connections.endpointDefault":
    "公式アドレスが入力済みです。空にすると同じアドレスで保存されます。プロキシや互換サーバーを使うときだけ変更します。",
  "settings.connections.endpointRequired":
    "litellm には既定のアドレスがありません。エンドポイントを入力してください。",
  "settings.connections.billing": "コスト集計",
  "settings.connections.billing.per_token": "トークン単位で集計",
  "settings.connections.billing.none": "集計しない",
  "settings.connections.authKind": "認証方式",
  "settings.connections.authKind.api_key": "API キー",
  "settings.connections.authKind.bearer": "Bearer トークン",
  "settings.connections.key": "キーの値",
  "settings.autoMode.column": "自動モード",
  "settings.autoMode.supported": "対応",
  "settings.autoMode.unsupported": "非対応",
  "settings.autoMode.unknown": "不明",
  "settings.autoMode.set": "自動モードを判定",
  "settings.autoMode.setFor": "{id} の自動モードを判定",
  "settings.autoMode.title": "自動モードの判定",
  "settings.autoMode.description":
    "この接続のモデルが自動モード(auto)の分類器を実行できるかを記録します。「対応」にすると、実行モードが既定・編集許可・確認しない・計画のエージェントが、各セッションの次の claim から auto で実行されます。実行中のセッションは現在の実行が終わるまで変わりません。「非対応」と「不明」は現在の動作(既定モードと承認)のままです。",
  "settings.autoMode.label": "判定",
  "settings.autoMode.save": "保存",
  "settings.autoMode.saving": "保存中",
  "settings.done.autoMode": "{id} の自動モードを「{value}」と記録しました。",
  "settings.connections.egressWarning":
    "{host} は egress 資格情報の許可リストにありません。保存はできますが、セッションがこのキーで外に出るには運用者が EGRESS_CREDENTIAL_ALLOWLIST に追加する必要があります。",

  "settings.connections.nav": "モデル接続",
  "settings.mcp.nav": "MCP サーバー",
  "settings.mcp.title": "MCP サーバー",
  "settings.mcp.description":
    "エージェントカードが名前で呼ぶリモート MCP サーバーです。サーバーのツールはセッションが到達したときに分かり、名前はサーバーごとに下の名前空間を使います。",
  "settings.mcp.add": "MCP サーバーを追加",
  "settings.mcp.empty": "MCP サーバーがありません。",
  "settings.mcp.url": "URL",
  "settings.mcp.credentialRef": "資格情報名",
  "settings.mcp.credentialRefHint":
    "エージェントカードの credential_refs と照合する名前です。小文字で書きます。",
  "settings.mcp.workspaces": "ワークスペース",
  "settings.mcp.workspacesHint": "使えるワークスペースの slug、カンマ区切り",
  "settings.mcp.bearer": "Bearer トークンの値",
  "settings.mcp.tools": "ツールの名前空間",
  "settings.mcp.editWorkspaces": "ワークスペースを変える",
  "settings.mcp.editWorkspacesFor": "{id} のワークスペースを変える",
  "settings.mcp.editWorkspacesTitle": "{id} を使えるワークスペース",

  "home.setup.connection": "モデル接続を追加する",
  "home.setup.connectionHint":
    "設定のモデル接続で、エンドポイントとキーを入れます。",
  "home.setup.toConnections": "モデル接続",
  "settings.connections.models": "モデル",
  "settings.connections.noModels": "モデルなし",
  "settings.models.set": "モデル",
  "settings.models.setFor": "{id} のモデル一覧",
  "settings.models.title": "エージェントが選べるモデル",
  "settings.models.description":
    "この接続でエージェントのカードが選べるモデルです。一覧から外したモデルで動くセッションは、次のモデル呼び出しで止まります。",
  "settings.models.label": "モデル（1 行に 1 つ）",
  "settings.models.hint":
    "プロバイダーが使うモデル名のまま書きます。カンマ区切りでもかまいません。",
  "settings.models.save": "モデルを保存",
  "settings.models.saving": "保存中…",
  "settings.done.models": "{id} のモデル {count} 件を保存しました。",
  "home.setup.models": "モデル接続にモデルを決める",
  "home.setup.modelsHint": "接続ごとに、エージェントが選べるモデルを書きます。",
};
