export const engineSettingsKo = {
  "agent.tabs.engine": "실행 규칙",
  "engine.workspace.title": "실행 규칙",
  "engine.workspace.description":
    "이 워크스페이스의 모든 에이전트에 적용되는 도구 권한과 자동 모드 문장입니다. 막는 규칙(거부·확인·차단)은 에이전트 자신의 규칙에 더해지고, 허용하는 규칙(허용·환경)은 에이전트도 같은 항목을 허용할 때만 닿습니다.",
  "engine.agent.title": "실행 규칙",
  "engine.agent.description":
    "이 에이전트의 세션에만 적용되는 규칙입니다. 저장해도 릴리스는 만들어지지 않고, 이후 시작하는 세션부터 읽습니다. 실행 중인 세션은 좁히는 변경만 바로 반영합니다.",
  "engine.group.permissions": "도구 권한",
  "engine.group.auto_mode": "자동 모드",
  "engine.list.count": "{count} / {max}개",
  "engine.multiline":
    "이 목록에는 여러 줄로 된 항목이 있어 여기서 바꿀 수 없습니다. 바꾸려면 API를 쓰세요.",
  "engine.list.permissions.allow": "허용",
  "engine.list.permissions.ask": "확인",
  "engine.list.permissions.deny": "거부",
  "engine.list.auto_mode.allow": "허용 문장",
  "engine.list.auto_mode.soft_deny": "소프트 차단 문장",
  "engine.list.auto_mode.hard_deny": "하드 차단 문장",
  "engine.list.auto_mode.environment": "환경 문장",
  "engine.list.permissions.hint":
    "한 줄에 규칙 하나입니다. 예: Read, Bash(git status), mcp__서버__도구",
  "engine.list.auto_mode.hint":
    "한 줄에 문장 하나입니다. 분류기가 글로 읽으므로 형식 검사는 하지 않습니다.",
  "engine.save": "저장",
  "engine.saving": "저장하는 중",
  "engine.saved": "저장했습니다. 이후 시작하는 세션부터 적용됩니다.",
  "engine.unchanged": "바뀐 내용이 없습니다.",
  "engine.conflict":
    "다른 곳에서 먼저 저장했습니다. 최신 규칙을 불러온 뒤 다시 고쳐 주세요.",
  "engine.reload": "최신 규칙 불러오기",
  "engine.refused": "저장하지 못했습니다: {reason}",
  "engine.refusedRule": "{reason} 규칙: {rule}",
  "engine.refused.rule_syntax": "규칙 형식이 올바르지 않습니다.",
  "engine.refused.rule_no_effect": "엔진이 무시하는 규칙입니다.",
  "engine.refused.rule_too_long": "규칙이 너무 깁니다.",
  "engine.refused.too_many_rules": "규칙이 너무 많습니다.",
  "engine.refused.auto_mode_rule_syntax":
    "자동 모드 문장이 올바르지 않거나 길이·개수가 한도를 넘었습니다.",
  "engine.refused.mcp_rule_verdict": "MCP 규칙은 거부만 쓸 수 있습니다.",
  "engine.refused.settings_too_large": "규칙의 전체 크기가 한도를 넘습니다.",
  "engine.refused.engine_settings_catalog_ambiguous":
    "설치된 도구 목록마다 이 규칙을 다르게 읽습니다. 운영자에게 문의하세요.",
  "engine.refused.engine_settings_catalog_unavailable":
    "도구 목록이 없어 규칙을 검사할 수 없습니다. 운영자에게 문의하세요.",
  "engine.refused.other": "서버가 규칙을 받지 않았습니다.",
  "engine.workspaceRules.title": "워크스페이스 규칙",
  "engine.workspaceRules.hint":
    "워크스페이스 설정에서 바꿉니다. 이 에이전트에도 적용됩니다.",
  "engine.workspaceRules.empty": "워크스페이스 규칙이 없습니다.",
  "engine.reach.inactive":
    "워크스페이스는 {lists}을(를) 허용하지만 이 에이전트의 같은 목록이 비어 있어, 워크스페이스의 허용이 이 에이전트에 닿지 않습니다.",
  "engine.reach.withoutEffect":
    "아래 허용 항목은 워크스페이스가 같은 목록에서 허용하지 않아 효과가 없습니다.",
} as const;

export const engineSettingsEn: Record<keyof typeof engineSettingsKo, string> = {
  "agent.tabs.engine": "Run rules",
  "engine.workspace.title": "Run rules",
  "engine.workspace.description":
    "Tool permissions and auto mode sentences for every agent in this workspace. Restricting rules (deny, ask, block) add to an agent's own; granting rules (allow, environment) reach an agent only where it allows the same entry.",
  "engine.agent.title": "Run rules",
  "engine.agent.description":
    "Rules for this agent's sessions only. Saving makes no release; sessions that start afterwards read them. A running session takes only a change that narrows.",
  "engine.group.permissions": "Tool permissions",
  "engine.group.auto_mode": "Auto mode",
  "engine.list.count": "{count} of {max}",
  "engine.multiline":
    "This list has an entry that spans several lines, so it cannot be changed here. Use the API to change it.",
  "engine.list.permissions.allow": "Allow",
  "engine.list.permissions.ask": "Ask",
  "engine.list.permissions.deny": "Deny",
  "engine.list.auto_mode.allow": "Allow sentences",
  "engine.list.auto_mode.soft_deny": "Soft block sentences",
  "engine.list.auto_mode.hard_deny": "Hard block sentences",
  "engine.list.auto_mode.environment": "Environment sentences",
  "engine.list.permissions.hint":
    "One rule per line, e.g. Read, Bash(git status), mcp__server__tool",
  "engine.list.auto_mode.hint":
    "One sentence per line. The classifier reads them as prose, so their form is not checked.",
  "engine.save": "Save",
  "engine.saving": "Saving",
  "engine.saved": "Saved. Sessions that start from now on use it.",
  "engine.unchanged": "Nothing has changed.",
  "engine.conflict":
    "Someone saved first. Load the latest rules and edit them again.",
  "engine.reload": "Load latest rules",
  "engine.refused": "Not saved: {reason}",
  "engine.refusedRule": "{reason} Rule: {rule}",
  "engine.refused.rule_syntax": "The rule is not written correctly.",
  "engine.refused.rule_no_effect": "The engine would ignore this rule.",
  "engine.refused.rule_too_long": "The rule is too long.",
  "engine.refused.too_many_rules": "There are too many rules.",
  "engine.refused.auto_mode_rule_syntax":
    "An auto mode sentence is not valid, or one is too long or there are too many.",
  "engine.refused.mcp_rule_verdict": "An MCP rule can only deny.",
  "engine.refused.settings_too_large": "The rules together are too large.",
  "engine.refused.engine_settings_catalog_ambiguous":
    "The installed tool catalogs read this rule differently. Ask the operator.",
  "engine.refused.engine_settings_catalog_unavailable":
    "No tool catalog is installed, so the rules cannot be checked. Ask the operator.",
  "engine.refused.other": "The server did not accept the rules.",
  "engine.workspaceRules.title": "Workspace rules",
  "engine.workspaceRules.hint":
    "Change them in the workspace settings. They apply to this agent too.",
  "engine.workspaceRules.empty": "The workspace has no rules.",
  "engine.reach.inactive":
    "The workspace allows {lists}, but this agent's list of the same kind is empty, so the workspace's allow does not reach this agent.",
  "engine.reach.withoutEffect":
    "These allow entries have no effect because the workspace does not allow them in the same list.",
};

export const engineSettingsJa: Record<keyof typeof engineSettingsKo, string> = {
  "agent.tabs.engine": "実行ルール",
  "engine.workspace.title": "実行ルール",
  "engine.workspace.description":
    "このワークスペースのすべてのエージェントに適用するツール権限と自動モードの文です。制限するルール(拒否・確認・ブロック)はエージェント自身のルールに加わり、許可するルール(許可・環境)はエージェントも同じ項目を許可している場合だけ届きます。",
  "engine.agent.title": "実行ルール",
  "engine.agent.description":
    "このエージェントのセッションだけに適用するルールです。保存してもリリースは作られず、以降に始まるセッションから読みます。実行中のセッションには絞り込む変更だけがすぐ反映されます。",
  "engine.group.permissions": "ツール権限",
  "engine.group.auto_mode": "自動モード",
  "engine.list.count": "{count} / {max}件",
  "engine.multiline":
    "このリストには複数行にわたる項目があるため、ここでは変更できません。変更するには API を使ってください。",
  "engine.list.permissions.allow": "許可",
  "engine.list.permissions.ask": "確認",
  "engine.list.permissions.deny": "拒否",
  "engine.list.auto_mode.allow": "許可する文",
  "engine.list.auto_mode.soft_deny": "ソフトブロックの文",
  "engine.list.auto_mode.hard_deny": "ハードブロックの文",
  "engine.list.auto_mode.environment": "環境の文",
  "engine.list.permissions.hint":
    "1行に1ルールです。例: Read、Bash(git status)、mcp__サーバー__ツール",
  "engine.list.auto_mode.hint":
    "1行に1文です。分類器が文章として読むため、形式は検査しません。",
  "engine.save": "保存",
  "engine.saving": "保存中",
  "engine.saved": "保存しました。以降に始まるセッションから適用されます。",
  "engine.unchanged": "変更はありません。",
  "engine.conflict":
    "先に別の場所で保存されました。最新のルールを読み込んでから、もう一度編集してください。",
  "engine.reload": "最新のルールを読み込む",
  "engine.refused": "保存できませんでした: {reason}",
  "engine.refusedRule": "{reason} ルール: {rule}",
  "engine.refused.rule_syntax": "ルールの書式が正しくありません。",
  "engine.refused.rule_no_effect": "エンジンが無視するルールです。",
  "engine.refused.rule_too_long": "ルールが長すぎます。",
  "engine.refused.too_many_rules": "ルールが多すぎます。",
  "engine.refused.auto_mode_rule_syntax":
    "自動モードの文が正しくないか、長さまたは件数が上限を超えています。",
  "engine.refused.mcp_rule_verdict": "MCP ルールは拒否のみ使えます。",
  "engine.refused.settings_too_large":
    "ルール全体のサイズが上限を超えています。",
  "engine.refused.engine_settings_catalog_ambiguous":
    "インストールされたツール一覧ごとにこのルールの解釈が異なります。運営者に問い合わせてください。",
  "engine.refused.engine_settings_catalog_unavailable":
    "ツール一覧がないためルールを検査できません。運営者に問い合わせてください。",
  "engine.refused.other": "サーバーがルールを受け付けませんでした。",
  "engine.workspaceRules.title": "ワークスペースのルール",
  "engine.workspaceRules.hint":
    "ワークスペース設定で変更します。このエージェントにも適用されます。",
  "engine.workspaceRules.empty": "ワークスペースのルールはありません。",
  "engine.reach.inactive":
    "ワークスペースは{lists}を許可していますが、このエージェントの同じ一覧が空のため、ワークスペースの許可はこのエージェントに届きません。",
  "engine.reach.withoutEffect":
    "次の許可項目は、ワークスペースが同じ一覧で許可していないため効果がありません。",
};
