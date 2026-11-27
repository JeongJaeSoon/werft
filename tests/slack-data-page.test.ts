import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SLACK_NOTICE_LOCALE_VALUES,
  SLACK_NOTICE_VERSIONS,
} from "../packages/contracts/src/domain/slack-notice.ts";

const page = join(
  import.meta.dir,
  "../apps/docs/content/docs/integrations/slack-data",
);
const DOCS_SITE = "https://jeongjaesoon.github.io/werft/";

const fileOf = (locale: "ko" | "ja" | "en") =>
  `${page}${locale === "ko" ? "" : `.${locale}`}.mdx`;

/**
 * The words of each published version, as sha256 of its text. A version's
 * words never change once published: new words are a new version, added
 * here with its digest.
 */
const PUBLISHED_TEXT: Record<number, string> = {
  1: "8099e6f5a9e3643a3a0722c2d01ab8d0bf4d5dc04e1219411c5171db9316a732",
};

describe("the data page the notice versions link to", () => {
  test("every version links the page in its own language", () => {
    for (const entry of SLACK_NOTICE_VERSIONS) {
      for (const locale of SLACK_NOTICE_LOCALE_VALUES) {
        const href = entry.text[locale].policyLink.href;
        expect(href).toBe(`${DOCS_SITE}${locale}/integrations/slack-data/`);
        expect(existsSync(fileOf(locale))).toBe(true);
      }
    }
  });

  test("no page promises a notice approval", () => {
    for (const locale of ["ko", "ja", "en"] as const) {
      const text = readFileSync(fileOf(locale), "utf8");
      expect(text).not.toMatch(
        /고지를? 승인|告知の承認|告知を承認|approves? the notice|notice approval/i,
      );
    }
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
