import { describe, expect, test } from "bun:test";

import { setupDom, setViewport } from "../test-support/dom.ts";
import { htmlOf } from "../test-support/html.ts";

const { render } = await setupDom();
// The gallery reaches Radix through the dialogs, so it loads after the DOM.
const { Gallery } = await import("./gallery.tsx");

const WIDTHS = [360, 768, 1440] as const;

function galleryAt(width: number): string {
  setViewport({ width, height: 900 });
  const { container } = render(<Gallery />);
  return htmlOf(container.firstElementChild);
}

describe("컴포넌트 갤러리", () => {
  test("360px", () => {
    expect(galleryAt(360)).toMatchSnapshot();
  });

  test("폭이 바뀌어도 마크업은 그대로다", () => {
    const [narrow, ...rest] = WIDTHS.map((width) => galleryAt(width));
    for (const markup of rest) {
      // Breakpoints belong to CSS. A JS branch on width would desync SSR and
      // client and would not survive a window resize.
      expect(markup).toBe(narrow as string);
    }
  });

  test("열린 다이얼로그까지 포함한 좁은 화면", () => {
    setViewport({ width: 360, height: 900 });
    const { baseElement } = render(<Gallery openDialog="destructive" />);
    expect(
      htmlOf(baseElement.querySelector("[role='dialog']")),
    ).toMatchSnapshot();
  });
});
