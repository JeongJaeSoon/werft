/**
 * The installed Werft documentation as text: each MDX page of apps/docs read
 * into its title, sections and plain text, and a keyword index over its
 * chunks. No embedding and no network: what is in the image is all it reads.
 */

export const DOCS_LANGUAGES = ["ko", "en", "ja"] as const;
export type DocsLanguage = (typeof DOCS_LANGUAGES)[number];
/** The language every page is written in first; the others translate it. */
export const DOCS_SOURCE_LANGUAGE: DocsLanguage = "ko";

/** The public docs site (GitHub Pages): one site, of the latest release. */
export const DOCS_SITE = "https://jeongjaesoon.github.io/werft";
/** Where a page's source is read at the version this image was built from. */
export const DOCS_SOURCE_TREE = "https://github.com/JeongJaeSoon/werft/blob";
const SOURCE_ROOT = "apps/docs/content/docs";

/** The upper bound of one chunk of a section, in characters. */
export const CHUNK_CHARS = 1_200;
/** The upper bound of the text a result quotes from its chunk. */
export const EXCERPT_CHARS = 320;

/** A file under apps/docs/content/docs: its path there and its text. */
export type DocsFile = { path: string; text: string };

export type DocsSection = {
  /** The heading, or null for the text before the first one. */
  heading: string | null;
  anchor: string | null;
  text: string;
};

export type DocsPage = {
  /** The page's path on the site, without language: `getting-started/install`, `` for the home page. */
  slug: string;
  language: DocsLanguage;
  /** The file it was read from; a page not translated yet is its Korean source. */
  file: string;
  translated: boolean;
  title: string;
  description: string;
  sections: DocsSection[];
};

export type DocsChunk = {
  page: DocsPage;
  section: DocsSection;
  text: string;
};

const FILE = /^(?<slug>.+?)(?:\.(?<language>en|ja))?\.mdx$/;

/**
 * The pages of one language, ordered by path: its own translation where one
 * exists, else the Korean source, as the docs site shows them.
 */
export function docsPages(
  files: readonly DocsFile[],
  language: DocsLanguage,
): DocsPage[] {
  const bySlug = new Map<string, { source?: DocsFile; own?: DocsFile }>();
  for (const file of files) {
    const match = FILE.exec(file.path);
    if (match?.groups === undefined) continue;
    const slug = match.groups.slug as string;
    const fileLanguage = match.groups.language ?? DOCS_SOURCE_LANGUAGE;
    const entry = bySlug.get(slug) ?? {};
    if (fileLanguage === DOCS_SOURCE_LANGUAGE) entry.source = file;
    else if (fileLanguage === language) entry.own = file;
    bySlug.set(slug, entry);
  }
  const pages: DocsPage[] = [];
  for (const [slug, { source, own }] of [...bySlug].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const file = own ?? source;
    if (file === undefined) continue;
    pages.push(
      parsePage(
        file,
        siteSlugOf(slug),
        language,
        own !== undefined || language === DOCS_SOURCE_LANGUAGE,
      ),
    );
  }
  return pages;
}

function siteSlugOf(slug: string): string {
  if (slug === "index") return "";
  return slug.endsWith("/index") ? slug.slice(0, -"/index".length) : slug;
}

/** The page on the public site, at a section when there is one. */
export function pageUrl(page: DocsPage, anchor: string | null = null): string {
  const path = page.slug === "" ? "" : `${page.slug}/`;
  return `${DOCS_SITE}/${page.language}/${path}${anchor === null ? "" : `#${encodeURIComponent(anchor)}`}`;
}

/**
 * The page's source at `version`, a release tag or a commit; null for a
 * build that wrote none, which has no version to point at.
 */
export function sourceUrl(
  page: DocsPage,
  version: string | null,
): string | null {
  return version === null
    ? null
    : `${DOCS_SOURCE_TREE}/${encodeURIComponent(version)}/${SOURCE_ROOT}/${page.file}`;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const HEADING = /^(#{2,4})\s+(.+?)\s*$/;
const CUSTOM_ANCHOR = /\s*\[#([^\]]+)\]$/;
const FENCE = /^\s*(```|~~~)/;
// A JSX tag of a component (capitalised), opening, closing or self-closing,
// on its own or inline: the tag goes, what it wraps stays.
const COMPONENT_TAG = /<\/?[A-Z][\w.]*(?:\s[^<>]*)?\/?>/g;
const ESM = /^(?:import|export)\s/;

function frontmatterValue(block: string, key: string): string {
  const line = block
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${key}:`));
  if (line === undefined) return "";
  const value = line.slice(key.length + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** github-slugger's id, which the docs site gives a heading. */
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

function plainHeading(raw: string): string {
  return (
    raw
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
      // An underscore inside a word (outcome_unknown) is not emphasis.
      .replace(/(?<![\p{L}\p{N}_])_{1,2}([^_]+)_{1,2}(?![\p{L}\p{N}_])/gu, "$1")
      .trim()
  );
}

function parsePage(
  file: DocsFile,
  slug: string,
  language: DocsLanguage,
  translated: boolean,
): DocsPage {
  const front = FRONTMATTER.exec(file.text);
  const body = front === null ? file.text : file.text.slice(front[0].length);
  const meta = front?.[1] ?? "";
  const sections: DocsSection[] = [];
  let current: DocsSection = { heading: null, anchor: null, text: "" };
  const lines: string[] = [];
  const flush = () => {
    current.text = lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (current.heading !== null || current.text !== "") sections.push(current);
    lines.length = 0;
  };
  // A repeated heading's id gets -1, -2, … as github-slugger gives it.
  const anchors = new Map<string, number>();
  // As github-slugger numbers them: a number already taken by another
  // heading ("A", "A-1", "A") moves on to the next.
  const unique = (anchor: string) => {
    let result = anchor;
    while (anchors.has(result)) {
      const n = (anchors.get(anchor) ?? 0) + 1;
      anchors.set(anchor, n);
      result = `${anchor}-${n}`;
    }
    anchors.set(result, 0);
    return result;
  };
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const fenceMark = FENCE.exec(line)?.[1];
    if (fence !== null) {
      lines.push(line);
      if (fenceMark === fence) fence = null;
      continue;
    }
    if (fenceMark !== undefined) {
      fence = fenceMark;
      lines.push(line);
      continue;
    }
    if (ESM.test(line)) continue;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      const raw = heading[2] as string;
      const custom = CUSTOM_ANCHOR.exec(raw);
      const title = plainHeading(
        custom === null ? raw : raw.slice(0, custom.index),
      );
      current = {
        heading: title,
        anchor: custom?.[1] ?? unique(anchorOf(title)),
        text: "",
      };
      continue;
    }
    lines.push(
      line
        .replace(COMPONENT_TAG, (tag) => {
          // A card or tab says what it is in its attributes.
          const said = [
            ...tag.matchAll(/\b(?:title|description|value)="([^"]*)"/g),
          ]
            .map((match) => match[1])
            .join(" — ");
          return said === "" ? "" : said;
        })
        .replace(
          /\]\((\/[^)\s]*)\)/g,
          (_, href: string) => `](${siteHref(href, language)})`,
        ),
    );
  }
  flush();
  return {
    slug,
    language,
    file: file.path,
    translated,
    title: frontmatterValue(meta, "title") || slug || "Werft",
    description: frontmatterValue(meta, "description"),
    sections,
  };
}

// A link inside the docs (`/sessions/start#x`) as the public site has it.
function siteHref(href: string, language: DocsLanguage): string {
  const [path = "", anchor] = href.split("#", 2);
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const first = trimmed.split("/")[0];
  const localized = (DOCS_LANGUAGES as readonly string[]).includes(first ?? "")
    ? trimmed
    : `${language}${trimmed === "" ? "" : `/${trimmed}`}`;
  return `${DOCS_SITE}/${localized}/${anchor === undefined ? "" : `#${anchor}`}`;
}

/** The page as one Markdown text: title, description, then its sections. */
export function pageText(page: DocsPage): string {
  return [
    `# ${page.title}`,
    page.description,
    ...page.sections.map((section) =>
      section.heading === null
        ? section.text
        : `## ${section.heading}\n\n${section.text}`,
    ),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** A section cut at paragraph ends into chunks of at most CHUNK_CHARS. */
export function chunksOf(page: DocsPage): DocsChunk[] {
  const chunks: DocsChunk[] = [];
  for (const section of page.sections) {
    let text = "";
    const push = () => {
      if (text.trim() !== "") chunks.push({ page, section, text: text.trim() });
      text = "";
    };
    for (const paragraph of section.text.split(/\n{2,}/)) {
      for (let at = 0; at < paragraph.length || at === 0; at += CHUNK_CHARS) {
        const piece = paragraph.slice(at, at + CHUNK_CHARS);
        if (text.length + piece.length + 2 > CHUNK_CHARS) push();
        text = text === "" ? piece : `${text}\n\n${piece}`;
        if (paragraph.length === 0) break;
      }
    }
    push();
    // A heading with no text of its own still finds the section.
    if (!chunks.some((chunk) => chunk.section === section)) {
      chunks.push({ page, section, text: "" });
    }
  }
  if (chunks.length === 0) {
    chunks.push({
      page,
      section: { heading: null, anchor: null, text: "" },
      text: "",
    });
  }
  return chunks;
}

// Korean and Japanese are searched by character pairs, so a word with a
// particle on it (저장소를) still matches its stem (저장소); other scripts by
// whole words. The long-vowel mark (ー) is in no script of its own.
const CJK =
  /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;
const WORD = /[\p{L}\p{N}_]+/gu;

/** The terms a text is indexed and searched by. */
export function termsOf(text: string): string[] {
  const normal = text.normalize("NFKC").toLowerCase();
  const terms: string[] = [];
  for (const run of normal.match(CJK) ?? []) {
    const chars = [...run];
    if (chars.length === 1) terms.push(run);
    for (let i = 0; i + 1 < chars.length; i += 1) {
      terms.push(`${chars[i]}${chars[i + 1]}`);
    }
  }
  for (const word of normal.replace(CJK, " ").match(WORD) ?? []) {
    if (word.length >= 2) terms.push(word);
  }
  return terms;
}

export type DocsHit = { chunk: DocsChunk; score: number };

export type DocsIndex = {
  pages: readonly DocsPage[];
  search(query: string, limit: number): DocsHit[];
};

// What a query term found in the page title, or in the section heading, adds
// on top of the body's BM25, in units of its idf among titles or headings.
const TITLE_BOOST = 2;
const HEADING_BOOST = 1;
const K1 = 1.2;
const B = 0.75;

/**
 * A BM25 index over the chunks of `pages`. A term in the page title or the
 * section heading adds to it, and a chunk that has more of the query's terms
 * ranks above one that repeats a few.
 */
export function docsIndex(pages: readonly DocsPage[]): DocsIndex {
  const chunks = pages.flatMap(chunksOf);
  const termSet = (text: string) => new Set(termsOf(text));
  const titles = new Map(pages.map((page) => [page, termSet(page.title)]));
  const headings = new Map<DocsSection, Set<string>>();
  const entries = chunks.map((chunk) => {
    const count = new Map<string, number>();
    for (const term of termsOf(chunk.text)) {
      count.set(term, (count.get(term) ?? 0) + 1);
    }
    let length = 0;
    for (const n of count.values()) length += n;
    if (!headings.has(chunk.section)) {
      headings.set(chunk.section, termSet(chunk.section.heading ?? ""));
    }
    return {
      count,
      length,
      title: titles.get(chunk.page) as Set<string>,
      heading: headings.get(chunk.section) as Set<string>,
    };
  });
  const documents = new Map<string, number>();
  for (const { count } of entries) {
    for (const term of count.keys()) {
      documents.set(term, (documents.get(term) ?? 0) + 1);
    }
  }
  // At least 1: chunks that are all headings would divide by zero.
  const average =
    entries.reduce((sum, { length }) => sum + length, 0) /
      Math.max(entries.length, 1) || 1;
  const idfIn = (n: number, df: number) =>
    Math.log(1 + (n - df + 0.5) / (df + 0.5));
  // A title or heading term weighs by how few titles or headings have it.
  const fieldCounts = (sets: Iterable<Set<string>>) => {
    const counts = new Map<string, number>();
    let n = 0;
    for (const set of sets) {
      n += 1;
      for (const term of set) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    return (term: string) => idfIn(n, counts.get(term) ?? 0);
  };
  const idf = (term: string) => idfIn(entries.length, documents.get(term) ?? 0);
  const titleIdf = fieldCounts(titles.values());
  const headingIdf = fieldCounts(headings.values());
  return {
    pages,
    search(query, limit) {
      const terms = [...new Set(termsOf(query))];
      if (terms.length === 0) return [];
      const weights = terms.map(idf);
      // A term no page has (a particle pair, a typo) cannot be matched, so
      // it does not count against the chunks that match the rest.
      const total = terms.reduce(
        (sum, term, t) =>
          (documents.get(term) ?? 0) > 0 ||
          titleIdf(term) < idfIn(titles.size, 0) ||
          headingIdf(term) < idfIn(headings.size, 0)
            ? sum + (weights[t] as number)
            : sum,
        0,
      );
      if (total === 0) return [];
      const hits: DocsHit[] = [];
      entries.forEach(({ count, length, title, heading }, i) => {
        let score = 0;
        let matched = 0;
        terms.forEach((term, t) => {
          const weight = weights[t] as number;
          const tf = count.get(term) ?? 0;
          const inTitle = title.has(term);
          const inHeading = heading.has(term);
          if (tf === 0 && !inTitle && !inHeading) return;
          matched += weight;
          score +=
            (weight * tf * (K1 + 1)) /
              (tf + K1 * (1 - B + (B * length) / average)) +
            (inTitle ? TITLE_BOOST * titleIdf(term) : 0) +
            (inHeading ? HEADING_BOOST * headingIdf(term) : 0);
        });
        if (score > 0) {
          hits.push({
            chunk: chunks[i] as DocsChunk,
            score: score * (matched / total) ** 2,
          });
        }
      });
      hits.sort((a, b) => b.score - a.score);
      // One result per section: its best chunk.
      const seen = new Set<DocsSection>();
      return hits
        .filter(({ chunk }) => {
          if (seen.has(chunk.section)) return false;
          seen.add(chunk.section);
          return true;
        })
        .slice(0, limit);
    },
  };
}

/** At most EXCERPT_CHARS of `text`, around the first place a term of `query` is. */
export function excerptOf(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  const lower = flat.toLowerCase();
  const at =
    termsOf(query)
      .map((term) => lower.indexOf(term))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(
    0,
    Math.min(at - EXCERPT_CHARS / 4, flat.length - EXCERPT_CHARS),
  );
  const cut = flat.slice(start, start + EXCERPT_CHARS);
  return `${start > 0 ? "…" : ""}${cut}${start + EXCERPT_CHARS < flat.length ? "…" : ""}`;
}
