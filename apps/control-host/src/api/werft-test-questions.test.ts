import { describe, expect, test } from "bun:test";
import { werftMcpToolNames } from "@werft-ai/platform";
import { installedWerftDocs } from "./werft-docs.ts";
import { werftMcpParts } from "./werft-mcp.ts";
import { WERFT_TEST_QUESTIONS } from "./werft-test-questions.ts";

describe("the test questions about Werft", () => {
  test("are ten, each once", () => {
    expect(WERFT_TEST_QUESTIONS).toHaveLength(10);
    const ids = WERFT_TEST_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(10);
    const questions = WERFT_TEST_QUESTIONS.map((q) => q.question);
    expect(new Set(questions).size).toBe(10);
  });

  test("name only tools the shipped server serves", () => {
    // Listing the parts reads nothing: the stores are asked only on a call.
    const served = werftMcpToolNames(
      werftMcpParts({ version: "test" }, {
        db: {},
        authorization: {},
      } as never),
    );
    for (const q of WERFT_TEST_QUESTIONS) {
      expect(q.tools.length).toBeGreaterThan(0);
      for (const tool of q.tools) expect(served).toContain(tool);
      expect(q.status === undefined || q.tools.includes("get_status")).toBe(
        true,
      );
    }
  });

  test("name only docs pages this version carries, in the question's language or the Korean original", () => {
    const pages = new Set(installedWerftDocs().map((file) => file.path));
    for (const q of WERFT_TEST_QUESTIONS) {
      for (const doc of q.docs) {
        expect(
          pages.has(`${doc}.${q.language}.mdx`) || pages.has(`${doc}.mdx`),
        ).toBe(true);
      }
      expect(q.docs.length > 0 || !q.tools.includes("search_docs")).toBe(true);
    }
  });
});
