import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { sessionsEn, sessionsJa, sessionsKo } from "./sessions.ts";

const GLOSSARY = readFileSync(
  new URL("../../../../docs/contributing/i18n-glossary.md", import.meta.url),
  "utf8",
);

// The glossary's row for a permission request's denial: concept, ko, ja, en.
const DENY_ROW = GLOSSARY.split("\n")
  .find((line) => line.startsWith("| 권한 요청 거절 |"))
  ?.split("|")
  .map((cell) => cell.trim());

const CATALOGS = [
  { name: "ko", catalog: sessionsKo, column: 2, optional: " (선택)" },
  { name: "en", catalog: sessionsEn, column: 4, optional: " (optional)" },
  { name: "ja", catalog: sessionsJa, column: 3, optional: "(任意)" },
] as const;

describe("권한 요청의 거부 문구", () => {
  for (const { name, catalog, column, optional } of CATALOGS) {
    test(`${name}: 버튼의 낱말이 용어집과 같고, 버튼 이름도 그 낱말로 시작한다`, () => {
      expect(DENY_ROW?.[column]).toBeString();
      expect(catalog["session.answer.deny"]).toBe(String(DENY_ROW?.[column]));
      expect(catalog["session.answer.denyFor"]).toBe(
        `${catalog["session.answer.deny"]}: {tool} · {session}`,
      );
    });

    test(`${name}: 이유 칸은 적지 않아도 된다고 라벨에 적는다`, () => {
      const label = catalog["session.answer.denyReason"];
      expect(label.endsWith(optional)).toBe(true);
    });
  }
});
