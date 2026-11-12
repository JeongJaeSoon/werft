import { dlopen, FFIType } from "bun:ffi";
import { messageOf } from "./message-of.ts";

// <linux/prctl.h>
const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

/** `prctl(option, value)` as libc exports it; returns what the call did. */
export type Prctl = (option: number, value: number) => number;

function libcPrctl(): Prctl {
  // glibc's soname: the worker image is Debian. prctl is variadic in C; the
  // three unused arguments are passed as zeroes so every register it may
  // read is defined.
  const libc = dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  });
  return (option, value) => libc.symbols.prctl(option, value, 0, 0, 0);
}

/**
 * Stops other processes of this uid from reading this one. The engine and
 * every command it runs share the worker's uid, and Linux lets a process
 * read the environ, memory, open descriptors and maps of any other process
 * of its own uid under /proc. This process holds what the engine must not
 * see: the session credential, the object store token, the MCP servers'
 * upstream tokens.
 *
 * A process that is not dumpable is owned by root under /proc and fails the
 * kernel's ptrace access check for anyone without CAP_SYS_PTRACE, which
 * nothing in the worker container has. The flag is per address space, is
 * reset only by execve and by a change of uid or gid, and so holds for this
 * process's life while the children it starts stay as they were.
 *
 * It does not cover PID 1, which holds the same launch environment: the
 * worker makes the nonce in it useless instead (WorkerHost's activation).
 *
 * On Linux a failure throws, so the worker does not start: running without
 * the boundary would look the same as running with it. Elsewhere (a
 * developer's direct run) there is no /proc to protect and nothing is done.
 */
export function denySameUserInspection(
  platform: NodeJS.Platform = process.platform,
  load: () => Prctl = libcPrctl,
): void {
  if (platform !== "linux") return;
  let prctl: Prctl;
  try {
    prctl = load();
  } catch (error) {
    throw new Error(
      `The worker cannot make itself unreadable to the engine: prctl could not be loaded from libc (${messageOf(error)})`,
      { cause: error },
    );
  }
  const set = prctl(PR_SET_DUMPABLE, 0);
  if (set !== 0) {
    throw new Error(
      `The worker cannot make itself unreadable to the engine: prctl(PR_SET_DUMPABLE, 0) returned ${set}`,
    );
  }
  const dumpable = prctl(PR_GET_DUMPABLE, 0);
  if (dumpable < 0) {
    throw new Error(
      `The worker cannot make itself unreadable to the engine: prctl(PR_GET_DUMPABLE) returned ${dumpable}, so the flag could not be read back`,
    );
  }
  if (dumpable !== 0) {
    throw new Error(
      `The worker cannot make itself unreadable to the engine: it is still dumpable (${dumpable}) after prctl(PR_SET_DUMPABLE, 0)`,
    );
  }
}
