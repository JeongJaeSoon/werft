import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

// A JSON Schema node as z.toJSONSchema writes it.
export type JsonSchema = boolean | { [keyword: string]: unknown };
type Node = { [keyword: string]: unknown };

// Keywords that never change which values a schema accepts.
const ANNOTATIONS = new Set([
  "$schema",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

// Keywords this checker reasons about. On the accepting side any other
// keyword must be identical on both sides, so a construct it does not know
// fails rather than passes.
const UNDERSTOOD = new Set([
  "type",
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "format",
]);

/**
 * Where a value the `sender` schema allows could be refused by the
 * `receiver` schema; empty when every such value is accepted. Conservative:
 * a difference it cannot decide (two patterns, an unknown keyword, a $ref)
 * is reported. An open sender object (no additionalProperties false) may
 * carry keys it does not declare: a worker does not parse its requests.
 */
export function subsetProblems(
  sender: JsonSchema,
  receiver: JsonSchema,
  path = "$",
): string[] {
  const problems: string[] = [];
  check(sender, receiver, path, problems);
  return problems;
}

function check(
  sender: JsonSchema,
  receiver: JsonSchema,
  path: string,
  out: string[],
): void {
  for (const schema of [sender, receiver]) {
    if (isNode(schema) && ("$ref" in schema || "$defs" in schema)) {
      out.push(
        `${path}: a $ref or $defs; this check does not follow references`,
      );
      return;
    }
  }
  if (receiver === true || (isNode(receiver) && unconstrained(receiver))) {
    return;
  }
  if (sender === false) {
    return;
  }
  if (receiver === false) {
    out.push(`${path}: the receiver accepts no value here`);
    return;
  }
  const senderBranches = isNode(sender) ? branches(sender) : undefined;
  if (senderBranches) {
    senderBranches.forEach((branch, index) => {
      check(branch, receiver, `${path}<${index}>`, out);
    });
    return;
  }
  const receiverBranches = branches(receiver);
  if (receiverBranches) {
    let best: string[] | undefined;
    for (const branch of receiverBranches) {
      const found: string[] = [];
      check(sender, branch, path, found);
      if (found.length === 0) {
        return;
      }
      if (best === undefined || found.length < best.length) {
        best = found;
      }
    }
    out.push(
      `${path}: no branch of the receiver's union accepts the sender; the closest one refuses:`,
      ...(best ?? []).map((line) => `  ${line}`),
    );
    return;
  }
  if (sender === true || unconstrained(sender)) {
    out.push(
      `${path}: the sender may send any value; the receiver does not accept every value`,
    );
    return;
  }
  unknownKeywords(sender, receiver, path, out);
  const senderValues = literals(sender);
  if (senderValues) {
    const accepts = z.fromJSONSchema(receiver as never);
    for (const value of senderValues) {
      if (!accepts.safeParse(value).success) {
        out.push(`${path}: the receiver refuses ${JSON.stringify(value)}`);
      }
    }
    return;
  }
  if (literals(receiver)) {
    out.push(
      `${path}: the receiver accepts only ${JSON.stringify(literals(receiver))}; the sender is not limited to those`,
    );
    return;
  }
  const senderTypes = types(sender);
  const receiverTypes = types(receiver);
  if (senderTypes === undefined) {
    if (receiverTypes !== undefined) {
      out.push(
        `${path}: the sender's type is open; the receiver takes only ${receiverTypes.join(", ")}`,
      );
    }
    return;
  }
  for (const type of senderTypes) {
    if (
      receiverTypes !== undefined &&
      !receiverTypes.includes(type) &&
      !(type === "integer" && receiverTypes.includes("number"))
    ) {
      out.push(
        `${path}: the sender may send ${type}; the receiver takes only ${receiverTypes.join(", ")}`,
      );
      continue;
    }
    if (type === "string") {
      strings(sender, receiver, path, out);
    } else if (type === "number" || type === "integer") {
      numbers(sender, receiver, path, out, type, receiverTypes);
    } else if (type === "array") {
      arrays(sender, receiver, path, out);
    } else if (type === "object") {
      objects(sender, receiver, path, out);
    }
  }
}

function isNode(schema: JsonSchema): schema is Node {
  return typeof schema === "object" && schema !== null;
}

function unconstrained(schema: Node): boolean {
  return Object.keys(schema).every((keyword) => ANNOTATIONS.has(keyword));
}

// A union as its branches, each carrying the keywords written beside it.
function branches(schema: Node): JsonSchema[] | undefined {
  const union = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (union === undefined) {
    return undefined;
  }
  const { anyOf: _anyOf, oneOf: _oneOf, ...beside } = schema;
  return union.map((branch) =>
    isNode(branch) ? { ...beside, ...branch } : branch,
  );
}

function literals(schema: Node): unknown[] | undefined {
  if ("const" in schema) {
    return [schema.const];
  }
  return Array.isArray(schema.enum) ? schema.enum : undefined;
}

function types(schema: Node): string[] | undefined {
  const type = schema.type;
  if (type === undefined) {
    return undefined;
  }
  return Array.isArray(type) ? (type as string[]) : [type as string];
}

function unknownKeywords(
  sender: Node,
  receiver: Node,
  path: string,
  out: string[],
): void {
  for (const keyword of Object.keys(receiver)) {
    if (ANNOTATIONS.has(keyword) || UNDERSTOOD.has(keyword)) {
      continue;
    }
    if (!isDeepStrictEqual(sender[keyword], receiver[keyword])) {
      out.push(
        `${path}: the receiver's "${keyword}" differs and this check cannot compare it`,
      );
    }
  }
}

// The sender's lower bound must be at least the receiver's, and its upper
// bound at most the receiver's; a missing sender bound is unbounded.
function bounded(
  path: string,
  out: string[],
  what: string,
  sender: number | undefined,
  receiver: number | undefined,
  side: "min" | "max",
): void {
  if (receiver === undefined) {
    return;
  }
  const ok =
    sender !== undefined &&
    (side === "min" ? sender >= receiver : sender <= receiver);
  if (!ok) {
    out.push(
      `${path}: the receiver's ${what} is ${receiver}; the sender's is ${sender ?? "unbounded"}`,
    );
  }
}

function strings(
  sender: Node,
  receiver: Node,
  path: string,
  out: string[],
): void {
  bounded(
    path,
    out,
    "minLength",
    (sender.minLength as number) ?? 0,
    receiver.minLength as number | undefined,
    "min",
  );
  bounded(
    path,
    out,
    "maxLength",
    sender.maxLength as number | undefined,
    receiver.maxLength as number | undefined,
    "max",
  );
  for (const keyword of ["pattern", "format"] as const) {
    if (
      receiver[keyword] !== undefined &&
      sender[keyword] !== receiver[keyword]
    ) {
      out.push(
        `${path}: the receiver requires ${keyword} ${JSON.stringify(receiver[keyword])}; the sender's is ${JSON.stringify(sender[keyword] ?? null)}`,
      );
    }
  }
}

type Bound = { value: number; exclusive: boolean };

function bound(schema: Node, side: "min" | "max"): Bound | undefined {
  const inclusive = schema[side === "min" ? "minimum" : "maximum"] as
    | number
    | undefined;
  const exclusive = schema[
    side === "min" ? "exclusiveMinimum" : "exclusiveMaximum"
  ] as number | undefined;
  if (exclusive === undefined) {
    return inclusive === undefined
      ? undefined
      : { value: inclusive, exclusive: false };
  }
  if (inclusive === undefined) {
    return { value: exclusive, exclusive: true };
  }
  // Both: the tighter one decides.
  const tighter =
    side === "min" ? exclusive >= inclusive : exclusive <= inclusive;
  return tighter
    ? { value: exclusive, exclusive: true }
    : { value: inclusive, exclusive: false };
}

function numbers(
  sender: Node,
  receiver: Node,
  path: string,
  out: string[],
  type: string,
  receiverTypes: string[] | undefined,
): void {
  if (
    type === "number" &&
    receiverTypes !== undefined &&
    !receiverTypes.includes("number")
  ) {
    out.push(
      `${path}: the sender may send a fraction; the receiver takes only integers`,
    );
  }
  for (const side of ["min", "max"] as const) {
    const want = bound(receiver, side);
    if (want === undefined) {
      continue;
    }
    const have = bound(sender, side);
    const within =
      have !== undefined &&
      (side === "min" ? have.value > want.value : have.value < want.value);
    const same =
      have !== undefined &&
      have.value === want.value &&
      (have.exclusive || !want.exclusive);
    if (!(within || same)) {
      out.push(
        `${path}: the receiver's ${side === "min" ? "lower" : "upper"} bound is ${want.exclusive ? "exclusive " : ""}${want.value}; the sender's is ${have === undefined ? "unbounded" : `${have.exclusive ? "exclusive " : ""}${have.value}`}`,
      );
    }
  }
}

function arrays(
  sender: Node,
  receiver: Node,
  path: string,
  out: string[],
): void {
  bounded(
    path,
    out,
    "minItems",
    (sender.minItems as number) ?? 0,
    receiver.minItems as number | undefined,
    "min",
  );
  bounded(
    path,
    out,
    "maxItems",
    sender.maxItems as number | undefined,
    receiver.maxItems as number | undefined,
    "max",
  );
  const senderPrefix = (sender.prefixItems as JsonSchema[] | undefined) ?? [];
  const receiverPrefix =
    (receiver.prefixItems as JsonSchema[] | undefined) ?? [];
  const senderRest = (sender.items as JsonSchema | undefined) ?? true;
  const receiverRest = (receiver.items as JsonSchema | undefined) ?? true;
  const positions = Math.max(senderPrefix.length, receiverPrefix.length);
  for (let index = 0; index < positions; index++) {
    check(
      senderPrefix[index] ?? senderRest,
      receiverPrefix[index] ?? receiverRest,
      `${path}[${index}]`,
      out,
    );
  }
  check(senderRest, receiverRest, `${path}[]`, out);
}

function objects(
  sender: Node,
  receiver: Node,
  path: string,
  out: string[],
): void {
  const senderProperties =
    (sender.properties as Record<string, JsonSchema> | undefined) ?? {};
  const receiverProperties =
    (receiver.properties as Record<string, JsonSchema> | undefined) ?? {};
  const senderRequired = new Set(
    (sender.required as string[] | undefined) ?? [],
  );
  const receiverExtra = receiver.additionalProperties as JsonSchema | undefined;
  for (const key of (receiver.required as string[] | undefined) ?? []) {
    if (!senderRequired.has(key)) {
      out.push(
        `${path}: the receiver requires "${key}"; the sender may leave it out`,
      );
    }
  }
  for (const [key, schema] of Object.entries(senderProperties)) {
    const at = `${path}.${key}`;
    if (key in receiverProperties) {
      check(schema, receiverProperties[key] as JsonSchema, at, out);
      continue;
    }
    if (receiverExtra === false) {
      out.push(
        `${at}: the receiver refuses this key (additionalProperties: false)`,
      );
    } else if (receiverExtra !== undefined) {
      check(schema, receiverExtra, at, out);
    }
    if (receiver.propertyNames !== undefined) {
      check(
        { type: "string", const: key },
        receiver.propertyNames as JsonSchema,
        `${at} (name)`,
        out,
      );
    }
  }
  const senderExtra = sender.additionalProperties as JsonSchema | undefined;
  if (senderExtra === undefined) {
    // Open but undeclared: what rides along is unknown.
    if (receiverExtra === false) {
      out.push(
        `${path}: the sender's object is open; the receiver refuses keys it does not declare`,
      );
    }
  } else if (senderExtra !== false) {
    // A record or a loose object: keys of the sender's own choosing.
    if (receiverExtra === false) {
      out.push(
        `${path}: the sender may send keys of its own; the receiver refuses unknown keys`,
      );
    } else if (receiverExtra !== undefined) {
      check(senderExtra, receiverExtra, `${path}.*`, out);
    }
    for (const [key, schema] of Object.entries(receiverProperties)) {
      if (!(key in senderProperties)) {
        check(senderExtra, schema, `${path}.${key}`, out);
      }
    }
    if (receiver.propertyNames !== undefined) {
      check(
        (sender.propertyNames as JsonSchema | undefined) ?? { type: "string" },
        receiver.propertyNames as JsonSchema,
        `${path}.* (name)`,
        out,
      );
    }
  }
}
