import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BUNDLE_LIMITS,
  validateExtensionBundle,
} from "@werft-ai/platform";
import { parse } from "yaml";

/**
 * The engine reads a skill's frontmatter as YAML; its parser is not in this
 * repository, so a YAML 1.2 parser stands in for it. A description uploaded as
 * a block scalar is stored as one JSON-quoted line, which YAML must read back
 * to the value it read from the upload.
 */
const head = (text: string) => {
  // The break before the closing --- belongs to the last value.
  const match = /^---\n([\s\S]*?\n)---\n/.exec(text);
  if (match === null) throw new Error("no frontmatter");
  return parse(match[1] as string) as Record<string, unknown>;
};

describe("a stored block scalar description reads as YAML read the upload", () => {
  const ls = String.fromCharCode(0x2028);
  test.each([
    ["|", "  One.\n    Two, indented.\n\n  Three.\n", "license: MIT\n"],
    ["|-", "  One.\n  Two.\n\n", "license: MIT\n"],
    [
      ">",
      "  Folded\n  line.\n\n  Paragraph.\n    Kept.\n  End.\n",
      "license: MIT\n",
    ],
    [">-", "  Folded\n  line.\n\n\n  Two breaks.\n", "license: MIT\n"],
    [
      "|-",
      `  Tab\there, "quotes", a back\\slash and ${ls}.\n`,
      "license: MIT\n",
    ],
    ["|", "  Right before the closing line.\n", ""],
    [">", "  Right before\n  the closing line.\n", ""],
  ])("%s", (header, lines, after) => {
    const upload = `---\nname: research\ndescription: ${header}\n${lines}${after}---\nBody.\n`;
    const result = validateExtensionBundle(
      {
        slug: "research",
        files: [
          {
            path: "skills/research/SKILL.md",
            kind: "file",
            mode: 0o644,
            bytes: new TextEncoder().encode(upload),
          },
        ],
      },
      DEFAULT_BUNDLE_LIMITS,
      "upload",
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const stored = new TextDecoder().decode(
      result.bundle.files.find((f) => f.path === "skills/research/SKILL.md")
        ?.bytes,
    );
    const want = head(upload);
    expect(head(stored)).toEqual(want);
    expect(typeof want.description).toBe("string");
  });
});
