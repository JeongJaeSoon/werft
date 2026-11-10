import { describe, expect, test } from "bun:test";

import type { RuntimeCapabilityTable } from "./descriptor.ts";
import {
  featureSupport,
  runtimeRequirementsOf,
  unmetFeatures,
} from "./features.ts";

const table: RuntimeCapabilityTable = {
  interrupt: true,
  checkpoint: true,
  approvalCheckpoint: false,
  resume: true,
  mcp: "native",
  skills: "none",
  permissionModes: {
    default: "native",
    acceptEdits: "native",
    dontAsk: "native",
    plan: "native",
    bypassPermissions: "native",
    auto: "native",
  },
};
const mcpServer = {
  name: "docs",
  endpoint: "https://mcp.example.invalid/mcp",
  binding: `sha256:${"0".repeat(64)}`,
  access: { kind: "egress_token", token: "t" },
} as const;

describe("runtimeRequirementsOf", () => {
  test("asks for nothing beyond what every engine runs", () => {
    expect(runtimeRequirementsOf({ permission_mode: "default" })).toEqual({
      features: [],
    });
  });

  test("asks for mcp with a server and a classifier in auto mode", () => {
    expect(
      runtimeRequirementsOf({
        permission_mode: "auto",
        mcp_servers: [mcpServer],
      }),
    ).toEqual({ features: ["mcp", "classifier_review"] });
  });

  test("asks for skills when the claim names an extension bundle, and only then", () => {
    const bundle = { name: "lint", digest: "ab".repeat(32), scope: "agent" };
    const one = runtimeRequirementsOf({
      permission_mode: "default",
      extensions: [bundle],
    } as never);
    expect(one).toEqual({ features: ["skills"] });
    expect(
      runtimeRequirementsOf({ permission_mode: "default", extensions: [] }),
    ).toEqual({ features: [] });
    expect(unmetFeatures(table, {}, one)).toEqual(["skills"]);
    expect(unmetFeatures({ ...table, skills: "native" }, {}, one)).toEqual([]);
  });
});

describe("featureSupport", () => {
  test("reads table features from the table, ignoring the extras", () => {
    expect(featureSupport(table, { mcp: "none" }, "mcp")).toBe("native");
    expect(featureSupport(table, { skills: "native" }, "skills")).toBe("none");
  });

  test("derives resume and park from the boolean capabilities", () => {
    expect(featureSupport(table, {}, "session_resume")).toBe("native");
    // Parking needs a checkpoint taken at the approval, not only a turn-end one.
    expect(featureSupport(table, {}, "approval_park")).toBe("none");
    const parking = { ...table, approvalCheckpoint: true };
    expect(featureSupport(parking, {}, "approval_park")).toBe("native");
    const noResume = { ...parking, resume: false };
    expect(featureSupport(noResume, {}, "session_resume")).toBe("none");
    expect(featureSupport(noResume, {}, "approval_park")).toBe("none");
  });

  test("reads the classifier from the auto mode's support", () => {
    const withAuto = (auto: "emulated" | "none") => ({
      ...table,
      permissionModes: { ...table.permissionModes, auto },
    });
    expect(featureSupport(withAuto("emulated"), {}, "classifier_review")).toBe(
      "emulated",
    );
    expect(featureSupport(withAuto("none"), {}, "classifier_review")).toBe(
      "none",
    );
  });

  test("defaults an extra feature nobody declared to none", () => {
    expect(featureSupport(table, {}, "user_hooks")).toBe("none");
    expect(featureSupport(table, { subagents: "emulated" }, "subagents")).toBe(
      "emulated",
    );
  });
});

describe("unmetFeatures", () => {
  test("is empty when every required feature is supported", () => {
    expect(
      unmetFeatures(table, {}, { features: ["mcp", "classifier_review"] }),
    ).toEqual([]);
  });

  test("counts emulated as met and lists what is missing in order", () => {
    const partial = { ...table, mcp: "emulated" as const };
    expect(
      unmetFeatures(
        partial,
        { subagents: "emulated" },
        { features: ["user_hooks", "mcp", "subagents", "skills"] },
      ),
    ).toEqual(["user_hooks", "skills"]);
  });
});
