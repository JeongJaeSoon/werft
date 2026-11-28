import { describe, expect, test } from "bun:test";
import type { EgressUpstream } from "../catalog/index.ts";
import { registeredUpstream } from "./private-upstream.ts";

const upstream: EgressUpstream = {
  url: "http://llm.corp:4000",
  headers: [["x-api-key", "k"]],
};
const gate = (
  deny: readonly string[] | null,
  listed = false,
  asked: string[] = [],
) => ({
  deny: async () => {
    asked.push("deny");
    return deny;
  },
  operatorListed: () => listed,
});

describe("registeredUpstream", () => {
  test("a private connection goes to a proxy that reads the mark with the mark and the installation's hosts", async () => {
    expect(
      await registeredUpstream(
        upstream,
        "private",
        true,
        gate(["api", "10.0.0.3"]),
      ),
    ).toEqual({ ...upstream, allow: "private", deny: ["api", "10.0.0.3"] });
    // No host to deny is still a list: the proxy needs one with the mark.
    expect(
      await registeredUpstream(upstream, "private", true, gate([])),
    ).toEqual({
      ...upstream,
      allow: "private",
      deny: [],
    });
  });

  test("a proxy that does not read the mark gets no private grant, but for a host the operator listed", async () => {
    const asked: string[] = [];
    expect(
      await registeredUpstream(
        upstream,
        "private",
        false,
        gate(["api"], false, asked),
      ),
    ).toBe("egress_proxy_outdated");
    // The operator's own list holds it there, as before the mark: no mark.
    expect(
      await registeredUpstream(
        upstream,
        "private",
        false,
        gate(["api"], true, asked),
      ),
    ).toEqual(upstream);
    expect(asked).toEqual([]);
  });

  test("hosts that cannot all be told leave no private grant, listed or not", async () => {
    for (const listed of [false, true]) {
      expect(
        await registeredUpstream(upstream, "private", true, gate(null, listed)),
      ).toBe("private_deny_unavailable");
    }
  });

  test("any other connection goes as it is", async () => {
    const asked: string[] = [];
    for (const network of ["public", undefined] as const) {
      for (const reads of [true, false]) {
        expect(
          await registeredUpstream(
            upstream,
            network,
            reads,
            gate(["api"], false, asked),
          ),
        ).toEqual(upstream);
      }
    }
    expect(
      await registeredUpstream(upstream, "private", true, undefined),
    ).toEqual(upstream);
    expect(asked).toEqual([]);
  });
});
