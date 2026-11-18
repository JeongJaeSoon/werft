import { describe, expect, test } from "bun:test";

import { sessionsEn, sessionsJa, sessionsKo } from "./sessions.ts";

const CATALOGS = [
  { name: "ko", catalog: sessionsKo, optional: " (선택)" },
  { name: "en", catalog: sessionsEn, optional: " (optional)" },
  { name: "ja", catalog: sessionsJa, optional: "(任意)" },
] as const;

describe("권한 요청의 거부 문구", () => {
  for (const { name, catalog, optional } of CATALOGS) {
    test(`${name}: 버튼 이름은 버튼의 낱말로 시작한다`, () => {
      expect(catalog["session.answer.denyFor"]).toBe(
        `${catalog["session.answer.deny"]}: {tool} · {session}`,
      );
    });

    test(`${name}: 이유 칸은 적지 않아도 된다고 라벨에 적는다`, () => {
      const label = catalog["session.answer.denyReason"];
      expect(label.endsWith(optional)).toBe(true);
    });
  }

  // English and Japanese say the form's parts in other words, so only
  // Korean shares the button's word with them.
  test("ko: 거부 폼의 라벨과 보내기 버튼도 버튼과 같은 낱말로 시작한다", () => {
    const word = sessionsKo["session.answer.deny"];
    expect(sessionsKo["session.answer.denyReason"].startsWith(word)).toBe(true);
    expect(sessionsKo["session.answer.denySubmit"].startsWith(word)).toBe(true);
  });
});
