import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { LanguageSelect } from "fumadocs-ui/layouts/shared/slots/language-select";
import { Languages } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { isLocale, messages } from "@/lib/i18n";
import { baseOptions } from "@/lib/layout.shared";
import { appName } from "@/lib/shared";
import { source } from "@/lib/source";
import "../global.css";

interface Props {
  children: ReactNode;
  params: Promise<{ lang: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang } = await params;
  const { siteTitle, siteDescription } = messages[isLocale(lang) ? lang : "ko"];
  return {
    title: { template: `%s | ${appName}`, default: siteTitle },
    description: siteDescription,
    // No icon yet; without one the browser asks the Pages host root for /favicon.ico.
    icons: { icon: "data:," },
  };
}

export default async function Layout({ children, params }: Props) {
  const { lang } = await params;
  // A pre-i18n URL such as /sessions/start: the page only redirects.
  if (!isLocale(lang)) {
    return (
      <html lang="ko">
        <body>{children}</body>
      </html>
    );
  }

  const { nav, ...base } = baseOptions(lang);
  return (
    <html lang={lang} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider lang={lang}>
          <DocsLayout
            tree={source.getPageTree(lang)}
            {...base}
            // Both tabs stay visible in the header instead of a sidebar dropdown.
            tabMode="navbar"
            nav={{
              ...nav,
              mode: "top",
              // Below md the built-in selector sits in the sidebar only.
              children: (
                <LanguageSelect className="ms-auto md:hidden">
                  <Languages className="size-4.5 text-fd-muted-foreground" />
                </LanguageSelect>
              ),
            }}
          >
            {children}
          </DocsLayout>
        </Provider>
      </body>
    </html>
  );
}
