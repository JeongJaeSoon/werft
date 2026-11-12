import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type JsonSchema,
  subsetProblems,
} from "../scripts/lib/schema-subset.ts";

const json = (schema: z.ZodType, io: "input" | "output" = "input") =>
  z.toJSONSchema(schema, { io }) as JsonSchema;

// A response: the control-host's output reaches a worker that parses with
// its own (older) input schema.
const response = (sent: z.ZodType, read: z.ZodType) =>
  subsetProblems(json(sent, "output"), json(read));
// A request: an older worker's input reaches the control-host's input.
const request = (sent: z.ZodType, read: z.ZodType) =>
  subsetProblems(json(sent), json(read));

describe("subsetProblems on responses", () => {
  const old = z.object({ id: z.string(), mode: z.enum(["a", "b"]) });

  test("the same schema passes", () => {
    expect(response(old, old)).toEqual([]);
  });

  test("a field the old reader requires, gone", () => {
    expect(response(z.object({ mode: z.enum(["a", "b"]) }), old)).toEqual([
      '$: the receiver requires "id"; the sender may leave it out',
    ]);
  });

  test("a required field made optional", () => {
    expect(
      response(
        z.object({ id: z.string().optional(), mode: z.enum(["a", "b"]) }),
        old,
      ),
    ).toEqual(['$: the receiver requires "id"; the sender may leave it out']);
  });

  test("a new field: dropped by a plain reader, refused by a strict one", () => {
    const more = old.extend({ extra: z.number() });
    expect(response(more, old)).toEqual([]);
    expect(response(more, old.strict())).toEqual([
      "$.extra: the receiver refuses this key (additionalProperties: false)",
    ]);
  });

  test("a new enum value", () => {
    expect(
      response(
        z.object({ id: z.string(), mode: z.enum(["a", "b", "c"]) }),
        old,
      ),
    ).toEqual(['$.mode: the receiver refuses "c"']);
    expect(
      response(z.object({ id: z.string(), mode: z.enum(["a"]) }), old),
    ).toEqual([]);
  });

  test("null where the reader wants a value", () => {
    expect(
      response(
        z.object({ id: z.string().nullable(), mode: z.enum(["a", "b"]) }),
        old,
      ),
    ).toEqual([
      "$.id: the sender may send null; the receiver takes only string",
    ]);
  });

  test("a new branch of a discriminated union", () => {
    const one = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("x") }),
    ]);
    const two = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("x") }),
      z.object({ kind: z.literal("y"), v: z.string() }),
    ]);
    expect(response(one, two)).toEqual([]);
    const found = response(two, one);
    expect(found[0]).toBe(
      "$<1>: no branch of the receiver's union accepts the sender; the closest one refuses:",
    );
    expect(found[1]).toBe('  $<1>.kind: the receiver refuses "y"');
  });

  test("lengths and bounds", () => {
    const short = z.object({
      s: z.string().max(10),
      n: z.number().int().min(1),
    });
    expect(
      response(
        z.object({ s: z.string().max(5), n: z.number().int().min(2) }),
        short,
      ),
    ).toEqual([]);
    expect(
      response(
        z.object({ s: z.string().max(20), n: z.number().int().min(0) }),
        short,
      ),
    ).toEqual([
      "$.s: the receiver's maxLength is 10; the sender's is 20",
      "$.n: the receiver's lower bound is 1; the sender's is 0",
    ]);
    expect(
      response(z.object({ s: z.string(), n: z.number().int().min(1) }), short),
    ).toEqual([
      "$.s: the receiver's maxLength is 10; the sender's is unbounded",
    ]);
    expect(
      response(
        z.object({ s: z.string().max(10), n: z.number().min(1) }),
        short,
      ),
    ).toEqual([
      "$.n: the sender may send number; the receiver takes only integer",
    ]);
  });

  test("patterns and formats must be the same text", () => {
    expect(
      response(z.object({ id: z.uuid() }), z.object({ id: z.uuid() })),
    ).toEqual([]);
    expect(
      response(z.object({ id: z.string() }), z.object({ id: z.uuid() })),
    ).toEqual([
      '$.id: the receiver requires pattern "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"; the sender\'s is null',
      '$.id: the receiver requires format "uuid"; the sender\'s is null',
    ]);
  });

  test("a literal is checked against the reader's constraints", () => {
    expect(
      response(
        z.object({ v: z.literal("abc") }),
        z.object({ v: z.string().max(2) }),
      ),
    ).toEqual(['$.v: the receiver refuses "abc"']);
    expect(
      response(
        z.object({ v: z.literal("ab") }),
        z.object({ v: z.string().max(2) }),
      ),
    ).toEqual([]);
  });

  test("records", () => {
    const counts = z.record(z.string(), z.number().int());
    expect(response(counts, z.record(z.string(), z.number()))).toEqual([]);
    expect(response(z.record(z.string(), z.number()), counts)).toEqual([
      "$.*: the sender may send number; the receiver takes only integer",
    ]);
    expect(response(counts, z.object({}).strict())).toEqual([
      "$: the sender may send keys of its own; the receiver refuses unknown keys",
    ]);
  });

  test("a $ref is never compared", () => {
    expect(subsetProblems({ $ref: "#" }, { type: "string" })).toEqual([
      "$: a $ref or $defs; this check does not follow references",
    ]);
  });

  test("an unknown keyword on the receiver passes only when identical", () => {
    expect(
      subsetProblems(
        { type: "string", contentMediaType: "a" },
        { type: "string", contentMediaType: "a" },
      ),
    ).toEqual([]);
    expect(
      subsetProblems(
        { type: "string" },
        { type: "string", contentMediaType: "a" },
      ),
    ).toEqual([
      '$: the receiver\'s "contentMediaType" differs and this check cannot compare it',
    ]);
  });
});

describe("subsetProblems on requests", () => {
  const old = z
    .object({ session_id: z.string(), note: z.string().optional() })
    .strict();

  test("a new required field the old worker does not send", () => {
    expect(request(old, old.extend({ added: z.string() }))).toEqual([
      '$: the receiver requires "added"; the sender may leave it out',
    ]);
    expect(request(old, old.extend({ added: z.string().optional() }))).toEqual(
      [],
    );
    expect(
      request(old, old.extend({ added: z.string().default("x") })),
    ).toEqual([]);
  });

  test("a field the old worker sends, dropped from a strict schema", () => {
    expect(request(old, z.object({ session_id: z.string() }).strict())).toEqual(
      ["$.note: the receiver refuses this key (additionalProperties: false)"],
    );
    expect(request(old, z.object({ session_id: z.string() }))).toEqual([]);
  });

  test("an open object made strict", () => {
    const open = z.object({ session_id: z.string() });
    expect(request(open, open.strict())).toEqual([
      "$: the sender's object is open; the receiver refuses keys it does not declare",
    ]);
  });

  test("an unknown value is fine only for a reader that takes anything", () => {
    expect(
      request(z.object({ v: z.unknown() }), z.object({ v: z.unknown() })),
    ).toEqual([]);
    expect(
      request(z.object({ v: z.unknown() }), z.object({ v: z.string() })),
    ).toEqual([
      "$.v: the sender may send any value; the receiver does not accept every value",
    ]);
  });
});
