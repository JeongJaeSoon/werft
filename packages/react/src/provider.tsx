import { useQueryClient } from "@tanstack/react-query";
import type { ApiClient, RetryTiming } from "@werft-ai/client";
import {
  type QueryScope,
  queryScopeFilter,
  withQueryScope,
} from "@werft-ai/core";
// The foundations entry, not the root: the root loads every component with it.
import { AriaLocale } from "@werft-ai/ui/foundations";
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  defaultMessages,
  type Locale,
  type ModuleMessageKey,
  type ModuleMessages,
} from "./messages/index.ts";

/** A place a module links to; the host app turns it into its own URL. */
export type LinkTarget = {
  readonly to: "session" | "agent";
  readonly id: string;
};

export type RenderLink = (
  link: LinkTarget & {
    readonly children: ReactNode;
    // Set by a module's link; the host's anchor carries them as given.
    readonly className?: string;
    readonly title?: string;
    readonly "aria-label"?: string;
  },
) => ReactNode;

export interface WerftProviderProps {
  /** Made by the host app; the modules never build one. */
  readonly client: ApiClient;
  readonly locale: Locale;
  /** Replaces the default wording key by key. */
  readonly messages?: Partial<Record<ModuleMessageKey, string>>;
  readonly renderLink: RenderLink;
  /**
   * Called when a session event stream is refused for a missing login. Keep
   * it stable: a new function reopens every open stream.
   */
  readonly onUnauthorized?: () => void;
  /** Reconnect timing of session event streams; tests shorten it. */
  readonly eventRetry?: RetryTiming;
  readonly children: ReactNode;
}

export interface WerftContextValue {
  readonly client: ApiClient;
  readonly locale: Locale;
  /** The locale's default messages with the host's replacements applied. */
  readonly messages: ModuleMessages;
  readonly renderLink: RenderLink;
  readonly onUnauthorized?: () => void;
  readonly eventRetry?: RetryTiming;
}

const WerftContext = createContext<WerftContextValue | null>(null);

/**
 * What every hook and block of this package reads. It sits inside the host's
 * QueryClientProvider, which owns the cache.
 */
export function WerftProvider({
  client,
  locale,
  messages,
  renderLink,
  onUnauthorized,
  eventRetry,
  children,
}: WerftProviderProps) {
  const value = useMemo<WerftContextValue>(
    () => ({
      client,
      locale,
      messages: { ...defaultMessages[locale], ...messages },
      renderLink,
      ...(onUnauthorized ? { onUnauthorized } : {}),
      ...(eventRetry ? { eventRetry } : {}),
    }),
    [client, locale, messages, renderLink, onUnauthorized, eventRetry],
  );
  return (
    <WerftContext value={value}>
      <AriaLocale locale={locale}>{children}</AriaLocale>
    </WerftContext>
  );
}

/**
 * Gives the tree below a client whose queries are cached under `scope`, the
 * signed-in principal and its workspace. When the scope changes, the tree
 * mounts afresh, so no observer's kept data or component state carries the
 * previous scope over, and what the previous one cached is dropped.
 */
export function QueryScopeProvider({
  scope,
  children,
}: {
  readonly scope: QueryScope;
  readonly children: ReactNode;
}) {
  const parent = useWerft();
  const queryClient = useQueryClient();
  const { actor, workspace } = scope;
  const value = useMemo<WerftContextValue>(
    () => ({
      ...parent,
      client: withQueryScope(parent.client, { actor, workspace }),
    }),
    [parent, actor, workspace],
  );
  const previous = useRef<QueryScope | null>(null);
  useEffect(() => {
    const before = previous.current;
    if (before && (before.actor !== actor || before.workspace !== workspace)) {
      queryClient.removeQueries(queryScopeFilter(before));
    }
    previous.current = { actor, workspace };
  }, [queryClient, actor, workspace]);
  return (
    <WerftContext value={value}>
      <Fragment key={`${actor}\n${workspace}`}>{children}</Fragment>
    </WerftContext>
  );
}

export function useWerft(): WerftContextValue {
  const value = useContext(WerftContext);
  if (!value) throw new Error("useWerft outside WerftProvider");
  return value;
}
