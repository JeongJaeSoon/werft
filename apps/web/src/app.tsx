import { QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  type RouterHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { type RenderLink, WerftProvider } from "@werft-ai/react";
import { cn } from "@werft-ai/ui";
import { type ReactNode, useCallback, useState } from "react";
import { I18nProvider, type Locale, useI18n } from "./i18n/i18n.tsx";
import { createAppRouter } from "./router.tsx";
import { createServices, type Services } from "./services.tsx";

export interface AppProps {
  readonly services?: Services;
  readonly history?: RouterHistory;
  readonly locale?: Locale;
}

// The parts set their own underline; the colour defaults to the link colour.
const renderLink: RenderLink = ({
  to,
  id,
  children,
  className,
  title,
  "aria-label": label,
}) =>
  to === "agent" ? (
    <Link
      to="/agents/$id"
      params={{ id }}
      // A parent path counts as active by default; an agent link names no tab.
      activeOptions={{ exact: true }}
      className={cn("text-link", className)}
      title={title}
      aria-label={label}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/sessions/$id"
      params={{ id }}
      className={cn("text-link", className)}
      title={title}
      aria-label={label}
    >
      {children}
    </Link>
  );

function Platform({
  services,
  children,
}: {
  readonly services: Services;
  readonly children: ReactNode;
}) {
  const { locale } = useI18n();
  // Read at call time: App sets services.onUnauthorized once its router exists.
  const onUnauthorized = useCallback(
    () => services.onUnauthorized(),
    [services],
  );
  return (
    <WerftProvider
      client={services.client}
      locale={locale}
      renderLink={renderLink}
      onUnauthorized={onUnauthorized}
      {...(services.eventRetry ? { eventRetry: services.eventRetry } : {})}
    >
      {children}
    </WerftProvider>
  );
}

export function App({ services: given, history, locale }: AppProps) {
  const [services] = useState(() => given ?? createServices());
  const [router] = useState(() => {
    const created = createAppRouter(services, history);
    services.onUnauthorized = () => {
      const { pathname, href } = created.state.location;
      if (pathname === "/login" || pathname === "/bootstrap") return;
      services.queryClient.clear();
      void created.navigate({ to: "/login", search: { redirect: href } });
    };
    return created;
  });
  return (
    <I18nProvider {...(locale ? { locale } : {})}>
      <QueryClientProvider client={services.queryClient}>
        <Platform services={services}>
          <RouterProvider router={router} />
        </Platform>
      </QueryClientProvider>
    </I18nProvider>
  );
}
