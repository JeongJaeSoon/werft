import Link from "fumadocs-core/link";
import { flattenTree, type Root } from "fumadocs-core/page-tree";
import { Callout } from "fumadocs-ui/components/callout";
import { Card } from "fumadocs-ui/components/card";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
} from "fumadocs-ui/layouts/notebook/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ComponentType } from "react";
import { OpenAPIPage } from "@/components/api-page";
import { HomeHero } from "@/components/home-hero";
import { LocaleRedirect } from "@/components/locale-redirect";
import { getMDXComponents } from "@/components/mdx";
import {
  i18n,
  isLocale,
  type Locale,
  localizeHref,
  messages,
} from "@/lib/i18n";
import { getPageMarkdownUrl } from "@/lib/shared";
import { isUntranslated, source } from "@/lib/source";

interface Props {
  params: Promise<{ lang: string; slug?: string[] }>;
}

export default async function Page(props: Props) {
  const { lang, slug = [] } = await props.params;
  if (!isLocale(lang)) return <LocaleRedirect path={legacyPath(lang, slug)} />;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  // The generated reference is English in every language: the spec is.
  if (page.type === "openapi") {
    return (
      <DocsPage full>
        <DocsTitle lang="en">{page.data.title}</DocsTitle>
        {/* The operation repeats its description, rendered as Markdown. */}
        <DocsBody lang="en">
          <OpenAPIPage {...page.data.getOpenAPIPageProps()} />
        </DocsBody>
      </DocsPage>
    );
  }

  // A fallback page shows Korean text; screen readers need to know.
  const fallback = isUntranslated(page);
  const contentLang = fallback ? i18n.defaultLanguage : lang;
  const toc = fallback
    ? page.data.toc.map((item) => ({
        ...item,
        title: <span lang={contentLang}>{item.title}</span>,
      }))
    : page.data.toc;

  const MDX = page.data.body;
  const isHome = page.slugs.length === 0;
  return (
    <DocsPage
      toc={toc}
      full={page.data.full ?? isHome}
      // The layout's tree leaves contributing out of the sidebar; previous and
      // next come from the whole tree so that page keeps its neighbours.
      footer={{ items: neighbours(source.getPageTree(lang), page.url) }}
    >
      {isHome ? null : (
        <>
          <DocsTitle lang={contentLang}>{page.data.title}</DocsTitle>
          <DocsDescription className="mb-0" lang={contentLang}>
            {page.data.description}
          </DocsDescription>
          <div className="flex flex-row items-center gap-2 border-b pb-6">
            <MarkdownCopyButton markdownUrl={getPageMarkdownUrl(page).url} />
          </div>
        </>
      )}
      <DocsBody>
        {fallback ? (
          <Callout type="info">{messages[lang].untranslated}</Callout>
        ) : null}
        <div lang={contentLang}>
          <MDX
            components={getMDXComponents({
              a: createRelativeLink(source, page, localized(Link, lang)),
              Card: localized(Card, lang),
              HomeHero: localizedHomeHero(lang),
            })}
          />
        </div>
      </DocsBody>
    </DocsPage>
  );
}

function localized<P extends { href?: string }>(
  Component: ComponentType<P>,
  lang: Locale,
) {
  return function Localized(props: P) {
    return (
      <Component
        {...props}
        href={props.href && localizeHref(props.href, lang)}
      />
    );
  };
}

function localizedHomeHero(lang: Locale) {
  return function LocalizedHomeHero() {
    return <HomeHero lang={lang} />;
  };
}

/**
 * Previous and next pages over the whole tree, contributing included. External
 * links such as the Scalar reference are not pages, so they are skipped.
 */
function neighbours(tree: Root, url: string) {
  const items = flattenTree(tree.children).filter((item) => !item.external);
  const index = items.findIndex((item) => item.url === url);
  if (index === -1) return {};
  return { previous: items[index - 1], next: items[index + 1] };
}

/** `/sessions/start/` as it was before languages, from its `[lang]` and slug. */
function legacyPath(first: string, rest: string[]): string {
  return `/${[first, ...rest].join("/")}/`;
}

export function generateStaticParams() {
  const legacy = source
    .getPages(i18n.defaultLanguage)
    .filter((page) => page.slugs.length > 0)
    .map(({ slugs: [first, ...rest] }) => ({ lang: first, slug: rest }));
  return [...source.generateParams(), ...legacy];
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { lang, slug } = await props.params;
  if (!isLocale(lang)) return { robots: { index: false } };
  const page = source.getPage(slug, lang);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
