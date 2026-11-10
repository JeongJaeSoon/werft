/**
 * Installs the packed @werft-ai/ui into an empty Vite + React app with no
 * Tailwind, the way an outside consumer would, and fails unless it type-checks
 * with skipLibCheck off, builds, and renders a styled Button in Chrome.
 *
 *   bun run --cwd packages/ui build:package
 *   bun scripts/ui-pack-smoke.ts [--screenshot <file.png>] [--keep]
 *
 * Needs node and npm (the consumer's toolchain, from the npm registry) and
 * Chrome (CHROME_BIN, or the usual install path). The app lives under the
 * system temp directory and is removed afterwards unless --keep is given.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_DIR = join(ROOT, "packages/ui/dist");

// The versions this repo locks, so the consumer matches what the kit is tested with.
const CONSUMER_DEPENDENCIES = {
  react: "19.3.0",
  "react-dom": "19.3.0",
};
const CONSUMER_DEV_DEPENDENCIES = {
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  "@vitejs/plugin-react": "5.2.0",
  typescript: "5.9.2",
  vite: "7.3.7",
};

const { values: args } = parseArgs({
  options: {
    screenshot: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

function step(message: string): void {
  console.log(`\n== ${message}`);
}

// Thrown, not process.exit, so the work directory is still removed.
function fail(message: string): never {
  throw new Error(message);
}

async function run(cmd: string[], cwd: string): Promise<string> {
  console.log(`$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) fail(`${cmd[0]} exited ${code}\n${stdout}${stderr}`);
  return stdout;
}

function chromeBinary(): string {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    Bun.which("google-chrome"),
    Bun.which("google-chrome-stable"),
    Bun.which("chromium"),
  ];
  for (const candidate of candidates) {
    if (candidate && Bun.file(candidate).size > 0) return candidate;
  }
  fail("no Chrome found; set CHROME_BIN");
}

const CONSUMER_FILES: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="ko" data-theme="light">
  <head><meta charset="utf-8" /><title>ui-pack-smoke</title></head>
  <body style="margin: 0; padding: 24px">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  "vite.config.ts": `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react()] });
`,
  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      // The app's code only, as Vite's template splits it: vite.config.ts
      // would need @types/node, which says nothing about the kit.
      include: ["src"],
    },
    null,
    2,
  )}\n`,
  "src/css.d.ts": `declare module "*.css";\n`,
  "src/main.tsx": `import { Button, Card } from "@werft-ai/ui";
import "@werft-ai/ui/styles.css";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const container = document.getElementById("root");
if (!container) throw new Error("no #root");
const root = createRoot(container);
flushSync(() =>
  root.render(
    <div style={{ display: "flex", gap: 8 }}>
      <Button id="probe">저장</Button>
      <Button id="probe-outline" variant="outline">취소</Button>
      <Button id="probe-ghost" variant="ghost">더보기</Button>
      <Button asChild variant="outline">
        <a id="probe-link" href="#next">다음</a>
      </Button>
      <Card id="probe-card" className="px-4">카드</Card>
    </div>,
  ),
);

// Chrome's --dump-dom prints markup only, so the computed style rides on it.
const button = document.getElementById("probe");
const outline = document.getElementById("probe-outline");
const ghost = document.getElementById("probe-ghost");
const link = document.getElementById("probe-link");
const card = document.getElementById("probe-card");
if (!button || !outline || !ghost || !link || !card) {
  throw new Error("kit did not render");
}
const style = getComputedStyle(button);
document.body.dataset.background = style.backgroundColor;
document.body.dataset.color = style.color;
document.body.dataset.height = style.height;
document.body.dataset.border = style.borderTopWidth;
document.body.dataset.outlineBorder = \`\${getComputedStyle(outline).borderTopWidth} \${getComputedStyle(outline).borderTopStyle}\`;
document.body.dataset.ghostBackground = getComputedStyle(ghost).backgroundColor;
document.body.dataset.fontInherited = String(
  style.fontFamily === getComputedStyle(document.body).fontFamily,
);
document.body.dataset.link = \`\${getComputedStyle(link).textDecorationLine} \${getComputedStyle(link).color === getComputedStyle(outline).color}\`;
document.body.dataset.cardBorder = \`\${getComputedStyle(card).borderTopWidth} \${getComputedStyle(card).borderTopColor}\`;
`,
  // Type-checked only: the published types are real, not \`any\`.
  "src/types.tsx": `import { Button, type ButtonProps } from "@werft-ai/ui";
import { Button as PrimitiveButton } from "@werft-ai/ui/primitives";
import { ConfirmDialog } from "@werft-ai/ui/patterns";

export const props: ButtonProps = { variant: "outline", size: "sm" };
// @ts-expect-error: not a Button variant
export const wrong = <Button variant="nope" />;
export const same: typeof Button = PrimitiveButton;
export const dialog: typeof ConfirmDialog = ConfirmDialog;
// @ts-expect-error: test helpers are not part of the published package
export const helpers = import("@werft-ai/ui/test-support/dom");
`,
};

if (!(await Bun.file(join(PACKAGE_DIR, "package.json")).exists())) {
  fail(`${PACKAGE_DIR} has no package.json; run build:package first`);
}

const work = mkdtempSync(join(tmpdir(), "ui-pack-smoke-"));
console.log(`work directory: ${work}`);

try {
  step("npm pack");
  const packed = JSON.parse(
    await run(
      ["npm", "pack", PACKAGE_DIR, "--pack-destination", work, "--json"],
      ROOT,
    ),
  )[0] as {
    filename: string;
    size: number;
    unpackedSize: number;
    files: { path: string }[];
  };
  const paths = packed.files.map((file) => file.path).sort();
  console.log(paths.join("\n"));
  console.log(
    `${packed.filename}: ${packed.size} B packed, ${packed.unpackedSize} B unpacked, ${paths.length} files`,
  );
  const stray = paths.filter((path) =>
    /test-support|__fixtures__|\.test\.|fonts|\.woff2$/.test(path),
  );
  if (stray.length > 0) fail(`the tarball carries ${stray.join(", ")}`);

  step("consumer app");
  const app = join(work, "app");
  await Bun.write(
    join(app, "package.json"),
    `${JSON.stringify(
      {
        name: "ui-pack-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@werft-ai/ui": `file:../${packed.filename}`,
          ...CONSUMER_DEPENDENCIES,
        },
        devDependencies: CONSUMER_DEV_DEPENDENCIES,
      },
      null,
      2,
    )}\n`,
  );
  for (const [file, text] of Object.entries(CONSUMER_FILES)) {
    await Bun.write(join(app, file), text);
  }
  console.log(await run(["npm", "install", "--no-audit", "--no-fund"], app));
  for (const name of ["tailwindcss", "@tailwindcss/vite", "pretendard"]) {
    if (
      await Bun.file(join(app, "node_modules", name, "package.json")).exists()
    ) {
      fail(`${name} was installed; the consumer must not have it`);
    }
  }
  console.log(
    "no tailwindcss, @tailwindcss/vite or pretendard in node_modules",
  );

  step("tsc (skipLibCheck: false)");
  await run([join(app, "node_modules/.bin/tsc"), "-p", "tsconfig.json"], app);
  console.log("tsc: no errors");

  step("vite build");
  console.log(await run([join(app, "node_modules/.bin/vite"), "build"], app));

  step("render in Chrome");
  const dist = join(app, "dist");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const file = Bun.file(
        join(dist, normalize(pathname === "/" ? "/index.html" : pathname)),
      );
      return (await file.exists())
        ? new Response(file)
        : new Response("not found", { status: 404 });
    },
  });
  try {
    const chrome = chromeBinary();
    const flags = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(work, "chrome-profile")}`,
      "--window-size=480,120",
      "--virtual-time-budget=5000",
      // GitHub's Ubuntu runners block the user namespaces Chrome's sandbox needs.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ];
    const dom = await run(
      [chrome, ...flags, "--dump-dom", server.url.href],
      work,
    );
    const button = dom.match(
      /<button[^>]*id="probe"[^>]*>[^<]*<\/button>/,
    )?.[0];
    if (!button) fail(`no rendered button in\n${dom}`);
    const body = dom.match(/<body[^>]*>/)?.[0] ?? "";
    console.log(button);
    console.log(body);

    const tokens = await Bun.file(join(PACKAGE_DIR, "tokens.css")).text();
    // The first match is the light theme's value.
    const tokenRgb = (name: string): string => {
      const hex = tokens.match(
        new RegExp(`--${name}:\\s*#([0-9a-f]{6});`, "i"),
      )?.[1];
      if (!hex) fail(`tokens.css has no light --${name}`);
      const [r, g, b] = [0, 2, 4].map((i) =>
        Number.parseInt(hex.slice(i, i + 2), 16),
      );
      return `rgb(${r}, ${g}, ${b})`;
    };
    const accent = tokenRgb("werft-color-accent");
    const border = tokenRgb("werft-color-border");
    const expected = {
      'data-slot="button"': button.includes('data-slot="button"'),
      "class bg-primary": /class="[^"]*\bbg-primary\b/.test(button),
      [`background ${accent}`]: body.includes(`data-background="${accent}"`),
      // --werft-control-height is 2rem; unstyled, the button would be its text's height.
      "height 32px": body.includes('data-height="32px"'),
      // No preflight here: the user agent's 2px outset button border must not show.
      "border 0px": body.includes('data-border="0px"'),
      "outline variant border 1px solid": body.includes(
        'data-outline-border="1px solid"',
      ),
      // Without preflight, a UA buttonface background and system font would show.
      "ghost variant background transparent": body.includes(
        'data-ghost-background="rgba(0, 0, 0, 0)"',
      ),
      "button font inherited": body.includes('data-font-inherited="true"'),
      // Button asChild on <a>: no UA underline or link blue.
      "link button no underline, button colour": body.includes(
        'data-link="none true"',
      ),
      // A bare `border` class takes theme.css's colour, not currentColor.
      [`card border 1px ${border}`]: body.includes(
        `data-card-border="1px ${border}"`,
      ),
    };
    for (const [check, ok] of Object.entries(expected)) {
      console.log(`${ok ? "ok  " : "FAIL"} ${check}`);
    }
    if (Object.values(expected).includes(false)) fail("render checks failed");

    if (args.screenshot) {
      await run(
        [
          chrome,
          ...flags,
          "--hide-scrollbars",
          "--force-device-scale-factor=2",
          `--screenshot=${args.screenshot}`,
          server.url.href,
        ],
        work,
      );
      console.log(`screenshot: ${args.screenshot}`);
    }
  } finally {
    server.stop(true);
  }

  console.log("\nui-pack-smoke: ok");
} catch (error) {
  console.error(`\nui-pack-smoke: FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  if (args.keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
