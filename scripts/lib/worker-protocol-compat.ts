/**
 * The worker protocol as data, and what a new control-host would break for a
 * worker of the baseline release
 * (docs/contributing/decisions/worker-compat.md § 3).
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type JsonSchema, subsetProblems } from "./schema-subset.ts";

type Io = "input" | "output";
// The zod namespace and contracts module of whichever tree is described: a
// baseline made from a release tag reads that tag's own zod and schemas.
type Schema = { _zod: { def: Record<string, unknown> } };
type Zod = {
  toJSONSchema: (
    schema: never,
    options: {
      io: Io;
      unrepresentable?: "any";
      override?: (context: {
        zodSchema: Schema;
        path: (string | number)[];
      }) => void;
    },
  ) => unknown;
};
export type ContractsModule = {
  WORKER_PROTOCOL_ROUTES: Record<string, { request: Schema; response: Schema }>;
  apiErrorResponseSchema: Schema;
};

export type Message = { schema: JsonSchema; opaque: string[] };
export type Protocol = {
  release: string | null;
  commit: string;
  routes: Record<string, { request: Message; response: Message }>;
  error: Message;
};

function message(z: Zod, schema: Schema, io: Io): Message {
  const opaque = opaqueParts(schema);
  let described: unknown;
  try {
    described = z.toJSONSchema(schema as never, { io });
  } catch {
    // Some node has no JSON Schema (a transform's output, a date, a bigint
    // literal). zod writes a stand-in that may compare equal across a real
    // change ({} for both a date and a string turned into one), so each such
    // node is also named in opaque: the deepest one, as zod visits children
    // before their parent.
    const unrepresented: string[] = [];
    described = z.toJSONSchema(schema as never, {
      io,
      unrepresentable: "any",
      override: ({ zodSchema, path }) => {
        const at = ["$", ...path].join("/");
        if (
          unrepresented.some(
            (part) => part.startsWith(`${at} `) || part.startsWith(`${at}/`),
          )
        ) {
          return;
        }
        try {
          z.toJSONSchema(zodSchema as never, { io });
        } catch {
          unrepresented.push(
            `${at} no JSON Schema (${String(zodSchema._zod.def.type)})`,
          );
        }
      },
    });
    opaque.push(...unrepresented.sort());
  }
  const { $schema: _, ...json } = described as Record<string, unknown>;
  return { schema: json, opaque };
}

/**
 * The protocol a worker of this tree speaks. The baseline keeps both sides
 * as input: what that worker's requests look like before any parse, and what
 * its response parse accepts. The current tree's responses are compared as
 * output, the shape the control-host's parse leaves on the wire.
 */
export function describeProtocol(
  contracts: ContractsModule,
  z: Zod,
  head: { release: string | null; commit: string },
  responseIo: Io = "input",
): Protocol {
  return {
    ...head,
    routes: Object.fromEntries(
      Object.entries(contracts.WORKER_PROTOCOL_ROUTES).map(
        ([path, { request, response }]) => [
          path,
          {
            request: message(z, request, "input"),
            response: message(z, response, responseIo),
          },
        ],
      ),
    ),
    error: message(z, contracts.apiErrorResponseSchema, responseIo),
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

// Where a schema decides with code that JSON Schema cannot carry. A refine's
// body is hashed; superRefine, transform and catch bodies are behind zod's
// own wrappers, so only their place and kind are kept.
export function opaqueParts(schema: Schema, path = "$"): string[] {
  const out: string[] = [];
  const walk = (node: Schema, at: string) => {
    const def = node._zod.def;
    for (const check of (def.checks as Schema[] | undefined) ?? []) {
      const checkDef = check._zod.def;
      if (checkDef.check === "custom") {
        out.push(
          typeof checkDef.fn === "function"
            ? `${at} refine ${sha256(String(checkDef.fn))}`
            : `${at} refine`,
        );
      }
    }
    const child = (key: string) => def[key] as Schema;
    switch (def.type) {
      case "object":
        for (const [key, value] of Object.entries(
          def.shape as Record<string, Schema>,
        )) {
          walk(value, `${at}.${key}`);
        }
        if (def.catchall) walk(child("catchall"), `${at}.*`);
        return;
      case "array":
        return walk(child("element"), `${at}[]`);
      case "union":
        (def.options as Schema[]).forEach((option, index) => {
          walk(option, `${at}<${index}>`);
        });
        return;
      case "intersection":
        walk(child("left"), `${at}&0`);
        return walk(child("right"), `${at}&1`);
      case "record":
        walk(child("keyType"), `${at}{key}`);
        return walk(child("valueType"), `${at}.*`);
      case "tuple":
        (def.items as Schema[]).forEach((item, index) => {
          walk(item, `${at}[${index}]`);
        });
        if (def.rest) walk(child("rest"), `${at}[]`);
        return;
      case "pipe":
        out.push(`${at} pipe`);
        walk(child("in"), `${at}|in`);
        return walk(child("out"), `${at}|out`);
      case "transform":
        out.push(`${at} transform`);
        return;
      case "catch":
        out.push(`${at} catch`);
        return walk(child("innerType"), at);
      case "custom":
        out.push(`${at} custom`);
        return;
      case "lazy":
        out.push(`${at} lazy`);
        return;
      default:
        if (def.innerType) walk(child("innerType"), at);
    }
  };
  walk(schema, path);
  return out;
}

function opaqueChanges(where: string, before: string[], after: string[]) {
  const added = after.filter((part) => !before.includes(part));
  const removed = before.filter((part) => !after.includes(part));
  return [
    ...removed.map(
      (part) =>
        `${where}: code-only check ${part} changed or went away; JSON Schema cannot show what it accepted`,
    ),
    ...added.map(
      (part) =>
        `${where}: code-only check ${part} is new or changed; JSON Schema cannot show what it accepts`,
    ),
  ];
}

/**
 * What a worker of the baseline release would meet that it cannot handle:
 * a route gone, a request the control-host now refuses, a response or error
 * body that worker refuses, or a code-only check that moved.
 */
export function compatibilityProblems(
  baseline: Protocol,
  current: Protocol,
): string[] {
  const problems: string[] = [];
  for (const [path, old] of Object.entries(baseline.routes)) {
    const now = current.routes[path];
    if (now === undefined) {
      problems.push(`${path}: the route is gone`);
      continue;
    }
    problems.push(
      ...subsetProblems(
        old.request.schema,
        now.request.schema,
        `${path} request $`,
      ),
      ...subsetProblems(
        now.response.schema,
        old.response.schema,
        `${path} response $`,
      ),
      ...opaqueChanges(
        `${path} request`,
        old.request.opaque,
        now.request.opaque,
      ),
      ...opaqueChanges(
        `${path} response`,
        old.response.opaque,
        now.response.opaque,
      ),
    );
  }
  problems.push(
    ...subsetProblems(current.error.schema, baseline.error.schema, "error $"),
    ...opaqueChanges("error", baseline.error.opaque, current.error.opaque),
  );
  return problems;
}

export function sameProtocol(left: Protocol, right: Protocol): boolean {
  return isDeepStrictEqual(left, right);
}
