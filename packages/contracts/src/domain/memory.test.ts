import { describe, expect, test } from "bun:test";
import {
  MEMORY_BODY_MAX_BYTES,
  memoryCandidateSchema,
  memoryDocumentSchema,
  memoryPromotionSchema,
  memoryRevisionSchema,
  resolveMemoryScope,
} from "./memory.ts";

const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000e1";
const DOCUMENT_ID = "019a0000-0000-7000-8000-0000000000e2";
const SESSION_ID = "019a0000-0000-7000-8000-0000000000e3";
const USER_ID = "019a0000-0000-7000-8000-0000000000e4";
const AGENT_ID = "019a0000-0000-7000-8000-0000000000e5";
const SOURCE_ID = "019a0000-0000-7000-8000-0000000000e6";
const HASH = "a".repeat(64);
const AT = "2026-11-20T01:00:00Z";

const document = {
  id: DOCUMENT_ID,
  workspace_id: WORKSPACE_ID,
  scope: "agent",
  session_id: null,
  subject_user_id: null,
  agent_id: AGENT_ID,
  state: "active",
  current_revision: 1,
  ancestor_ids: [],
  personal_subjects: [],
  expires_at: null,
  created_at: AT,
};

describe("memoryDocumentSchema", () => {
  test("each scope fills exactly its own key", () => {
    const keys = {
      session: { session_id: SESSION_ID },
      personal: { subject_user_id: USER_ID },
      agent: { agent_id: AGENT_ID },
      workspace: {},
    } as const;
    const empty = { session_id: null, subject_user_id: null, agent_id: null };
    for (const [scope, key] of Object.entries(keys)) {
      expect(
        memoryDocumentSchema.safeParse({ ...document, ...empty, ...key, scope })
          .success,
      ).toBe(true);
      expect(
        memoryDocumentSchema.safeParse({ ...document, ...empty, scope })
          .success,
      ).toBe(scope === "workspace");
      // A second key would let one row answer to two owners.
      expect(
        memoryDocumentSchema.safeParse({
          ...document,
          ...empty,
          ...key,
          scope,
          ...(scope === "session"
            ? { agent_id: AGENT_ID }
            : { session_id: SESSION_ID }),
        }).success,
      ).toBe(false);
    }
  });

  test("refuses a state outside the lifecycle", () => {
    expect(
      memoryDocumentSchema.safeParse({ ...document, state: "purged" }).success,
    ).toBe(false);
  });
});

describe("resolveMemoryScope", () => {
  test("refuses the space scope until shared spaces open", () => {
    expect(resolveMemoryScope("space")).toEqual({
      ok: false,
      reason: "space_scope_unavailable",
    });
    expect(resolveMemoryScope("personal")).toEqual({
      ok: true,
      scope: "personal",
    });
  });
});

describe("memoryRevisionSchema", () => {
  const revision = {
    document_id: DOCUMENT_ID,
    revision: 1,
    title: "Release notes",
    body: "Tag releases from main only.",
    body_sha256: HASH,
    scan_status: "unscanned",
    author_user_id: null,
    author_session_id: SESSION_ID,
    adopted_at: null,
    created_at: AT,
  };

  test("caps the body in bytes, not characters", () => {
    expect(memoryRevisionSchema.safeParse(revision).success).toBe(true);
    // 3 bytes per character: under the cap by length, over it in bytes.
    const body = "한".repeat(MEMORY_BODY_MAX_BYTES / 3 + 1);
    expect(memoryRevisionSchema.safeParse({ ...revision, body }).success).toBe(
      false,
    );
  });

  test("names who wrote it", () => {
    expect(
      memoryRevisionSchema.safeParse({ ...revision, author_session_id: null })
        .success,
    ).toBe(false);
  });
});

describe("candidate and promotion", () => {
  const candidate = {
    document_id: DOCUMENT_ID,
    source_session_id: SESSION_ID,
    source_document_id: null,
    source_revision: null,
    releaser_user_id: USER_ID,
    released_by: null,
    released_at: null,
    released_body_sha256: null,
    expires_at: AT,
    created_at: AT,
  };
  const promotion = {
    id: SOURCE_ID,
    workspace_id: WORKSPACE_ID,
    target_document_id: DOCUMENT_ID,
    target_revision: 1,
    target_scope: "agent",
    source_session_id: SESSION_ID,
    source_document_id: null,
    source_revision: null,
    source_body_sha256: null,
    released_body_sha256: HASH,
    released_by: USER_ID,
    released_at: AT,
    adopted_by: USER_ID,
    adopted_at: AT,
  };

  test("a release is recorded whole or not at all", () => {
    expect(memoryCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(
      memoryCandidateSchema.safeParse({ ...candidate, released_by: USER_ID })
        .success,
    ).toBe(false);
  });

  test("a promotion keeps the releaser and the adopter, and one source", () => {
    expect(memoryPromotionSchema.safeParse(promotion).success).toBe(true);
    expect(
      memoryPromotionSchema.safeParse({
        ...promotion,
        source_document_id: SOURCE_ID,
        source_revision: 1,
        source_body_sha256: HASH,
      }).success,
    ).toBe(false);
    expect(
      memoryPromotionSchema.safeParse({ ...promotion, target_scope: "session" })
        .success,
    ).toBe(false);
  });
});
