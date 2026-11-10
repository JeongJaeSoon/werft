// A stand-in OTLP/HTTP collector for local verification only: accepts
// POST /v1/traces (protobuf), prints one line per span and the resource
// attributes, and answers 200. Attribute values on spans are never printed
// (they may carry prompts); resource attributes are.
//
//   bun scripts/fake-otlp-receiver.ts [port]        # default 4318, loopback
//
// Reads the wire format by hand so it needs no installed dependency.

type Field = { num: number; wire: number; value: Uint8Array | bigint };

function* fields(bytes: Uint8Array): Generator<Field> {
  let at = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[at++];
      if (byte === undefined) throw new Error("truncated varint");
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (at < bytes.length) {
    const tag = Number(varint());
    const num = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) yield { num, wire, value: varint() };
    else if (wire === 1) {
      yield { num, wire, value: bytes.subarray(at, at + 8) };
      at += 8;
    } else if (wire === 5) {
      yield { num, wire, value: bytes.subarray(at, at + 4) };
      at += 4;
    } else if (wire === 2) {
      const length = Number(varint());
      yield { num, wire, value: bytes.subarray(at, at + length) };
      at += length;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
}

const text = (value: Field["value"]) =>
  new TextDecoder().decode(value as Uint8Array);
const hex = (value: Field["value"]) =>
  Buffer.from(value as Uint8Array).toString("hex");

function keyValue(bytes: Uint8Array): { key: string; value: string } {
  let key = "";
  let value = "";
  for (const field of fields(bytes)) {
    if (field.num === 1) key = text(field.value);
    if (field.num === 2) {
      for (const inner of fields(field.value as Uint8Array)) {
        if (inner.num === 1) value = text(inner.value);
        else if (inner.num === 3) value = String(inner.value);
      }
    }
  }
  return { key, value };
}

function describe(body: Uint8Array): string[] {
  const lines: string[] = [];
  for (const request of fields(body)) {
    if (request.num !== 1) continue;
    const resource: string[] = [];
    const spans: string[] = [];
    for (const part of fields(request.value as Uint8Array)) {
      if (part.num === 1) {
        for (const field of fields(part.value as Uint8Array)) {
          if (field.num !== 1) continue;
          const { key, value } = keyValue(field.value as Uint8Array);
          resource.push(`${key}=${value}`);
        }
      }
      if (part.num !== 2) continue;
      for (const scope of fields(part.value as Uint8Array)) {
        if (scope.num !== 2) continue;
        let name = "";
        let traceId = "";
        const attributeKeys: string[] = [];
        for (const span of fields(scope.value as Uint8Array)) {
          if (span.num === 1) traceId = hex(span.value);
          if (span.num === 5) name = text(span.value);
          if (span.num === 9) {
            attributeKeys.push(keyValue(span.value as Uint8Array).key);
          }
        }
        spans.push(
          `span trace_id=${traceId} name=${name} attribute_keys=${attributeKeys.join(",")}`,
        );
      }
    }
    lines.push(`resource ${resource.join(" ")}`, ...spans);
  }
  return lines;
}

const port = Number(process.argv[2] ?? 4318);
Bun.serve({
  hostname: process.env.RECEIVER_HOST ?? "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/traces") {
      return new Response("not found", { status: 404 });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    try {
      for (const line of describe(body)) console.log(line);
    } catch (error) {
      console.log(`undecodable body of ${body.length} bytes: ${error}`);
    }
    // Header names only: values may be credentials.
    console.log(`headers ${[...request.headers.keys()].sort().join(",")}`);
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  },
});
console.log(`fake OTLP receiver on ${port}`);
