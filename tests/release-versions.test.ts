import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { highestStable } from "../.github/scripts/release-versions.ts";

// What the "Latest" mark follows: the highest stable version of all releases,
// never the one a run happens to be for.

describe("highestStable", () => {
  test("picks the highest version, whatever the order", () => {
    expect(highestStable(["v0.4.0", "v0.4.1"])).toBe("v0.4.1");
    expect(highestStable(["v0.4.1", "v0.4.0"])).toBe("v0.4.1");
  });

  test("compares numbers, not text", () => {
    expect(highestStable(["v0.9.0", "v0.10.0"])).toBe("v0.10.0");
    expect(highestStable(["v9.0.0", "v10.0.0", "v2.99.99"])).toBe("v10.0.0");
    // Beyond what a double holds exactly.
    expect(
      highestStable(["v0.0.900000000000000001", "v0.0.900000000000000002"]),
    ).toBe("v0.0.900000000000000002");
  });

  test("a later hotfix on an older line is not the highest", () => {
    expect(highestStable(["v0.3.0", "v0.4.0", "v0.3.5"])).toBe("v0.4.0");
  });

  test("a prerelease is never chosen, even of a higher version", () => {
    expect(highestStable(["v0.4.0", "v0.5.0-rc.1", "v1.0.0-beta"])).toBe(
      "v0.4.0",
    );
    expect(highestStable(["v0.5.0-rc.1"])).toBeUndefined();
  });

  test("anything that is not a release version is ignored", () => {
    expect(
      highestStable(["sdk-v9.0.0", "v1.2", "v01.0.0", "1.0.0", "", "v0.1.0"]),
    ).toBe("v0.1.0");
    expect(highestStable([])).toBeUndefined();
  });
});

describe("release-versions.ts latest", () => {
  const run = (stdin: string, ...args: string[]) => {
    const out = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "../.github/scripts/release-versions.ts"),
        ...args,
      ],
      { stdin: new TextEncoder().encode(stdin) },
    );
    return { exitCode: out.exitCode, stdout: out.stdout.toString() };
  };

  test("prints the highest stable tag of the lines on stdin", () => {
    expect(run("v0.4.0\nv0.3.5\nv0.5.0-rc.1\n", "latest")).toEqual({
      exitCode: 0,
      stdout: "v0.4.0\n",
    });
  });

  test("prints nothing when there is none", () => {
    expect(run("\n", "latest")).toEqual({ exitCode: 0, stdout: "" });
  });

  test("refuses any other command", () => {
    expect(run("v0.4.0\n").exitCode).toBe(2);
    expect(run("v0.4.0\n", "aliases").exitCode).toBe(2);
  });
});
