import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApiClient } from "@werft-ai/client";
import { meQuery } from "@werft-ai/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultMessages,
  LOCALES,
  sessionsEn,
  sessionsJa,
  sessionsKo,
  useMe,
  useWerft,
  WerftProvider,
  type WerftProviderProps,
} from "./index.ts";

// A server render reads the cache and the context without a DOM; requests
// are the core's to make and are pinned there.

const client = {} as ApiClient;

function render(
  node: ReactNode,
  props: Partial<WerftProviderProps> = {},
  queryClient = new QueryClient(),
) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <WerftProvider
        client={client}
        locale="ko"
        renderLink={({ to, id, children }) => (
          <a href={`/${to}/${id}`}>{children}</a>
        )}
        {...props}
      >
        {node}
      </WerftProvider>
    </QueryClientProvider>,
  );
}

function Message({ name }: { name: keyof typeof sessionsKo }) {
  return <>{useWerft().messages[name]}</>;
}

describe("WerftProvider", () => {
  test("hands the hooks the client it was given", () => {
    let seen: ApiClient | undefined;
    function Probe() {
      seen = useWerft().client;
      return null;
    }
    render(<Probe />);
    expect(seen).toBe(client);
  });

  test("the locale picks the default messages", () => {
    expect(render(<Message name="sessions.title" />)).toBe(
      sessionsKo["sessions.title"],
    );
    expect(render(<Message name="sessions.title" />, { locale: "en" })).toBe(
      sessionsEn["sessions.title"],
    );
    expect(render(<Message name="sessions.title" />, { locale: "ja" })).toBe(
      sessionsJa["sessions.title"],
    );
  });

  test("messages replace the defaults key by key", () => {
    const html = render(
      <>
        <Message name="sessions.status.needs_input" />|
        <Message name="sessions.status.running" />
      </>,
      { messages: { "sessions.status.needs_input": "확인이 필요해요" } },
    );
    expect(html).toBe(
      `확인이 필요해요|${sessionsKo["sessions.status.running"]}`,
    );
  });

  test("links are drawn by the host's renderLink", () => {
    function SessionLink() {
      const { renderLink } = useWerft();
      return renderLink({ to: "session", id: "s-1", children: "열기" });
    }
    expect(render(<SessionLink />)).toBe('<a href="/session/s-1">열기</a>');
  });

  test("a hook outside the provider says so", () => {
    function Probe() {
      useWerft();
      return null;
    }
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(
      "useWerft outside WerftProvider",
    );
  });

  test("every locale carries the same keys, none of them blank", () => {
    const keys = Object.keys(defaultMessages.ko).sort();
    for (const locale of LOCALES) {
      const messages = defaultMessages[locale];
      expect(Object.keys(messages).sort()).toEqual(keys);
      for (const key of keys) {
        expect(messages[key as keyof typeof messages].trim()).not.toBe("");
      }
    }
  });
});

describe("useMe", () => {
  test("reads the principal under the core's me key", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(meQuery(client).queryKey, {
      user: { display_name: "Ada" },
    } as never);
    function Name() {
      return <>{useMe().data?.user?.display_name}</>;
    }
    expect(render(<Name />, {}, queryClient)).toBe("Ada");
  });
});
