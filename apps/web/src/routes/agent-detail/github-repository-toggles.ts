import { useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import { useEffect, useRef, useState } from "react";
import { errorKey, type MessageKey, useI18n } from "../../i18n/i18n.tsx";
import { githubKey } from "./github-activity.ts";

/**
 * How the server finds the repository: by the `ref` a response gave, or, to
 * turn on one the catalog may not hold yet, by the App installation that
 * lists it.
 */
export type RepositoryTarget =
  | { readonly ref: string }
  | {
      readonly installation_id: number;
      readonly github_repository_id: number;
    };

const REFUSALS: Partial<Record<string, MessageKey>> = {
  not_installed: "github.repo.pickHint",
  no_author_app: "github.repo.pickNoApp",
  name_held: "github.repo.pickNameHeld",
};

/** Per agent and outside React, so a remount still queues behind a request in flight. */
const queues = new Map<string, Promise<void>>();

const without = <V>(
  held: Readonly<Record<string, V>>,
  key: string,
): Record<string, V> => {
  const { [key]: _gone, ...rest } = held;
  return rest;
};

/**
 * One request per switch, sent one after another for the whole agent: the
 * server keeps a single settings revision, so two in flight at once would
 * race for it. A click shows at once (`wanted`); it goes back to what the
 * server holds when the request is refused, with the reason in `errors`.
 * Each request carries the state the person asked for, never a flip of
 * whatever the server held when its turn came.
 */
export function useRepositoryToggles(agentId: string) {
  const { client } = useWerft();
  const cache = useQueryClient();
  const { t } = useI18n();
  const [wanted, setWanted] = useState<Readonly<Record<string, boolean>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(0);
  // The newest click per row: an older request finishing must not clear it.
  const newest = useRef(new Map<string, number>());
  const clicks = useRef(0);
  // Rows shown from a save whose re-read failed, until a re-read succeeds.
  const kept = useRef(new Set<string>());

  useEffect(() => {
    const own = JSON.stringify(githubKey(client, agentId));
    return cache.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      if (JSON.stringify(event.query.queryKey) !== own) return;
      if (kept.current.size === 0) return;
      const done = [...kept.current];
      kept.current.clear();
      setWanted((held) => done.reduce((rest, key) => without(rest, key), held));
    });
  }, [cache, client, agentId]);

  const refuse = (error: ApiError): string => {
    const reason = (error.details as { reason_code?: string } | null)
      ?.reason_code;
    const key = reason === undefined ? undefined : REFUSALS[reason];
    return t("agentGitHub.repositoryRefused", {
      reason: t(key ?? errorKey(error.code)),
    });
  };

  const toggle = (
    key: string,
    repository: RepositoryTarget,
    enabled: boolean,
  ) => {
    const click = ++clicks.current;
    newest.current.set(key, click);
    kept.current.delete(key);
    setWanted((held) => ({ ...held, [key]: enabled }));
    setErrors((held) => without(held, key));
    setPending((count) => count + 1);
    const queued = queues.get(agentId) ?? Promise.resolve();
    const next = queued.then(async () => {
      const latest = () => newest.current.get(key) === click;
      try {
        await unwrap(
          client.PUT("/v1/agents/{id}/github/repository-access", {
            params: { path: { id: agentId } },
            body: { repository, enabled },
          }),
        );
        // A failed re-read is the tab's own error, not this switch's.
        await cache.invalidateQueries({
          queryKey: githubKey(client, agentId),
        });
        // The save went through: while the re-read failed the cache still
        // holds the old value, so keep showing what was saved.
        const reread = cache.getQueryState(githubKey(client, agentId));
        if (latest()) {
          if (reread?.status === "error") kept.current.add(key);
          else setWanted((held) => without(held, key));
        }
      } catch (error) {
        const message = refuse(error as ApiError);
        if (latest()) {
          setWanted((held) => without(held, key));
          setErrors((held) => ({ ...held, [key]: message }));
        }
        await cache.invalidateQueries({
          queryKey: githubKey(client, agentId),
        });
      } finally {
        setPending((count) => count - 1);
      }
    });
    queues.set(agentId, next);
    // Leaving the screen must not drop the queue: the next mount of the tab
    // waits behind whatever is still in flight.
    void next.then(() => {
      if (queues.get(agentId) === next) queues.delete(agentId);
    });
  };

  return { wanted, errors, pending: pending > 0, toggle };
}
