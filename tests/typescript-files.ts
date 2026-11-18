import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** The `.ts`/`.tsx` files under `directory`, outside node_modules. */
export async function typescriptFiles(
  directory: string,
  keep: (name: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        keep(entry.name) &&
        !entry.parentPath.includes(`${join(directory, "node_modules")}`),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}
