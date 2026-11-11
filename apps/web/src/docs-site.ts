import type { Locale } from "@werft-ai/react";

/**
 * The public documentation site. Every console link to it reads this one
 * constant. The site's bare root redirects by the language the docs site
 * remembers or the browser's; the console links its own language, which can
 * differ from both.
 */
const DOCS_SITE_URL = "https://jeongjaesoon.github.io/werft/";

export function docsSiteUrl(locale: Locale): string {
  return `${DOCS_SITE_URL}${locale}/`;
}
