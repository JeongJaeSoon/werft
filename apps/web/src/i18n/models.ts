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

  "agent.releases.profileOptionMismatch": "{profile} · 카드 모델과 다름",
  "agent.releases.modelRefused":
    "카드 모델 {card}이(가) 프로필 {profile}에서 실행되지 않아 릴리스를 만들지 못했습니다. 카드 모델을 실행하는 프로필을 고르세요.",
  "agent.releases.profileBlocked":
    "운영자가 프로필 {profile}을(를) 차단했습니다. 차단이 풀릴 때까지 이 프로필로는 릴리스를 만들거나 활성화할 수 없습니다.",
  "agent.releases.baseProfileBlocked":
    "운영자가 프로필 {profile}의 바탕 프로필을 차단했습니다. 차단이 풀릴 때까지 이 프로필로는 릴리스를 만들거나 활성화할 수 없습니다.",

  "agent.modelRemoved.title":
    "모델 {model}이(가) 프로필 {profile}의 허용 목록에서 빠졌습니다",
  "agent.modelRemoved.text":
    "이 에이전트로는 새 세션이 시작되지 않고, 이 모델로 실행 중인 세션은 멈춥니다. 프로필 관리자에게 모델을 허용 목록에 되돌려 달라고 요청하거나, 상세 설정 탭에서 모델을 허용된 모델로 바꿔 저장하세요.",
  "agent.modelMoves.title":
    "모델 {model}이(가) 프로필 {profile}의 허용 목록에서 빠져 {successor}(으)로 옮겨 실행됩니다",
  "agent.modelMoves.text":
    "새 세션은 {successor}(으)로 시작하고, 기다리던 세션은 다음 턴부터 {successor}(으)로 옮겨 갑니다. 실행 중인 턴은 {model} 요청이 막혀 멈춥니다. 릴리스 카드에는 아직 {model}이(가) 적혀 있으니 상세 설정 탭에서 모델을 바꿔 저장해 두세요.",
  "profiles.detail.agents.modelRemovedTitle":
    "허용 목록에서 빠진 모델을 쓰는 에이전트가 {count}개 있습니다",
  "profiles.detail.agents.modelRemovedText":
    "이 에이전트들로는 새 세션이 시작되지 않고, 해당 모델로 실행 중인 세션은 멈춥니다. 모델을 프로필의 허용 목록에 되돌리거나, 각 에이전트의 상세 설정 탭에서 모델을 허용된 모델로 바꿔 저장하세요.",
  "profiles.detail.agents.modelRemovedRow":
    "모델 {model}이(가) 이 프로필에서 빠졌습니다",
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

  "agent.releases.profileOptionMismatch": "{profile} · not the card's model",
  "agent.releases.modelRefused":
    "Profile {profile} does not run the card's model {card}, so no release was created. Choose a profile that runs the card's model.",
  "agent.releases.profileBlocked":
    "The operator blocked the profile {profile}. Until it is unblocked, no release on it can be created or activated.",
  "agent.releases.baseProfileBlocked":
    "The operator blocked the profile that profile {profile} narrows. Until it is unblocked, no release on it can be created or activated.",

  "agent.modelRemoved.title":
    "Model {model} was taken off the allowed list of profile {profile}",
  "agent.modelRemoved.text":
    "This agent starts no new session, and sessions running this model stop. Ask the profile's administrator to put the model back on the list, or change the model to an allowed one in the Settings tab and save.",
  "agent.modelMoves.title":
    "Model {model} was taken off the allowed list of profile {profile}; it now runs on {successor}",
  "agent.modelMoves.text":
    "New sessions start on {successor}, and sessions waiting for a turn move to {successor} from their next turn. A turn already running is stopped when its {model} requests are blocked. The release card still names {model}: change the model in the Settings tab and save.",
  "profiles.detail.agents.modelRemovedTitle":
    "{count} agents run a model that is no longer on the allowed list",
  "profiles.detail.agents.modelRemovedText":
    "These agents start no new session, and sessions running that model stop. Put the model back on the profile's list, or change the model to an allowed one in each agent's Settings tab and save.",
  "profiles.detail.agents.modelRemovedRow":
    "Model {model} is no longer on this profile",
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

  "agent.releases.profileOptionMismatch": "{profile} · カードのモデルと不一致",
  "agent.releases.modelRefused":
    "プロファイル {profile} はカードのモデル {card} を実行しないため、リリースは作成されませんでした。カードのモデルを実行するプロファイルを選んでください。",
  "agent.releases.profileBlocked":
    "運用担当者がプロファイル {profile} をブロックしました。解除されるまで、このプロファイルのリリースは作成も有効化もできません。",
  "agent.releases.baseProfileBlocked":
    "運用担当者がプロファイル {profile} のもとになっているプロファイルをブロックしました。解除されるまで、このプロファイルのリリースは作成も有効化もできません。",

  "agent.modelRemoved.title":
    "モデル {model} がプロファイル {profile} の許可リストから外れました",
  "agent.modelRemoved.text":
    "このエージェントでは新しいセッションを開始できず、このモデルで実行中のセッションは止まります。プロファイルの管理者にモデルを許可リストへ戻すよう依頼するか、詳細設定タブでモデルを許可されたものに変更して保存してください。",
  "agent.modelMoves.title":
    "モデル {model} がプロファイル {profile} の許可リストから外れたため、{successor} に切り替えて実行されます",
  "agent.modelMoves.text":
    "新しいセッションは {successor} で開始し、ターンを待っているセッションは次のターンから {successor} に切り替わります。実行中のターンは {model} へのリクエストがブロックされて止まります。リリースのカードにはまだ {model} が書かれているので、詳細設定タブでモデルを変更して保存してください。",
  "profiles.detail.agents.modelRemovedTitle":
    "許可リストから外れたモデルを使うエージェントが {count} 件あります",
  "profiles.detail.agents.modelRemovedText":
    "これらのエージェントでは新しいセッションを開始できず、そのモデルで実行中のセッションは止まります。モデルをプロファイルの許可リストへ戻すか、各エージェントの詳細設定タブでモデルを許可されたものに変更して保存してください。",
  "profiles.detail.agents.modelRemovedRow":
    "モデル {model} はこのプロファイルから外れました",
};
