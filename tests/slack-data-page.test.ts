import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SLACK_NOTICE_LOCALE_VALUES,
  SLACK_NOTICE_VERSIONS,
  slackNoticeWindow,
} from "../packages/contracts/src/domain/slack-notice.ts";

const page = join(
  import.meta.dir,
  "../apps/docs/content/docs/integrations/slack-data",
);
const DOCS_SITE = "https://jeongjaesoon.github.io/werft/";

// How each language's page names its version, as its first line says it.
const VERSION_LINE = {
  ko: (n: number) => `**판 ${n}.**`,
  ja: (n: number) => `**第${n}版。**`,
  en: (n: number) => `**Version ${n}.**`,
} as const;

const fileOf = (locale: keyof typeof VERSION_LINE) =>
  `${page}${locale === "ko" ? "" : `.${locale}`}.mdx`;

/**
 * Each version's page in each language, as sha256 of its file. A version's
 * record never changes: a changed page is a new version, so bump the notice
 * and the version line, then add the new version's digests here.
 */
const PUBLISHED_PAGE: Record<number, Record<"ko" | "ja" | "en", string>> = {
  1: {
    ko: "bc21bbcf4fc6de3ac3811359282c7c351cd2f27c7296c6299dbbc0415aaf79bd",
    ja: "0038ecf946ef1bdf19ea680562c9f70a261b3bef28fc67a7a1b5a7cccf2e73ef",
    en: "ce68c5bd49d58b996de8ab25e470c2e783f919aeb9a84276fc6b9f356987f02d",
  },
};

/**
 * The words of each published version, as sha256 of its text. A version's
 * words never change once published: new words are a new version, added
 * here with its digest.
 */
const PUBLISHED_TEXT: Record<number, string> = {
  1: "8099e6f5a9e3643a3a0722c2d01ab8d0bf4d5dc04e1219411c5171db9316a732",
};

describe("the data page the notice links to", () => {
  const window = slackNoticeWindow(SLACK_NOTICE_VERSIONS);

  test("every language's page carries the current notice version", () => {
    expect(window).not.toBeNull();
    for (const locale of ["ko", "ja", "en"] as const) {
      const text = readFileSync(fileOf(locale), "utf8");
      const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
      expect(
        body.startsWith(VERSION_LINE[locale](Number(window?.current))),
      ).toBe(true);
    }
  });

  test("every version links the page in its own language", () => {
    for (const entry of SLACK_NOTICE_VERSIONS) {
      for (const locale of SLACK_NOTICE_LOCALE_VALUES) {
        const href = entry.text[locale].policyLink.href;
        expect(href).toBe(`${DOCS_SITE}${locale}/integrations/slack-data/`);
        expect(existsSync(fileOf(locale))).toBe(true);
      }
    }
  });

  test("the page does not change without a new version", () => {
    const digests = Object.fromEntries(
      (["ko", "ja", "en"] as const).map((locale) => [
        locale,
        createHash("sha256")
          .update(readFileSync(fileOf(locale), "utf8"))
          .digest("hex"),
      ]),
    );
    expect(digests).toEqual(PUBLISHED_PAGE[Number(window?.current)] as never);
  });

  test("a published version's words never change", () => {
    const digests = Object.fromEntries(
      SLACK_NOTICE_VERSIONS.map((entry) => [
        entry.version,
        createHash("sha256").update(JSON.stringify(entry.text)).digest("hex"),
      ]),
    );
    expect(digests).toEqual(PUBLISHED_TEXT);
  });
});
