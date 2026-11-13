import {
  MutationCache,
  QueryCache,
  QueryClient,
  useIsMutating,
} from "@tanstack/react-query";
import { rootRouteId, useRouteContext } from "@tanstack/react-router";
import {
  type ApiClient,
  type ApiClientOptions,
  isApiError,
  type RetryTiming,
} from "@werft-ai/client";
import { useSyncExternalStore } from "react";
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
  /**
   * Leaves the app for another site (an identity provider's consent page).
   * `false` when the page stays where it is (the demo).
   */
  readonly leave: (url: string) => unknown;
  /** Whether the page is on its way to another site; see `useLeave`. */
  readonly leaving: Flag;
}

interface Flag {
  readonly get: () => boolean;
  readonly set: (next: boolean) => void;
  readonly subscribe: (follow: () => void) => () => void;
}

/**
 * A 401 from any query, or from any mutation not marked `meta.public` (login
 * and bootstrap answer 401 for a wrong password or token), means the session
 * is gone: cached data would keep showing the old identity otherwise.
 */
export function createServices(
  options: ApiClientOptions & {
    readonly leave?: (url: string) => unknown;
    readonly eventRetry?: RetryTiming;
  } = {},
): Services {
  const leaving = flag();
  // Back from the other site the browser restores the page as it was left
  // (bfcache), with this still set: being shown again lets go.
  window.addEventListener("pageshow", () => leaving.set(false));
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
    leaving,
  };
  return services;
}

export function useAppServices(): Services {
  return useRouteContext({ from: rootRouteId });
}

/** The key of every mutation whose answer is an address to leave for. */
export const LEAVING_KEY = ["leaving"] as const;

/**
 * Leaving for another site, and holding what starts that meanwhile: while a
 * start is out (a mutation under LEAVING_KEY) and once the page is on its
 * way. The page stays live until the other site answers, and a second start
 * in the gap would replace the flow the browser is already on its way to.
 * It is held for the app, not by a screen: one that is replaced and mounted
 * again (a step, a failed re-read) finds it as it is.
 */
export function useLeave(): readonly [
  held: boolean,
  leave: (url: string) => void,
] {
  const { leave, leaving } = useAppServices();
  const starting = useIsMutating({ mutationKey: LEAVING_KEY }) > 0;
  const left = useSyncExternalStore(leaving.subscribe, leaving.get);
  return [
    starting || left,
    (url) => {
      if (leave(url) !== false) leaving.set(true);
    },
  ];
}

/** A value screens follow that outlives any of them. */
function flag(): Flag {
  let on = false;
  const followers = new Set<() => void>();
  return {
    get: () => on,
    set: (next) => {
      if (on === next) return;
      on = next;
      for (const follow of followers) follow();
    },
    subscribe: (follow) => {
      followers.add(follow);
      return () => void followers.delete(follow);
    },
  };
}
