import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteDocsLayout } from "@/components/docs-layout";
import { Provider } from "@/components/provider";
import { mapTagFolders } from "@/lib/api-sidebar";
import { isLocale, messages } from "@/lib/i18n";
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

  const tree = mapTagFolders(source.getPageTree(lang), lang, () => []);
  return (
    <html lang={lang} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider lang={lang}>
          <SiteDocsLayout lang={lang} tree={tree}>
            {children}
          </SiteDocsLayout>
        </Provider>
      </body>
    </html>
  );
}
