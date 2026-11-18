import { expect, test } from "bun:test";
import { publicStatus } from "./public-status.ts";

test("a person's open request makes an in-flight or parked session needs_input, and only those", () => {
  expect(publicStatus("running", true)).toBe("needs_input");
  expect(publicStatus("idle", true)).toBe("needs_input");
  expect(publicStatus("queued", true)).toBe("queued");
  expect(publicStatus("stopped", true)).toBe("stopped");
});

test("with nothing to answer, a stored needs_input reads as running and the rest as stored", () => {
  expect(publicStatus("needs_input", false)).toBe("running");
  expect(publicStatus("running", false)).toBe("running");
  expect(publicStatus("idle", false)).toBe("idle");
});
