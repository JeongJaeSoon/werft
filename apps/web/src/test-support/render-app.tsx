import type { Locale } from "@werft-ai/react";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import type { fakeApi as FakeApi } from "./fake-api.ts";

export type Routes = Parameters<typeof FakeApi>[0];

export const WAITING_SESSIONS = "GET /v1/sessions?status=needs_input";

const ME_ROUTE = "GET /v1/auth/me";

/**
 * The fixture account's saved language is `ko`, the harness's default. A
 * console started in another language reads the account as having saved that
 * one, or the saved ko would win when the console opens. A fixture that saved
 * another language, or none, is left as it is.
 */
function savedAs(locale: Locale, route: Routes[string]): Routes[string] {
  return async (request, ...rest) => {
    const response = await route(request, ...rest);
    if (!response.ok) return response;
    const body = (await response.clone().json()) as {
      user?: { locale?: unknown };
    };
    if (body.user?.locale !== "ko") return response;
    return new Response(
      JSON.stringify({ ...body, user: { ...body.user, locale } }),
      { status: response.status, headers: response.headers },
    );
  };
}

/** Back from another site: the browser restores the page as it was left. */
export function comeBack(): void {
  const shown = new Event("pageshow");
  Object.defineProperty(shown, "persisted", { value: true });
  window.dispatchEvent(shown);
}

/**
 * The whole app at a path against a fake API. Call once per test file, at
 * the top level: the DOM has to exist before the router and Testing Library
 * load, so they are imported here, after setupDom.
 */
export async function appHarness() {
  const testing = await setupDom();
  const { createMemoryHistory } = await import("@tanstack/react-router");
  const { App } = await import("../app.tsx");
  const { createServices } = await import("../services.tsx");
  const { fakeApi, json } = await import("./fake-api.ts");
  const nothingWaiting: Routes = {
    [WAITING_SESSIONS]: () => json(200, { items: [], next_cursor: null }),
  };

  // `null` leaves the language to the app: stored choice, then the browser.
  function renderAt(
    path: string,
    routes: Routes,
    locale: Locale | null = "ko",
    validate: "strict" | "warn" = "strict",
  ) {
    const api = fakeApi({
      ...nothingWaiting,
      ...routes,
      ...(locale && locale !== "ko" && routes[ME_ROUTE]
        ? { [ME_ROUTE]: savedAs(locale, routes[ME_ROUTE]) }
        : {}),
    });
    const left: string[] = [];
    const services = createServices({
      baseUrl: "https://console.test",
      fetch: api.fetch,
      // Every fake answer is held to the contract; production only warns.
      validate,
      eventRetry: { initialMs: 1, maxMs: 4 },
      leave: (url) => left.push(url),
    });
    const history = createMemoryHistory({ initialEntries: [path] });
    const { container } = testing.render(
      <App
        services={services}
        history={history}
        {...(locale ? { locale } : {})}
      />,
    );
    return { api, history, services, container, left };
  }

  // Testing Library's own `screen` is bound to the document that existed when
  // it was first imported, which in a multi-file run is an earlier file's.
  // These queries look the body up on every call instead.
  const screen = new Proxy(testing.screen, {
    get: (_target, key) => Reflect.get(testing.within(document.body), key),
  });
  return { ...testing, screen, renderAt };
}
