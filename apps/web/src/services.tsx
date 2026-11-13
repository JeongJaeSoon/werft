import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { rootRouteId, useRouteContext } from "@tanstack/react-router";
import {
  type ApiClient,
  type ApiClientOptions,
  isApiError,
  type RetryTiming,
} from "@werft-ai/client";
import { useEffect, useState } from "react";
import { createApiClient } from "./api/client.ts";

/**
 * What the app builds once at start. The client and the cache reach screens
 * through WerftProvider and QueryClientProvider; the rest is the
 * app's own and rides on the router's context.
 */
export interface Services {
  readonly client: ApiClient;
  readonly queryClient: QueryClient;
  /** Reconnect timing of session event streams; tests shorten it. */
  readonly eventRetry?: RetryTiming;
  /** Set by the app once its router exists; a 401 anywhere calls it. */
  onUnauthorized: () => void;
  /** Leaves the app for another site (an identity provider's consent page). */
  readonly leave: (url: string) => void;
}

/**
 * A 401 from any query, or from any mutation not marked `meta.public` (login
 * and bootstrap answer 401 for a wrong password or token), means the session
 * is gone: cached data would keep showing the old identity otherwise.
 */
export function createServices(
  options: ApiClientOptions & {
    readonly leave?: (url: string) => void;
    readonly eventRetry?: RetryTiming;
  } = {},
): Services {
  const services: Services = {
    // A production answer outside the contract is logged, not thrown: the
    // screen keeps the value as it came.
    client: createApiClient({
      validate: import.meta.env.DEV ? "strict" : "warn",
      ...options,
    }),
    ...(options.eventRetry ? { eventRetry: options.eventRetry } : {}),
    queryClient: new QueryClient({
      queryCache: new QueryCache({
        onError: (error) => {
          if (isApiError(error, "UNAUTHORIZED")) services.onUnauthorized();
        },
      }),
      mutationCache: new MutationCache({
        onError: (error, _variables, _context, mutation) => {
          if (
            mutation.meta?.public !== true &&
            isApiError(error, "UNAUTHORIZED")
          )
            services.onUnauthorized();
        },
      }),
    }),
    onUnauthorized: () => {},
    leave: options.leave ?? ((url) => window.location.assign(url)),
  };
  return services;
}

export function useAppServices(): Services {
  return useRouteContext({ from: rootRouteId });
}

/**
 * Leaving for another site, and holding what started it meanwhile. The page
 * stays live until that site answers, and a second start in the gap would
 * replace the flow the browser is already on its way to. Back from there
 * restores this page as it was left (bfcache), so being shown again lets go.
 */
export function useLeave(): readonly [
  leaving: boolean,
  leave: (url: string) => void,
] {
  const { leave } = useAppServices();
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const shown = () => setLeaving(false);
    window.addEventListener("pageshow", shown);
    return () => window.removeEventListener("pageshow", shown);
  }, []);
  return [
    leaving,
    (url) => {
      setLeaving(true);
      leave(url);
    },
  ];
}
