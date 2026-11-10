import { createMemoryHistory } from "@tanstack/react-router";
import type { Locale } from "@werft-ai/react";
import { useEffect, useState } from "react";
import { App } from "../../../web/src/app.tsx";
import { THEME_STORAGE_KEY } from "../../../web/src/components/theme.ts";
import { createServices } from "../../../web/src/services.tsx";
import { fakeApi } from "../../../web/src/test-support/fake-api.ts";

type Handler = (request: Request) => Response | Promise<Response>;

/** What the console asks for, by "METHOD /path" or "METHOD /path?query". */
export type ConsoleRoutes = Readonly<Record<string, Handler>>;

const ME = "GET /v1/auth/me";
// Long enough for the first answers to land on screen.
const REFRESH_AFTER_MS = 300;

/**
 * The signed-in account has saved the story's language, so the console
 * opens in it and sends no PATCH to save one.
 */
function savedAs(locale: Locale, route: Handler): Handler {
  return async (request) => {
    const response = await route(request);
    if (!response.ok) return response;
    const body = (await response.clone().json()) as {
      user?: Record<string, unknown>;
    };
    if (!body.user) return response;
    return new Response(
      JSON.stringify({ ...body, user: { ...body.user, locale } }),
      { status: response.status, headers: response.headers },
    );
  };
}

/**
 * apps/web's console itself, shell and router included, opened at `path`
 * against fake answers: a story shows the screen the app ships, not a copy
 * of its markup. Nothing leaves the page; a request no route names is 404.
 */
export function WebConsole({
  path,
  routes,
  locale,
  refresh = false,
}: {
  readonly path: string;
  /** A function for answers that change as they are read (a refresh that fails). */
  readonly routes: ConsoleRoutes | (() => ConsoleRoutes);
  readonly locale: Locale;
  /** Reads everything once more after the first answers, as a change would. */
  readonly refresh?: boolean;
}) {
  const [services] = useState(() => {
    // The console applies the theme it finds saved when its shell mounts;
    // the story's theme, already on <html>, is what it must find.
    try {
      localStorage.setItem(
        THEME_STORAGE_KEY,
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      );
    } catch {
      // Blocked storage: the console then follows the system theme.
    }
    const answers = typeof routes === "function" ? routes() : routes;
    const me = answers[ME];
    const api = fakeApi({
      // Nothing waits on the viewer: the shell's badge stays quiet.
      "GET /v1/sessions": () =>
        new Response(JSON.stringify({ items: [], next_cursor: null }), {
          headers: { "content-type": "application/json" },
        }),
      ...answers,
      ...(me ? { [ME]: savedAs(locale, me) } : {}),
    });
    return createServices({
      baseUrl: "https://storybook.invalid",
      fetch: api.fetch as unknown as typeof globalThis.fetch,
      leave: () => {},
    });
  });
  const [history] = useState(() =>
    createMemoryHistory({ initialEntries: [path] }),
  );
  useEffect(() => {
    if (!refresh) return;
    const timer = setTimeout(
      () => void services.queryClient.refetchQueries(),
      REFRESH_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [refresh, services]);
  return <App services={services} history={history} locale={locale} />;
}

/** The story's language, from the toolbar or the story's own globals. */
export function storyLocale(value: unknown): Locale {
  return value === "en" || value === "ja" ? value : "ko";
}
