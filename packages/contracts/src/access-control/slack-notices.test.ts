import { describe, expect, test } from "bun:test";
import { USER_LOCALE_VALUES } from "./auth.ts";
import {
  AUTHORIZATION_REASON_VALUES,
  type AuthorizationReason,
  authorizationSurfaceSchema,
  slackUserKindOf,
} from "./authorization.ts";
import { SLACK_NOTICE_MESSAGES, slackNoticeFor } from "./slack-notices.ts";

const links = { connectUrl: "https://app.example/settings/accounts" };
const deny = (reason_code: AuthorizationReason) => ({
  outcome: "deny" as const,
  reason_code,
});

describe("slackNoticeFor", () => {
  test.each([
    ["unlinked", "session.submit", "connect", true],
    ["stale_link", "session.submit", "connect", true],
    ["role", "session.submit", "noRequestRight", false],
    ["surface_ceiling", "session.submit", "noRequestRight", false],
    ["role", "session.approve", "noApproveRight", false],
    ["surface_ceiling", "session.approve", "noApproveRight", false],
    ["unlinked", "session.approve", "connect", true],
    ["guest_disabled", "session.submit", "guestDisabled", false],
    ["external_user", "session.submit", "membersOnly", false],
    ["not_found", "session.approve", "outOfShare", false],
    ["justification_required", "session.read", "noRequestRight", false],
    ["credential_unbound", "session.submit", "credentialUnbound", false],
    ["error", "session.submit", "failed", false],
  ] as const)("%s on %s", (reason, action, message, linked) => {
    expect(slackNoticeFor(deny(reason), action, links)).toEqual(
      linked ? { message, link_url: links.connectUrl } : { message },
    );
  });

  test("the copy is the wording the design gives", () => {
    expect(SLACK_NOTICE_MESSAGES.ko).toMatchObject({
      connect: "웹에서 Slack 계정을 연결해 주세요",
      noRequestRight: "이 채널에서 이 에이전트에게 요청할 권한이 없어요",
      noApproveRight: "이 요청을 승인할 권한이 없어요",
      guestDisabled:
        "이 워크스페이스는 게스트의 에이전트 사용을 허용하지 않아요",
      membersOnly: "이 에이전트는 이 워크스페이스 구성원만 쓸 수 있어요",
    });
  });

  test("a stop's lines are the wording decided for them, the count in each language", () => {
    expect(SLACK_NOTICE_MESSAGES.ko).toMatchObject({
      sessionStopped:
        "요청하신 대로 작업을 멈췄어요. 이어서 하려면 이 스레드에 다시 써 주세요.",
      sessionStoppedQueued:
        "요청하신 대로 작업을 멈췄어요. 기다리던 글 {count}개도 처리하지 않았어요. 이어서 하려면 이 스레드에 다시 써 주세요.",
      nothingToStop: "지금 멈출 작업이 없어요.",
      stopNotPermitted: "작업을 맡긴 사람만 멈출 수 있어요",
      taskStoppedBeforeStart:
        "요청하신 대로 작업을 시작하기 전에 멈추고 닫았어요. 다시 하려면 새로 맡겨 주세요.",
    });
    expect(SLACK_NOTICE_MESSAGES.ja.taskStoppedBeforeStart).toBe(
      "ご依頼どおり、作業を始める前に止めて閉じました。もう一度行うには、新しく依頼してください。",
    );
    expect(SLACK_NOTICE_MESSAGES.en.taskStoppedBeforeStart).toBe(
      "Stopped and closed the task before it started, as you asked. To do it again, ask for it as a new task.",
    );
    for (const locale of USER_LOCALE_VALUES) {
      const messages = SLACK_NOTICE_MESSAGES[locale];
      expect(messages.sessionStoppedQueued).toContain("{count}");
      expect(messages.sessionStopped).not.toContain("{count}");
      expect(messages.taskStoppedBeforeStartQueued).toContain("{count}");
      expect(messages.taskStoppedBeforeStart).not.toContain("{count}");
    }
  });

  test("every language says every notice, in its own words", () => {
    const keys = Object.keys(SLACK_NOTICE_MESSAGES.ko).sort();
    for (const locale of USER_LOCALE_VALUES) {
      const messages = SLACK_NOTICE_MESSAGES[locale];
      expect(Object.keys(messages).sort()).toEqual(keys);
      for (const text of Object.values(messages)) {
        expect(text.trim()).not.toBe("");
        expect(text).not.toMatch(/Musterrolle|Werft|Kollegium|Kiel|Lotse/);
      }
    }
    expect(SLACK_NOTICE_MESSAGES.en.connect).toMatch(/^[\x20-\x7e]+$/);
    expect(SLACK_NOTICE_MESSAGES.ja.connect).toMatch(/[ぁ-ん]/);
  });

  test("every refusal reason has a notice; an allow or a redact has none", () => {
    for (const reason of AUTHORIZATION_REASON_VALUES) {
      if (reason === "ok") continue;
      const notice = slackNoticeFor(deny(reason), "session.submit", links);
      expect(notice && SLACK_NOTICE_MESSAGES.ko[notice.message]).toEqual(
        expect.any(String),
      );
    }
    expect(
      slackNoticeFor(
        { outcome: "allow", reason_code: "ok" },
        "session.submit",
        links,
      ),
    ).toBeNull();
    expect(
      slackNoticeFor(
        { outcome: "redact", reason_code: "surface_ceiling" },
        "session.read",
        links,
      ),
    ).toBeNull();
  });
});

describe("slackUserKindOf", () => {
  const TEAM = "T0OPS";
  test.each([
    [{}, "member"],
    [{ is_restricted: true }, "guest"],
    [{ is_restricted: true, is_ultra_restricted: true }, "guest"],
    [{ is_stranger: true }, "external"],
    [{ is_external: true }, "external"],
    // A Slack Connect user is not marked restricted, but a guest flag on
    // someone from elsewhere does not make them a guest of this workspace.
    [{ is_restricted: true, team_id: "T0PARTNER" }, "external"],
    [{ team_id: "T0PARTNER" }, "external"],
  ] as const)("%o is %s", (fields, kind) => {
    expect(slackUserKindOf({ id: "U0", team_id: TEAM, ...fields }, TEAM)).toBe(
      kind,
    );
  });
});

describe("authorizationSurfaceSchema", () => {
  test("only a slack surface carries the user's kind, a channel ceiling and its agent", () => {
    const ceiling = { actions: ["session.submit"], disclosure: "full" };
    const agent_id = "019a0000-0000-7000-8000-0000000000a2";
    expect(
      authorizationSurfaceSchema.safeParse({
        kind: "slack",
        slack_user_kind: "external",
        ceiling,
        agent_id,
      }).success,
    ).toBe(true);
    for (const extra of [
      { slack_user_kind: "member" },
      { ceiling },
      { agent_id },
    ]) {
      expect(
        authorizationSurfaceSchema.safeParse({ kind: "web", ...extra }).success,
      ).toBe(false);
    }
  });

  test("no channel ceiling can name a web-only action", () => {
    for (const action of [
      "session.recover",
      "session.delete",
      "workspace.manage",
    ]) {
      expect(
        authorizationSurfaceSchema.safeParse({
          kind: "slack",
          ceiling: { actions: [action], disclosure: "full" },
        }).success,
      ).toBe(false);
    }
  });
});
