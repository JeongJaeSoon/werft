import { describe, expect, test } from "bun:test";
import {
  type BundleInputFile,
  type BundleIssueCode,
  bundleDigest,
  DEFAULT_BUNDLE_LIMITS,
  readSkillFile,
  skillPathIssues,
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
          "disable-model-invocation: false\nuser-invocable: false\n",
        ),
      ),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const skill = new TextDecoder().decode(result.bundle.files[1]?.bytes);
    expect(skill).toContain("disable-model-invocation: false");
    expect(skill).toContain("user-invocable: false");
  });

  test("a skill neither a person nor the model may call is rejected", () => {
    expectIssue(
      withSkill(
        skillMd(
          "research",
          "disable-model-invocation: true\nuser-invocable: false\n",
        ),
      ),
      path,
      "bad_frontmatter",
    );
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

  test("a Buffer input is copied too, not aliased", () => {
    const input = Buffer.from("a");
    const result = validate([...base(), file("skills/research/x.md", input)]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    input[0] = 98;
    const kept = result.bundle.files.find((f) => f.path.endsWith("x.md"));
    expect(new TextDecoder().decode(kept?.bytes)).toBe("a");
  });

  test("a folded settings name is denied", () => {
    expectIssue(
      [...base(), file("skills/research/ſettings.json", "{}")],
      "skills/research/ſettings.json",
      "denied_path",
    );
  });

  test("Unicode case variants fold for nested SKILL.md and file/directory clashes", () => {
    expectIssue(
      [...base(), file("skills/research/nested/ſKILL.md", "x")],
      "skills/research/nested/ſKILL.md",
      "path_not_allowed",
    );
    expectIssue(
      [
        ...base(),
        file("skills/research/σ.md", "x"),
        file("skills/research/ς.md/child.md", "x"),
      ],
      "skills/research/ς.md/child.md",
      "path_collision",
    );
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

describe("a skill upload", () => {
  const upload = (files: BundleInputFile[], slug = "research") =>
    validateExtensionBundle({ slug, files }, DEFAULT_BUNDLE_LIMITS, "upload");
  const codesOf = (files: BundleInputFile[]) => {
    const result = upload(files);
    if (result.ok) throw new Error("expected the upload to be rejected");
    return result.issues.map((i) => [i.path, i.code]);
  };

  test("one skill is accepted and its stored tree validates to the same digest", () => {
    const result = upload(base());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const again = validateExtensionBundle({
      slug: "research",
      files: result.bundle.files.map((f) => ({
        path: f.path,
        kind: "file" as const,
        mode: f.mode,
        bytes: f.bytes,
      })),
    });
    if (!again.ok) throw new Error(JSON.stringify(again.issues));
    expect(again.bundle.digest).toBe(result.bundle.digest);
    expect(result.bundle.expectedSkills).toEqual(["research:research"]);
  });

  test("a tree of two skills is refused", () => {
    expect(
      codesOf([...base(), file("skills/other/SKILL.md", skillMd("other"))]),
    ).toContainEqual(["", "multiple_skills"]);
    expect(
      codesOf([
        ...base(),
        file("skills/research/inner/SKILL.md", skillMd("inner")),
      ]),
    ).toContainEqual(["skills/research/inner/SKILL.md", "multiple_skills"]);
  });

  test("the directory must be the name it is registered under", () => {
    const result = upload(base(), "other");
    if (result.ok) throw new Error("expected rejection");
    expect(result.issues.map((i) => i.code)).toContain("bad_slug");
  });

  test.each([
    ".claude-plugin/plugin.json",
    "skills/research/.claude-plugin/plugin.json",
    "skills/research/.codex-plugin/plugin.json",
    "skills/research/plugin.json",
  ])("an engine manifest at %s is refused", (path) => {
    expect(codesOf([...base(), file(path, "{}")])).toContainEqual([
      path,
      "engine_manifest",
    ]);
  });

  test("the stored mode still takes the validator's own plugin.json", () => {
    const result = validate([
      ...base(),
      file(".claude-plugin/plugin.json", '{"name":"x"}'),
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("Agent Skills specification fields", () => {
  const path = "skills/research/SKILL.md";
  const one = (extra: string) => [file(path, skillMd("research", extra))];
  const emitted = (extra: string) => {
    const result = validate(one(extra));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const skill = result.bundle.files.find((f) => f.path === path);
    return { text: new TextDecoder().decode(skill?.bytes), result };
  };

  test("license, compatibility and metadata are kept in one canonical form", () => {
    const { text, result } = emitted(
      "user-invocable: false\nlicense: Apache-2.0\ncompatibility: Needs git\nmetadata:\n    owner: platform\n    reviewed: true\n",
    );
    expect(text).toBe(
      '---\nname: "research"\ndescription: "Use for research"\nlicense: "Apache-2.0"\ncompatibility: "Needs git"\nmetadata:\n  owner: "platform"\n  reviewed: "true"\nuser-invocable: false\n---\nDo the thing.\n',
    );
    const again = validateExtensionBundle({
      slug: "acme",
      files: result.bundle.files.map((f) => ({
        path: f.path,
        kind: "file" as const,
        mode: f.mode,
        bytes: f.bytes,
      })),
    });
    if (!again.ok) throw new Error(JSON.stringify(again.issues));
    expect(again.bundle.digest).toBe(result.bundle.digest);
  });

  test("a tree without them re-emits what it always did", () => {
    const { text } = emitted("disable-model-invocation: true\n");
    expect(text).toBe(
      '---\nname: "research"\ndescription: "Use for research"\ndisable-model-invocation: true\n---\nDo the thing.\n',
    );
  });

  test("allowed-tools is refused with its reason", () => {
    const issues = rejected(one("allowed-tools: Bash Read\n"));
    expect(issues).toContainEqual(
      expect.objectContaining({
        path,
        code: "disallowed_frontmatter_key",
        message: expect.stringContaining("tool permissions"),
      }),
    );
  });

  const keys = Array.from({ length: 33 }, (_, n) => `  k${n}: v\n`).join("");
  test.each([
    ["a nested map", "metadata:\n  a:\n    b: c\n"],
    ["a second indent", "metadata:\n  a: b\n   c: d\n"],
    ["an anchor", "metadata:\n  a: &x b\n"],
    ["an alias", "metadata:\n  a: *x\n"],
    ["a tag", "metadata:\n  a: !!str b\n"],
    ["a flow map", "metadata: {a: b}\n"],
    ["a single-line value", "metadata: owner\n"],
    ["a duplicate key", "metadata:\n  a: b\n  a: c\n"],
    ["an empty block", "metadata:\n"],
    ["a key too long", `metadata:\n  ${"k".repeat(65)}: v\n`],
    ["a value too long", `metadata:\n  a: ${"v".repeat(1025)}\n`],
    ["too many keys", `metadata:\n${keys}`],
    ["a tab indent", "metadata:\n\ta: b\n"],
    ["compatibility too long", `compatibility: ${"c".repeat(501)}\n`],
    ["a boolean license", "license: true\n"],
  ])("metadata or a field with %s is refused", (_label, extra) => {
    expect(rejected(one(extra)).some((i) => i.path === path)).toBe(true);
  });

  test("a value is measured by its own length, in the upload and in its stored tree alike", () => {
    const quotes = `'${'"'.repeat(1024)}'`;
    const { text, result } = emitted(
      `license: ${quotes}\ncompatibility: "a\\u2028b\\u2029c"\nmetadata:\n  a: ${quotes}\n  b: ${"m".repeat(1024)}\n`,
    );
    expect(text).toContain('compatibility: "a\\u2028b\\u2029c"');
    const stored = validateExtensionBundle({
      slug: "acme",
      files: result.bundle.files.map((f) => ({
        path: f.path,
        kind: "file" as const,
        mode: f.mode,
        bytes: f.bytes,
      })),
    });
    if (!stored.ok) throw new Error(JSON.stringify(stored.issues));
    expect(stored.bundle.digest).toBe(result.bundle.digest);

    expect(
      rejected(one(`metadata:\n  a: '${'"'.repeat(1025)}'\n`)),
    ).toContainEqual(
      expect.objectContaining({
        path,
        code: "bad_frontmatter",
        message: 'metadata: "a" is too long.',
      }),
    );
    expect(rejected(one(`license: ${"l".repeat(1025)}\n`))).toContainEqual(
      expect.objectContaining({ path, message: '"license" is too long.' }),
    );
  });
});

describe("description as a block scalar", () => {
  const path = "skills/research/SKILL.md";
  const tree = (head: string): BundleInputFile[] => [
    file(
      path,
      `---\nname: research\n${head}license: MIT\n---\nDo the thing.\n`,
    ),
  ];
  const inMode = (files: BundleInputFile[], mode: "upload" | "stored") =>
    validateExtensionBundle(
      { slug: "research", files },
      DEFAULT_BUNDLE_LIMITS,
      mode,
    );
  type Tree = {
    files: readonly { path: string; mode: 0o644 | 0o755; bytes: Uint8Array }[];
  };
  const storedTree = (bundle: Tree) =>
    bundle.files.map((f) => ({
      path: f.path,
      kind: "file" as const,
      mode: f.mode,
      bytes: f.bytes,
    }));
  const skillText = (bundle: Tree) =>
    new TextDecoder().decode(bundle.files.find((f) => f.path === path)?.bytes);
  const descriptionLine = (text: string) => {
    const line = text.split("\n").find((l) => l.startsWith("description: "));
    if (line === undefined) throw new Error("no description line");
    return line;
  };
  /** Upload, then read its stored tree the way every release reads it. */
  function roundTrip(head: string) {
    const uploaded = inMode(tree(head), "upload");
    if (!uploaded.ok) throw new Error(JSON.stringify(uploaded.issues));
    const stored = inMode(storedTree(uploaded.bundle), "stored");
    if (!stored.ok) throw new Error(JSON.stringify(stored.issues));
    expect(stored.bundle.digest).toBe(uploaded.bundle.digest);
    expect(skillText(stored.bundle)).toBe(skillText(uploaded.bundle));
    const line = descriptionLine(skillText(uploaded.bundle));
    return {
      value: JSON.parse(line.slice("description: ".length)) as string,
      line,
      text: skillText(uploaded.bundle),
    };
  }
  const issuesOf = (files: BundleInputFile[], mode: "upload" | "stored") => {
    const result = inMode(files, mode);
    if (result.ok) throw new Error("expected rejection");
    return result.issues;
  };

  // Expected values are what a YAML 1.2 parser (the yaml package) reads.
  test.each([
    [
      "|",
      "description: |\n  First line.\n    Kept indent.\n\n  After a blank.\n",
      "First line.\n  Kept indent.\n\nAfter a blank.\n",
    ],
    [
      "|-",
      "description: |-\n  First line.\n    Kept indent.\n\n  After a blank.\n\n",
      "First line.\n  Kept indent.\n\nAfter a blank.",
    ],
    [
      ">",
      "description: >\n  Folded\n  into one.\n\n  New paragraph.\n    More indented.\n  Back.\n",
      "Folded into one.\nNew paragraph.\n  More indented.\nBack.\n",
    ],
    [
      ">-",
      "description: >-\n  Folded\n  into one.\n\n\n  Two breaks.\n",
      "Folded into one.\n\nTwo breaks.",
    ],
  ])(
    "an upload's %s description is read as YAML reads it and stored as one quoted line",
    (_header, head, want) => {
      const { value, line, text } = roundTrip(head);
      expect(value).toBe(want);
      expect(line).toBe(`description: ${JSON.stringify(want)}`);
      expect(text).toContain('\nlicense: "MIT"\n');
    },
  );

  test("tabs, quotes, backslashes and line separators come back from the stored tree unchanged", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const { value, line } = roundTrip(
      `description: |-\n  Say "hi"\tthen wait.\n  A back\\slash \\n stays text.\n  Split${ls}here${ps}too.\n`,
    );
    expect(value).toBe(
      `Say "hi"\tthen wait.\nA back\\slash \\n stays text.\nSplit${ls}here${ps}too.`,
    );
    expect(line).not.toContain("\t");
    expect(line).not.toContain(ls);
    expect(line).not.toContain(ps);
    expect(line).toContain(`${String.fromCharCode(92)}u2028`);
  });

  test.each([
    ["an indentation indicator", "description: |2\n  Text.\n"],
    ["an indentation indicator with strip", "description: >-2\n  Text.\n"],
    ["keep chomping", "description: |+\n  Text.\n"],
    ["folded keep chomping", "description: >+\n  Text.\n"],
    ["a comment after the header", "description: | # note\n  Text.\n"],
    ["a comment after a strip header", "description: >- #note\n  Text.\n"],
    ["a tab indent", "description: |\n\tText.\n"],
    ["a tab after the spaces", "description: |\n  \tText.\n"],
    ["a tab on a later line", "description: >\n  Text.\n \tMore.\n"],
    [
      "a leading blank line indented past the text",
      "description: |\n      \n  Text.\n",
    ],
    ["a less indented line inside", "description: |\n    Text.\n  Less.\n"],
    ["a comment line below the block", "description: |\n    Text.\n  # note\n"],
    ["an empty block", "description: |\n"],
    [
      "a block on another key",
      "description: Use it\ncompatibility: |\n  Needs git\n",
    ],
  ])("an upload with %s is refused as bad_frontmatter", (_label, head) => {
    const issues = issuesOf(tree(head), "upload");
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue).toEqual(
        expect.objectContaining({ path, code: "bad_frontmatter" }),
      );
    }
  });

  test("a character YAML does not allow in a block is refused; NEL and NBSP are text", () => {
    for (const code of [0x00, 0x1b, 0x7f, 0x80, 0x9f, 0xfeff, 0xfffe]) {
      const char = String.fromCharCode(code);
      expect(
        issuesOf(tree(`description: |-\n  A${char}B\n`), "upload"),
      ).toContainEqual(
        expect.objectContaining({
          path,
          code: "bad_frontmatter",
          message: '"description" holds a character YAML does not allow.',
        }),
      );
    }
    const kept = `A${String.fromCharCode(0x85)}B${String.fromCharCode(0xa0)}C`;
    expect(roundTrip(`description: >-\n  ${kept}\n`).value).toBe(kept);
  });

  test.each(["|", "|-", ">", ">-"])(
    "the stored mode still refuses a %s description",
    (header) => {
      expect(
        issuesOf(tree(`description: ${header}\n  Text.\n`), "stored"),
      ).toContainEqual(
        expect.objectContaining({ path, code: "bad_frontmatter" }),
      );
    },
  );

  test("the length limit is on the parsed value, not on the lines", () => {
    // Indentation and line breaks folded into spaces are not counted twice.
    const word = (n: number) => `${"w".repeat(n - 1)}.`;
    const lines = (total: number) =>
      [word(500), word(500), word(total - 1002)]
        .map((l) => `      ${l}`)
        .join("\n");
    expect(roundTrip(`description: >-\n${lines(1024)}\n`).value.length).toBe(
      1024,
    );
    expect(roundTrip(`description: |-\n${lines(1024)}\n`).value.length).toBe(
      1024,
    );
    // "|" keeps the final line break, so the same lines are one longer.
    for (const [header, total] of [
      ["|-", 1025],
      [">-", 1025],
      ["|", 1024],
    ] as const) {
      expect(
        issuesOf(tree(`description: ${header}\n${lines(total)}\n`), "upload"),
      ).toContainEqual(
        expect.objectContaining({
          path,
          code: "bad_frontmatter",
          message: '"description" is too long.',
        }),
      );
    }
  });

  // Shapes of anthropics/skills at e4bb5d96 (our own text, their lengths):
  // academy-guide 992, discernment-nudge 983 and claude-api 1,068 characters.
  const prose = (length: number) => {
    const words: string[] = [];
    let size = -1;
    for (let n = 0; size + 8 <= length; n++) {
      words.push(`word${String(n % 1000).padStart(3, "0")}`);
      size += 8;
    }
    const text = `${words.join(" ")}${"x".repeat(length - size)}`;
    return text.replace(/(.{60,72}?) /g, "$1\n");
  };
  const measured = (name: string, length: number) => {
    const value = prose(length);
    expect(value.length).toBe(length);
    const body = value
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    return [
      file(
        `skills/${name}/SKILL.md`,
        `---\nname: ${name}\ndescription: |-\n${body}\n---\n# ${name}\n\nBody.\n`,
      ),
    ];
  };
  test.each([
    ["academy-guide", 992],
    ["discernment-nudge", 983],
  ])("a %s-shaped skill (%i characters, |-) is accepted", (name, length) => {
    const result = validateExtensionBundle(
      { slug: name, files: measured(name, length) },
      DEFAULT_BUNDLE_LIMITS,
      "upload",
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.bundle.expectedSkills).toEqual([`${name}:${name}`]);
  });
  test("a claude-api-shaped skill (1,068 characters, |-) is still refused by length", () => {
    const result = validateExtensionBundle(
      { slug: "claude-api", files: measured("claude-api", 1068) },
      DEFAULT_BUNDLE_LIMITS,
      "upload",
    );
    if (result.ok) throw new Error("expected rejection");
    expect(result.issues).toContainEqual({
      path: "skills/claude-api/SKILL.md",
      code: "bad_frontmatter",
      message: '"description" is too long.',
    });
    expect(new Set(result.issues.map((i) => i.code))).toEqual(
      new Set(["bad_frontmatter"]),
    );
  });
});

describe("what passed before passes alike", () => {
  const path = "skills/research/SKILL.md";
  const one = (text: string): BundleInputFile[] => [file(path, text)];
  // Digests taken with the validator as it was before block scalars.
  test.each([
    [
      "a plain skill",
      "---\nname: research\ndescription: Use for research\n---\nDo the thing.\n",
      "4063380d276d6894bdb5283405492ab2638497bfccbcb07dd2f480137053bb48",
    ],
    [
      "every specification field",
      "---\nname: research\ndescription: 'It''s for research'\nlicense: Apache-2.0\ncompatibility: \"Needs git\\tand a shell\"\nmetadata:\n  owner: platform\n  reviewed: true\ndisable-model-invocation: true\n---\nBody line.\n\nSecond line.\n",
      "7f8653673b60305f1dabdcd70713a0d00f915e8aa26d51f8df67a22e45e6956b",
    ],
    [
      "a stored tree's own quoted shape",
      '---\nname: "research"\ndescription: "Line one\\nLine two \\"quoted\\" \\\\ back"\n---\nStored body.\n',
      "6f04a8a6cdf9113222ada4d32e02dec327ef84a147bd7426ca23edb14e5cf276",
    ],
  ])("%s keeps its digest in both modes", (_label, text, digest) => {
    for (const mode of ["upload", "stored"] as const) {
      const result = validateExtensionBundle(
        { slug: "research", files: one(text) },
        DEFAULT_BUNDLE_LIMITS,
        mode,
      );
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.bundle.digest).toBe(digest);
    }
  });

  test("a single-line description keeps taking what it took, a raw DEL included", () => {
    const del = String.fromCharCode(0x7f);
    for (const mode of ["upload", "stored"] as const) {
      const result = validateExtensionBundle(
        {
          slug: "research",
          files: one(
            `---\nname: research\ndescription: a${del}b\n---\nBody.\n`,
          ),
        },
        DEFAULT_BUNDLE_LIMITS,
        mode,
      );
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(
        new TextDecoder().decode(
          result.bundle.files.find((f) => f.path === path)?.bytes,
        ),
      ).toBe(`---\nname: "research"\ndescription: "a${del}b"\n---\nBody.\n`);
    }
  });

  test("a stored tree in its old shape reads back to the same bytes", () => {
    const old =
      '---\nname: "research"\ndescription: "Line one\\nLine two"\nlicense: "MIT"\nuser-invocable: false\n---\nStored body.\n';
    const result = validateExtensionBundle({
      slug: "research",
      files: [
        file(".claude-plugin/plugin.json", '{"name":"research"}'),
        ...one(old),
      ],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(
      new TextDecoder().decode(
        result.bundle.files.find((f) => f.path === path)?.bytes,
      ),
    ).toBe(old);
  });

  // The stored mode is the frontmatter reader every release before this one
  // ran, so an upload judged like it is judged as it always was.
  test.each([
    "description: Use for research\n",
    "description: 'single ''quoted'''\n",
    'description: "double \\u00e9 quoted"\n',
    "description: true\n",
    "description: \n",
    "description:\n",
    "description: >no space\n",
    "description: |text\n",
    "description: |-text\n",
    "description: a: b\n",
    "description: a #b\n",
    "description: &x a\n",
    "description: [a]\n",
    "description: Use it\ndescription: twice\n",
    `description: ${"d".repeat(1024)}\n`,
    `description: ${"d".repeat(1025)}\n`,
    "description: Use it\n  indented: line\n",
    "description: Use it\nlicense: |\n  MIT\n",
    "description: Use it\nmetadata:\n  a: |\n",
    "description: Use it\nallowed-tools: Bash\n",
    "description: Use it\nuser-invocable: maybe\n",
    "description: Use it\ndisable-model-invocation: true\nuser-invocable: false\n",
    "description: Use it\n# a comment\n",
    "description:\tUse it\n",
    `description: a${String.fromCharCode(0x7f)}b\n`,
  ])("frontmatter %j gets the verdict the stored mode gives", (head) => {
    const files = one(`---\nname: research\n${head}---\nBody.\n`);
    const judge = (mode: "upload" | "stored") => {
      const result = validateExtensionBundle(
        { slug: "research", files },
        DEFAULT_BUNDLE_LIMITS,
        mode,
      );
      return result.ok
        ? { digest: result.bundle.digest }
        : { issues: result.issues };
    };
    expect(judge("upload")).toEqual(judge("stored"));
  });
});

describe("what a listing reads agrees with an upload", () => {
  const uploaded = (name: string, files: BundleInputFile[]) =>
    validateExtensionBundle(
      { slug: name, files },
      DEFAULT_BUNDLE_LIMITS,
      "upload",
    );

  test("a SKILL.md gives its name, description and license", () => {
    expect(readSkillFile(text(skillMd("research", "license: MIT\n")))).toEqual({
      name: "research",
      description: "Use for research",
      license: "MIT",
      issues: [],
    });
  });

  test.each([
    skillMd("research"),
    "---\nname: research\ndescription: |\n  Two\n  lines.\n---\nBody.\n",
    skillMd("research", "allowed-tools: Bash\n"),
    skillMd("research", "", "Run !`id` first.\n"),
    "---\nname: research\n---\nBody.\n",
    "---\nname: Not A Name\ndescription: d\n---\nBody.\n",
    "---\ndescription: d\n---\nBody.\n",
    "No frontmatter.\n",
  ])(
    "SKILL.md %j has no issues exactly when its upload under that name passes",
    (md) => {
      const read = readSkillFile(text(md));
      const name = read.name ?? "research";
      expect(read.issues.length === 0).toBe(
        uploaded(name, [file(`skills/${name}/SKILL.md`, md)]).ok,
      );
    },
  );

  test.each([
    [["notes.md"], []],
    [["hooks/run.sh"], ["denied_path"]],
    [["settings.local.json"], ["denied_path"]],
    [[".claude-plugin/plugin.json"], ["engine_manifest"]],
    [["plugin.json"], ["engine_manifest"]],
    [["inner/SKILL.md"], ["multiple_skills"]],
    [["a\\b.md"], ["unsafe_path"]],
    [["Notes.md", "notes.md"], ["path_collision"]],
  ] as const)("paths %j are refused as their upload is: %j", (paths, codes) => {
    const all = ["SKILL.md", ...paths];
    expect(skillPathIssues(all).map((issue) => issue.code)).toEqual([...codes]);
    const result = uploaded(
      "research",
      all.map((path) =>
        file(
          `skills/research/${path}`,
          path === "SKILL.md" ? skillMd("research") : "x\n",
        ),
      ),
    );
    expect(result.ok ? [] : result.issues.map((issue) => issue.code)).toEqual([
      ...codes,
    ]);
  });
});
