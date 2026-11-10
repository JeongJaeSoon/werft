import { describe, expect, test } from "bun:test";
import {
  markdownToSlackMrkdwn,
  markdownToSlackParts,
  SLACK_TABLE_MAX,
} from "@werft-ai/platform";
import { slackOutboxText, slackReplyBlocks } from "./slack-outbox.ts";

const table = (rows: number, columns: number, cell = "x") =>
  [
    `|${Array(columns).fill("h").join("|")}|`,
    `|${Array(columns).fill("---").join("|")}|`,
    ...Array(rows).fill(`|${Array(columns).fill(cell).join("|")}|`),
  ].join("\n");

const REPLY = [
  "현재 접근 가능한 저장소는 3개입니다.",
  "",
  "| 저장소 | 상태 | 설명 |",
  "| --- | --- | --- |",
  "| acme/web | 기본 저장소 | 웹 앱 |",
  "| acme/api | 붙일 수 있음 | |",
  "",
  "요청하시면 붙이겠습니다.",
].join("\n");

describe("markdownToSlackParts", () => {
  test("lifts the first table out between its text", () => {
    expect(markdownToSlackParts(REPLY)).toEqual([
      { text: "현재 접근 가능한 저장소는 3개입니다.\n" },
      {
        table: {
          rows: [
            ["저장소", "상태", "설명"],
            ["acme/web", "기본 저장소", "웹 앱"],
            ["acme/api", "붙일 수 있음", "—"],
          ],
        },
      },
      { text: "\n요청하시면 붙이겠습니다." },
    ]);
  });

  test("is null without a table, or when the table is over a limit", () => {
    expect(markdownToSlackParts("no table")).toBeNull();
    expect(markdownToSlackParts(table(SLACK_TABLE_MAX.rows, 2))).toBeNull();
    expect(
      markdownToSlackParts(table(2, SLACK_TABLE_MAX.columns + 1)),
    ).toBeNull();
    expect(
      markdownToSlackParts(table(1, 1, "x".repeat(SLACK_TABLE_MAX.characters))),
    ).toBeNull();
    expect(
      markdownToSlackParts(table(SLACK_TABLE_MAX.rows - 2, 2)),
    ).not.toBeNull();
  });

  test("a sparse table over the limits is not expanded", () => {
    const sparse = `|${"h|".repeat(2_000)}\n|${"-|".repeat(2_000)}\n${"|x|\n".repeat(2_000)}`;
    expect(markdownToSlackParts(sparse)).toBeNull();
  });

  test("leaves a second table to the row list", () => {
    const parts = markdownToSlackParts(`${table(1, 2)}\n\n${table(1, 2, "y")}`);
    expect(parts?.filter((part) => "table" in part)).toHaveLength(1);
    expect(JSON.stringify(parts)).toContain("*y* — h: y");
  });

  test("falls back to the row list text without a code block", () => {
    const text = markdownToSlackMrkdwn(REPLY);
    expect(text).toContain("*acme/web* — 상태: 기본 저장소 · 설명: 웹 앱");
    expect(text).toContain("*acme/api* — 상태: 붙일 수 있음");
    expect(text).not.toContain("```");
  });

  test("a blank cell does not move its neighbour to another column", () => {
    const text = markdownToSlackMrkdwn(
      "| 항목 | Before | After |\n| --- | --- | --- |\n| a | | 10 |\n| b | 10 | |",
    );
    expect(text).toBe("*a* — After: 10\n*b* — Before: 10");
  });
});

describe("slackReplyBlocks", () => {
  const body = { text: REPLY, link_url: "https://console.test/sessions/1" };

  test("text, a table block, text and the link", () => {
    const blocks = slackReplyBlocks(body) as Record<string, unknown>[];
    expect(blocks.map((block) => block.type)).toEqual([
      "section",
      "table",
      "section",
      "section",
    ]);
    expect(blocks[1]).toEqual({
      type: "table",
      column_settings: [
        { is_wrapped: true },
        { is_wrapped: true },
        { is_wrapped: true },
      ],
      rows: [
        ["저장소", "상태", "설명"],
        ["acme/web", "기본 저장소", "웹 앱"],
        ["acme/api", "붙일 수 있음", "—"],
      ].map((row) => row.map((text) => ({ type: "raw_text", text }))),
    });
    expect(JSON.stringify(blocks.at(-1))).toContain("https://console.test");
  });

  test("is null over the table limit, so the text carries the row list", () => {
    const over = { text: table(SLACK_TABLE_MAX.rows, 2) };
    expect(slackReplyBlocks(over)).toBeNull();
    const text = slackOutboxText(over);
    expect(text).not.toContain("```");
    expect(text.split("\n")).toHaveLength(SLACK_TABLE_MAX.rows);
  });

  test("is null when a text piece cannot be split safely", () => {
    expect(
      slackReplyBlocks({ text: `${"x".repeat(3_001)}\n\n${table(1, 2)}` }),
    ).toBeNull();
    expect(
      slackReplyBlocks({
        text: `\`\`\`\n${"code\n".repeat(700)}\`\`\`\n\n${table(1, 2)}`,
      }),
    ).toBeNull();
  });

  test("a first line of exactly the section limit leaves no empty section", () => {
    const blocks = slackReplyBlocks({
      text: `${"z".repeat(3_000)}\nmore\n\n${table(1, 2)}`,
    }) as { type: string; text?: { text: string } }[];
    for (const block of blocks.filter((b) => b.type === "section")) {
      expect(block.text?.text.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("long text around the table is split between lines", () => {
    const line = "y".repeat(100);
    const blocks = slackReplyBlocks({
      text: `${Array(80).fill(line).join("\n")}\n\n${table(1, 2)}`,
    }) as { type: string; text?: { text: string } }[];
    const sections = blocks.filter((block) => block.type === "section");
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.text?.text.length ?? 0).toBeLessThanOrEqual(3_000);
    }
  });
});
