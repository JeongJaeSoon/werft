import { describe, expect, test } from "bun:test";

import {
  DIGEST_SUMMARY_MAX_BYTES,
  DIGEST_SUMMARY_MAX_CODE_POINTS,
  DIGEST_TITLE_MAX_BYTES,
  DIGEST_TITLE_MAX_CODE_POINTS,
  sessionDigestSchema,
  sessionDigestViewSchema,
} from "./digest.ts";

const SESSION_ID = "019a0000-0000-7000-8000-0000000000c1";
const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000c2";
const AT = "2026-09-22T01:00:00Z";

const digest = {
  session_id: SESSION_ID,
  workspace_id: WORKSPACE_ID,
  agent_id: null,
  agent_release_id: null,
  title: "분기 보고서 이상치 조사",
  title_locked: false,
  summary: "",
  admission_state: "active",
  status: "running",
  last_turn_state: null,
  waiting_reason: null,
  last_activity_at: AT,
  turn_count: 3,
  cost_usd: "0.41",
  source_thread: "slack:C01:1758500000.0001",
  revision: 7,
  source_session_revision: 12,
  summarized_turn_sequence: null,
  last_summarized_turn_id: null,
  updated_at: AT,
} satisfies Record<string, unknown>;

describe("SessionDigest", () => {
  test("accepts the row a session projects into", () => {
    const parsed = sessionDigestSchema.parse(digest);
    expect(parsed.source_session_revision).toBe(12);
    expect(parsed.summarized_turn_sequence).toBeNull();
  });

  test("a title always says something, an empty summary is honest", () => {
    // Dispatch generates the title and a person can rename it; neither
    // produces a blank. An unsummarized session really has no summary.
    expect(
      sessionDigestSchema.safeParse({ ...digest, title: "" }).success,
    ).toBe(false);
    expect(
      sessionDigestSchema.safeParse({ ...digest, summary: "" }).success,
    ).toBe(true);
  });

  test("the summarizer checkpoint is both fields or neither", () => {
    // Half of it lets one consumer read "never summarized" and another read a
    // covered turn.
    expect(
      sessionDigestSchema.safeParse({
        ...digest,
        summarized_turn_sequence: 4,
        last_summarized_turn_id: "4",
      }).success,
    ).toBe(true);
    expect(
      sessionDigestSchema.safeParse({ ...digest, summarized_turn_sequence: 4 })
        .success,
    ).toBe(false);
    expect(
      sessionDigestSchema.safeParse({ ...digest, last_summarized_turn_id: "4" })
        .success,
    ).toBe(false);
  });

  test("caps the title by code points, and the byte cap is what makes that safe", () => {
    const ascii = "a".repeat(DIGEST_TITLE_MAX_CODE_POINTS);
    expect(
      sessionDigestSchema.safeParse({ ...digest, title: ascii }).success,
    ).toBe(true);
    expect(
      sessionDigestSchema.safeParse({ ...digest, title: `${ascii}a` }).success,
    ).toBe(false);
    // 480 bytes is exactly 120 four-byte code points: the widest legal title
    // still fits the column, which is the point of carrying both limits.
    const widest = "😀".repeat(DIGEST_TITLE_MAX_CODE_POINTS);
    expect(new TextEncoder().encode(widest).length).toBe(
      DIGEST_TITLE_MAX_BYTES,
    );
    expect(
      sessionDigestSchema.safeParse({ ...digest, title: widest }).success,
    ).toBe(true);
  });

  test("the summary byte cap bites before its code-point cap", () => {
    const ascii = "a".repeat(DIGEST_SUMMARY_MAX_CODE_POINTS);
    expect(
      sessionDigestSchema.safeParse({ ...digest, summary: ascii }).success,
    ).toBe(true);
    expect(
      sessionDigestSchema.safeParse({ ...digest, summary: `${ascii}a` })
        .success,
    ).toBe(false);
    // 513 emoji are only 513 of the 600 allowed code points, and 2052 bytes.
    const overBytes = "😀".repeat(DIGEST_SUMMARY_MAX_BYTES / 4 + 1);
    expect([...overBytes].length).toBeLessThan(DIGEST_SUMMARY_MAX_CODE_POINTS);
    expect(
      sessionDigestSchema.safeParse({ ...digest, summary: overBytes }).success,
    ).toBe(false);
    expect(
      sessionDigestSchema.safeParse({
        ...digest,
        summary: "😀".repeat(DIGEST_SUMMARY_MAX_BYTES / 4),
      }).success,
    ).toBe(true);
  });

  test("keeps cost as a decimal string, never a float", () => {
    expect(
      sessionDigestSchema.safeParse({ ...digest, cost_usd: 0.41 }).success,
    ).toBe(false);
    expect(
      sessionDigestSchema.safeParse({ ...digest, cost_usd: "1e-2" }).success,
    ).toBe(false);
  });

  test("uses the alpha admission and status vocabularies", () => {
    expect(
      sessionDigestSchema.safeParse({ ...digest, admission_state: "idle" })
        .success,
    ).toBe(false);
    expect(
      sessionDigestSchema.safeParse({ ...digest, status: "closed" }).success,
    ).toBe(false);
    expect(
      sessionDigestSchema.safeParse({ ...digest, waiting_reason: "review" })
        .success,
    ).toBe(false);
    expect(
      sessionDigestSchema.safeParse({ ...digest, waiting_reason: "permission" })
        .success,
    ).toBe(true);
  });

  test("the API projection drops the summarizer's bookkeeping", () => {
    const {
      source_session_revision: _revision,
      summarized_turn_sequence: _sequence,
      last_summarized_turn_id: _turnId,
      ...view
    } = digest;
    const parsed = sessionDigestViewSchema.parse({ ...view, unread: true });
    expect(parsed.unread).toBe(true);
    expect(Object.hasOwn(parsed, "source_session_revision")).toBe(false);
  });
});
