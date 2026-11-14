import { type EgressUpstream, judgeUpstreamOf } from "../catalog.ts";
import type { SettingsSnapshot } from "../installation-settings.ts";

/**
 * Where a workspace judge setting's `connection_id` leads: the Decisions API
 * upstream with the connection's credential, for the egress proxy to attach.
 * Null when the connection does not exist, is disabled, or is not of kind
 * `openai_decisions`; the judgment is then skipped (`judge_unavailable`).
 */
export interface JudgeConnections {
  upstream(connectionId: string): Promise<EgressUpstream | null>;
  /** The connections a judge setting may name now, by id. */
  ids(): Promise<readonly string[]>;
}

/** No connection resolves: for a process without installation settings. */
export const NO_JUDGE_CONNECTIONS: JudgeConnections = {
  upstream: async () => null,
  ids: async () => [],
};

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
    async ids() {
      await registry.refresh(0);
      return Object.keys(registry.settings?.judge_connections ?? {}).sort();
    },
  };
}
