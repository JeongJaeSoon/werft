// Loaded before every `bun test` run (bunfig.toml `[test] preload`).
//
// A PGlite's WebAssembly memory takes about 4 GiB of the room Bun on Linux
// has for all ArrayBuffers together (about 60 GiB, a fixed reservation):
// JSC reserves the whole 32-bit address space for its first memories so it
// can skip bounds checks. `close()` keeps that memory, and a test file keeps
// its last instance in module-level variables for the rest of the process.
// Eight such files left half the room taken for the whole run, and a later
// allocation that did not fit failed with "RangeError: Out of memory", as did
// every pipe read after it. Dropping the Emscripten module on close
// lets the memory go even while the closed instance stays referenced.
import { PGlite } from "@electric-sql/pglite";

const close = PGlite.prototype.close;
PGlite.prototype.close = async function (this: PGlite) {
  await close.call(this);
  (this as unknown as { mod?: unknown }).mod = undefined;
};
