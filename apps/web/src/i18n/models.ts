/**
 * The card's model picker and the release form's model check, kept apart
 * from ko.ts and en.ts like sessions.ts; both catalogs spread these in.
 */
export const modelsKo = {
  "agentCard.modelPick": "모델을 고르세요",
  "agentCard.modelUncataloged": "{model} · 카탈로그에 없음",
  "agentCard.modelUncatalogedWarning":
    "이 모델은 카탈로그에 없어 이 카드로는 릴리스를 만들 수 없습니다. 바꾸지 않으면 그대로 저장됩니다.",
  "agentCard.modelsLoading":
    "모델 목록을 불러오는 중… 다 불러온 뒤에 저장할 수 있습니다.",
  "agentCard.modelsFailed":
    "모델 목록을 불러오지 못해 저장할 수 없습니다: {reason}",

  "agent.releases.modelRefused":
    "카드 모델 {card}을(를) 연결 {connection}이(가) 제공하지 않아 릴리스를 만들지 못했습니다. 이 모델을 제공하는 연결을 고르거나 모델을 바꾸세요.",

  "agent.modelRemoved.title":
    "모델 {model}이(가) 연결 {connection}의 모델 목록에서 빠졌습니다",
  "agent.modelRemoved.text":
    "이 에이전트로는 새 세션이 시작되지 않고, 이 모델로 실행 중인 세션은 멈춥니다. 설치 owner에게 모델을 연결의 모델 목록에 되돌려 달라고 요청하거나, 상세 설정 탭에서 모델을 연결이 제공하는 모델로 바꿔 저장하세요.",
  "agent.modelMoves.title":
    "모델 {model}이(가) 연결 {connection}의 모델 목록에서 빠져 {successor}(으)로 옮겨 실행됩니다",
  "agent.modelMoves.text":
    "새 세션은 {successor}(으)로 시작하고, 기다리던 세션은 다음 턴부터 {successor}(으)로 옮겨 갑니다. 에이전트의 릴리스도 {successor}(으)로 새로 만들어집니다. 실행 중인 턴은 {model} 요청이 막혀 멈춥니다.",
  "agent.modelMoves.offTitle":
    "모델 {model}이(가) 연결 {connection}의 모델 목록에서 빠졌고, 자동 이동이 꺼져 있어 멈춰 있습니다",
  "agent.modelMoves.offText":
    "{successor}(으)로 옮길 수 있지만 이 에이전트는 자동 이동을 끄고 있어 새 세션도 시작되지 않습니다. 자동 이동을 켜거나 상세 설정 탭에서 모델을 바꿔 저장하세요.",
  "agent.modelMoves.turnOn": "자동 이동 켜기",
  "agent.modelMoves.turnOff": "자동 이동 끄기",
  "agent.modelMoves.failedTitle":
    "모델 {model}을(를) {successor}(으)로 자동으로 옮기지 못했습니다",
  "agent.modelMoves.failedText":
    "이유: {reason}. 마지막 시도 {at}. {minutes}분마다 다시 시도합니다.",
  "agent.modelMoves.failedActorInactive":
    "자동 이동은 이 에이전트를 마지막으로 활성화한 사람의 이름으로 돕니다. 그 사람이 더는 오너나 어드민이 아닙니다. 오너나 어드민이 상세 설정 탭에서 모델을 {successor}(으)로 바꿔 저장하세요.",
  "agent.modelMoves.failedCredential":
    "자격 증명을 연결한 뒤 상세 설정 탭에서 모델을 {successor}(으)로 바꿔 저장하세요.",
  "agent.modelMoves.failedOther":
    "상세 설정 탭에서 모델을 {successor}(으)로 바꿔 저장해 보세요. 같은 이유로 막히면 저장 결과에 이유가 나옵니다.",

  "agentCard.judgmentModel": "판단 모델",
  "agentCard.judgmentModelCard": "카드 모델 사용 ({model})",
  "agentCard.judgmentModelCardUnset": "카드 모델 사용",
  "agentCard.judgmentModelHint":
    "채널 글에 끼어들지 판단하고 채널 요약을 접을 때 쓰는 모델입니다. 고른 연결이 제공하는 모델 중에서 고르고, 비워 두면 카드 모델을 씁니다. 성과 판정의 판정 모델과는 따로입니다.",
  "agentCard.judgmentModelUncatalogedWarning":
    "이 판단 모델은 연결의 모델 목록에 없어 판단을 돌리지 않습니다. 이 카드로는 릴리스를 만들 수 없으니 연결이 제공하는 모델이나 카드 모델 사용으로 바꾸세요.",
  "agent.releases.judgmentModelRefused":
    "판단 모델 {model}을(를) 연결 {connection}이(가) 제공하지 않아 릴리스를 만들지 못했습니다. 이 연결의 모델을 고르거나 카드 모델 사용으로 바꾸세요.",
  "agent.releases.field.judgmentModel": "판단 모델",
  "agent.save.reason.judgment_model_not_in_connection":
    "연결이 제공하지 않는 판단 모델입니다",
};

export const modelsEn: Record<keyof typeof modelsKo, string> = {
  "agentCard.modelPick": "Choose a model",
  "agentCard.modelUncataloged": "{model} · not in the catalog",
  "agentCard.modelUncatalogedWarning":
    "This model is not in the catalog, so this card cannot be released. If you leave it, it is saved as it is.",
  "agentCard.modelsLoading":
    "Loading the models… You can save once they are loaded.",
  "agentCard.modelsFailed":
    "Could not load the models, so you cannot save: {reason}",

  "agent.releases.modelRefused":
    "Connection {connection} does not offer the card's model {card}, so no release was created. Choose a connection that offers it, or change the model.",

  "agent.modelRemoved.title":
    "Model {model} was taken off the model list of connection {connection}",
  "agent.modelRemoved.text":
    "This agent starts no new session, and sessions running this model stop. Ask the installation owner to put the model back on the connection's list, or change the model to one the connection offers in the Settings tab and save.",
  "agent.modelMoves.title":
    "Model {model} was taken off the model list of connection {connection}; it now runs on {successor}",
  "agent.modelMoves.text":
    "New sessions start on {successor}, and sessions waiting for a turn move to {successor} from their next turn. The agent also gets a new release on {successor}. A turn already running is stopped when its {model} requests are blocked.",
  "agent.modelMoves.offTitle":
    "Model {model} was taken off the model list of connection {connection}, and automatic move is off, so this agent is blocked",
  "agent.modelMoves.offText":
    "It could move to {successor}, but this agent has automatic move turned off, so no new session starts. Turn automatic move on, or change the model in the Settings tab and save.",
  "agent.modelMoves.turnOn": "Turn automatic move on",
  "agent.modelMoves.turnOff": "Turn automatic move off",
  "agent.modelMoves.failedTitle":
    "Model {model} could not move to {successor} automatically",
  "agent.modelMoves.failedText":
    "Reason: {reason}. Last tried {at}. It is tried again every {minutes} minutes.",
  "agent.modelMoves.failedActorInactive":
    "The automatic move runs in the name of the person who last activated this agent, and that person is no longer an owner or admin. Have an owner or admin change the model to {successor} in the Settings tab and save.",
  "agent.modelMoves.failedCredential":
    "Connect the credential, then change the model to {successor} in the Settings tab and save.",
  "agent.modelMoves.failedOther":
    "Try changing the model to {successor} in the Settings tab and saving. If it is blocked for the same reason, the save result shows why.",

  "agentCard.judgmentModel": "Judgment model",
  "agentCard.judgmentModelCard": "Use the card's model ({model})",
  "agentCard.judgmentModelCardUnset": "Use the card's model",
  "agentCard.judgmentModelHint":
    "The model that judges whether to step into channel messages and folds channel summaries. Choose among the models the chosen connection offers; left empty, the card's model is used. It is separate from the decision model of achievement judging.",
  "agentCard.judgmentModelUncatalogedWarning":
    "This judgment model is not on the connection's model list, so no judgment runs. This card cannot be released: choose a model the connection offers, or use the card's model.",
  "agent.releases.judgmentModelRefused":
    "Connection {connection} does not offer the judgment model {model}, so no release was created. Choose one of its models, or use the card's model.",
  "agent.releases.field.judgmentModel": "Judgment model",
  "agent.save.reason.judgment_model_not_in_connection":
    "The connection does not offer this judgment model",
};

export const modelsJa: Record<keyof typeof modelsKo, string> = {
  "agentCard.modelPick": "モデルを選択",
  "agentCard.modelUncataloged": "{model} · カタログにありません",
  "agentCard.modelUncatalogedWarning":
    "このモデルはカタログにないため、このカードはリリースできません。そのままにすると、現在の状態で保存されます。",
  "agentCard.modelsLoading":
    "モデルを読み込み中… 読み込みが終わると保存できます。",
  "agentCard.modelsFailed":
    "モデルを読み込めなかったため、保存できません: {reason}",

  "agent.releases.modelRefused":
    "接続 {connection} はカードのモデル {card} を提供していないため、リリースは作成されませんでした。このモデルを提供する接続を選ぶか、モデルを変更してください。",

  "agent.modelRemoved.title":
    "モデル {model} が接続 {connection} のモデル一覧から外れました",
  "agent.modelRemoved.text":
    "このエージェントでは新しいセッションを開始できず、このモデルで実行中のセッションは止まります。インストールの owner にモデルを接続のモデル一覧へ戻すよう依頼するか、詳細設定タブでモデルを接続が提供するものに変更して保存してください。",
  "agent.modelMoves.title":
    "モデル {model} が接続 {connection} のモデル一覧から外れたため、{successor} に切り替えて実行されます",
  "agent.modelMoves.text":
    "新しいセッションは {successor} で開始し、ターンを待っているセッションは次のターンから {successor} に切り替わります。エージェントのリリースも {successor} で新しく作られます。実行中のターンは {model} へのリクエストがブロックされて止まります。",
  "agent.modelMoves.offTitle":
    "モデル {model} が接続 {connection} のモデル一覧から外れ、自動切り替えがオフのため止まっています",
  "agent.modelMoves.offText":
    "{successor} に切り替えられますが、このエージェントは自動切り替えをオフにしているため新しいセッションも開始されません。自動切り替えをオンにするか、詳細設定タブでモデルを変更して保存してください。",
  "agent.modelMoves.turnOn": "自動切り替えをオンにする",
  "agent.modelMoves.turnOff": "自動切り替えをオフにする",
  "agent.modelMoves.failedTitle":
    "モデル {model} を {successor} に自動で切り替えられませんでした",
  "agent.modelMoves.failedText":
    "理由: {reason}。最後の試行 {at}。{minutes} 分ごとに再試行します。",
  "agent.modelMoves.failedActorInactive":
    "自動切り替えは、このエージェントを最後に有効化した人の名前で実行されます。その人はもうオーナーでもアドミンでもありません。オーナーかアドミンが詳細設定タブでモデルを {successor} に変更して保存してください。",
  "agent.modelMoves.failedCredential":
    "認証情報を接続してから、詳細設定タブでモデルを {successor} に変更して保存してください。",
  "agent.modelMoves.failedOther":
    "詳細設定タブでモデルを {successor} に変更して保存してみてください。同じ理由で止まる場合は、保存結果に理由が表示されます。",

  "agentCard.judgmentModel": "判断モデル",
  "agentCard.judgmentModelCard": "カードのモデルを使う ({model})",
  "agentCard.judgmentModelCardUnset": "カードのモデルを使う",
  "agentCard.judgmentModelHint":
    "チャンネルの投稿に加わるかを判断し、チャンネルの要約をまとめるときに使うモデルです。選んだ接続が提供するモデルから選び、空のままならカードのモデルを使います。成果判定の判定モデルとは別です。",
  "agentCard.judgmentModelUncatalogedWarning":
    "この判断モデルは接続のモデル一覧にないため、判断は実行されません。このカードではリリースを作れないので、接続が提供するモデルかカードのモデルに変更してください。",
  "agent.releases.judgmentModelRefused":
    "接続 {connection} は判断モデル {model} を提供していないため、リリースは作成されませんでした。この接続のモデルを選ぶか、カードのモデルを使ってください。",
  "agent.releases.field.judgmentModel": "判断モデル",
  "agent.save.reason.judgment_model_not_in_connection":
    "接続が提供していない判断モデルです",
};
