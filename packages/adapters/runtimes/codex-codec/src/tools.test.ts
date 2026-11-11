import { expect, test } from "bun:test";
import { RUNTIME_FIXED_TOOLS } from "@werft-ai/contracts";
import { CODEX_DESCRIPTOR } from "./descriptor.ts";
import { CODEX_BUILTIN_TOOLS } from "./tools.ts";

test("a Codex release carries exactly the tools the adapter accepts", () => {
  expect(RUNTIME_FIXED_TOOLS[CODEX_DESCRIPTOR.kind]).toEqual([
    ...CODEX_BUILTIN_TOOLS,
  ]);
});
