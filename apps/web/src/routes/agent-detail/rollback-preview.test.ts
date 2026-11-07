import { describe, expect, test } from "bun:test";
import type { ProfileSummary } from "@werft-ai/contracts";
import { type Translate, translate } from "../../i18n/i18n.tsx";
import {
  rollbackPreview,
  rolledBackText,
  trackingChange,
  trackingLine,
} from "./rollback-preview.ts";

const t: Translate = (key, vars) => translate("ko", key, vars);

const profile = (
  id: string,
  version: number,
  model = "claude-sonnet-5",
): ProfileSummary => ({
  id,
  source: "workspace",
  model,
  models: [model],
  tools: ["Read"],
  permission_mode: "default",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  billing: "metered",
  repository_mode: "optional",
  repository_ids: [],
  workspace: {
    name: "strict",
    version,
    base_profile_id: "claude-coding-local",
    state: "usable",
    created_at: "2026-10-27T00:00:00.000Z",
    retired_at: null,
  },
});

const release = (profileId: string, model = "claude-sonnet-5") => ({
  runtime_profile_id: profileId,
  runtime_config_snapshot: { model },
});

const PROFILES = [profile("ws_strict_v1", 1), profile("ws_strict_v2", 2)];

describe("trackingChange", () => {
  test("같은 값이면 유지, 다르면 바뀜으로 읽는다", () => {
    expect(trackingChange("follow", "follow")).toBe("keepOn");
    expect(trackingChange("pinned", "pinned")).toBe("keepOff");
    expect(trackingChange("follow", "pinned")).toBe("turnedOff");
    expect(trackingChange("pinned", "follow")).toBe("turnedOn");
  });
});

describe("rollbackPreview", () => {
  test("고정된 에이전트는 꺼짐 유지로 확정한다", () => {
    const preview = rollbackPreview(
      { profile_tracking: "pinned", model_source: "fixed" },
      release("ws_strict_v1"),
      PROFILES,
    );
    expect(preview.tracking).toBe("keepOff");
  });

  test("따르는 에이전트가 계보의 최신 버전으로 돌아가면 켜짐 유지로 확정한다", () => {
    const preview = rollbackPreview(
      { profile_tracking: "follow", model_source: "fixed" },
      release("ws_strict_v2"),
      PROFILES,
    );
    expect(preview.tracking).toBe("keepOn");
  });

  test("따르는 에이전트가 옛 버전으로 돌아가면 웹이 정할 수 없어 열어 둔다", () => {
    const preview = rollbackPreview(
      { profile_tracking: "follow", model_source: "fixed" },
      release("ws_strict_v1"),
      PROFILES,
    );
    expect(preview.tracking).toBe("undetermined");
  });

  test("목록에 없는 프로필도 정할 수 없다고 하고, 필드가 없는 응답은 따르는 것으로 읽는다", () => {
    const preview = rollbackPreview(
      { model_source: "fixed" },
      release("ws_gone_v1"),
      PROFILES,
    );
    expect(preview).toEqual({
      tracking: "undetermined",
      modelBecomesFixed: false,
      modelMayBecomeFixed: false,
      profile: null,
    });
  });

  test("프로필 목록이 비어도 상세만으로 정해지는 안내는 남고, 모르는 것은 모른다고 한다", () => {
    const pinned = rollbackPreview(
      { profile_tracking: "pinned", model_source: "profile" },
      release("ws_strict_v1"),
      [],
    );
    expect(pinned.tracking).toBe("keepOff");
    expect(pinned.modelMayBecomeFixed).toBe(true);
    expect(pinned.modelBecomesFixed).toBe(false);
    const following = rollbackPreview(
      { profile_tracking: "follow", model_source: "fixed" },
      release("ws_strict_v1"),
      [],
    );
    expect(following.tracking).toBe("undetermined");
    expect(following.modelMayBecomeFixed).toBe(false);
  });

  test("프로필 기본 모델을 따르던 에이전트가 다른 모델의 릴리스로 가면 직접 고르기로 바뀐다", () => {
    const profiles = [profile("ws_strict_v2", 2, "claude-sonnet-5")];
    const base = {
      profile_tracking: "follow",
      model_source: "profile",
    } as const;
    expect(
      rollbackPreview(base, release("ws_strict_v2", "claude-haiku-5"), profiles)
        .modelBecomesFixed,
    ).toBe(true);
    expect(
      rollbackPreview(
        base,
        release("ws_strict_v2", "claude-sonnet-5"),
        profiles,
      ).modelBecomesFixed,
    ).toBe(false);
    expect(
      rollbackPreview(
        { ...base, model_source: "fixed" },
        release("ws_strict_v2", "claude-haiku-5"),
        profiles,
      ).modelBecomesFixed,
    ).toBe(false);
  });

  const installed = (
    id: string,
    name: string | null,
    version: number,
    previousId: string | null,
  ) =>
    ({
      ...profile(id, version),
      source: "operator",
      workspace: undefined,
      installation: { name, version, state: "usable", previous_id: previousId },
    }) as unknown as ProfileSummary;
  const follows = {
    profile_tracking: "follow",
    model_source: "fixed",
  } as const;

  test("이름이 달라진 다음 설치 판이 가리키는 이전 판은 최신으로 확정하지 않는다", () => {
    const profiles = [
      installed("inst_a_v1", "alpha", 1, null),
      installed("inst_b_v1", "beta", 1, "inst_a_v1"),
    ];
    expect(
      rollbackPreview(follows, release("inst_a_v1"), profiles).tracking,
    ).toBe("undetermined");
    expect(
      rollbackPreview(follows, release("inst_b_v1"), profiles).tracking,
    ).toBe("keepOn");
  });

  test("이름 없는 설치 프로필은 계보를 알 수 없어 최신으로 확정하지 않는다", () => {
    const profiles = [installed("inst_x", null, 1, null)];
    expect(rollbackPreview(follows, release("inst_x"), profiles).tracking).toBe(
      "undetermined",
    );
  });

  test("프로필은 이름으로 알리고 id를 내놓지 않는다", () => {
    const preview = rollbackPreview(
      { profile_tracking: "follow", model_source: "fixed" },
      release("ws_strict_v2"),
      PROFILES,
    );
    expect(preview.profile).toBe("strict");
  });
});

describe("rolledBackText", () => {
  const after = (
    tracking: "follow" | "pinned",
    source: "fixed" | "profile",
  ) => ({
    profile_tracking: tracking,
    model_source: source,
  });

  test("서버에 남은 값으로 따라가기 변화를 말하고, 저장소 설정은 그대로라고 알린다", () => {
    const text = rolledBackText(t, {
      release: "릴리스 A",
      before: { tracking: "follow", modelSource: "fixed" },
      after: after("follow", "fixed"),
    });
    expect(text).toContain("릴리스 A(으)로 되돌렸습니다.");
    expect(text).toContain("켜짐 유지");
    expect(text).toContain("저장소와 GitHub 설정은 지금 그대로입니다.");
    expect(text).not.toContain("직접 고르기");
  });

  test("꺼짐으로 바뀌면 그렇게 말하고 다시 켜는 길을 알린다", () => {
    const text = rolledBackText(t, {
      release: "릴리스 A",
      before: { tracking: "follow", modelSource: "fixed" },
      after: after("pinned", "fixed"),
    });
    expect(text).toContain("꺼짐으로 바뀜");
    expect(text).toContain(t("agent.rolledBack.reenable"));
  });

  test("모델 방식이 프로필 기본에서 직접 고르기로 바뀐 것도 말한다", () => {
    const text = rolledBackText(t, {
      release: "릴리스 A",
      before: { tracking: "pinned", modelSource: "profile" },
      after: after("pinned", "fixed"),
    });
    expect(text).toContain("꺼짐 유지");
    expect(text).toContain("실행 모델: 직접 고르기로 바뀜.");
  });
});

describe("trackingLine", () => {
  test("열린 경우는 확정하지 않는 문장으로 읽힌다", () => {
    const line = trackingLine(t, "undetermined");
    expect(line).not.toContain("켜짐 유지");
    expect(line).not.toContain("꺼짐 유지");
  });
});
