import { SessionServiceError } from "../../access-control/index.ts";
import {
  type ConnectionNetwork,
  type EgressUpstream,
  judgeUpstreamOf,
} from "../../catalog/index.ts";
import type { SettingsSnapshot } from "../installation-settings.ts";

/**
 * Where a workspace judge setting's `connection_id` leads: the Decisions API
 * upstream with the connection's credential, for the egress proxy to attach.
 * Null when the connection does not exist, is disabled, or is not of kind
 * `openai_decisions`; the judgment is then skipped (`judge_unavailable`).
 */
export interface JudgeConnections {
  upstream(connectionId: string): Promise<EgressUpstream | null>;
  /** What the connection's endpoint was registered as, when it says. */
  network?(connectionId: string): ConnectionNetwork | undefined;
  /** The connections a judge setting may name now, by id. */
  ids(): Promise<readonly string[]>;
}

/**
 * Achievements need a decision model: with no enabled `openai_decisions`
 * connection, every achievement write is refused and nothing is judged,
 * `always` rules included. What is saved stays, read only.
 */
export async function requireDecisionModel(
  connections: Pick<JudgeConnections, "ids">,
): Promise<void> {
  if ((await connections.ids()).length > 0) return;
  throw new SessionServiceError(
    "DECISION_MODEL_REQUIRED",
    "Set up a decision model (an enabled openai_decisions connection) first",
  );
}

/**
 * The installation settings' `openai_decisions` connections. A judgment
 * reads the last snapshot, which the registry keeps current; a person
 * naming a connection reads again first, so one just added is found.
 */
export function settingsJudgeConnections(registry: {
  readonly settings: Pick<SettingsSnapshot, "judge_connections"> | null;
  refresh(maxAgeMs?: number): Promise<void>;
}): JudgeConnections {
  return {
    async upstream(connectionId) {
      const connections = registry.settings?.judge_connections ?? {};
      const connection = Object.hasOwn(connections, connectionId)
        ? connections[connectionId]
        : undefined;
      return connection === undefined ? null : judgeUpstreamOf(connection);
    },
    network(connectionId) {
      const connections = registry.settings?.judge_connections ?? {};
      return Object.hasOwn(connections, connectionId)
        ? connections[connectionId]?.network
        : undefined;
    },
    async ids() {
      await registry.refresh(0);
      return Object.keys(registry.settings?.judge_connections ?? {}).sort();
    },
  };
}
