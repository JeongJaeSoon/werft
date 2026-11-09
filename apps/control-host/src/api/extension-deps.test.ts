import { expect, test } from "bun:test";
import { installedRuntimes } from "./catalog-config.ts";

test("the installed Claude runtime offers skills, so a bundle is no longer refused for the runtime", () => {
  expect(installedRuntimes.offers("claude_agent_sdk", "skills")).toBe(true);
});
