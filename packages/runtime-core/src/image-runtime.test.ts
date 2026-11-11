import { describe, expect, test } from "bun:test";
import {
  imageRuntimeVersions,
  parseImageRuntime,
  restorableSchemesOf,
} from "./image-runtime.ts";

const stamped = {
  cliVersion: "2.1.270",
  engine: "claude",
  sdkVersion: "0.3.270",
};

describe("parseImageRuntime", () => {
  test("reads what an image prints, its per-session profiles ignored", () => {
    expect(
      parseImageRuntime(
        JSON.stringify({ ...stamped, profileDigestScheme: 2, profiles: {} }),
      ),
    ).toEqual({ ...stamped, profileDigestScheme: 2 });
  });

  test("an image from before the scheme field hashed under scheme 1", () => {
    expect(parseImageRuntime(JSON.stringify(stamped))).toEqual({
      ...stamped,
      profileDigestScheme: 1,
    });
  });

  test("an image names the schemes it resumes; one that says nothing resumes only its own", () => {
    expect(
      parseImageRuntime(
        JSON.stringify({
          ...stamped,
          profileDigestScheme: 2,
          restorableSchemes: [1, 2, 2],
        }),
      ),
    ).toEqual({
      ...stamped,
      profileDigestScheme: 2,
      restorableSchemes: [1, 2],
    });
    expect(
      restorableSchemesOf(
        parseImageRuntime(
          JSON.stringify({ ...stamped, profileDigestScheme: 2 }),
        ),
      ),
    ).toEqual([2]);
  });

  test("refuses restorableSchemes that leave out the image's own scheme", () => {
    for (const restorableSchemes of [[1], [], "1", [0, 2], [1.5, 2]]) {
      expect(() =>
        parseImageRuntime(
          JSON.stringify({
            ...stamped,
            profileDigestScheme: 2,
            restorableSchemes,
          }),
        ),
      ).toThrow("restorableSchemes");
    }
  });

  test("refuses anything that is not that shape", () => {
    for (const [text, problem] of [
      ["", "not JSON"],
      ["[]", "JSON object"],
      [JSON.stringify({ ...stamped, sdkVersion: "" }), "sdkVersion"],
      [JSON.stringify({ cliVersion: "2", engine: "claude" }), "sdkVersion"],
      [JSON.stringify({ ...stamped, profileDigestScheme: 0 }), "positive"],
      [JSON.stringify({ ...stamped, profileDigestScheme: "1" }), "positive"],
      [JSON.stringify({ ...stamped, sdk_version: "0.3.270" }), "sdk_version"],
    ] as const) {
      expect(() => parseImageRuntime(text)).toThrow(problem);
    }
  });

  test("a release may name either the SDK or the CLI version", () => {
    expect(
      imageRuntimeVersions({ ...stamped, profileDigestScheme: 1 }),
    ).toEqual(["0.3.270", "2.1.270"]);
  });
});
