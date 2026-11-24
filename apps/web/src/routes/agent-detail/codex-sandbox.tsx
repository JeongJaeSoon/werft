import { useQuery } from "@tanstack/react-query";
import type { AgentDetail } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { Alert, AlertDescription } from "@werft-ai/ui";
import { connectionsQuery } from "../../api/queries.ts";
import { useMe } from "../../auth/guard.tsx";
import { useI18n } from "../../i18n/i18n.tsx";

/**
 * One line for the agent's admins where the installation refuses Codex
 * workers (no Codex sandbox) and the agent runs on the Codex engine (its released or saved
 * card is on a Responses API connection): its sessions fail with
 * CODEX_SANDBOX_NOT_INSTALLED. Turning the agent on stays open, since the
 * chart's value can be turned on later.
 */
export function CodexSandboxAlert({
  detail,
}: {
  readonly detail: AgentDetail;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const disabled = useMe()?.codex_sandbox_missing === true;
  const connections = useQuery({
    ...connectionsQuery(client),
    enabled: disabled,
  });
  const { applied, draft } = detail.effective_behavior;
  const codex = [applied, draft].some(
    (behavior) =>
      behavior !== null &&
      connections.data?.items.find(
        (listed) => listed.id === behavior.connection_id,
      )?.kind === "openai_responses",
  );
  if (!disabled || !codex) return null;
  return (
    <Alert variant="amber" className="border-0" data-codex-sandbox="disabled">
      <AlertDescription>{t("agent.codexSandboxDisabled")}</AlertDescription>
    </Alert>
  );
}
