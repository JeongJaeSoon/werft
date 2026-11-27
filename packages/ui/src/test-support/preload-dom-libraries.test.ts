import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { useLayoutEffect } from "react";

// The copy of Radix's layout-effect module the dialog loads. Without the
// preload, this file run first in a process, or after a plain logic test that
// loads a component module, would get the no-op and dialogs would not mount.
const dialog = Bun.resolveSync("@radix-ui/react-dialog", import.meta.dir);
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  dirname(dialog),
);

test("Radix's layout effect is React's in every file of a run, DOM or not", async () => {
  expect(typeof document).toBe("undefined");
  const radix = await import(layoutEffect);
  expect(radix.useLayoutEffect).toBe(useLayoutEffect);
});

test("the preload gives its window back before any file runs", () => {
  expect(typeof window).toBe("undefined");
  expect(String(globalThis.fetch)).toContain("[native code]");
});
