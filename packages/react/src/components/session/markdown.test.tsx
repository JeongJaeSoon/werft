import { describe, expect, test } from "bun:test";
import { presentTurnEvent, type TurnEventMessage } from "@werft-ai/contracts";

import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists.
const { Markdown } = await import("./markdown.tsx");
const { markdownPlainText, FOLD_AT } = await import("./markdown-text.ts");
const { StageIndicator } = await import("./stage-indicator.tsx");
const { Timeline } = await import("./timeline.tsx");

const FOLD = { more: "더 보기", less: "접기" };

const REPLY = [
  "**werft-sandbox:** 샘플 PR을 열었습니다.",
  "",
  "- 첫째 항목",
  "- 둘째 항목 [링크](https://example.com/a)",
  "",
  "`inline` 코드와",
  "",
  "```",
  "block code",
  "```",
  "",
  "| 이름 | 값 |",
  "| --- | --- |",
  "| a | 1 |",
].join("\n");

describe("Markdown", () => {
  test("굵게·목록·링크·코드·표를 요소로 그린다", () => {
    const { container } = render(
      <Markdown text={REPLY} tableLabel="표" newTabLabel="(새 탭에서 열림)" />,
    );
    expect(container.querySelector("strong")?.textContent).toBe(
      "werft-sandbox:",
    );
    expect(container.textContent).not.toContain("**");
    expect(
      [...container.querySelectorAll("ul > li")].map((li) => li.textContent),
    ).toEqual(["첫째 항목", "둘째 항목 링크(새 탭에서 열림)"]);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
    expect(container.querySelector("code")?.textContent).toBe("inline");
    expect(container.querySelector("pre")?.textContent).toBe("block code");
    expect(
      [...container.querySelectorAll("th, td")].map((cell) => cell.textContent),
    ).toEqual(["이름", "값", "a", "1"]);
    expect(
      container.querySelector("[data-slot=table-container]")?.ariaLabel ??
        container
          .querySelector("[data-slot=table-container]")
          ?.getAttribute("aria-label"),
    ).toBe("표");
  });

  test("HTML과 위험한 링크는 마크업이 되지 않고 글자로만 남는다", () => {
    const hostile = [
      "<script>window.__pwned = 1</script>",
      '<img src="x" onerror="window.__pwned = 2">',
      "[눌러](javascript:window.__pwned=3)",
      "[데이터](data:text/html;base64,PHNjcmlwdD4=)",
      "![픽셀](https://tracker.example/p.png)",
      '<a href="javascript:window.__pwned=4">raw</a>',
    ].join("\n\n");
    const { container } = render(<Markdown text={hostile} />);
    expect(container.querySelector("script, img, iframe")).toBeNull();
    for (const element of container.querySelectorAll("*")) {
      expect(element.getAttributeNames().some((n) => n.startsWith("on"))).toBe(
        false,
      );
    }
    // The only anchor is the image's alt text pointing at an https address.
    expect(
      [...container.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    ).toEqual(["https://tracker.example/p.png"]);
    // The markup is on screen as text instead.
    expect(container.textContent).toContain(
      "<script>window.__pwned = 1</script>",
    );
    expect(container.textContent).toContain("눌러");
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });

  test("짧은 답은 접지 않고, 아주 긴 답은 블록 사이에서 접고 키보드로 편다", async () => {
    const user = await setupUser();
    const short = render(<Markdown text={REPLY} fold={FOLD} />);
    expect(short.container.querySelector("button")).toBeNull();
    short.unmount();

    const blocks = Array.from(
      { length: 40 },
      (_, index) => `문단 ${index} ${"가".repeat(100)}`,
    );
    const text = blocks.join("\n\n");
    expect(text.length).toBeGreaterThan(FOLD_AT);
    const { container } = render(<Markdown text={text} fold={FOLD} />);
    const paragraphs = () => container.querySelectorAll("p").length;
    const folded = paragraphs();
    expect(folded).toBeGreaterThan(0);
    expect(folded).toBeLessThan(40);
    // Cut between paragraphs: the last shown one is whole.
    expect(container.textContent).toContain(
      `문단 ${folded - 1} ${"가".repeat(100)}`,
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("더 보기");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("…");
    button?.focus();
    await user.keyboard("{Enter}");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(button?.textContent).toBe("접기");
    expect(paragraphs()).toBe(40);
    expect(
      document.getElementById(button?.getAttribute("aria-controls") ?? "x"),
    ).not.toBeNull();
    await user.keyboard(" ");
    expect(paragraphs()).toBe(folded);
  });

  test("링크 정의는 접기 계산에 들지 않고, 보이는 블록이 항상 하나 이상 남는다", () => {
    const text = `[ref]: https://example.com\n\n${"a".repeat(1600)}\n\n${"b".repeat(1600)}`;
    const { container } = render(<Markdown text={text} fold={FOLD} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.textContent).toContain("a".repeat(1600));
    expect(container.querySelector("button")?.textContent).toBe("더 보기");
  });

  test("순서 목록은 시작 번호와 표시 방식을 지키고, 같은 정의가 둘이면 첫 정의가 이긴다", () => {
    const { container } = render(
      <Markdown
        text={
          "3. first\n4. second\n\n[click][ref]\n\n[ref]: https://first.example\n[ref]: https://second.example"
        }
      />,
    );
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
    for (const item of container.querySelectorAll("li")) {
      // A flex item stops being a list item, which hides its number.
      expect(item.className).not.toMatch(/\bflex\b/);
    }
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://first.example/",
    );
  });

  test("fold를 넘기지 않으면 아무리 길어도 접지 않는다", () => {
    const text = Array.from({ length: 60 }, () => "가".repeat(100)).join(
      "\n\n",
    );
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelectorAll("p")).toHaveLength(60);
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("markdownPlainText", () => {
  test("Markdown 기호를 벗겨 한 줄로 만든다", () => {
    expect(markdownPlainText(REPLY)).toBe(
      "werft-sandbox: 샘플 PR을 열었습니다. 첫째 항목 둘째 항목 링크 inline 코드와 block code 이름 값 a 1",
    );
    expect(markdownPlainText("## 제목\n\n> 인용 ~~삭제~~ *기울임*")).toBe(
      "제목 인용 삭제 기울임",
    );
  });

  test("alt 없는 이미지는 본문과 같이 주소를 보인다", () => {
    expect(markdownPlainText("![](https://example.com/a)")).toBe(
      "https://example.com/a",
    );
  });

  test("alt 없는 참조형 이미지도 첫 정의의 주소를 보인다", () => {
    expect(
      markdownPlainText(
        "![][img]\n\n[img]: https://example.com/a\n[img]: https://example.com/b",
      ),
    ).toBe("https://example.com/a");
  });

  test("max를 넘으면 …으로 끝내고, 원문 끝의 짝 잃은 기호도 글자로 둔다", () => {
    expect(markdownPlainText("가".repeat(300), 200)).toBe(
      `${"가".repeat(200)}…`,
    );
    expect(markdownPlainText("**끝나지 않은 굵게")).toBe("**끝나지 않은 굵게");
  });
});

describe("타임라인과 한 줄 미리보기", () => {
  const formatMessage = ({ key }: TurnEventMessage) => key;
  const MESSAGES = {
    label: "events",
    empty: "no events",
    connecting: "connecting",
    closed: "closed",
    turn: (turnId: string) => `turn ${turnId}`,
    more: "더 보기",
    less: "접기",
  };
  const presented = (text: string) =>
    presentTurnEvent({ event: "assistant", data: { text } });

  test("응답 항목이 Markdown으로 그려지고 200자를 넘어도 …로 잘리지 않는다", () => {
    const text = `**굵게** ${"가".repeat(400)}\n\n- 목록`;
    const { container } = render(
      <Timeline
        entries={[
          {
            id: "e1",
            occurredAt: "2026-10-21T01:00:00.000Z",
            turnId: "t1",
            presentation: presented(text),
          },
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    expect(container.querySelector("li strong")?.textContent).toBe("굵게");
    expect(container.querySelector("li ul li")?.textContent).toBe("목록");
    expect(container.textContent).toContain("가".repeat(400));
    expect(container.textContent).not.toContain("…");
    expect(container.textContent).not.toContain("**");
  });

  test("StageIndicator는 Markdown 기호를 벗긴 글자를 한 줄로 보인다", () => {
    const { container } = render(
      <StageIndicator
        presentation={presented(`**werft-sandbox:** ${"가".repeat(300)}`)}
        formatMessage={formatMessage}
        emptyLabel="대기"
      />,
    );
    const shown = container.textContent ?? "";
    expect(shown).toContain("werft-sandbox:");
    expect(shown).not.toContain("**");
    expect(shown.endsWith("…")).toBe(true);
  });
});
