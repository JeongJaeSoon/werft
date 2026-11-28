import { describe, expect, test } from "bun:test";
import {
  registerSkillRepositoryRequestSchema,
  SKILL_REPOSITORY_URL,
} from "./skill-repositories.ts";

const parses = (url: string) =>
  registerSkillRepositoryRequestSchema.safeParse({ url }).success;

describe("a skill repository's address", () => {
  test("names an owner and a repository on github.com", () => {
    for (const url of [
      "https://github.com/anthropics/skills",
      "https://github.com/anthropics/skills.git",
      "https://github.com/anthropics/skills/",
      "https://github.com/anthropics/.github",
      "https://github.com/anthropics/a..b",
      "https://github.com/anthropics/...",
    ]) {
      expect([url, parses(url)]).toEqual([url, true]);
    }
    expect(
      SKILL_REPOSITORY_URL.exec(
        "https://github.com/anthropics/skills.git/",
      )?.slice(1),
    ).toEqual(["anthropics", "skills"]);
  });

  test("a name of . or .. is a path step and is refused", () => {
    for (const url of [
      "https://github.com/anthropics/.",
      "https://github.com/anthropics/..",
      "https://github.com/anthropics/./",
      "https://github.com/anthropics/../",
      "https://github.com/anthropics/..git",
      "https://github.com/anthropics/...git",
      "https://github.com/anthropics/../.git",
    ]) {
      expect([url, parses(url)]).toEqual([url, false]);
    }
  });
});
