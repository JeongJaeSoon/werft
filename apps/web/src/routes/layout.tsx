import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
  Link,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { ApiError, isApiError, unwrap } from "@werft-ai/client";
import { queryScopeOf, sessionQuery } from "@werft-ai/core";
import { QueryScopeProvider, useWerft } from "@werft-ai/react";
import { shortSessionId } from "@werft-ai/react/components";
import {
  Button,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  PageFrame,
  SkipLink,
  Text,
} from "@werft-ai/ui";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { agentQuery } from "../api/queries.ts";
import { useMe } from "../auth/guard.tsx";
import {
  AppSidebar,
  MANAGER_NAV_GROUP,
  type NavGroup,
  navItemFor,
  useNavGroups,
  useSettingsNavGroups,
} from "../components/app-sidebar.tsx";
import { FormError } from "../components/auth-page.tsx";
import { MAIN_CONTENT_ID, Main } from "../components/main.tsx";
import { SettingsLayout } from "../components/settings-nav.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { applyTheme, storedTheme } from "../components/theme.ts";
import {
  errorKey,
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  useI18n,
} from "../i18n/i18n.tsx";
import { useSavedLocale } from "../i18n/saved-locale.ts";

export function RootLayout() {
  const { t } = useI18n();
  const authed = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId === "/authed"),
  });
  useLayoutEffect(() => applyTheme(storedTheme()), []);
  useFocusOnPageChange();
  return (
    <div className="group/root flex min-h-dvh flex-col">
      <SkipLink href={`#${MAIN_CONTENT_ID}`}>
        {t("common.skipToContent")}
      </SkipLink>
      {/* On an AuthPage this spacer and the footer split the spare height,
          so the page sits in the middle of the viewport and, once taller,
          scrolls from its top. Other public screens keep to the top. Both
          grow from a 0px basis with no padding of their own: the root's
          height is indefinite, so a 0% basis would fall back to content. */}
      {authed ? null : (
        <div className="hidden grow basis-0 group-has-[>.auth-page]/root:block" />
      )}
      <Outlet />
      {authed ? null : (
        <footer className="mt-auto flex justify-end group-has-[>.auth-page]/root:grow group-has-[>.auth-page]/root:basis-0 group-has-[>.auth-page]/root:items-end">
          <div className="p-4">
            <LocaleSwitch />
          </div>
        </footer>
      )}
    </div>
  );
}

/**
 * A move to another page puts focus on its h1, or on <main> without one, so
 * the next Tab and a screen reader start there rather than at the document's
 * top. Not on the first load, not when only the search or hash changes, and
 * not when something else took focus while the page changed (a dialog, a
 * notice) or focus sits in a menu or dialog still open (back pressed from
 * the account menu). <main> itself counts as untaken: links whose menu
 * closes park focus there on the way.
 */
function useFocusOnPageChange() {
  const router = useRouter();
  const before = useRef<Element | null>(null);
  useEffect(() => {
    // The router follows a redirect with a replace while the first
    // navigation is still pending; the focus to compare against is the one
    // from before that first navigation. Any other move, such as a second
    // link followed while the first page loads, starts over. The app's own
    // replace navigations start from a page already shown, not mid-load.
    let pending = false;
    const offHistory = router.history.subscribe(({ action }) => {
      if (pending && action.type === "REPLACE") return;
      before.current = document.activeElement;
      pending = true;
    });
    const offResolved = router.subscribe("onResolved", () => {
      pending = false;
    });
    return () => {
      offHistory();
      offResolved();
    };
  }, [router]);
  // After the render the resolved path commits, not on the router's
  // onRendered: ShellMain swaps the page's frame in that render, which
  // remounts a title focused any earlier.
  const pathname = useRouterState({
    select: (state) => state.resolvedLocation?.pathname,
  });
  const shown = useRef(pathname);
  useEffect(() => {
    const last = shown.current;
    shown.current = pathname;
    if (last === undefined || last === pathname) return;
    const main = document.getElementById(MAIN_CONTENT_ID);
    const active = document.activeElement;
    const taken =
      active !== null &&
      active !== before.current &&
      active !== document.body &&
      active !== main &&
      active.isConnected;
    const open = active?.closest(
      '[role="menu"], [role="dialog"], [role="alertdialog"]',
    );
    if (taken || open || !main) return;
    const target = main.querySelector<HTMLElement>("h1") ?? main;
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    // The page's scroll stays where the router left it.
    target.focus({ preventScroll: true });
  }, [pathname]);
}

function LocaleSwitch() {
  const { t, locale, setLocale } = useI18n();
  return (
    <Field orientation="horizontal" className="w-auto gap-2">
      <FieldLabel>{t("common.language")}</FieldLabel>
      <NativeSelect
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {LOCALES.map((value) => (
          <NativeSelectOption key={value} value={value}>
            {LOCALE_NAMES[value]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

// The router opens these with a trailing slash too.
const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;
const AGENT_PATH = /^\/agents\/([^/]+)\/?$/;
const RAIL_PATH = /^\/(sessions(\/[^/]+)?|operations\/tools)?\/?$/;
const SETTINGS_PATH = /^\/settings(\/|$)/;

export function AuthedLayout() {
  const me = useMe();
  const scope = me ? queryScopeOf(me) : null;
  // Everything below caches under who is signed in; until that is known
  // there is nothing of theirs to show.
  if (!scope) return null;
  return (
    <QueryScopeProvider scope={scope}>
      <AuthedShell />
    </QueryScopeProvider>
  );
}

function AuthedShell() {
  const { t } = useI18n();
  const me = useMe();
  useSavedLocale();
  const groups = useNavGroups();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const sidebarId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const logout = useMutation<unknown, ApiError>({
    // A 401 means the session is already gone, which is what was asked.
    meta: { public: true },
    mutationFn: () =>
      unwrap(client.POST("/v1/auth/logout")).catch((error: unknown) => {
        if (!isApiError(error, "UNAUTHORIZED")) throw error;
      }),
    // Only once the server has dropped the session: on any other failure the
    // cookie still works, and saying "logged out" would be a lie.
    // Clear once the shell is gone: a shell still mounted refetches the
    // principal it reads into the emptied cache.
    onSuccess: async () => {
      await navigate({ to: "/login", search: { notice: "logged_out" } });
      queryClient.clear();
    },
  });

  return (
    // Header, sidebar, main in reading order: below md the open menu unfolds
    // under its button; from md on the grid puts the sidebar on the left.
    <div className="flex flex-1 flex-col md:grid md:grid-cols-[var(--werft-layout-sidebar-width)_minmax(0,1fr)] md:grid-rows-[auto_1fr]">
      <header className="flex min-h-[var(--werft-topbar-h)] items-center gap-3 border-b bg-surface px-4 md:col-start-2 md:row-start-1 md:px-6">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="md:hidden"
          aria-expanded={menuOpen}
          aria-controls={sidebarId}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? t("shell.closeMenu") : t("shell.openMenu")}
        </Button>
        <PageTrail
          groups={groups}
          fallback={me?.workspace?.name ?? t("common.appName")}
        />
      </header>
      <AppSidebar
        id={sidebarId}
        openBelowMd={menuOpen}
        groups={groups}
        onNavigate={() => {
          if (!menuOpen) return;
          setMenuOpen(false);
          // The followed link hides with the menu; focus lands on the page.
          document.getElementById(MAIN_CONTENT_ID)?.focus();
        }}
        logout={{ pending: logout.isPending, run: () => logout.mutate() }}
      />
      <ShellMain>
        {logout.error ? (
          <FormError>
            {t("common.logoutFailed")} {t(errorKey(logout.error.code))}
          </FormError>
        ) : null}
        <Outlet />
      </ShellMain>
    </div>
  );
}

function usePathname() {
  return useRouterState({ select: (state) => state.location.pathname });
}

/**
 * What a screen under a sidebar item is called after it, when it is not the
 * item's own list: a session by its title, an agent by its name (console v4
 * crumb). Read from the cache the screen fills, so the bar asks for nothing.
 */
function useLeafTitle(pathname: string): string | undefined {
  const { t } = useI18n();
  const { client } = useWerft();
  const sessionId = SESSION_PATH.exec(pathname)?.[1];
  const agentId = AGENT_PATH.exec(pathname)?.[1];
  const sessionRead = useQuery({
    ...sessionQuery(client, sessionId ?? ""),
    enabled: false,
  });
  const agentRead = useQuery({
    ...agentQuery(client, agentId === "new" ? "" : (agentId ?? "")),
    enabled: false,
  });
  // A refetch that failed keeps the old data; the screen has dropped it (a
  // share taken back, a deletion), so the bar drops it too.
  const session = sessionRead.isError ? undefined : sessionRead.data;
  const agent = agentRead.isError ? undefined : agentRead.data;
  // Until the screen has it, or when it failed, the bar names only the item:
  // no separator left hanging before an empty name.
  if (session && sessionId !== undefined) {
    // A server from before titles sends none, as the page head shows.
    return session.title || shortSessionId(sessionId);
  }
  if (agentId === "new") return t("agents.newTitle");
  return agent?.agent.name;
}

function PageTrail({
  groups,
  fallback,
}: {
  readonly groups: readonly NavGroup[];
  readonly fallback: string;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  // A settings page reads as its own name, not the one sidebar item.
  const settingsGroups = useSettingsNavGroups();
  const here = navItemFor(
    [...settingsGroups, ...groups, MANAGER_NAV_GROUP],
    pathname,
  );
  const leaf = useLeafTitle(pathname);
  if (!here) {
    return (
      <Text weight="medium" truncate>
        {fallback}
      </Text>
    );
  }
  // The same words as the sidebar item and the page title; a screen under an
  // item leads with the item, a link back to its list (console v4 `.crumbs`).
  return (
    // Named apart from a page's own breadcrumb under its title.
    <PageBreadcrumb label={t("shell.menuTrail")}>
      {leaf === undefined ? null : (
        <PageBreadcrumbLink asChild>
          {/* The list is above this page, not this page. */}
          <Link to={here.item.to} activeOptions={{ exact: true }}>
            {t(here.item.label)}
          </Link>
        </PageBreadcrumbLink>
      )}
      <PageBreadcrumbCurrent className="wrap-anywhere">
        {leaf ?? t(here.item.label)}
      </PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );
}

function ShellMain({ children }: { readonly children: ReactNode }) {
  // A rail runs to the screen's edge, so a screen that may open one frames
  // its own body (V4-RAIL); every other screen sits in the shared frame.
  // Read from the screen on show: switching the frame while the next one
  // loads would remount the leaving screen, which reads its queries again.
  const pathname = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  });
  const flush = RAIL_PATH.test(pathname);
  return (
    <Main className="web-shell__main flex w-full min-w-0 flex-col bg-surface md:col-start-2 md:row-start-2">
      {flush ? (
        <div
          data-slot="page-flush"
          className="flex w-full min-w-0 flex-1 flex-col"
        >
          {children}
        </div>
      ) : (
        <PageFrame className="flex-1">
          {SETTINGS_PATH.test(pathname) ? (
            <SettingsLayout>{children}</SettingsLayout>
          ) : (
            children
          )}
        </PageFrame>
      )}
    </Main>
  );
}

export function AuthedError({ error }: ErrorComponentProps) {
  const router = useRouter();
  if (isApiError(error, "FORBIDDEN")) {
    return (
      <Main className="mx-auto w-full max-w-md px-4 py-10">
        <StatusScreen kind="forbidden" />
      </Main>
    );
  }
  return (
    <Main className="mx-auto w-full max-w-md px-4 py-10">
      <StatusScreen
        kind="error"
        detail={
          error instanceof ApiError ? errorKey(error.code) : "error.UNKNOWN"
        }
        // reset() only clears the boundary; the failure is in beforeLoad,
        // which runs again only when the router reloads.
        onRetry={() => void router.invalidate()}
      />
    </Main>
  );
}
