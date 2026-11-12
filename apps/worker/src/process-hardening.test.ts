import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { denySameUserInspection, type Prctl } from "./process-hardening.ts";

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

function recording(answers: Record<number, number>) {
  const calls: Array<[number, number]> = [];
  const prctl: Prctl = (option, value) => {
    calls.push([option, value]);
    return answers[option] ?? 0;
  };
  return { calls, load: () => prctl };
}

describe("denySameUserInspection", () => {
  test("on Linux it clears the dumpable flag and reads it back", () => {
    const { calls, load } = recording({});

    denySameUserInspection("linux", load);

    expect(calls).toEqual([
      [PR_SET_DUMPABLE, 0],
      [PR_GET_DUMPABLE, 0],
    ]);
  });

  test("off Linux it loads nothing and calls nothing", () => {
    let loaded = false;

    denySameUserInspection("darwin", () => {
      loaded = true;
      return () => 0;
    });

    expect(loaded).toBe(false);
  });

  test("a refused prctl stops the worker, without reading the flag back", () => {
    const { calls, load } = recording({ [PR_SET_DUMPABLE]: -1 });

    expect(() => denySameUserInspection("linux", load)).toThrow(
      "prctl(PR_SET_DUMPABLE, 0) returned -1",
    );
    expect(calls).toEqual([[PR_SET_DUMPABLE, 0]]);
  });

  test("a flag that reads back set stops the worker", () => {
    const { load } = recording({ [PR_GET_DUMPABLE]: 1 });

    expect(() => denySameUserInspection("linux", load)).toThrow(
      "still dumpable (1)",
    );
  });

  test("a flag that cannot be read back stops the worker, and is not reported as still set", () => {
    const { load } = recording({ [PR_GET_DUMPABLE]: -1 });

    expect(() => denySameUserInspection("linux", load)).toThrow(
      "prctl(PR_GET_DUMPABLE) returned -1, so the flag could not be read back",
    );
  });

  test("a libc that cannot be loaded stops the worker and says why", () => {
    expect(() =>
      denySameUserInspection("linux", () => {
        throw new Error("libc.so.6: cannot open shared object file");
      }),
    ).toThrow("prctl could not be loaded from libc (libc.so.6: cannot open");
  });

  // The kernel's side of it, with the real libc: a child of the same uid
  // reads its parent's environ until the parent calls this, and not after.
  // Root holds CAP_SYS_PTRACE outside a container that dropped it, which
  // is the one reader the flag does not stop.
  test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
    "a process of the same uid reads this one's environ before the call and is refused after it",
    async () => {
      const module = join(import.meta.dir, "process-hardening.ts");
      const script = `
        import { denySameUserInspection } from ${JSON.stringify(module)};
        if (process.argv.at(-1) === "harden") denySameUserInspection();
        const reader = Bun.spawnSync(["cat", "/proc/" + process.pid + "/environ"]);
        console.log(JSON.stringify({
          exitCode: reader.exitCode,
          sawMarker: reader.stdout.toString().includes("BOUNDARY_MARKER=held-by-parent"),
          stderr: reader.stderr.toString().trim(),
        }));
      `;
      const run = async (mode: "harden" | "plain") => {
        const child = Bun.spawn([process.execPath, "-e", script, mode], {
          env: { ...process.env, BOUNDARY_MARKER: "held-by-parent" },
          stderr: "pipe",
          stdout: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code !== 0) throw new Error(`${mode} child exited ${code}: ${err}`);
        return JSON.parse(out.trim()) as {
          exitCode: number;
          sawMarker: boolean;
          stderr: string;
        };
      };

      // The control: without the call the read works, so a refusal below is
      // the flag's doing and not this host's.
      expect(await run("plain")).toEqual({
        exitCode: 0,
        sawMarker: true,
        stderr: "",
      });
      const hardened = await run("harden");
      expect(hardened.sawMarker).toBe(false);
      expect(hardened.exitCode).not.toBe(0);
      expect(hardened.stderr).toContain("Permission denied");
    },
    30_000,
  );
});
