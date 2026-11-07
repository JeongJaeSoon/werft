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
};
