import { describe, expect, test } from "bun:test";
import {
  type BundleInputFile,
  type BundleIssueCode,
  bundleDigest,
  DEFAULT_BUNDLE_LIMITS,
  validateExtensionBundle,
} from "./bundle-validator.ts";

const text = (value: string) => new TextEncoder().encode(value);
const skillMd = (name: string, extra = "", body = "Do the thing.\n") =>
  `---\nname: ${name}\ndescription: Use for ${name}\n${extra}---\n${body}`;
const file = (
  path: string,
  content: string | Uint8Array,
  over: Partial<BundleInputFile> = {},
): BundleInputFile => ({
  path,
  kind: "file",
  mode: 0o644,
  bytes: typeof content === "string" ? text(content) : content,
  ...over,
});
const base = (): BundleInputFile[] => [
  file("skills/research/SKILL.md", skillMd("research")),
  file("skills/research/notes.md", "# notes\n"),
];
const validate = (files: BundleInputFile[], slug = "acme") =>
  validateExtensionBundle({ slug, files });

function rejected(files: BundleInputFile[]) {
  const result = validate(files);
  if (result.ok) throw new Error("expected the bundle to be rejected");
  return result.issues;
}
function expectIssue(
  files: BundleInputFile[],
  path: string,
  code: BundleIssueCode,
) {
  expect(rejected(files)).toContainEqual(
    expect.objectContaining({ path, code }),
  );
}

describe("allow-list", () => {
  test("a skill-only bundle is accepted and rebuilt around a platform plugin.json", () => {
    const result = validate(base());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.bundle.files.map((f) => f.path)).toEqual([
      ".claude-plugin/plugin.json",
      "skills/research/SKILL.md",
      "skills/research/notes.md",
    ]);
    expect(result.bundle.expectedSkills).toEqual(["acme:research"]);
    expect(result.bundle.manifest).toEqual({
      schema: 1,
      slug: "acme",
      skills: [{ name: "research", has_scripts: false }],
    });
    const plugin = result.bundle.files[0];
    expect(JSON.parse(new TextDecoder().decode(plugin?.bytes))).toEqual({
      name: "acme",
    });
  });

  test.each([
    ["hooks/hooks.json", '{"hooks":{}}'],
    ["hooks/run.sh", "echo"],
    ["hooks.json", "{}"],
    [".mcp.json", "{}"],
    ["bin/tool", "#!/bin/sh"],
    ["agents/a.md", "x"],
    ["commands/c.md", "x"],
    ["settings.json", "{}"],
    ["settings.local.json", "{}"],
    ["package.json", "{}"],
    ["node_modules/x/index.js", "x"],
    ["skills/research/hooks.json", "{}"],
    ["skills/research/package.json", "{}"],
    ["skills/research/bin/run", "x"],
    ["skills/research/.mcp.json", "{}"],
    ["skills/research/node_modules/a.js", "x"],
  ])("denied path %s is rejected with its path", (path, content) => {
    expectIssue([...base(), file(path, content)], path, "denied_path");
  });

  test("a path outside the list is rejected, not dropped", () => {
    expectIssue(
      [...base(), file("README.md", "x")],
      "README.md",
      "path_not_allowed",
    );
    expectIssue(
      [...base(), file(".claude-plugin/other.json", "{}")],
      ".claude-plugin/other.json",
      "path_not_allowed",
    );
    expectIssue(
      [...base(), file("skills/Bad_Name/SKILL.md", skillMd("x"))],
      "skills/Bad_Name/SKILL.md",
      "path_not_allowed",
    );
  });

  test("a skill directory without SKILL.md is rejected", () => {
    expectIssue(
      [file("skills/empty/notes.md", "x")],
      "skills/empty",
      "missing_skill_file",
    );
  });

  test("a bundle with no skills is rejected", () => {
    expect(rejected([])).toContainEqual(
      expect.objectContaining({ code: "no_skills" }),
    );
  });

  test("an uploaded platform manifest is discarded and root instructions become candidates", () => {
    const result = validate([
      ...base(),
      file("agent-platform-bundle.json", '{"skills":[]}'),
      file("CLAUDE.md", "Be kind."),
      file("AGENTS.md", "Be brief."),
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(
      result.bundle.files.some((f) => f.path.endsWith("bundle.json")),
    ).toBe(false);
    expect(result.bundle.files.some((f) => f.path.endsWith("CLAUDE.md"))).toBe(
      false,
    );
    expect(result.bundle.instructionCandidates).toEqual([
      { name: "AGENTS.md", text: "Be brief." },
      { name: "CLAUDE.md", text: "Be kind." },
    ]);
  });

  test("a bad slug is rejected", () => {
    const result = validate(base(), "Not A Slug");
    expect(result.ok).toBe(false);
  });
});

describe("plugin.json", () => {
  const withPlugin = (body: string) => [
    ...base(),
    file(".claude-plugin/plugin.json", body),
  ];
  test("name, version and description survive; the name is always the slug", () => {
    const result = validate(
      withPlugin('{"name":"evil","version":"1.2.3","description":"d"}'),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const plugin = result.bundle.files.find((f) =>
      f.path.endsWith("plugin.json"),
    );
    expect(JSON.parse(new TextDecoder().decode(plugin?.bytes))).toEqual({
      name: "acme",
      version: "1.2.3",
      description: "d",
    });
  });
  test.each([
    '{"hooks":"hooks/hooks.json"}',
    '{"mcpServers":{}}',
    '{"version":1}',
    "[]",
    "not json",
  ])("%s is rejected", (body) => {
    expectIssue(
      withPlugin(body),
      ".claude-plugin/plugin.json",
      "bad_plugin_json",
    );
  });
});

describe("SKILL.md frontmatter", () => {
  const withSkill = (content: string) => [
    file("skills/research/SKILL.md", content),
  ];
  const path = "skills/research/SKILL.md";

  test.each([
    ["allowed-tools", "allowed-tools: Bash\n"],
    ["hooks", "hooks: x\n"],
    ["model", "model: opus\n"],
  ])("key %s is rejected", (_key, line) => {
    expectIssue(
      withSkill(skillMd("research", line)),
      path,
      "disallowed_frontmatter_key",
    );
  });

  test("the two permitted flags are kept as booleans", () => {
    const result = validate(
      withSkill(
        skillMd(
          "research",
          "disable-model-invocation: true\nuser-invocable: false\n",
        ),
      ),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const skill = new TextDecoder().decode(result.bundle.files[1]?.bytes);
    expect(skill).toContain("disable-model-invocation: true");
    expect(skill).toContain("user-invocable: false");
  });

  test.each([
    ["duplicate key", skillMd("research", "description: again\n")],
    ["anchor", skillMd("research", "user-invocable: &a true\n")],
    ["alias", skillMd("research", "disable-model-invocation: *a\n")],
    ["tag", skillMd("research", "disable-model-invocation: !!str true\n")],
    ["block scalar", "---\nname: research\ndescription: |\n  hi\n---\nbody"],
    [
      "continuation line",
      "---\nname: research\ndescription: a\n  b\n---\nbody",
    ],
    ["comment value", skillMd("research", "user-invocable: # x\n")],
    ["unquoted colon", "---\nname: research\ndescription: a: b\n---\nbody"],
    ["name mismatch", skillMd("other")],
    ["missing description", "---\nname: research\n---\nbody"],
    ["no frontmatter", "just text"],
    ["unclosed frontmatter", "---\nname: research\n"],
    ["flag not boolean", skillMd("research", 'user-invocable: "yes"\n')],
  ])("%s is rejected", (_label, content) => {
    expect(rejected(withSkill(content)).some((i) => i.path === path)).toBe(
      true,
    );
  });

  test("invalid UTF-8 is rejected", () => {
    expect(rejected(withSkill("")).length).toBeGreaterThan(0);
    const bad = file(path, new Uint8Array([0xff, 0xfe, 0x2d]));
    expectIssue([bad], path, "bad_frontmatter");
  });

  test("dynamic context is rejected in both forms", () => {
    expectIssue(
      withSkill(skillMd("research", "", "Run !`ls` now\n")),
      path,
      "dynamic_context",
    );
    expectIssue(
      withSkill(skillMd("research", "", "```!\nls\n```\n")),
      path,
      "dynamic_context",
    );
  });

  test("quoted values are re-emitted in one canonical form", () => {
    const a = validate(
      withSkill(`---\nname: research\ndescription: 'It''s: ok'\n---\nbody\n`),
    );
    const b = validate(
      withSkill(
        `---\r\nname: "research"\r\ndescription: "It's: ok"\r\n---\r\nbody\r\n`,
      ),
    );
    if (!a.ok || !b.ok) throw new Error("expected both to validate");
    expect(a.bundle.digest).toBe(b.bundle.digest);
  });
});

describe("paths and entry kinds", () => {
  test.each([
    "../escape.md",
    "skills/../../x",
    "/etc/passwd",
    "C:/x",
    "skills\\research\\SKILL.md",
    "skills//research/SKILL.md",
    "./skills/research/SKILL.md",
    "skills/research/\u0000x",
    "skills/research/e\u0301.md",
  ])("unsafe path %j is rejected", (path) => {
    expectIssue([...base(), file(path, "x")], path, "unsafe_path");
  });

  test.each(["symlink", "hardlink", "device"] as const)(
    "a %s entry is rejected",
    (kind) => {
      expectIssue(
        [...base(), file("skills/research/link", "", { kind })],
        "skills/research/link",
        "unsupported_entry_kind",
      );
    },
  );

  test("a duplicate path and a case-only collision are rejected", () => {
    expectIssue(
      [...base(), file("skills/research/notes.md", "again")],
      "skills/research/notes.md",
      "path_collision",
    );
    expectIssue(
      [...base(), file("skills/research/NOTES.md", "again")],
      "skills/research/NOTES.md",
      "path_collision",
    );
  });

  test.each(["hooks/", "bin/", "node_modules/", "agents/", "docs/"])(
    "a directory entry %s is held to the same policy as a file",
    (path) => {
      const issues = rejected([
        ...base(),
        file(path, "", { kind: "directory", mode: 0o755 }),
      ]);
      expect(issues.map((i) => i.path)).toEqual([path]);
    },
  );

  test("a file cannot also be a directory, and a file path cannot end in a slash", () => {
    expectIssue(
      [...base(), file("skills/research/notes.md/child.md", "x")],
      "skills/research/notes.md/child.md",
      "path_collision",
    );
    expectIssue(
      [...base(), file("skills/research/notes.md/", "x")],
      "skills/research/notes.md/",
      "unsafe_path",
    );
    expectIssue(
      [...base(), file("skills/research/notes.md", "", { kind: "directory" })],
      "skills/research/notes.md",
      "path_collision",
    );
  });

  test("a SKILL.md below the skill root is rejected", () => {
    expectIssue(
      [...base(), file("skills/research/nested/SKILL.md", skillMd("nested"))],
      "skills/research/nested/SKILL.md",
      "path_not_allowed",
    );
  });

  test("changing the input buffer after validation does not change the output", () => {
    const input = text("normal");
    const result = validate([...base(), file("skills/research/x.md", input)]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    input.set(text("#!sh\n"));
    const kept = result.bundle.files.find((f) => f.path.endsWith("x.md"));
    expect(new TextDecoder().decode(kept?.bytes)).toBe("normal");
  });

  test("directory entries inside the allow-list are ignored", () => {
    const result = validate([
      ...base(),
      file("skills/research/", "", { kind: "directory" }),
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("limits", () => {
  test("file count, single file and total size are enforced", () => {
    const small = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };
    const run = (files: BundleInputFile[]) =>
      validateExtensionBundle({ slug: "acme", files }, small);
    const over = (r: ReturnType<typeof run>) =>
      r.ok ? [] : r.issues.map((i) => i.code);
    expect(over(run([file("a", ""), file("b", ""), file("c", "")]))).toEqual([
      "too_many_files",
    ]);
    expect(over(run([file("skills/a/SKILL.md", "x".repeat(11))]))).toContain(
      "file_too_large",
    );
    expect(
      over(run([file("a", "x".repeat(9)), file("b", "x".repeat(9))])),
    ).toEqual(["bundle_too_large"]);
    expect(DEFAULT_BUNDLE_LIMITS.maxFiles).toBeGreaterThan(0);
  });
});

describe("has_scripts", () => {
  const scripted = (extra: BundleInputFile) => {
    const result = validate([...base(), extra]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.bundle.manifest.skills[0]?.has_scripts;
  };
  test("documents are not scripts", () => {
    expect(scripted(file("skills/research/data.csv", "a,b"))).toBe(false);
    expect(scripted(file("skills/research/ref.yaml", "a: 1"))).toBe(false);
  });
  test("an execute bit, an unlisted extension, no extension or a shebang is a script", () => {
    expect(scripted(file("skills/research/run.md", "x", { mode: 0o755 }))).toBe(
      true,
    );
    expect(scripted(file("skills/research/run.py", "print(1)"))).toBe(true);
    expect(scripted(file("skills/research/Makefile", "all:"))).toBe(true);
    expect(scripted(file("skills/research/notes2.md", "#!/bin/sh\necho"))).toBe(
      true,
    );
  });
});

describe("digest", () => {
  const digestOf = (files: BundleInputFile[]) => {
    const result = validate(files);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.bundle;
  };

  test("the same input twice gives the same manifest and digest, whatever the order", () => {
    const one = digestOf(base());
    const two = digestOf([...base()].reverse());
    expect(two.digest).toBe(one.digest);
    expect(two.manifest).toEqual(one.manifest);
    expect(one.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("mode bits other than execute do not matter; the execute bit does", () => {
    const plain = digestOf([
      ...base(),
      file("skills/research/x.md", "x", { mode: 0o600 }),
    ]);
    const same = digestOf([
      ...base(),
      file("skills/research/x.md", "x", { mode: 0o664 }),
    ]);
    const exec = digestOf([
      ...base(),
      file("skills/research/x.md", "x", { mode: 0o755 }),
    ]);
    expect(same.digest).toBe(plain.digest);
    expect(exec.digest).not.toBe(plain.digest);
  });

  test("a changed path or content changes the digest", () => {
    const one = digestOf(base());
    expect(
      digestOf([
        file("skills/research/SKILL.md", skillMd("research")),
        file("skills/research/other.md", "# notes\n"),
      ]).digest,
    ).not.toBe(one.digest);
    expect(
      digestOf([
        file("skills/research/SKILL.md", skillMd("research")),
        file("skills/research/notes.md", "# changed\n"),
      ]).digest,
    ).not.toBe(one.digest);
  });

  test("the digest is the 94S-865 line format over the engine tree", () => {
    const bundle = digestOf(base());
    expect(bundleDigest(bundle.files)).toBe(bundle.digest);
    expect(bundleDigest([...bundle.files].reverse())).toBe(bundle.digest);
  });

  test("a tampered upload is refused whole, never partly dropped", () => {
    const result = validate([
      file(
        "skills/research/SKILL.md",
        skillMd("research", "allowed-tools: Bash\n"),
      ),
      file("hooks/hooks.json", '{"hooks":{}}'),
      file(".mcp.json", "{}"),
      file("bin/x", "x"),
    ]);
    if (result.ok) throw new Error("expected rejection");
    expect(result.issues.map((i) => i.path).sort()).toEqual([
      ".mcp.json",
      "bin/x",
      "hooks/hooks.json",
      "skills/research/SKILL.md",
    ]);
  });
});
