import { describe, expect, test } from "bun:test";
import {
  achievementCategorySchema,
  achievementRuleRequestSchema,
  BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS,
  createAchievementCategoryRequestSchema,
  createAchievementTypeRequestSchema,
  updateAchievementCategoryRequestSchema,
  updateAchievementTypeRequestSchema,
} from "./achievements.ts";

const ID = "019a0000-0000-7000-8000-0000000000a1";
const ok =
  (schema: { safeParse(v: unknown): { success: boolean } }) =>
  (value: unknown) =>
    schema.safeParse(value).success;

describe("achievement requests", () => {
  test("names, titles and definitions are trimmed; whitespace alone is refused; a stored padded name still reads", () => {
    expect(
      createAchievementCategoryRequestSchema.parse({ name: " 품질 " }),
    ).toEqual({ name: "품질" });
    expect(ok(createAchievementCategoryRequestSchema)({ name: "  " })).toBe(
      false,
    );
    expect(ok(updateAchievementCategoryRequestSchema)({ name: "\t" })).toBe(
      false,
    );
    expect(
      createAchievementTypeRequestSchema.parse({
        key: "first_fix",
        name: " 첫 수정\n",
        evidence_kind: "out_file",
      }).name,
    ).toBe("첫 수정");
    expect(ok(updateAchievementTypeRequestSchema)({ name: " " })).toBe(false);
    const rule = {
      category_id: ID,
      title: " 제목 ",
      type_id: ID,
      definition: " 정의 ",
      judge: "always",
    };
    const parsed = achievementRuleRequestSchema.parse(rule);
    expect([parsed.title, parsed.definition]).toEqual(["제목", "정의"]);
    expect(ok(achievementRuleRequestSchema)({ ...rule, title: "  " })).toBe(
      false,
    );
    expect(
      ok(achievementRuleRequestSchema)({ ...rule, definition: "\n" }),
    ).toBe(false);
    expect(
      ok(achievementCategorySchema)({
        id: ID,
        name: " 품질 ",
        position: 0,
        created_by: ID,
        created_at: "2026-11-16T00:00:00.000Z",
        archived_at: null,
        archived_by: null,
      }),
    ).toBe(true);
  });

  test("a position set by hand is at most 1,000,000; one stored after it still answers", () => {
    const patch = ok(updateAchievementCategoryRequestSchema);
    expect(patch({ position: 1_000_000 })).toBe(true);
    expect(patch({ position: 1_000_001 })).toBe(false);
    expect(
      ok(achievementCategorySchema)({
        id: ID,
        name: "Delivery",
        position: 1_000_001,
        created_by: ID,
        created_at: "2026-11-02T00:00:00.000Z",
        archived_at: null,
        archived_by: null,
      }),
    ).toBe(true);
    const stored = (position: number) =>
      ok(achievementCategorySchema)({
        id: ID,
        name: "Delivery",
        position,
        created_by: ID,
        created_at: "2026-11-02T00:00:00.000Z",
        archived_at: null,
        archived_by: null,
      });
    expect(stored(2_147_483_647)).toBe(true);
    expect(stored(2_147_483_648)).toBe(false);
  });

  test("a category name is 1 to 32 characters; a patch names something", () => {
    const create = ok(createAchievementCategoryRequestSchema);
    expect(create({ name: "a".repeat(32) })).toBe(true);
    expect(create({ name: "a".repeat(33) })).toBe(false);
    expect(create({ name: "" })).toBe(false);
    const update = ok(updateAchievementCategoryRequestSchema);
    expect(update({})).toBe(false);
    expect(update({ position: 2 })).toBe(true);
    expect(update({ position: -1 })).toBe(false);
  });

  test("a type key is [a-z][a-z0-9_]{1,40} and its evidence kind is fixed in code", () => {
    const create = ok(createAchievementTypeRequestSchema);
    const type = (key: string, evidence_kind = "out_file") =>
      create({ key, name: "Report", evidence_kind });
    expect(type("ab")).toBe(true);
    expect(type(`a${"b".repeat(40)}`)).toBe(true);
    expect(type(`a${"b".repeat(41)}`)).toBe(false);
    expect(type("a")).toBe(false);
    expect(type("1ab")).toBe(false);
    expect(type("Ab")).toBe(false);
    expect(type("a-b")).toBe(false);
    for (const kind of [
      "github_pull_request",
      "github_review",
      "out_file",
      "conversation",
    ]) {
      expect(type("report", kind)).toBe(true);
    }
    expect(type("report", "slack_reply")).toBe(false);
    expect(
      create({
        key: "report",
        name: "a".repeat(41),
        evidence_kind: "out_file",
      }),
    ).toBe(false);
  });

  test("a type patch changes the name only", () => {
    const update = ok(updateAchievementTypeRequestSchema);
    expect(update({ name: "Report" })).toBe(true);
    expect(update({ name: "Report", key: "other" })).toBe(false);
    expect(update({ name: "Report", evidence_kind: "out_file" })).toBe(false);
  });

  test("a rule is one title, type and definition, for every agent", () => {
    const rule = (extra: Record<string, unknown> = {}) =>
      achievementRuleRequestSchema.safeParse({
        category_id: ID,
        title: "Merged PR",
        type_id: ID,
        definition: "Only merged pull requests count.",
        judge: "luna",
        ...extra,
      });
    expect(rule().data?.agent_ids).toBeNull();
    expect(rule({ agent_ids: null }).success).toBe(true);
    expect(rule({ agent_ids: [ID] }).success).toBe(false);
    expect(rule({ judge: "sonnet" }).success).toBe(false);
    expect(rule({ title: "a".repeat(81) }).success).toBe(false);
    expect(rule({ definition: "a".repeat(2_000) }).success).toBe(true);
    expect(rule({ definition: "a".repeat(2_001) }).success).toBe(false);
    expect(rule({ definition: "" }).success).toBe(false);
  });
});

describe("built-in achievement payloads", () => {
  const pr = {
    repository: "acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    state: "merged",
    merged_at: "2026-11-02T00:00:00.000Z",
    additions: 3,
    deletions: 1,
  };

  test("a pull request payload has the design's fields and nothing else", () => {
    const parse = ok(BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS.pull_request);
    expect(parse(pr)).toBe(true);
    expect(
      parse({ ...pr, additions: null, deletions: null, merged_at: null }),
    ).toBe(true);
    expect(parse({ ...pr, title: "Fix" })).toBe(false);
    expect(parse({ ...pr, state: "submitted" })).toBe(false);
    expect(parse({ ...pr, repository: "app" })).toBe(false);
    expect(parse({ ...pr, number: 0 })).toBe(false);
  });

  test("a review payload names the event and the commit", () => {
    const parse = ok(BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS.code_review);
    const review = {
      repository: "acme/app",
      number: 9,
      url: "https://github.com/acme/app/pull/9#pullrequestreview-1",
      event: "APPROVE",
      commit_id: "c".repeat(40),
    };
    expect(parse(review)).toBe(true);
    expect(parse({ ...review, event: "MERGE" })).toBe(false);
    expect(parse({ ...review, body: "LGTM" })).toBe(false);
  });

  test("a document payload is the path and its size", () => {
    const parse = ok(BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS.document);
    expect(parse({ path: "out/report.md", size: 10 })).toBe(true);
    expect(parse({ path: "out/report.md", size: -1 })).toBe(false);
    expect(parse({ path: "", size: 1 })).toBe(false);
  });
});
