import type { AgentRelease } from "@werft-ai/contracts";
import type { Translate } from "../../i18n/i18n.tsx";

/** What a rollback says it did: the release it runs now, settings kept. */
export function rolledBackText(
  t: Translate,
  input: { readonly release: string },
): string {
  return [
    t("agent.rolledBack", { release: input.release }),
    t("agent.rollback.settingsKept"),
  ].join(" ");
}

export interface RollbackPreview {
  /** The connection the release runs on. */
  readonly connection: string;
}

export function rollbackPreview(
  release: Pick<AgentRelease, "connection_id">,
): RollbackPreview {
  return { connection: release.connection_id };
}
