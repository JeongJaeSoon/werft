import { describe, expect, test } from "bun:test";
import {
  USER_LOCALE_VALUES,
  WORKFLOWS_PUSH_REASON_VALUES,
} from "@werft-ai/contracts";
import {
  ACTION_NOTICE_RESULTS,
  type ActionNotice,
  actionNoticeText,
} from "./action-notice.ts";

const base = {
  repository: "app",
  branch: "agent/s-1",
  commit: "a".repeat(40),
  number: 12,
  reason: "head_moved",
} satisfies Omit<ActionNotice, "result">;

describe("action notices", () => {
  test("every result has words in every language, naming what it reports", () => {
    for (const locale of USER_LOCALE_VALUES) {
      for (const result of ACTION_NOTICE_RESULTS) {
        const text = actionNoticeText(locale, { ...base, result });
        expect(text).toContain("app");
        if (
          result === "opened" ||
          result === "pr_updated" ||
          result === "pr_closed"
        ) {
          expect(text).toContain("12");
        }
        if (result === "pushed" || result === "pr_updated") {
          expect(text).toContain("aaaaaaa");
        }
        if (result.endsWith("failed") || result === "pr_uncertain") {
          expect(text).toContain("head_moved");
        }
      }
    }
  });

  test("a push GitHub refused for a workflow file says what to ask for in place of the code", () => {
    const failed = { ...base, result: "push_failed" } as const;
    for (const locale of USER_LOCALE_VALUES) {
      const texts = WORKFLOWS_PUSH_REASON_VALUES.map((reason) =>
        actionNoticeText(locale, { ...failed, reason }),
      );
      expect(new Set(texts).size).toBe(texts.length);
      for (const [index, text] of texts.entries()) {
        expect(text).toContain("app agent/s-1\n");
        expect(text).not.toContain("push_failed");
        expect(text).toMatch(/workflow/i);
        expect(text).not.toContain(WORKFLOWS_PUSH_REASON_VALUES[index]);
      }
      // Another result with the same code keeps its own words.
      expect(
        actionNoticeText(locale, {
          ...base,
          result: "pr_failed",
          reason: "workflows_off",
        }),
      ).toContain("(workflows_off)");
    }
    expect(actionNoticeText("ko", { ...failed, reason: "workflows_off" })).toBe(
      'push하지 못했어요: app agent/s-1\nworkflow 파일을 push하려면 Werft에서 "workflow 파일 수정과 CI 결과 보기"를 켜야 해요. 워크스페이스 관리자에게 에이전트 GitHub 설정에서 켜 달라고 요청하세요.',
    );
    expect(
      actionNoticeText("ko", {
        ...failed,
        reason: "workflows_permission_missing",
      }),
    ).toContain(
      "GitHub App에 Workflows 권한이 필요해요. 워크스페이스 관리자에게 요청하세요.",
    );
  });

  test("workflows off names the switch that is off: the agent's settings, the workspace ceiling, or both (94S-2453)", () => {
    const ko = (reason: (typeof WORKFLOWS_PUSH_REASON_VALUES)[number]) =>
      actionNoticeText("ko", { ...base, result: "push_failed", reason });
    // The agent's settings alone: the words it had before.
    expect(ko("workflows_off")).toContain("에이전트 GitHub 설정에서 켜 달라고");
    expect(ko("workflows_off")).not.toContain("상한");
    expect(ko("workflows_ceiling_off")).toBe(
      'push하지 못했어요: app agent/s-1\nworkflow 파일을 push하려면 워크스페이스 GitHub 상한에서 "workflow 파일 수정과 CI 결과 보기"를 켜야 해요. 이 상한은 워크스페이스 owner나 admin만 바꿀 수 있으니 그분들에게 요청하세요.',
    );
    expect(ko("workflows_ceiling_off")).not.toContain("에이전트 GitHub 설정");
    expect(ko("workflows_both_off")).toBe(
      'push하지 못했어요: app agent/s-1\nworkflow 파일을 push하려면 워크스페이스 GitHub 상한과 에이전트 GitHub 설정에서 "workflow 파일 수정과 CI 결과 보기"를 둘 다 켜야 해요. 워크스페이스 owner나 admin에게 상한부터 켜 달라고 요청하세요.',
    );
    for (const locale of ["en", "ja"] as const) {
      const text = (reason: (typeof WORKFLOWS_PUSH_REASON_VALUES)[number]) =>
        actionNoticeText(locale, { ...base, result: "push_failed", reason });
      expect(text("workflows_ceiling_off")).toMatch(/owner.+admin/);
      expect(text("workflows_both_off")).toMatch(/owner.+admin/);
      expect(text("workflows_off")).not.toMatch(/owner/);
    }
  });

  // Slack notices speak 해요체; tests/korean-copy.test.ts (합니다체) covers
  // the console's screens, not the thread (94S-2453).
  test("every Korean thread notice is in 해요체", () => {
    const reasons = [
      ...WORKFLOWS_PUSH_REASON_VALUES,
      "default_branch",
      "non_fast_forward",
      "repository_not_allowed",
      "head_moved",
    ];
    for (const result of ACTION_NOTICE_RESULTS) {
      for (const reason of reasons) {
        const text = actionNoticeText("ko", { ...base, result, reason });
        expect(text).toMatch(/요[.:]?/);
        expect(text).not.toMatch(/(니다|십시오)/);
      }
    }
  });

  test("a refusal a person can act on says why and whom to ask, for a failed and for a cancelled push", () => {
    const reasons = [
      "default_branch",
      "non_fast_forward",
      "repository_not_allowed",
    ] as const;
    for (const locale of USER_LOCALE_VALUES) {
      for (const result of ["push_failed", "push_cancelled"] as const) {
        const texts = reasons.map((reason) =>
          actionNoticeText(locale, { ...base, result, reason }),
        );
        expect(new Set(texts).size).toBe(texts.length);
        for (const [index, text] of texts.entries()) {
          expect(text).toContain("app agent/s-1\n");
          expect(text).not.toContain(reasons[index]);
        }
      }
      // A refusal with no words of its own keeps its code.
      expect(
        actionNoticeText(locale, {
          ...base,
          result: "push_failed",
          reason: "lease_expired",
        }),
      ).toContain("(lease_expired)");
    }
    const ko = (reason: (typeof reasons)[number]) =>
      actionNoticeText("ko", { ...base, result: "push_failed", reason });
    expect(ko("default_branch")).toBe(
      "push하지 못했어요: app agent/s-1\n기본 브랜치에는 바로 push하지 않아요. 에이전트에게 작업 브랜치로 push하고 PR을 열어 달라고 요청하세요.",
    );
    expect(ko("non_fast_forward")).toContain("원격 브랜치가 앞서 있어서");
    expect(ko("repository_not_allowed")).toContain("에이전트 관리자에게");
  });

  test("the languages differ, and an unknown reader reads English", () => {
    const notice = { ...base, result: "opened" } as const;
    const en = actionNoticeText("en", notice);
    expect(actionNoticeText("ko", notice)).not.toBe(en);
    expect(actionNoticeText("ja", notice)).not.toBe(en);
    expect(actionNoticeText(null, notice)).toBe(en);
    expect(actionNoticeText(undefined, notice)).toBe(en);
  });
});
