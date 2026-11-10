import { describe, expect, test } from "bun:test";
import { type Translate, translate } from "../../i18n/i18n.tsx";
import { rollbackPreview, rolledBackText } from "./rollback-preview.ts";

const t: Translate = (key, vars) => translate("ko", key, vars);

describe("rollbackPreview", () => {
  test("되돌릴 릴리스가 도는 모델 연결을 알린다", () => {
    expect(rollbackPreview({ connection_id: "anthropic-main" })).toEqual({
      connection: "anthropic-main",
    });
  });
});

describe("rolledBackText", () => {
  test("되돌린 릴리스를 말하고, 저장소 설정은 그대로라고 알린다", () => {
    const text = rolledBackText(t, { release: "v3" });
    expect(text).toContain("v3");
    expect(text).toContain("저장소와 GitHub 설정은 지금 그대로입니다.");
  });
});
