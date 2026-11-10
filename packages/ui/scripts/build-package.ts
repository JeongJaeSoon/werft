/**
 * Builds the publishable @werft-ai/ui into packages/ui/dist: one ESM module
 * and d.ts per source file, a prebuilt styles.css, the source tokens.css and
 * theme.css, a package.json whose exports point at those files, and LICENSE.
 * `npm pack dist` packs it. The repo's own package.json keeps pointing at src,
 * so the workspace never needs this build.
 *
 *   bun run --cwd packages/ui build:package
 */

import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "tsdown";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const FOUNDATIONS = join(PACKAGE_ROOT, "src/foundations");
const OUT = join(PACKAGE_ROOT, "dist");

// The package does not ship fonts: the host app picks and loads its own.
const FONTS_IMPORT = '@import "./fonts.css";\n';

type Manifest = {
  name: string;
  version: string;
  license: string;
  type: string;
  sideEffects: string[];
  exports: Record<string, string>;
  peerDependencies: Record<string, string>;
  dependencies: Record<string, string>;
};

/** `./src/primitives/index.ts` → types and import of the built module; CSS sits at the root. */
function distExports(source: Record<string, string>) {
  const exports: Record<string, unknown> = {};
  for (const [subpath, file] of Object.entries(source)) {
    // Test helpers for this repo's own suites.
    if (subpath.startsWith("./test-support/")) continue;
    const ts = file.match(/^\.\/src\/(.+)\.ts$/);
    if (ts) {
      exports[subpath] = {
        types: `./${ts[1]}.d.ts`,
        import: `./${ts[1]}.js`,
      };
    } else if (file.endsWith(".css")) {
      exports[subpath] = `./${subpath.slice(2)}`;
    } else {
      throw new Error(`export ${subpath} → ${file}: no rule to ship it`);
    }
  }
  exports["./package.json"] = "./package.json";
  return exports;
}

async function prebuiltStyles(): Promise<string> {
  const styles = await Bun.file(join(FOUNDATIONS, "styles.css")).text();
  if (!styles.includes(FONTS_IMPORT)) {
    throw new Error(
      "styles.css no longer imports ./fonts.css; update the build",
    );
  }
  // The layer order comes first: Tailwind's layered imports would otherwise
  // fix `utilities` before `base` and let theme.css's border colour win.
  // No preflight: the kit must not reset the host app's global styles.
  const input = [
    "@layer theme, base, components, utilities, werft;",
    '@import "tailwindcss/theme.css" layer(theme);',
    '@import "tailwindcss/utilities.css" layer(utilities) source(none);',
    '@import "./theme.css";',
    '@import "./scoped-preflight.css";',
    styles.replace(FONTS_IMPORT, ""),
    '@source "..";',
    '@source not "../__fixtures__";',
    '@source not "../test-support";',
    '@source not "../**/*.test.{ts,tsx}";',
  ].join("\n");
  // Read from stdin, Tailwind resolves the imports above against its cwd.
  const proc = Bun.spawn(["tailwindcss", "-i", "-", "-o", "-", "--minify"], {
    cwd: FOUNDATIONS,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [css, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`tailwindcss exited ${code}:\n${stderr}`);
  if (/@import|url\(/.test(css)) {
    throw new Error("prebuilt styles.css still loads another file");
  }
  return css;
}

rmSync(OUT, { recursive: true, force: true });

await build({
  config: false,
  cwd: PACKAGE_ROOT,
  entry: ["src/index.ts", "src/primitives/index.ts", "src/patterns/index.ts"],
  format: "esm",
  platform: "neutral",
  unbundle: true,
  dts: true,
  tsconfig: "tsconfig.build.json",
  outDir: OUT,
  logLevel: "warn",
});

await Bun.write(join(OUT, "styles.css"), await prebuiltStyles());
for (const file of ["tokens.css", "theme.css"]) {
  cpSync(join(FOUNDATIONS, file), join(OUT, file));
}
cpSync(join(PACKAGE_ROOT, "../../LICENSE"), join(OUT, "LICENSE"));

const source: Manifest = await Bun.file(
  join(PACKAGE_ROOT, "package.json"),
).json();
const manifest = {
  name: source.name,
  version: source.version,
  // Packable, but nothing here names a registry: publishing is a person's call.
  private: false,
  license: source.license,
  type: source.type,
  sideEffects: source.sideEffects,
  exports: distExports(source.exports),
  peerDependencies: source.peerDependencies,
  dependencies: source.dependencies,
};
await Bun.write(
  join(OUT, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`built ${source.name}@${source.version} into ${OUT}`);
