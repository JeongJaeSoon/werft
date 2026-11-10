/**
 * Deterministic JSON for content-addressed identity.
 *
 * Ported from Kollegium v1 `packages/core/src/ids.ts` (Apache-2.0,
 * JeongJaeSoon/kollegium @ d711706). Two rules make a hash trustworthy:
 * object keys sort, array order is data and never sorts. Anything JSON cannot
 * represent the same way twice throws instead of serialising to `null` or
 * being dropped on the floor.
 */

function assertRepresentable(value: unknown, path: string): void {
  if (value === undefined) {
    throw new TypeError(`canonicalJson: undefined at ${path}`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`canonicalJson: non-finite number at ${path}`);
  }
  // `JSON.stringify(-0)` is `"0"`, so two values JavaScript tells apart would
  // hash the same. Identity is the whole job here.
  if (Object.is(value, -0)) {
    throw new TypeError(`canonicalJson: negative zero at ${path}`);
  }
  if (typeof value === "bigint") {
    throw new TypeError(`canonicalJson: bigint at ${path}`);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonicalJson: ${typeof value} at ${path}`);
  }
  // Date, Map, Set and friends all stringify through their own rules, which
  // are not stable contract input. Only plain objects and arrays pass.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `canonicalJson: ${value.constructor?.name ?? "non-plain object"} at ${path}`,
      );
    }
  }
}

// A symbol-keyed property is invisible to JSON.stringify, so two cards that
// differ only there would hash alike. Refuse rather than drop.
function assertNoSymbolKeys(value: object, path: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`canonicalJson: symbol-keyed property at ${path}`);
  }
}

function canonicalizeArray(value: unknown[], path: string): unknown[] {
  assertNoSymbolKeys(value, path);
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    // `map` skips a hole and JSON.stringify writes it as `null`, which is a
    // different value that would hash the same. Refuse the hole instead.
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`canonicalJson: array hole at ${path}[${index}]`);
    }
    items.push(canonicalize(value[index], `${path}[${index}]`));
  }
  // Own properties beyond the indices (`a.note = "x"`) are dropped by
  // JSON.stringify; they are data the hash would silently lose.
  if (Object.keys(value).length !== value.length) {
    throw new TypeError(`canonicalJson: non-index property at ${path}`);
  }
  return items;
}

function canonicalize(value: unknown, path: string): unknown {
  assertRepresentable(value, path);
  if (Array.isArray(value)) {
    return canonicalizeArray(value, path);
  }
  if (value !== null && typeof value === "object") {
    assertNoSymbolKeys(value, path);
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`),
      ]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$"));
}

/**
 * `canonicalJson` of what `JSON.stringify` makes of `value`: an undefined
 * property is left out and `-0` reads as `0` instead of being refused. The
 * checkpoint manifest, the Claude runtime config digest and transcript entries
 * have always been hashed that way, and their digests are stored.
 */
export function canonicalJsonOfJson(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value)));
}
