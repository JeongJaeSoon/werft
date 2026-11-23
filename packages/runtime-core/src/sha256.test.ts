import { expect, test } from "bun:test";
import { sha256Hex } from "./sha256.ts";

test("sha256Hex hashes a string as its UTF-8 bytes", () => {
  expect(sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(sha256Hex("é")).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])));
});
