import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { RadioGroup, RadioGroupItem } = await import("./radio-group.tsx");

describe("RadioGroupItem", () => {
  test("고르지 않은 항목만 포인터에 테두리와 바탕이 바뀌고, 비활성은 그대로다", () => {
    const { getAllByRole } = render(
      <RadioGroup aria-label="테마" defaultValue="light">
        <RadioGroupItem value="light" aria-label="라이트" />
        <RadioGroupItem value="dark" aria-label="다크" disabled={true} />
      </RadioGroup>,
    );
    for (const radio of getAllByRole("radio")) {
      const classes = radio.className.split(" ");
      expect(classes).toContain(
        "enabled:not-aria-invalid:data-[state=unchecked]:hover:border-foreground",
      );
      expect(classes).toContain(
        "enabled:data-[state=unchecked]:hover:bg-hover",
      );
    }
  });

  test("포커스는 Checkbox와 같은 바깥 외곽선이고 링을 쓰지 않는다", () => {
    const { getByRole } = render(
      <RadioGroup aria-label="테마" defaultValue="light">
        <RadioGroupItem value="light" aria-label="라이트" />
      </RadioGroup>,
    );
    const classes = getByRole("radio").className.split(" ");
    for (const name of [
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-focus-ring",
    ])
      expect(classes).toContain(name);
    expect(classes.some((c) => c.includes("ring-"))).toBe(false);
    expect(classes).not.toContain("outline-none");
  });
});
