import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
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
  /** Whether a flow at a login provider is being started; see `useLeave`. */
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
  // (bfcache), with this still set. The first show of a page is not that:
  // a start may already be out by then.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) leaving.set(false);
  });
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

/**
 * Leaving for a flow at a login provider, and holding what starts one
 * meanwhile: from the moment a start is sent until the page is shown again.
 * The API keeps one such flow per browser, so a second start would replace
 * the flow the browser is on its way to, and the first callback would be
 * refused. `leaveFor` owns a start from its request to the departure: it
 * takes the hold, asks for the address, leaves, and lets go when the request
 * fails or the page stays. The hold is the app's and lives outside the query
 * cache: a screen replaced and mounted again finds it as it is, and so does
 * a sign-in or sign-out that clears the cache while a start is still out.
 */
export function useLeave(): readonly [
  held: boolean,
  leaveFor: (address: () => Promise<string>) => Promise<void>,
] {
  const { leave, leaving } = useAppServices();
  const held = useSyncExternalStore(leaving.subscribe, leaving.get);
  return [
    held,
    async (address) => {
      // A second start before the buttons are drawn as held.
      if (leaving.get()) return;
      leaving.set(true);
      let stays = true;
      try {
        stays = leave(await address()) === false;
      } finally {
        if (stays) leaving.set(false);
      }
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
