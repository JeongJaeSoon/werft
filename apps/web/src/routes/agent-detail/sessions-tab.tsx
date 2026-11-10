import { AgentRecentSessions } from "./overview.tsx";

export function SessionsTab({ agentId }: { readonly agentId: string }) {
  return <AgentRecentSessions agentId={agentId} />;
}
