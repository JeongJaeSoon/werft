// The agent detail's Access tab: the MCP server, tools and credential names an
// agent is set up with. They are agent settings, not part of a release.
export const agentAccessKo = {
  "agent.tabs.access": "접근",
  "agentAccess.mcp.title": "MCP 서버와 도구",
  "agentAccess.intro":
    "MCP 서버와 자격 증명은 에이전트 설정입니다. 바꿔도 릴리스는 만들어지지 않고, 변경은 릴리스 탭의 '접근 변경'에 남습니다. 실행 중인 세션에는 좁히는 변경만 바로 적용됩니다.",
  "agentAccess.fromRelease":
    "저장된 설정이 없어 활성 릴리스의 값을 보여줍니다. 저장하면 이 값부터 에이전트 설정이 됩니다.",
  "agentAccess.noRelease":
    "저장된 설정도 활성 릴리스도 없습니다. 값을 정하고 저장하면 에이전트 설정이 됩니다.",
  "agentAccess.server": "MCP 서버",
  "agentAccess.serverNone": "서버 없음",
  "agentAccess.serverGone": "{server} (목록에 없음)",
  "agentAccess.serverChangeClears":
    "서버를 바꾸면 허용할 도구가 비워집니다. 도구 이름은 서버별이기 때문입니다.",
  "agentAccess.tools": "허용할 도구",
  "agentAccess.remove": "빼기",
  "agentAccess.toolsHint":
    "이름은 mcp__서버__도구 형식입니다. 서버를 고르면 입력할 수 있습니다.",
  "agentAccess.toolsEmpty": "허용한 도구가 없습니다.",
  "agentAccess.toolsList": "허용한 도구",
  "agentAccess.toolInput": "도구 이름",
  "agentAccess.toolPlaceholder": "mcp__서버__도구",
  "agentAccess.toolAdd": "도구 추가",
  "agentAccess.toolRemove": "{name} 빼기",
  "agentAccess.toolInvalid":
    "mcp__서버__도구 형식이 아닙니다. 128자 이하, 공백과 제어 문자가 없어야 합니다.",
  "agentAccess.toolOutside": "고른 서버({server})의 도구가 아닙니다.",
  "agentAccess.toolDuplicate": "이미 있는 이름입니다.",
  "agentAccess.creds": "필요한 자격 증명 이름",
  "agentAccess.credsHint":
    "값이 아니라 이름입니다. 값은 아래 '자격 증명 연결'에서 에이전트에 연결합니다.",
  "agentAccess.credsEmpty": "필요한 자격 증명 이름이 없습니다.",
  "agentAccess.credsList": "필요한 자격 증명",
  "agentAccess.credInput": "자격 증명 이름",
  "agentAccess.credPlaceholder": "docs-key",
  "agentAccess.credAdd": "이름 추가",
  "agentAccess.credRemove": "{name} 빼기",
  "agentAccess.credInvalid":
    "이름 형식이 아닙니다. 소문자나 숫자로 시작하고, 소문자, 숫자, . _ : / - 만 쓸 수 있습니다.",
  "agentAccess.credDuplicate": "이미 있는 이름입니다.",
  "agentAccess.credFull": "이름은 32개까지 적을 수 있습니다.",
  "agentAccess.bound": "연결됨",
  "agentAccess.unbound": "연결 안 됨",
  "agentAccess.pending.title": "저장하지 않은 변경이 있습니다",
  "agentAccess.pending.firstTitle": "에이전트 설정으로 저장하지 않았습니다",
  "agentAccess.pending.body":
    "저장하면 릴리스 없이 바로 에이전트 설정이 바뀝니다. 새 세션은 이 값을 읽습니다.",
  "agentAccess.pending.save": "저장",
  "agentAccess.pending.saving": "저장하는 중",
  "agentAccess.pending.revert": "되돌리기",
  "agentAccess.pending.reload": "다시 읽기",
  "agentAccess.saved":
    "MCP 설정을 저장했습니다. 릴리스는 만들어지지 않았습니다.",
  "agentAccess.savedUnchanged": "이미 같은 값이 저장되어 있습니다.",
  "agentAccess.stale":
    "그 사이 다른 곳에서 설정이 바뀌었습니다. 다시 읽은 뒤 고쳐 주세요.",
  "agentAccess.conflict":
    "다른 곳에서 먼저 저장했습니다. 다시 읽은 값에서 고쳐 저장해 주세요.",
  "agentAccess.saveRefused": "저장하지 못했습니다. {reason}",
  "agentAccess.refused.server_unknown":
    "이 작업 공간에서 쓸 수 있는 MCP 서버가 아닙니다.",
  "agentAccess.refused.server_builtin":
    "내장 GitHub 서버는 GitHub 탭의 설정을 따릅니다. 여기서 고를 수 없습니다.",
  "agentAccess.refused.server_required":
    "도구를 허용하려면 먼저 MCP 서버를 골라야 합니다.",
  "agentAccess.refused.tool_outside_server":
    "고른 서버의 도구가 아닌 이름이 있습니다.",
  "agentAccess.refused.server_credential_missing":
    "이 서버가 쓰는 자격 증명 이름이 필요한 자격 증명 이름에 없습니다.",
  "agentAccess.refused.mcp_tool_denied":
    "활성 릴리스의 프로필이 막은 도구는 새로 허용할 수 없습니다.",
  "agentAccess.refused.duplicate": "같은 이름이 두 번 들어 있습니다.",
  "agentAccess.refused.other": "요청이 거절되었습니다.",
  "agentAccess.readOnly": "에이전트 관리자만 고칠 수 있습니다.",
  "agentAccess.activity.mcp": "MCP 설정 저장",
  "agentAccess.activity.summary":
    "서버 {server} · 도구 {tools} · 자격 증명 {refs}",
  "agentAccess.activity.before": "이전",
  "agentAccess.activity.after": "이후",
  "agentAccess.activity.none": "없음",
  "agentAccess.activity.first": "처음 저장",
} as const;

export const agentAccessEn: Record<keyof typeof agentAccessKo, string> = {
  "agent.tabs.access": "Access",
  "agentAccess.mcp.title": "MCP server and tools",
  "agentAccess.intro":
    "MCP servers and credentials are agent settings. Changing them does not create a release; the change appears as an 'Access change' in the Releases tab. For running sessions, only changes that narrow access apply at once.",
  "agentAccess.fromRelease":
    "No settings are saved, so the active release's values are shown. Saving makes them the agent's settings.",
  "agentAccess.noRelease":
    "There are no saved settings and no active release. Choose the values and save to create the agent's settings.",
  "agentAccess.server": "MCP server",
  "agentAccess.serverNone": "No server",
  "agentAccess.serverGone": "{server} (not in the list)",
  "agentAccess.serverChangeClears":
    "Changing the server clears the allowed tools, because tool names belong to a server.",
  "agentAccess.tools": "Allowed tools",
  "agentAccess.remove": "Remove",
  "agentAccess.toolsHint":
    "Names look like mcp__server__tool. Choose a server to add tools.",
  "agentAccess.toolsEmpty": "No tools are allowed.",
  "agentAccess.toolsList": "Allowed tools",
  "agentAccess.toolInput": "Tool name",
  "agentAccess.toolPlaceholder": "mcp__server__tool",
  "agentAccess.toolAdd": "Add tool",
  "agentAccess.toolRemove": "Remove {name}",
  "agentAccess.toolInvalid":
    "Not an mcp__server__tool name. At most 128 characters, with no spaces or control characters.",
  "agentAccess.toolOutside": "Not a tool of the chosen server ({server}).",
  "agentAccess.toolDuplicate": "That name is already listed.",
  "agentAccess.creds": "Credential names needed",
  "agentAccess.credsHint":
    "These are names, not values. Connect the values to the agent under 'Credential connections' below.",
  "agentAccess.credsEmpty": "No credential names are needed.",
  "agentAccess.credsList": "Credentials needed",
  "agentAccess.credInput": "Credential name",
  "agentAccess.credPlaceholder": "docs-key",
  "agentAccess.credAdd": "Add name",
  "agentAccess.credRemove": "Remove {name}",
  "agentAccess.credInvalid":
    "Not a valid name. Start with a lowercase letter or digit; only lowercase letters, digits and . _ : / - are allowed.",
  "agentAccess.credDuplicate": "That name is already listed.",
  "agentAccess.credFull": "At most 32 names can be listed.",
  "agentAccess.bound": "Connected",
  "agentAccess.unbound": "Not connected",
  "agentAccess.pending.title": "You have unsaved changes",
  "agentAccess.pending.firstTitle": "Not yet saved as agent settings",
  "agentAccess.pending.body":
    "Saving changes the agent's settings at once, without a release. New sessions read these values.",
  "agentAccess.pending.save": "Save",
  "agentAccess.pending.saving": "Saving",
  "agentAccess.pending.revert": "Revert",
  "agentAccess.pending.reload": "Reload",
  "agentAccess.saved": "MCP settings saved. No release was created.",
  "agentAccess.savedUnchanged": "The same values were already saved.",
  "agentAccess.stale":
    "The settings changed elsewhere in the meantime. Reload, then edit again.",
  "agentAccess.conflict":
    "Someone saved first. Edit again from the reloaded values and save.",
  "agentAccess.saveRefused": "Could not save. {reason}",
  "agentAccess.refused.server_unknown":
    "That is not an MCP server this workspace can use.",
  "agentAccess.refused.server_builtin":
    "The built-in GitHub server follows the GitHub tab's settings. It cannot be chosen here.",
  "agentAccess.refused.server_required":
    "Choose an MCP server before allowing tools.",
  "agentAccess.refused.tool_outside_server":
    "A name is not a tool of the chosen server.",
  "agentAccess.refused.server_credential_missing":
    "The credential name this server uses is not among the credential names needed.",
  "agentAccess.refused.mcp_tool_denied":
    "A tool the active release's profile blocks cannot be newly allowed.",
  "agentAccess.refused.duplicate": "A name is listed twice.",
  "agentAccess.refused.other": "The request was refused.",
  "agentAccess.readOnly": "Only agent admins can edit these.",
  "agentAccess.activity.mcp": "MCP settings saved",
  "agentAccess.activity.summary":
    "Server {server} · tools {tools} · credentials {refs}",
  "agentAccess.activity.before": "Before",
  "agentAccess.activity.after": "After",
  "agentAccess.activity.none": "none",
  "agentAccess.activity.first": "First save",
};

export const agentAccessJa: Record<keyof typeof agentAccessKo, string> = {
  "agent.tabs.access": "アクセス",
  "agentAccess.mcp.title": "MCPサーバーとツール",
  "agentAccess.intro":
    "MCPサーバーと認証情報はエージェント設定です。変更してもリリースは作られず、変更はリリース履歴に「アクセス変更」として表示されます。実行中のセッションには、アクセスを狭める変更だけがすぐに反映されます。",
  "agentAccess.fromRelease":
    "保存された設定がないため、有効なリリースの値を表示しています。保存すると、この値がエージェント設定になります。",
  "agentAccess.noRelease":
    "保存された設定も有効なリリースもありません。値を決めて保存すると、エージェント設定になります。",
  "agentAccess.server": "MCPサーバー",
  "agentAccess.serverNone": "サーバーなし",
  "agentAccess.serverGone": "{server}（一覧にありません）",
  "agentAccess.serverChangeClears":
    "サーバーを変えると、許可するツールは空になります。ツール名はサーバーごとのためです。",
  "agentAccess.tools": "許可するツール",
  "agentAccess.remove": "外す",
  "agentAccess.toolsHint":
    "名前は mcp__サーバー__ツール の形式です。サーバーを選ぶと追加できます。",
  "agentAccess.toolsEmpty": "許可したツールはありません。",
  "agentAccess.toolsList": "許可したツール",
  "agentAccess.toolInput": "ツール名",
  "agentAccess.toolPlaceholder": "mcp__サーバー__ツール",
  "agentAccess.toolAdd": "ツールを追加",
  "agentAccess.toolRemove": "{name} を外す",
  "agentAccess.toolInvalid":
    "mcp__サーバー__ツール の形式ではありません。128文字以内で、空白と制御文字は使えません。",
  "agentAccess.toolOutside":
    "選んだサーバー（{server}）のツールではありません。",
  "agentAccess.toolDuplicate": "すでにある名前です。",
  "agentAccess.creds": "必要な認証情報の名前",
  "agentAccess.credsHint":
    "値ではなく名前です。値は下の「認証情報の接続」でエージェントに接続します。",
  "agentAccess.credsEmpty": "必要な認証情報の名前はありません。",
  "agentAccess.credsList": "必要な認証情報",
  "agentAccess.credInput": "認証情報の名前",
  "agentAccess.credPlaceholder": "docs-key",
  "agentAccess.credAdd": "名前を追加",
  "agentAccess.credRemove": "{name} を外す",
  "agentAccess.credInvalid":
    "名前の形式ではありません。小文字か数字で始め、小文字、数字、. _ : / - だけを使えます。",
  "agentAccess.credDuplicate": "すでにある名前です。",
  "agentAccess.credFull": "名前は32個まで書けます。",
  "agentAccess.bound": "接続済み",
  "agentAccess.unbound": "未接続",
  "agentAccess.pending.title": "保存していない変更があります",
  "agentAccess.pending.firstTitle": "エージェント設定として未保存です",
  "agentAccess.pending.body":
    "保存すると、リリースなしでエージェント設定がすぐに変わります。新しいセッションはこの値を読みます。",
  "agentAccess.pending.save": "保存",
  "agentAccess.pending.saving": "保存中",
  "agentAccess.pending.revert": "元に戻す",
  "agentAccess.pending.reload": "再読み込み",
  "agentAccess.saved": "MCP設定を保存しました。リリースは作られていません。",
  "agentAccess.savedUnchanged": "同じ値がすでに保存されています。",
  "agentAccess.stale":
    "その間に別の場所で設定が変わりました。再読み込みしてから直してください。",
  "agentAccess.conflict":
    "先に別の場所で保存されました。再読み込みした値から直して保存してください。",
  "agentAccess.saveRefused": "保存できませんでした。{reason}",
  "agentAccess.refused.server_unknown":
    "このワークスペースで使えるMCPサーバーではありません。",
  "agentAccess.refused.server_builtin":
    "組み込みのGitHubサーバーはGitHubタブの設定に従います。ここでは選べません。",
  "agentAccess.refused.server_required":
    "ツールを許可するには、先にMCPサーバーを選んでください。",
  "agentAccess.refused.tool_outside_server":
    "選んだサーバーのツールではない名前があります。",
  "agentAccess.refused.server_credential_missing":
    "このサーバーが使う認証情報の名前が、必要な認証情報の名前にありません。",
  "agentAccess.refused.mcp_tool_denied":
    "有効なリリースのプロファイルがブロックしているツールは、新たに許可できません。",
  "agentAccess.refused.duplicate": "同じ名前が2回入っています。",
  "agentAccess.refused.other": "リクエストが拒否されました。",
  "agentAccess.readOnly": "編集できるのはエージェント管理者だけです。",
  "agentAccess.activity.mcp": "MCP設定を保存",
  "agentAccess.activity.summary":
    "サーバー {server} · ツール {tools} · 認証情報 {refs}",
  "agentAccess.activity.before": "変更前",
  "agentAccess.activity.after": "変更後",
  "agentAccess.activity.none": "なし",
  "agentAccess.activity.first": "初回の保存",
};
