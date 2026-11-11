import { describe, expect, test } from "bun:test";
import { DEFAULT_PULL_REQUEST_SETTINGS } from "@werft-ai/contracts";
import { createPostgresPullRequestSettingsStore } from "./pull-request-settings.ts";

describe("workspace pull request settings read", () => {
  test("an owner scope that is not a uuid reads the defaults without asking the database", async () => {
    const store = createPostgresPullRequestSettingsStore({
      select: () => {
        throw new Error("the database was asked");
      },
    } as never);
    expect(await store.get("quickstart")).toEqual({
      settings: DEFAULT_PULL_REQUEST_SETTINGS,
      revision: 0,
    });
  });
});
