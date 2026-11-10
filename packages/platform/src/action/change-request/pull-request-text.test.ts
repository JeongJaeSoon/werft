import { describe, expect, test } from "bun:test";
import {
  cleanBody,
  cleanTitle,
  neutralizeReferences,
  PULL_REQUEST_TITLE_MAX,
} from "./pull-request-text.ts";

const ZWSP = "​";
const keep = (line: string) => line;

describe("pull request text", () => {
  test("breaks mentions, team mentions and mentions at the start of a line", () => {
    expect(neutralizeReferences("@octocat cc @acme/reviewers, thanks")).toBe(
      `@${ZWSP}octocat cc @${ZWSP}acme/reviewers, thanks`,
    );
    expect(neutralizeReferences("mail dev@example.com")).toBe(
      "mail dev@example.com",
    );
    // An unclosed backtick is plain text on GitHub, so the mention is live.
    expect(neutralizeReferences("see `@octocat")).toBe(`see \`@${ZWSP}octocat`);
  });

  test("breaks closing keywords before any reference, and cross-repository references", () => {
    for (const [given, expected] of [
      ["Closes #12", `C${ZWSP}loses #12`],
      ["fixes: #3", `f${ZWSP}ixes: #3`],
      ["RESOLVED acme/app#7", `R${ZWSP}ESOLVED acme/app#${ZWSP}7`],
      [
        "close https://github.com/acme/app/issues/1",
        `c${ZWSP}lose https://github.com/acme/app/issues/1`,
      ],
      ["see other/repo#44", `see other/repo#${ZWSP}44`],
    ] as const) {
      expect(neutralizeReferences(given)).toBe(expected);
    }
    expect(neutralizeReferences("this fixes the build")).toBe(
      "this fixes the build",
    );
  });

  test("breaks HTML comments so nothing in the body is hidden or looks like a platform marker", () => {
    expect(neutralizeReferences("<!-- werft:s:status -->")).toBe(
      `<!${ZWSP}-- werft:s:status -->`,
    );
  });

  test("redacts line by line and cuts to the limit with a marker", () => {
    const redact = (line: string) => (/ghp_/.test(line) ? "[REDACTED]" : line);
    expect(cleanBody("ok\nuse ghp_abc123\nbye", 1000, redact)).toBe(
      "ok\n[REDACTED]\nbye",
    );
    const long = cleanBody("x".repeat(500), 100, keep);
    expect(long).toHaveLength(100);
    expect(long.endsWith("…(truncated)")).toBe(true);
    const emoji = cleanBody(`${"a".repeat(84)}${"😀".repeat(20)}`, 100, keep);
    expect(emoji.length).toBeLessThanOrEqual(100);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  test("hides fine-grained PATs, Slack tokens and whole private key blocks the shared redactor misses", () => {
    const pat = `github${"_pat_"}${"A1".repeat(20)}`;
    const slack = `xox${"b-"}${"1".repeat(12)}-abc`;
    const pem = (edge: string) => `-----${edge} RSA PRIVATE KEY-----`;
    const body = [
      "before",
      `token ${pat}`,
      `slack ${slack}`,
      pem("BEGIN"),
      "MIIEowIBAAKCAQEA",
      pem("END"),
      "after",
    ].join("\n");
    expect(cleanBody(body, 1000, keep)).toBe(
      [
        "before",
        "[REDACTED]",
        "[REDACTED]",
        "[REDACTED]",
        "[REDACTED]",
        "[REDACTED]",
        "after",
      ].join("\n"),
    );
    expect(cleanTitle(`Fix ${pat}`, keep)).toBe("[REDACTED]");
  });

  test("a title is one line, cleaned, at most 256 characters", () => {
    expect(cleanTitle("Fix\n  for @someone\tCloses #1", keep)).toBe(
      `Fix for @${ZWSP}someone C${ZWSP}loses #1`,
    );
    expect(cleanTitle("t".repeat(400), keep)).toHaveLength(
      PULL_REQUEST_TITLE_MAX,
    );
  });
});
