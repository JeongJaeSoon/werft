import type { AgentRelease } from "@werft-ai/contracts";
import type { Translate } from "../../i18n/i18n.tsx";

/** What a rollback says it did: the release it runs now, settings kept. */
export function rolledBackText(
  t: Translate,
  input: { readonly release: string; readonly forward?: boolean },
): string {
  return [
    t(input.forward ? "agent.turnedOn" : "agent.rolledBack", {
      release: input.release,
    }),
    t("agent.rollback.settingsKept"),
  ].join(" ");
}

/** Whether moving the active release from `from` to `to` goes forward. */
export function movesForward(
  releases: readonly Pick<AgentRelease, "id" | "created_at">[],
  from: string | null,
  to: string,
): boolean {
  const at = (id: string | null) =>
    releases.find((release) => release.id === id)?.created_at;
  const before = at(from);
  const after = at(to);
  return before === undefined || (after !== undefined && after > before);
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
