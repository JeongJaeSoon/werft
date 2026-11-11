import { describe, expect, test } from "bun:test";
import { digestParts } from "@werft-ai/runtime-codec-kit";
import type { CheckpointManifest } from "@werft-ai/runtime-core";
import {
  CLAUDE_RUNTIME_FINGERPRINT,
  claudeCheckpointCodec,
  decodeCheckpointManifest,
  encodeCheckpointManifest,
  validateCompatibility,
} from "./checkpoint-codec.ts";

const profileSha256 = "a".repeat(64);
const runtime = { ...CLAUDE_RUNTIME_FINGERPRINT, profileSha256 };

function revision(key: string) {
  const parts = [{ bytes: 42, key, sha256: "b".repeat(64) }];
  return { entryCount: 1, parts, sha256: digestParts(parts) };
}

function manifest(
  overrides: Partial<CheckpointManifest> = {},
): CheckpointManifest {
  return {
    createdAt: "2026-09-22T00:00:00.000Z",
    cwd: "/workspace",
    engine: "claude",
    resume: "sdk-session-1",
    revision: 3,
    runtime,
    sessionId: "session-1",
    transcripts: {
      root: revision("root/part-1.jsonl"),
      subagents: { "agents/reviewer": revision("sub/part-1.jsonl") },
    },
    version: 2,
    workspace: {
      bundle: {
        bytes: 1024,
        key: "sessions/s1/workspace/workspace.bundle",
        sha256: "c".repeat(64),
      },
      gitCommit: "0".repeat(40),
      untracked: [
        {
          bytes: 7,
          key: "sessions/s1/workspace/n",
          path: "notes.md",
          sha256: "b".repeat(64),
        },
      ],
    },
    ...overrides,
  };
}

const STORED_MANIFEST = JSON.parse(
  '{"createdAt":"2026-09-22T00:00:00.000Z","cwd":"/workspace","engine":"claude","resume":"sdk-session-1","revision":3,"runtime":{"cliVersion":"2.1.270","engine":"claude","profileSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sdkVersion":"0.3.270"},"sessionId":"session-1","transcripts":{"root":{"entryCount":1,"parts":[{"bytes":42,"key":"root/part-1.jsonl","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","version":"v1"}],"sha256":"8dee112f10b72c98a7dcbb4ee385d7eb99cfb8d19f7aea457b5362ae8a0e7f72"},"subagents":{"subagents/agent-a1b2":{"entryCount":1,"parts":[{"bytes":42,"key":"sub/a.jsonl","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","version":"v1"}],"sha256":"9a2dcedff2e1deb0b3159af0a4fd193a53033c4771fddaa0a0a8e5a7c62ceb45"},"subagents/agent-a1b2c3":{"entryCount":1,"parts":[{"bytes":42,"key":"sub/b.jsonl","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","version":"v1"}],"sha256":"c1f1788862c1f8a8b3fc7f778d9f7cd69fb4175634179350b3ffa5a989a5aa2f"}}},"version":2,"workspace":{"baseBundles":[{"bytes":10,"key":"base.bundle","sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","version":"v0"}],"bundle":{"bytes":1024,"key":"workspace.bundle","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","version":"v2"},"gitCommit":"0000000000000000000000000000000000000000","untracked":[{"bytes":7,"executable":true,"key":"n","path":"bin/run.sh","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}}',
);

describe("Claude checkpoint codec", () => {
  test("round-trips a manifest", () => {
    const original = manifest();

    const { bytes } = encodeCheckpointManifest(original);

    expect(decodeCheckpointManifest(bytes)).toEqual(original);
  });

  test("round-trips a bundle built on two earlier ones, oldest first", () => {
    const base = manifest().workspace;
    const link = (name: string, sha: string) => ({
      bytes: 512,
      key: `sessions/s1/checkpoints/${name}/workspace.bundle`,
      sha256: sha.repeat(64),
    });
    const original = manifest({
      workspace: {
        ...base,
        baseBundles: [link("0", "d"), { ...link("1", "e"), version: "v1" }],
      },
    });

    const decoded = decodeCheckpointManifest(
      encodeCheckpointManifest(original).bytes,
    );

    expect(decoded).toEqual(original);
    expect(() =>
      decodeCheckpointManifest(
        encodeCheckpointManifest(
          manifest({ workspace: { ...base, baseBundles: [] } }),
        ).bytes,
      ),
    ).toThrow();
  });

  test("round-trips the object versions a writer pinned", () => {
    const parts = [
      {
        bytes: 42,
        key: "root/part-1.jsonl",
        sha256: "b".repeat(64),
        version: "3sL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY",
      },
    ];
    const original = manifest({
      transcripts: {
        root: { entryCount: 1, parts, sha256: digestParts(parts) },
        subagents: {},
      },
      workspace: {
        ...manifest().workspace,
        bundle: { ...manifest().workspace.bundle, version: "bundle-v1" },
      },
    });

    const decoded = decodeCheckpointManifest(
      encodeCheckpointManifest(original).bytes,
    );

    expect(decoded).toEqual(original);
    expect(decoded.transcripts.root.parts[0]?.version).toBe(
      "3sL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY",
    );
    // A version is not part of what the part-list digest pins: the manifest
    // digest already covers it, and the mirror computes the list digest
    // before any writer could know one.
    expect(digestParts(parts)).toBe(
      digestParts(parts.map(({ version: _v, ...rest }) => rest)),
    );
  });

  test("accepts a manifest without versions; whether one is required is the control plane's call", () => {
    const original = manifest();
    expect(original.workspace.bundle).not.toHaveProperty("version");
    expect(
      decodeCheckpointManifest(encodeCheckpointManifest(original).bytes),
    ).toEqual(original);
  });

  test.each(["x".repeat(1024), "has space", "버전-🙂"])(
    "accepts the opaque object version %p",
    (version) => {
      const original = manifest();
      const edited = {
        ...original,
        workspace: {
          ...original.workspace,
          bundle: { ...original.workspace.bundle, version },
        },
      };
      expect(
        decodeCheckpointManifest(encodeCheckpointManifest(edited).bytes)
          .workspace.bundle.version,
      ).toBe(version);
    },
  );

  test.each([
    ["null", /immutable version/],
    ["", /version/],
    ["x".repeat(1025), /1024 bytes/],
    // 342 characters, 1026 bytes: the limit is S3's, in UTF-8 bytes.
    ["한".repeat(342), /1024 bytes/],
  ])("refuses the object version %p", (version, message) => {
    const { bytes } = encodeCheckpointManifest(manifest());
    const edited = JSON.parse(new TextDecoder().decode(bytes));
    edited.workspace.bundle.version = version;

    expect(() =>
      decodeCheckpointManifest(
        new TextEncoder().encode(JSON.stringify(edited)),
      ),
    ).toThrow(message);
  });

  test("encodes the same manifest to the same bytes whatever the key order", () => {
    const ordered = manifest();
    const shuffled = Object.fromEntries(
      Object.entries(ordered).reverse(),
    ) as CheckpointManifest;

    expect(encodeCheckpointManifest(shuffled)).toEqual(
      encodeCheckpointManifest(ordered),
    );
  });

  // Bytes written by the legacy localeCompare encoder, as they sit in the
  // object store: a stored manifest must still hash to its row's digest, and
  // decoding and re-encoding it must write the same bytes. A stored manifest
  // is verified by the digest of its bytes, never re-encoded; only subagent
  // labels differing in case or `_` would re-encode in another order.
  test("a manifest stored before the shared canonical JSON still verifies and re-encodes to the same bytes", () => {
    const stored = new TextEncoder().encode(
      `${JSON.stringify(STORED_MANIFEST)}\n`,
    );
    const digest =
      "0cc8eb21516be6ef67fe8d81457450971676649aacf522a52ad91a23d92b002a";
    expect(new Bun.CryptoHasher("sha256").update(stored).digest("hex")).toBe(
      digest,
    );

    const reencoded = encodeCheckpointManifest(
      decodeCheckpointManifest(stored),
    );

    expect(reencoded.sha256).toBe(digest);
    expect(reencoded.bytes).toEqual(stored);
  });

  test("the reported digest is the digest of the encoded bytes", async () => {
    const { bytes, sha256 } = encodeCheckpointManifest(manifest());

    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
      sha256,
    );
  });

  test("carries an untracked file's execute bit only as true", () => {
    const base = manifest();
    const executable = manifest({
      workspace: {
        ...base.workspace,
        untracked: base.workspace.untracked.map((file) => ({
          ...file,
          executable: true as const,
        })),
      },
    });

    expect(
      decodeCheckpointManifest(encodeCheckpointManifest(executable).bytes),
    ).toEqual(executable);
    const body = JSON.parse(
      new TextDecoder().decode(encodeCheckpointManifest(base).bytes),
    );
    body.workspace.untracked[0].executable = false;
    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("reads a manifest from before outputs, and leaves the field out of it", () => {
    const stored = new TextEncoder().encode(
      `${JSON.stringify(STORED_MANIFEST)}\n`,
    );

    const decoded = decodeCheckpointManifest(stored);

    expect("outputs" in decoded).toBe(false);
    expect(encodeCheckpointManifest(decoded).bytes).toEqual(stored);
  });

  test("round-trips stored and too-large outputs", () => {
    const original = manifest({
      outputs: [
        {
          bytes: 12,
          key: `sessions/s1/checkpoints/p/outputs/${"e".repeat(64)}`,
          path: "out/report.md",
          sha256: "e".repeat(64),
          version: "v3",
        },
        { bytes: 70_000_000, omitted: "too_large", path: "out/video.mp4" },
      ],
    });

    expect(
      decodeCheckpointManifest(encodeCheckpointManifest(original).bytes),
    ).toEqual(original);
  });

  test.each([
    ["a field this build does not know", { path: "out/a", future: 1 }],
    ["a path outside out/", { path: "notes/a" }],
    ["a climbing path", { path: "out/../secret" }],
    ["a path into .git", { path: "out/.git/config" }],
    ["a too-large entry that also names an object", { omitted: "too_large" }],
  ])("refuses an output with %s", (_, edit) => {
    const body = JSON.parse(
      new TextDecoder().decode(
        encodeCheckpointManifest(
          manifest({
            outputs: [
              {
                bytes: 1,
                key: `sessions/s1/checkpoints/p/outputs/${"e".repeat(64)}`,
                path: "out/a",
                sha256: "e".repeat(64),
              },
            ],
          }),
        ).bytes,
      ),
    );
    body.outputs[0] = { ...body.outputs[0], ...edit };

    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("round-trips the requests a parked turn waited on, arguments unredacted", () => {
    const original = manifest({
      workerState: {
        pendingApprovals: [
          {
            input: { command: "deploy --token=s3cret", env: { A: [1, null] } },
            inputHash: "f".repeat(64),
            kind: "permission",
            requestId: "req_1",
            tool: "Bash",
            toolCallId: "toolu_1",
          },
        ],
      },
    });

    expect(
      decodeCheckpointManifest(encodeCheckpointManifest(original).bytes),
    ).toEqual(original);
    expect(
      "workerState" in
        decodeCheckpointManifest(encodeCheckpointManifest(manifest()).bytes),
    ).toBe(false);
  });

  test.each([
    ["an empty request list", { pendingApprovals: [] }],
    [
      "a field this build does not know",
      {
        pendingApprovals: [
          {
            input: {},
            inputHash: "f".repeat(64),
            kind: "permission",
            requestId: "req_1",
            tool: "Bash",
            toolCallId: "toolu_1",
            answer: "allow",
          },
        ],
      },
    ],
  ])("refuses worker state with %s", (_, workerState) => {
    const body = {
      ...JSON.parse(
        new TextDecoder().decode(encodeCheckpointManifest(manifest()).bytes),
      ),
      workerState,
    };

    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("round-trips the worker's attribution findings, and leaves the field out when there are none", () => {
    const found = {
      attribution: {
        mismatches: [{ commit: "a".repeat(40), problems: ["author" as const] }],
      },
    };
    const original = { ...manifest(), ...found };
    expect(
      decodeCheckpointManifest(encodeCheckpointManifest(original).bytes),
    ).toEqual(original);
    const clean = new TextDecoder().decode(
      encodeCheckpointManifest(manifest()).bytes,
    );
    expect(clean).not.toContain("attribution");
  });

  test.each([
    ["an empty list", { mismatches: [] }],
    [
      "an unknown problem",
      { mismatches: [{ commit: "a".repeat(40), problems: ["mood"] }] },
    ],
    [
      "a commit that is not a full sha",
      { mismatches: [{ commit: "abc", problems: ["author"] }] },
    ],
  ])("refuses attribution findings with %s", (_, attribution) => {
    const body = {
      ...JSON.parse(
        new TextDecoder().decode(encodeCheckpointManifest(manifest()).bytes),
      ),
      attribution,
    };
    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("refuses bytes that are not a manifest", () => {
    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode("not json")),
    ).toThrow(/not JSON/);
  });

  test("refuses a manifest carrying a field this build does not know", () => {
    const { bytes } = encodeCheckpointManifest(manifest());
    const extended = {
      ...JSON.parse(new TextDecoder().decode(bytes)),
      futureField: 1,
    };

    expect(() =>
      decodeCheckpointManifest(
        new TextEncoder().encode(JSON.stringify(extended)),
      ),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("refuses a manifest whose part list was edited after capture", () => {
    const { bytes } = encodeCheckpointManifest(manifest());
    const body = JSON.parse(new TextDecoder().decode(bytes));
    body.transcripts.root.parts.push({
      bytes: 1,
      key: "smuggled.jsonl",
      sha256: "d".repeat(64),
    });

    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/part list does not match its digest/);
  });

  test("refuses a subagent revision whose part list was edited", () => {
    const { bytes } = encodeCheckpointManifest(manifest());
    const body = JSON.parse(new TextDecoder().decode(bytes));
    body.transcripts.subagents["agents/reviewer"].parts = [];

    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("refuses a subagent label that is not a safe relative subpath", () => {
    for (const label of [
      "../escape",
      "a/../b",
      "/abs",
      "a//b",
      "./a",
      "a\\b",
    ]) {
      const { bytes } = encodeCheckpointManifest(manifest());
      const body = JSON.parse(new TextDecoder().decode(bytes));
      body.transcripts.subagents = {
        [label]: body.transcripts.subagents["agents/reviewer"],
      };
      expect(() =>
        decodeCheckpointManifest(
          new TextEncoder().encode(JSON.stringify(body)),
        ),
      ).toThrow(/Invalid Claude checkpoint manifest/);
    }
  });

  test("refuses a version 1 manifest instead of reading it as this shape", () => {
    // Version 1 pinned a commit with no bundle behind it. Decoding one here
    // would mean inventing a bundle that was never uploaded, so the version
    // literal is what rejects it — not a missing-field error further down.
    const { bytes } = encodeCheckpointManifest(manifest());
    const body = JSON.parse(new TextDecoder().decode(bytes));
    body.version = 1;
    delete body.workspace.bundle;

    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("refuses a manifest whose workspace commit is not a full sha", () => {
    expect(() =>
      encodeCheckpointManifest(
        manifest({
          workspace: { ...manifest().workspace, gitCommit: "abc1234" },
        }),
      ),
    ).toThrow();
  });

  test("refuses a manifest that pins a commit without the bundle carrying it", () => {
    // The commit alone is unverifiable, so a manifest that omits the bundle is
    // not a manifest this codec will produce or accept.
    const { bundle: _bundle, ...workspace } = manifest().workspace;

    expect(() =>
      encodeCheckpointManifest(
        manifest({ workspace: workspace as CheckpointManifest["workspace"] }),
      ),
    ).toThrow(/bundle/);
  });

  test("accepts a manifest written by the same runtime", () => {
    expect(validateCompatibility(manifest(), runtime)).toEqual({
      status: "compatible",
    });
  });

  test("reports every version and profile field that moved", () => {
    const stale = manifest({
      runtime: {
        cliVersion: "2.0.0",
        engine: "claude",
        profileSha256: "d".repeat(64),
        sdkVersion: "0.3.100",
      },
    });

    expect(validateCompatibility(stale, runtime)).toEqual({
      status: "incompatible",
      mismatches: [
        { expected: runtime.sdkVersion, field: "sdkVersion", found: "0.3.100" },
        { expected: runtime.cliVersion, field: "cliVersion", found: "2.0.0" },
        {
          expected: profileSha256,
          field: "profileSha256",
          found: "d".repeat(64),
        },
      ],
    });
  });

  test("the codec exposes the engine it decodes", () => {
    expect(claudeCheckpointCodec.engine).toBe("claude");
    expect(
      claudeCheckpointCodec.decode(encodeCheckpointManifest(manifest()).bytes),
    ).toEqual(manifest());
  });
});
