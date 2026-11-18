// apps/web/src/components/kept-failure.ts holds the same hook for the web
// app, as this one is not exported; change both together.
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/**
 * The read's failure, kept while it reads again. A query with no data
 * forgets its error once it refetches, which would take the failure and its
 * retry, focus and all, off the screen until the answer. `key` names what
 * was read, so another one's failure never shows.
 */
export function useKeptFailure(
  query: Pick<UseQueryResult, "error" | "errorUpdatedAt" | "dataUpdatedAt">,
  key: string,
): unknown {
  const [failed, setFailed] = useState<{ key: string; error: unknown }>();
  useEffect(() => {
    if (query.error) setFailed({ key, error: query.error });
  }, [query.error, key]);
  if (query.error) return query.error;
  return failed?.key === key && query.errorUpdatedAt > query.dataUpdatedAt
    ? failed.error
    : null;
}
