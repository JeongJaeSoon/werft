import { describe, expect, test } from "bun:test";
import type { SessionEventPayload } from "@werft-ai/contracts";
import { digestParts } from "@werft-ai/runtime-codec-kit";
import {
  type CheckpointManifest,
  featureSupport,
  unmetFeatures,
} from "@werft-ai/runtime-core";

import {
  CODEX_CHECKPOINT_ENGINE,
  CODEX_RUNTIME_FINGERPRINT,
  codexCheckpointCodec,
} from "./checkpoint-codec.ts";
import { CODEX_DESCRIPTOR } from "./descriptor.ts";
import { codexEventCodec } from "./event-codec.ts";

const runtime = { ...CODEX_RUNTIME_FINGERPRINT, profileSha256: "a".repeat(64) };

function manifest(overrides: Partial<CheckpointManifest> = {}) {
  const parts = [{ bytes: 42, key: "t/rollout/a", sha256: "b".repeat(64) }];
  return {
    createdAt: "2026-11-10T00:00:00.000Z",
    cwd: "/workspace",
    engine: CODEX_CHECKPOINT_ENGINE,
    resume: "01a1c572-5499-7fa1-9352-1b3392fba7f7",
    revision: 1,
    runtime,
    sessionId: "session-1",
    transcripts: {
      root: { entryCount: 3, parts, sha256: digestParts(parts) },
      subagents: {},
    },
    version: 2,
    workspace: {
      bundle: { bytes: 1, key: "t/bundle", sha256: "c".repeat(64) },
      gitCommit: "d".repeat(40),
      untracked: [],
    },
    ...overrides,
  } satisfies CheckpointManifest;
}

describe("codex checkpoint codec", () => {
  test("round-trips a manifest byte for byte", () => {
    const encoded = codexCheckpointCodec.encode(manifest());
    expect(codexCheckpointCodec.decode(encoded.bytes)).toEqual(manifest());
    expect(codexCheckpointCodec.encode(manifest()).sha256).toBe(encoded.sha256);
  });

  test("refuses a manifest of another engine, naming Codex", () => {
    const claude = new TextEncoder().encode(
      JSON.stringify({ ...manifest(), engine: "claude" }),
    );
    expect(() => codexCheckpointCodec.decode(claude)).toThrow(
      /Invalid Codex checkpoint manifest/,
    );
  });

  test("refuses a part list edited after capture", () => {
    const parts = [
      { bytes: 9, key: "t/rollout/other", sha256: "e".repeat(64) },
    ];
    const edited = manifest();
    const bytes = codexCheckpointCodec.encode({
      ...edited,
      transcripts: {
        ...edited.transcripts,
        root: { ...edited.transcripts.root, parts },
      },
    }).bytes;
    expect(() => codexCheckpointCodec.decode(bytes)).toThrow(
      /does not match its digest/,
    );
  });

  test("holds a restore to the pinned build", () => {
    expect(
      codexCheckpointCodec.validateCompatibility(manifest(), runtime),
    ).toEqual({ status: "compatible" });
    const verdict = codexCheckpointCodec.validateCompatibility(manifest(), {
      ...runtime,
      cliVersion: "0.168.0",
    });
    expect(verdict.status).toBe("incompatible");
  });
});

describe("codex descriptor", () => {
  test("declares what the engine cannot do instead of faking it", () => {
    const { capabilities } = CODEX_DESCRIPTOR;
    expect(capabilities.approvalCheckpoint).toBe(false);
    expect(capabilities.mcp).toBe("none");
    expect(capabilities.skills).toBe("none");
    expect(capabilities.permissionModes.plan).toBe("none");
    expect(capabilities.permissionModes.auto).toBe("none");
    expect(
      featureSupport(
        capabilities,
        CODEX_DESCRIPTOR.extraFeatures,
        "approval_park",
      ),
    ).toBe("none");
    expect(
      unmetFeatures(capabilities, CODEX_DESCRIPTOR.extraFeatures, {
        features: ["mcp", "skills", "classifier_review", "approval_park"],
      }),
    ).toEqual(["mcp", "skills", "classifier_review", "approval_park"]);
  });
});

describe("codex event codec", () => {
  test("adds the neutral fields to a result and names the runtime", () => {
    const event = {
      event: "result",
      data: {
        type: "result",
        subtype: "success",
        session_id: "thread-1",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    } as SessionEventPayload;
    expect(codexEventCodec.withNeutralFields(event)).toMatchObject({
      data: {
        turn: { outcome: "success", is_error: false, tokens: 15 },
        runtime: { kind: "codex_app_server", session_ref: "thread-1" },
      },
    });
  });
});
