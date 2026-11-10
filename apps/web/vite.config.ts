import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3000";

/**
 * build.license lists only the JS packages in the bundle; the self-hosted
 * fonts are CSS assets, so their OFL texts ship beside it under licenses/.
 */
function fontLicenses(): Plugin {
  const fonts = new URL(
    "../../packages/ui/src/foundations/fonts/",
    import.meta.url,
  );
  return {
    name: "font-licenses",
    apply: "build",
    generateBundle() {
      for (const font of ["geist", "pretendard"]) {
        this.emitFile({
          type: "asset",
          fileName: `licenses/${font}-LICENSE.txt`,
          source: readFileSync(new URL(`${font}/LICENSE.txt`, fonts)),
        });
      }
    },
  };
}

/**
 * `--mode demo`: the read-only demo (src/demo/main.tsx) that answers from
 * recorded fixtures. Relative asset paths let it sit under any static path.
 * The recording lives in JeongJaeSoon/agent-platform-demo; DEMO_FIXTURES
 * points the build at it, else the placeholder in src/demo/fixtures.json.
 */
function demoEntry(): Plugin {
  const fixtures = process.env.DEMO_FIXTURES;
  return {
    name: "demo-entry",
    // Ahead of Vite's own resolver, which would find the placeholder.
    enforce: "pre",
    resolveId: (source, importer) =>
      fixtures &&
      source === "./fixtures.json" &&
      importer?.endsWith("/src/demo/main.tsx")
        ? resolve(fixtures)
        : null,
    // "pre": the build reads its entry from the transformed page.
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html.replace('src="/src/main.tsx"', 'src="/src/demo/main.tsx"'),
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: mode === "demo" ? "./" : "/",
  plugins: [
    react(),
    tailwindcss(),
    fontLicenses(),
    ...(mode === "demo" ? [demoEntry()] : []),
  ],
  // packages/ui resolves through a workspace symlink; without this a second
  // React or query-core copy breaks hooks and the query cache at runtime.
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  build: {
    outDir: mode === "demo" ? "dist-demo" : "dist",
    emptyOutDir: true,
    license: { fileName: "THIRD_PARTY_NOTICES.md" },
  },
  server: {
    proxy: { "/v1": { target: apiTarget, changeOrigin: false } },
    // chokidar keeps FSEvents on even when CHOKIDAR_USEPOLLING asks for
    // polling, so on a Mac where FSEvents delivers nothing no edit is seen.
    ...(/^(1|true)$/i.test(process.env.CHOKIDAR_USEPOLLING ?? "") && {
      watch: { useFsEvents: false },
    }),
  },
}));
