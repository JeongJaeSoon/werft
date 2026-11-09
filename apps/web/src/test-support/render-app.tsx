import type { Locale } from "@werft-ai/react";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import type { fakeApi as FakeApi } from "./fake-api.ts";

export type Routes = Parameters<typeof FakeApi>[0];

export const WAITING_SESSIONS = "GET /v1/sessions?status=needs_input";

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
    const api = fakeApi({ ...nothingWaiting, ...routes });
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
