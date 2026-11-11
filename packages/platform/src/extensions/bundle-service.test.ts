import { describe, expect, test } from "bun:test";
import { packBundleTar } from "@werft-ai/runtime-core";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import type {
  ExtensionBundle,
  ExtensionBundleStore,
  RegisterExtensionBundleResult,
} from "../ports/extension-bundle-store.ts";
import {
  BundleIntegrityError,
  bundleObjectKey,
  createExtensionBundleService,
} from "./bundle-service.ts";
import type { BundleInputFile } from "./bundle-validator.ts";

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DENIED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const text = (value: string) => new TextEncoder().encode(value);
const file = (path: string, content: string): BundleInputFile => ({
  path,
  kind: "file",
  mode: 0o644,
  bytes: text(content),
});
const skill = `---\nname: research\ndescription: Use for research\n---\nDo it.\n`;
const clean = () => [file("skills/research/SKILL.md", skill)];
const principal = (ownerId: string) => ({ ownerId });

/** Rows only; the Postgres store's behaviour is in extension-bundles.integration.test.ts. */
function fakeStore() {
  const rows: ExtensionBundle[] = [];
  const store: ExtensionBundleStore = {
    async find(workspaceId, id) {
      return (
        rows.find((r) => r.workspaceId === workspaceId && r.id === id) ?? null
      );
    },
    async findByDigest(workspaceId, digest) {
      return (
        rows.find(
          (r) => r.workspaceId === workspaceId && r.digest === digest,
        ) ?? null
      );
    },
    async list(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId);
    },
    async mayManage({ principal }) {
      return principal.ownerId === DENIED ? "outranked" : "ok";
    },
    async register(input): Promise<RegisterExtensionBundleResult> {
      const existing = rows.find(
        (r) => r.workspaceId === input.workspaceId && r.digest === input.digest,
      );
      if (existing) return { outcome: "already_registered", bundle: existing };
      const bundle: ExtensionBundle = {
        id: input.id,
        workspaceId: input.workspaceId,
        name: input.name,
        digest: input.digest,
        label: input.label,
        source: input.source,
        sizeBytes: input.sizeBytes,
        manifest: input.manifest,
        review: "pending",
        registeredBy: "u1",
        registeredAt: new Date(0),
        reviewedBy: null,
        reviewedAt: null,
      };
      rows.push(bundle);
      return { outcome: "registered", bundle, receiptId: input.receiptId };
    },
    async review() {
      return { outcome: "not_found" };
    },
    async recordAttachment() {
      return { outcome: "bundle_not_found" };
    },
    async listAttachments() {
      return [];
    },
  };
  return { store, rows };
}

function setup() {
  const { store, rows } = fakeStore();
  const objects = createMemoryCheckpointObjectStore();
  let n = 0;
  const service = createExtensionBundleService({
    store,
    objects,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  return { service, rows, objects, store };
}

const register = (
  service: ReturnType<typeof setup>["service"],
  files: BundleInputFile[],
  workspace = WS_A,
) =>
  service.register({
    principal: principal(workspace),
    slug: "acme",
    files,
    label: "Acme research",
    source: "upload",
  });

describe("register", () => {
  test("stores the tar under the workspace's key and the row under its digest", async () => {
    const { service, rows, objects } = setup();
    const result = await register(service, clean());
    if (result.outcome !== "registered") throw new Error(result.outcome);
    const key = bundleObjectKey(WS_A, result.bundle.digest);
    expect(key).toBe(`workspaces/${WS_A}/bundles/${result.bundle.digest}.tar`);
    expect(objects.keys()).toEqual([key]);
    expect(rows).toHaveLength(1);
    expect((await objects.get(key))?.byteLength).toBe(result.bundle.sizeBytes);
  });

  test.each([
    ["hooks/hooks.json", "{}"],
    ["skills/research/hooks/hooks.json", "{}"],
    [".mcp.json", "{}"],
    ["skills/research/.mcp.json", "{}"],
    ["bin/run", "#!/bin/sh\n"],
    ["skills/research/bin/run", "#!/bin/sh\n"],
  ])("a bundle carrying %s cannot be stored", async (path, content) => {
    const { service, rows, objects } = setup();
    const result = await register(service, [...clean(), file(path, content)]);
    expect(result.outcome).toBe("rejected");
    expect(rows).toEqual([]);
    expect(objects.keys()).toEqual([]);
  });

  test("a bundle whose rebuilt tree would pass the file limit is refused, not stored unreadable", async () => {
    const { service, rows, objects } = setup();
    // 256 files in: the validator accepts them, then adds plugin.json.
    const files = [
      ...clean(),
      ...Array.from({ length: 255 }, (_, i) =>
        file(`skills/research/notes-${i}.md`, `n${i}\n`),
      ),
    ];
    const result = await register(service, files);
    expect(result.outcome).toBe("rejected");
    expect(rows).toEqual([]);
    expect(objects.keys()).toEqual([]);
    // One fewer fits, and reads back.
    const fits = await register(service, files.slice(0, 255));
    if (fits.outcome !== "registered") throw new Error(fits.outcome);
    expect((await service.read(WS_A, fits.bundle.digest))?.files).toHaveLength(
      256,
    );
  });

  test("an actor who may not manage bundles leaves no object behind", async () => {
    const { service, rows, objects } = setup();
    const result = await register(service, clean(), DENIED);
    expect(result.outcome).toBe("outranked");
    expect(rows).toEqual([]);
    expect(objects.keys()).toEqual([]);
  });

  test("the same content again is the same version and writes nothing new", async () => {
    const { service, rows, objects } = setup();
    const first = await register(service, clean());
    const second = await register(service, [...clean()].reverse());
    expect(first.outcome).toBe("registered");
    expect(second.outcome).toBe("already_registered");
    expect(rows).toHaveLength(1);
    expect(objects.keys()).toHaveLength(1);
  });

  test("the same content in two workspaces is two objects", async () => {
    const { service, objects } = setup();
    await register(service, clean(), WS_A);
    await register(service, clean(), WS_B);
    expect(objects.keys()).toHaveLength(2);
  });
});

describe("read", () => {
  test("returns the validated bundle for its own workspace only", async () => {
    const { service } = setup();
    const result = await register(service, clean());
    if (result.outcome !== "registered") throw new Error(result.outcome);
    const digest = result.bundle.digest;
    expect((await service.read(WS_A, digest))?.digest).toBe(digest);
    expect(await service.read(WS_B, digest)).toBeNull();
  });

  test("an object swapped under the digest fails closed", async () => {
    const { service, objects } = setup();
    const result = await register(service, clean());
    if (result.outcome !== "registered") throw new Error(result.outcome);
    const key = bundleObjectKey(WS_A, result.bundle.digest);
    await objects.overwrite(
      key,
      packBundleTar([
        {
          path: "skills/research/SKILL.md",
          mode: 0o644,
          bytes: text(skill.replace("Do it.", "Do something else.")),
        },
      ]),
    );
    await expect(service.read(WS_A, result.bundle.digest)).rejects.toThrow(
      BundleIntegrityError,
    );
  });

  test("a tar that gained hooks after it was stored fails closed", async () => {
    const { service, objects } = setup();
    const result = await register(service, clean());
    if (result.outcome !== "registered") throw new Error(result.outcome);
    await objects.overwrite(
      bundleObjectKey(WS_A, result.bundle.digest),
      packBundleTar([
        { path: "skills/research/SKILL.md", mode: 0o644, bytes: text(skill) },
        { path: "hooks/hooks.json", mode: 0o644, bytes: text("{}") },
      ]),
    );
    await expect(service.read(WS_A, result.bundle.digest)).rejects.toThrow(
      "no longer validates",
    );
  });

  test("a missing object fails closed", async () => {
    const { service, objects } = setup();
    const result = await register(service, clean());
    if (result.outcome !== "registered") throw new Error(result.outcome);
    objects.remove(bundleObjectKey(WS_A, result.bundle.digest));
    await expect(service.read(WS_A, result.bundle.digest)).rejects.toThrow(
      "missing",
    );
  });

  test("a garbage object fails closed", async () => {
    const { service, objects } = setup();
    const result = await register(service, clean());
    if (result.outcome !== "registered") throw new Error(result.outcome);
    await objects.overwrite(
      bundleObjectKey(WS_A, result.bundle.digest),
      new Uint8Array(512).fill(7),
    );
    await expect(service.read(WS_A, result.bundle.digest)).rejects.toThrow(
      BundleIntegrityError,
    );
  });
});

describe("bundleObjectKey", () => {
  test("refuses an id or digest that could add a path segment", () => {
    const digest = "a".repeat(64);
    expect(() => bundleObjectKey(`${WS_A}/../${WS_B}`, digest)).toThrow();
    expect(() => bundleObjectKey(WS_A.toUpperCase(), digest)).toThrow();
    expect(() => bundleObjectKey(WS_A, `${digest}/../x`)).toThrow();
    expect(() => bundleObjectKey(WS_A, "A".repeat(64))).toThrow();
  });
});
