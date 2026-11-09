import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { buildSdkOptions } from "./runtime.ts";

/**
 * The settings handed to the engine, pinned for every combination of mode,
 * trusted tools, tool surface and workspace path. Each value is the sha256 of
 * the payload as it was produced before the rules moved into `settings/`, so
 * the move cannot change a decision unnoticed.
 *
 * A policy change that is meant to change the payload regenerates the file
 * on purpose (`WRITE_SETTINGS_GOLDEN=1 bun test <this file>`) and the PR says
 * why; the readable diff is in `settings/`, not in the hashes.
 */
const GOLDEN = new URL("./settings.golden.json", import.meta.url);

const MODES = [
  undefined,
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
  "plan",
  "auto",
] as const;
const TRUSTED = [[], ["mcp__github__request_push"]];
const TOOLS = [
  [],
  ["Bash"],
  ["Write"],
  ["Edit"],
  ["NotebookEdit"],
  ["Bash", "Write", "Edit"],
  ["Read", "Glob"],
];

function workspaces(): { cases: [string, string][]; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "settings-golden-")));
  // A root the rule syntax cannot carry literally drops the Edit rules and
  // would make the hashes depend on where the test runs.
  if (!/^\/[\w./-]+$/.test(root)) {
    throw new Error(`temporary directory ${root} is not a literal path`);
  }
  const real = join(root, "ws");
  mkdirSync(real);
  symlinkSync(real, join(root, "link"));
  for (const name of ["with space", "a*b", "[x]"]) mkdirSync(join(root, name));
  return {
    root,
    cases: [
      ["plain", real],
      ["symlink", join(root, "link")],
      ["missing", join(root, "missing")],
      ["trailing-slash", `${real}/`],
      ["slash-root", "/"],
      ["space", join(root, "with space")],
      ["glob", join(root, "a*b")],
      ["bracket", join(root, "[x]")],
    ],
  };
}

function hashOf(settings: unknown, root: string): string {
  const text = JSON.stringify(settings).split(root).join("<ROOT>");
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function compute(): Record<string, string> {
  const { cases, root } = workspaces();
  const out: Record<string, string> = {};
  for (const [name, cwd] of cases) {
    for (const mode of MODES) {
      for (const trusted of TRUSTED) {
        for (const tools of TOOLS) {
          const config: ClaudeRuntimeConfig = {
            claudeConfigDir: "/tenant/config",
            correlationId: "settings-golden",
            mode: "new",
            cwd,
            home: "/tenant/home",
            model: "primary",
            profile: {
              kind: "anthropic",
              endpoint: "https://api.anthropic.com",
              auth: { kind: "api_key", value: "placeholder" },
              principal: { ownerScope: "owner-a" },
            },
            tools,
            trustedTools: trusted,
            ...(mode === undefined ? {} : { permissionMode: mode }),
          };
          const { settings } = buildSdkOptions(config, {
            onPermission: async () => ({ behavior: "allow" }),
          });
          const key = [
            name,
            mode ?? "unset",
            trusted.length === 0 ? "untrusted" : "trusted",
            tools.join("+") || "none",
          ].join("|");
          out[key] = hashOf(settings, root);
        }
      }
    }
  }
  rmSync(root, { recursive: true, force: true });
  return out;
}

describe("engine settings golden", () => {
  test("every mode, trusted set, tool surface and workspace path keeps its payload", async () => {
    const actual = compute();
    if (process.env.WRITE_SETTINGS_GOLDEN === "1") {
      // A run that rewrites the baseline never counts as a pass, so the
      // variable cannot be set to make a changed payload green.
      await Bun.write(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
      throw new Error(
        "settings.golden.json was rewritten: review its diff, then run again without WRITE_SETTINGS_GOLDEN",
      );
    }
    const golden = (await Bun.file(GOLDEN).json()) as Record<string, string>;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
    const changed = Object.keys(golden).filter((k) => actual[k] !== golden[k]);
    expect(changed).toEqual([]);
  });
});
