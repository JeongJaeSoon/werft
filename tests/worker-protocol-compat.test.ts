import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as contracts from "@werft-ai/contracts";
import { z } from "zod";
import { ACCEPTED } from "../scripts/lib/worker-protocol-accepted.ts";
import {
  compatibilityProblems,
  describeProtocol,
  opaqueParts,
  type Protocol,
} from "../scripts/lib/worker-protocol-compat.ts";
import { BASELINE_FILE } from "../scripts/worker-protocol-baseline.ts";

const root = join(import.meta.dir, "..");
const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Protocol;
// As the control-host sends it: responses after its own parse.
const current = describeProtocol(
  contracts,
  z,
  { release: null, commit: "" },
  "output",
);
const problems = compatibilityProblems(baseline, current);

describe("worker protocol against the baseline release", () => {
  test("a worker of the baseline release can still talk to this control-host", () => {
    const accepted = new Set(ACCEPTED.map((entry) => entry.problem));
    const open = problems.filter((problem) => !accepted.has(problem));
    // On failure: follow the expand → contract order in
    // docs/contributing/decisions/worker-compat.md § 2, or, when the
    // difference cannot reach a worker of that release, list it in
    // scripts/lib/worker-protocol-accepted.ts with its proof. Never
    // regenerate the baseline to make this pass.
    expect(open).toEqual([]);
  });

  test("every accepted difference is still live and has its proof", () => {
    for (const entry of ACCEPTED) {
      expect(problems).toContain(entry.problem);
      expect(entry.why.length).toBeGreaterThan(0);
      expect(existsSync(join(root, entry.proof))).toBe(true);
    }
  });

  test("the baseline names a released version, or none before the first one", () => {
    expect(baseline.commit).toMatch(/^[0-9a-f]{40}$/);
    if (baseline.release !== null) {
      const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
      expect(changelog.split("\n")).toContain(`## ${baseline.release}`);
    }
  });

  test("the control-host serves every route of the table, and only those", () => {
    expect(Object.keys(baseline.routes).sort()).toEqual(
      Object.keys(contracts.WORKER_PROTOCOL_ROUTES).sort(),
    );
  });
});

describe("compatibilityProblems", () => {
  // The bootstrap-claim response with the two fields the profile removal
  // dropped while workers of the release before still required them.
  const withProfile = (protocol: Protocol): Protocol => {
    const copy = structuredClone(protocol);
    const response = copy.routes["/bootstrap-claim"]?.response.schema as {
      properties: Record<
        string,
        { properties: Record<string, unknown>; required: string[] }
      >;
      required: string[];
    };
    const runtime = response.properties.runtime;
    if (runtime === undefined)
      throw new Error("no runtime in the claim response");
    runtime.properties.profile_id = { type: "string" };
    runtime.required.push("profile_id");
    response.properties.profile_fingerprint = { type: "string" } as never;
    response.required.push("profile_fingerprint");
    return copy;
  };

  test("finds a response field removed while the baseline worker requires it", () => {
    const found = compatibilityProblems(withProfile(baseline), current);
    expect(found).toEqual([
      '/bootstrap-claim response $: the receiver requires "profile_fingerprint"; the sender may leave it out',
      '/bootstrap-claim response $.runtime: the receiver requires "profile_id"; the sender may leave it out',
    ]);
  });

  test("finds a removed route", () => {
    const fewer = structuredClone(current);
    delete fewer.routes["/heartbeat"];
    expect(compatibilityProblems(baseline, fewer)).toEqual([
      "/heartbeat: the route is gone",
    ]);
  });

  test("finds a code-only check that changed", () => {
    const changed = structuredClone(current);
    const route = changed.routes["/finalize"];
    if (route === undefined) throw new Error("no finalize route");
    route.request.opaque = route.request.opaque.map((part) =>
      part.replace(/refine [0-9a-f]+$/, "refine 0000000000000000"),
    );
    const found = compatibilityProblems(baseline, changed);
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.every((line) =>
        line.startsWith("/finalize request: code-only check"),
      ),
    ).toBe(true);
  });
});

describe("opaqueParts", () => {
  test("names refines with their body, and transforms, catches and pipes by place", () => {
    const schema = z.object({
      a: z.string().refine((value) => value !== "x"),
      b: z.preprocess((value) => value, z.number()),
      c: z.string().catch("d"),
      d: z.array(z.string().transform((value) => value.length)),
      e: z.string().optional(),
    });
    const parts = opaqueParts(schema as never);
    expect(parts[0]).toMatch(/^\$\.a refine [0-9a-f]{16}$/);
    expect(parts.slice(1)).toEqual([
      "$.b pipe",
      "$.b|in transform",
      "$.c catch",
      "$.d[] pipe",
      "$.d[]|out transform",
    ]);
  });

  test("a refine with another body hashes differently", () => {
    const one = opaqueParts(
      z.string().refine((value) => value !== "x") as never,
    );
    const two = opaqueParts(
      z.string().refine((value) => value !== "y") as never,
    );
    expect(one).not.toEqual(two);
  });
});
