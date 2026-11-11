import { useQuery } from "@tanstack/react-query";
import type { ConnectionOption } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { NativeSelectOption } from "@werft-ai/ui";
import { connectionsQuery } from "../api/queries.ts";
import { useI18n } from "../i18n/i18n.tsx";

/** Whether a release of a card naming `model` may run on it, as the server checks. */
export const runsModel = (
  connection: ConnectionOption,
  model: string | undefined,
): boolean => model === undefined || connection.models.includes(model);

/** The listed model a session on a dropped `model` moves to, if any. */
export const successorOf = (
  connection: ConnectionOption,
  model: string,
): string | undefined =>
  connection.models.includes(model)
    ? undefined
    : connection.model_successors[model];

/** The installation's enabled connections, as `GET /v1/connections` lists them. */
export function useConnections(): readonly ConnectionOption[] | undefined {
  const { client } = useWerft();
  return useQuery(connectionsQuery(client)).data?.items;
}

/**
 * One option per connection: those that `fits` first. One that does not fit
 * is listed last, disabled, and says why, so a refused choice is never the
 * one picked.
 */
export function ConnectionOptions({
  connections,
  fits = () => true,
}: {
  readonly connections: readonly ConnectionOption[];
  readonly fits?: (connection: ConnectionOption) => boolean;
}) {
  const { t } = useI18n();
  const ordered = [...connections].sort(
    (a, b) => Number(!fits(a)) - Number(!fits(b)),
  );
  return ordered.map((connection) => {
    const named = t("agent.connection.option", {
      id: connection.id,
      kind: connection.kind,
    });
    return (
      <NativeSelectOption
        key={connection.id}
        value={connection.id}
        disabled={!fits(connection)}
      >
        {fits(connection)
          ? named
          : t("agent.connection.optionMismatch", { connection: named })}
      </NativeSelectOption>
    );
  });
}
