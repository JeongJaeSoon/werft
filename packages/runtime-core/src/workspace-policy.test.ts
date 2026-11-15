import { describe, expect, test } from "bun:test";
import { parseWorkspacePolicy, WORKSPACE_POLICY } from "./workspace-policy.ts";

type Editable = Record<"git" | "fs" | "rgHidden", Record<string, unknown>>;

describe("parseWorkspacePolicy", () => {
  test("reads the shipped policy", () => {
    expect(parseWorkspacePolicy(structuredClone(WORKSPACE_POLICY))).toEqual(
      WORKSPACE_POLICY,
    );
  });

  test.each<[string, (policy: Editable) => void, RegExp]>([
    [
      "an emptied guard list",
      (policy) => {
        policy.git.ask = [];
      },
      /git\.ask must be a non-empty list/,
    ],
    [
      "an empty pattern",
      (policy) => {
        policy.git.ask = [...(policy.git.ask as string[]), ""];
      },
      /git\.ask must be a non-empty list/,
    ],
    [
      "a missing list",
      (policy) => {
        delete policy.fs.ask;
      },
      /fs\.ask must be a non-empty list/,
    ],
    [
      "an unknown key",
      (policy) => {
        policy.git.alow = ["git"];
      },
      /unknown key git\.alow/,
    ],
    [
      "an empty text",
      (policy) => {
        policy.rgHidden.letterBeforeUU = "";
      },
      /rgHidden\.letterBeforeUU must be a non-empty string/,
    ],
  ])("refuses %s", (_name, edit, message) => {
    const policy = structuredClone(WORKSPACE_POLICY) as unknown as Editable;
    edit(policy);
    expect(() => parseWorkspacePolicy(policy)).toThrow(message);
  });
});
