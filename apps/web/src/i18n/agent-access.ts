export const agentAccessKo = {
  "agent.tabs.access": "접근",
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
  "agentAccess.activity.mcp": "MCP設定を保存",
  "agentAccess.activity.summary":
    "サーバー {server} · ツール {tools} · 認証情報 {refs}",
  "agentAccess.activity.before": "変更前",
  "agentAccess.activity.after": "変更後",
  "agentAccess.activity.none": "なし",
  "agentAccess.activity.first": "初回の保存",
};
