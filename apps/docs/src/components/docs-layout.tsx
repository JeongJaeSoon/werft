"use client";
import type { Node, Root } from "fumadocs-core/page-tree";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { LanguageSelect } from "fumadocs-ui/layouts/shared/slots/language-select";
import { Languages } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SidebarSectionSeparator } from "@/components/sidebar-separator";
import {
  type ApiSidebar,
  apiSidebarRoute,
  mapTagFolders,
  type SidebarOperation,
} from "@/lib/api-sidebar";
import type { Locale } from "@/lib/i18n";
import { baseOptions } from "@/lib/layout.shared";
import { withBasePath } from "@/lib/shared";

// The colours fumadocs-openapi gives a method badge in its own sidebar entries.
const methodColor: Record<string, string> = {
  PUT: "text-yellow-600 dark:text-yellow-400",
  PATCH: "text-orange-600 dark:text-orange-400",
  POST: "text-blue-600 dark:text-blue-400",
  DELETE: "text-red-600 dark:text-red-400",
};

function operationName({ title, method, deprecated }: SidebarOperation) {
  const name = deprecated ? (
    <span className="fd-page-tree-item-name line-through">{title}</span>
  ) : (
    title
  );
  if (!method) return name;
  const upper = method.toUpperCase();
  return (
    <>
      {name}{" "}
      <span
        className={`font-mono font-medium ms-auto text-xs text-nowrap ${methodColor[upper] ?? "text-green-600 dark:text-green-400"}`}
      >
        {upper}
      </span>
    </>
  );
}

function withOperations(tree: Root, lang: Locale, sidebar: ApiSidebar): Root {
  return {
    ...mapTagFolders(tree, lang, (_folder, tag) =>
      (sidebar[tag] ?? []).map(
        (op): Node => ({
          type: "page",
          name: operationName(op),
          url: `/${lang}${op.url}`,
        }),
      ),
    ),
    // The tree context only takes a new tree under a new root id.
    $id: `${tree.$id ?? lang}:operations`,
  };
}

/** The docs layout; the server tree has empty tag folders, filled here. */
export function SiteDocsLayout({
  lang,
  tree,
  children,
}: {
  lang: Locale;
  tree: Root;
  children: ReactNode;
}) {
  const [full, setFull] = useState<Root>();
  useEffect(() => {
    let live = true;
    fetch(withBasePath(apiSidebarRoute))
      .then((res) => {
        if (!res.ok) throw new Error(`${apiSidebarRoute}: HTTP ${res.status}`);
        return res.json() as Promise<ApiSidebar>;
      })
      .then((sidebar) => {
        if (live) setFull(withOperations(tree, lang, sidebar));
      })
      // The sidebar keeps its tag folders; the pages and their links still work.
      .catch((error: unknown) => console.error(error));
    return () => {
      live = false;
    };
  }, [tree, lang]);

  const { nav, ...base } = baseOptions();
  return (
    <DocsLayout
      tree={full ?? tree}
      {...base}
      sidebar={{ components: { Separator: SidebarSectionSeparator } }}
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
  );
}
