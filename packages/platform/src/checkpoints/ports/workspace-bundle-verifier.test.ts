import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createGitBundle,
  verifyBundleBytes,
} from "@werft-ai/testkit/git-bundle";

import {
  rejectUnverifiedWorkspaceBundles,
  structuralBundleVerifier,
} from "./workspace-bundle-verifier.ts";

const real = await createGitBundle();

/**
 * A bundle nothing but git could tell from the real thing by inspection: a
 * correct header naming `commit`, a packfile header claiming one object, a
 * payload that is not one, and a trailing checksum computed over all of it.
 */
function fabricated(commit: string): Uint8Array {
  const header = new TextEncoder().encode(
    `# v2 git bundle\n${commit} refs/heads/main\n\n`,
  );
  const pack = new Uint8Array(12 + 1 + 20);
  pack.set(new TextEncoder().encode("PACK"));
  const view = new DataView(pack.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, 1);
  pack[12] = 0x9c;
  pack.set(createHash("sha1").update(pack.subarray(0, 13)).digest(), 13);
  const bytes = new Uint8Array(header.byteLength + pack.byteLength);
  bytes.set(header);
  bytes.set(pack, header.byteLength);
  return bytes;
}

describe("rejectUnverifiedWorkspaceBundles", () => {
  test("refuses even a bundle git itself wrote", async () => {
    // The default is about the deployment, not the object: until someone says
    // how bundles are verified here, no checkpoint is promoted.
    expect(
      await verifyBundleBytes(rejectUnverifiedWorkspaceBundles, {
        bytes: real.bytes,
        commit: real.commit,
        key: "sessions/s/checkpoints/0/a/workspace.bundle",
      }),
    ).toEqual({
      status: "unusable",
      reason: "no workspace bundle verifier configured",
    });
  });
});

describe("structuralBundleVerifier", () => {
  test("accepts a bundle git wrote for the commit it names", async () => {
    expect(
      await verifyBundleBytes(structuralBundleVerifier, {
        bytes: real.bytes,
        commit: real.commit,
        key: "sessions/s/checkpoints/0/a/workspace.bundle",
      }),
    ).toEqual({ status: "restorable" });
  });

  test("refuses a commit the bundle does not name", async () => {
    expect(
      await verifyBundleBytes(structuralBundleVerifier, {
        bytes: real.bytes,
        commit: "f".repeat(40),
        key: "sessions/s/checkpoints/0/a/workspace.bundle",
      }),
    ).toMatchObject({ status: "unusable" });
  });

  test("accepts a fabricated pack, which is exactly why it is not the default", async () => {
    // Pinning the known limit rather than hoping nobody finds it. Every field
    // this verifier reads is one the writer of the object chose, so a pack git
    // would reject at `index-pack` passes here — and the manifest's own digest
    // is no help, since the worker hashed these same bytes. Closing this needs
    // git; injects that verifier, and until then a deployment picking
    // this one is trusting its workers about their own commits.
    expect(
      await verifyBundleBytes(structuralBundleVerifier, {
        bytes: fabricated("a".repeat(40)),
        commit: "a".repeat(40),
        key: "sessions/s/checkpoints/0/a/workspace.bundle",
      }),
    ).toEqual({ status: "restorable" });
  });
});
