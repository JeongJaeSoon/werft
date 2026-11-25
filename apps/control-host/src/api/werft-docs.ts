import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { docsPart } from "@werft-ai/platform";

/** The docs pages this checkout or image carries (apps/docs/content/docs). */
export const WERFT_DOCS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "content",
  "docs",
);

/**
 * Every MDX page under `dir`, read once. The image ships apps/docs, so the
 * built-in `werft` server answers from the docs of the version it runs; an
 * image without them is a broken build, and the API does not start.
 */
export function installedWerftDocs(
  dir: string = WERFT_DOCS_DIR,
): Parameters<typeof docsPart>[1] {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".mdx"))
    .sort()
    .map((path) => ({
      path: relative(dir, join(dir, path)).split(sep).join("/"),
      text: readFileSync(join(dir, path), "utf8"),
    }));
  if (!files.some((file) => file.path === "index.mdx")) {
    throw new Error(`No Werft documentation in ${dir}`);
  }
  return files;
}
