import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedWerftDocs } from "./werft-docs.ts";

describe("installedWerftDocs", () => {
  test("reads every MDX page of the checkout, in all three languages, by its path there", () => {
    const paths = installedWerftDocs().map((file) => file.path);
    expect(paths).toContain("index.mdx");
    expect(paths).toContain("integrations/github.en.mdx");
    expect(paths).toContain("integrations/github.ja.mdx");
    expect(paths.every((path) => path.endsWith(".mdx"))).toBe(true);
  });

  test("a directory without the docs stops the API instead of serving none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "werft-docs-"));
    try {
      await Bun.write(join(dir, "meta.json"), "{}");
      expect(() => installedWerftDocs(dir)).toThrow("No Werft documentation");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
