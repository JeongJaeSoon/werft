/**
 * Download a file whose sha256 is pinned, retrying a bounded number of times.
 *
 *   bun scripts/fetch-pinned.ts <url> <sha256> <dest> [fallback-url]
 *
 * Dockerfile `ADD --checksum` has no retry, so one bad response from an
 * external host (snapshot.debian.org has answered with a body of another hash
 * for a pinned deb) fails the whole build. A wrong body is retried
 * like a failed request, and only bytes that hash to the pin are written: the
 * pin is never relaxed, and the last attempt's failure is the exit status.
 * An optional independent URL takes over after the first failure. GitHub
 * release asset APIs require Accept: application/octet-stream; both routes
 * must return the same pinned bytes. No credentials are sent.
 *
 * FETCH_PINNED_ATTEMPTS (default 4), FETCH_PINNED_DELAY_MS (default 5000,
 * multiplied by the attempt number), FETCH_PINNED_TIMEOUT_MS (60000, the whole
 * request including the body) and FETCH_PINNED_MAX_BYTES (16 MiB) exist for
 * tests/fetch-pinned.test.ts.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const [url, pin, dest, fallbackUrl] = process.argv.slice(2);
if (!url || !dest || !/^[0-9a-f]{64}$/.test(pin ?? "")) {
  console.error(
    "usage: bun fetch-pinned.ts <url> <sha256> <dest> [fallback-url]",
  );
  process.exit(2);
}

const attempts = Number(process.env.FETCH_PINNED_ATTEMPTS ?? 4);
const delayMs = Number(process.env.FETCH_PINNED_DELAY_MS ?? 5000);
const timeoutMs = Number(process.env.FETCH_PINNED_TIMEOUT_MS ?? 60_000);
const maxBytes = Number(process.env.FETCH_PINNED_MAX_BYTES ?? 16 * 1024 * 1024);

for (let attempt = 1; attempt <= attempts; attempt++) {
  const source = attempt > 1 && fallbackUrl ? fallbackUrl : url;
  let failure: string;
  try {
    const response = await fetch(source, {
      headers:
        source === fallbackUrl ? { accept: "application/octet-stream" } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Count decoded bytes as they arrive: Content-Length does not bound a
    // compressed or chunked body, and the pinned files are small.
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new Error(`body over ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const digest = createHash("sha256").update(body).digest("hex");
    if (response.ok && digest === pin) {
      writeFileSync(dest, body);
      console.log(`fetched ${source} on attempt ${attempt}: sha256:${digest}`);
      process.exit(0);
    }
    failure = `HTTP ${response.status}, ${body.length} bytes, sha256:${digest}, want sha256:${pin}`;
  } catch (error) {
    failure = String(error);
  }
  console.error(`attempt ${attempt}/${attempts} for ${source}: ${failure}`);
  if (attempt < attempts) {
    await Bun.sleep(delayMs * attempt);
  }
}
process.exit(1);
