import { join } from "node:path";
import { pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const root = join(import.meta.dir, "..", "..", "..");
const OPENAPI_DOCUMENT = join(root, "docs", "openapi.json");
export const GENERATED_SCHEMA = join(
  import.meta.dir,
  "..",
  "src",
  "schema.gen.ts",
);

const HEADER = `// Generated from docs/openapi.json by \`bun run --cwd packages/client api:generate\`.
// Do not edit by hand.

`;

export async function generateApiSchema(): Promise<string> {
  const ast = await openapiTS(pathToFileURL(OPENAPI_DOCUMENT));
  return HEADER + astToString(ast);
}

if (import.meta.main) {
  await Bun.write(GENERATED_SCHEMA, await generateApiSchema());
  console.log(`wrote ${GENERATED_SCHEMA}`);
}
