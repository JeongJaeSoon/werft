import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  findNames,
  IDENTIFIERS,
  identifiers,
  NOTICE,
} from "../.github/scripts/vendor-names.ts";

const repo = join(import.meta.dir, "..");
const script = join(repo, ".github/scripts/vendor-names.ts");

let dir: string;

function put(path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function run() {
  return Bun.spawnSync(["bun", script, dir], { stderr: "pipe" });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vendor-names-"));
  expect(Bun.spawnSync(["git", "init", "-q", dir]).exitCode).toBe(0);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("vendor-names.ts", () => {
  test("passes inside the vendor folder and on ordinary words", () => {
    put(IDENTIFIERS, "# nothing yet\n\n");
    put(
      "apps/web/src/vendor/affectui/free/affect-card.tsx",
      '// AffectUI\nexport const c = "affect-card var(--affect-bg) zz-orb";\n',
    );
    put(
      "apps/web/src/screen.tsx",
      [
        "// affected sessions: unaffected, affecting, AffectedSession",
        "// affected_agents; this does not affect UI",
        'import { Card } from "./vendor/affectui/free/affect-card.tsx";',
      ].join("\n"),
    );
    put("packages/ui/src/patterns/card.tsx", `// ${NOTICE}\n`);
    put("docs/source.md", "AffectUI affect-card\n");
    const result = run();
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test.each([
    ["apps/web/src/a.tsx", 'const c = "affect-card";'],
    ["apps/web/src/a.css", "a { color: var(--affect-bg); }"],
    ["apps/web/src/a.html", '<div data-affect-open="1">'],
    ["packages/ui/src/a.tsx", "// copied from AffectUI"],
    ["packages/ui/src/b.tsx", `// ${NOTICE} class="affect-card"`],
    ["apps/web/src/b.ts", 'import "./vendor/affectui-pro/x.ts";'],
    ["apps/web/src/vendor/affectui/pro/x.tsx", 'const c = "affect-x";'],
    ["apps/web/public/affect-loader.svg", "<svg/>"],
    ["apps/docs/content/docs/a.mdx", '<div className="affect-card" />'],
  ])("fails on %s", (path, text) => {
    put(path, `${text}\n`);
    try {
      expect(findNames(dir).join("\n")).toContain(path);
      expect(run().exitCode).toBe(1);
    } finally {
      rmSync(join(dir, path));
    }
  });

  test("fails on the name of a symlink, even one into the vendor folder", () => {
    const link = "apps/web/public/affect-link.svg";
    mkdirSync(dirname(join(dir, link)), { recursive: true });
    symlinkSync("../src/vendor/affectui/free/gone.svg", join(dir, link));
    try {
      expect(findNames(dir)).toEqual([`${link}: affect-`]);
    } finally {
      rmSync(join(dir, link));
    }
  });

  test("also fails on the owner's identifiers, ignoring case", () => {
    put(IDENTIFIERS, "# comment\n\n  ZZ-Orb  \n");
    put("apps/web/src/c.tsx", 'x;\nconst c = "zz-orb";\n');
    put("apps/web/public/zz-orb.json", "{}\n");
    try {
      expect(findNames(dir).sort()).toEqual([
        "apps/web/public/zz-orb.json: zz-orb",
        "apps/web/src/c.tsx:2: zz-orb",
      ]);
    } finally {
      put(IDENTIFIERS, "");
      rmSync(join(dir, "apps/web/src/c.tsx"));
      rmSync(join(dir, "apps/web/public/zz-orb.json"));
    }
  });

  test("reads comments and blank lines of the identifier list as nothing", () => {
    expect(identifiers("# a\n\n   \n  # b\n")).toEqual([]);
  });

  // Reads every tracked file; CI runners pass bun's 5 s default.
  test("this repository passes", () => {
    expect(findNames(repo)).toEqual([]);
  }, 30_000);
});
