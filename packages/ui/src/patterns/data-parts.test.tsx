import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

// Queries go through each render's result: in one `bun test` run the global
// `screen` may be bound to an earlier file's document.
const { render } = await setupDom();
const { KeyValueList } = await import("./key-value-list.tsx");
const { SecretField } = await import("./secret-field.tsx");
const { Section } = await import("./section.tsx");
const { StatCard } = await import("./stat-card.tsx");

const ITEMS = [
  { label: "모델", value: "claude-opus" },
  { label: "실행", value: "12회" },
];

describe("KeyValueList", () => {
  test("목록형은 dl 안에 행마다 dt·dd 한 쌍을 둔다", () => {
    const { container } = render(<KeyValueList items={ITEMS} />);
    const list = container.querySelector("dl");
    expect(list?.getAttribute("data-variant")).toBe("list");
    expect(list?.className.split(" ")).toContain("gap-1");
    const rows = [...(list?.children ?? [])];
    expect(rows.map((row) => row.tagName)).toEqual(["DIV", "DIV"]);
    for (const row of rows) {
      expect([...row.children].map((cell) => cell.tagName)).toEqual([
        "DT",
        "DD",
      ]);
      expect(row.className.split(" ")).toContain("min-h-6");
      expect(row.className.split(" ")).toContain("gap-3");
    }
    expect(rows[0]?.textContent).toBe("모델claude-opus");
  });

  test("격자형은 dt·dd를 dl 바로 아래 140px 열에 둔다", () => {
    const { container } = render(<KeyValueList variant="grid" items={ITEMS} />);
    const list = container.querySelector("dl");
    expect([...(list?.children ?? [])].map((cell) => cell.tagName)).toEqual([
      "DT",
      "DD",
      "DT",
      "DD",
    ]);
    const classes = list?.className.split(" ") ?? [];
    expect(classes).toContain("grid-cols-[140px_minmax(0,1fr)]");
    expect(classes).toContain("gap-x-4");
    expect(classes).toContain("gap-y-2");
  });
});

describe("StatCard", () => {
  test("라벨·숫자·설명을 Card 안에 두고 muted면 숫자를 흐리게 한다", () => {
    const screen = render(
      <StatCard
        label="이번 주 세션"
        value="128"
        description="지난주보다 12 많음"
      />,
    );
    const card = screen.container.querySelector("[data-slot=stat-card]");
    expect(card?.getAttribute("data-slot")).toBe("stat-card");
    const figure = screen.getByText("128");
    const classes = figure.className.split(" ");
    expect(figure.getAttribute("data-slot")).toBe("stat-value");
    for (const name of [
      "text-number",
      "font-mono",
      "font-medium",
      "tracking-normal",
      "tabular-nums",
    ])
      expect(classes).toContain(name);
    expect(classes).not.toContain("text-subtle-foreground");
    expect(screen.getByText("지난주보다 12 많음")).toBeTruthy();

    screen.rerender(<StatCard label="이번 주 세션" value="—" muted />);
    expect(screen.getByText("—").className.split(" ")).toContain(
      "text-subtle-foreground",
    );
  });
});

describe("Section", () => {
  test("제목이 h2로 섹션 이름이 되고, 배지는 이름에 들지 않는다", () => {
    const screen = render(
      <Section title="자격 증명" badge={<span>연결됨</span>}>
        본문
      </Section>,
    );
    const heading = screen.getByRole("heading", { name: "자격 증명" });
    expect(heading.tagName).toBe("H2");
    expect(screen.getByRole("region", { name: "자격 증명" })).toBeTruthy();
    const head = heading.parentElement?.parentElement?.parentElement;
    expect(head?.className.split(" ")).toContain("mb-3");
    // 32px, the same head height as SettingsSection's.
    expect(head?.className.split(" ")).toContain("min-h-8");
  });

  test("titleAs로 제목 수준을 바꾼다", () => {
    const screen = render(<Section title="최근 실행" titleAs="h3" />);
    const heading = screen.getByRole("heading", { name: "최근 실행" });
    expect(heading.tagName).toBe("H3");
  });

  test("설명과 동작을 머리에 둔다", () => {
    const screen = render(
      <Section
        title="구성원"
        description="3명"
        actions={<button type="button">초대</button>}
      />,
    );
    expect(screen.getByText("3명").tagName).toBe("P");
    expect(screen.getByRole("button", { name: "초대" })).toBeTruthy();
  });

  test("머리의 sm 버튼은 머리 높이(기본 버튼)와 같은 높이·좌우 여백으로 맞춘다", () => {
    const screen = render(
      <Section
        title="구성원"
        actions={
          <button type="button" data-werft-button="" data-size="sm">
            초대
          </button>
        }
      />,
    );
    const classes = (
      screen.getByRole("button", { name: "초대" }).parentElement?.className ??
      ""
    ).split(/\s+/);
    expect(classes).toContain(
      "[&_[data-werft-button][data-size=sm]]:h-[var(--werft-control-height)]",
    );
    expect(classes).toContain("[&_[data-werft-button][data-size=sm]]:px-3");
  });
});

describe("SecretField", () => {
  const COPY = {
    copyLabel: "복사",
    copiedMessage: "복사했습니다",
    copyFailedMessage: "복사하지 못했습니다. 값을 선택해 두었습니다",
  };
  const VALUE = "ws_FAKE0000000000000000000000";

  function stubClipboard(writeText: (text: string) => Promise<void>) {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return () => {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    };
  }

  test("복사하면 클립보드에 값을 쓰고 live 영역에 알린다", async () => {
    const screen = render(<SecretField value={VALUE} {...COPY} />);
    const { container } = screen;
    const user = await setupUser();
    // After setupUser, which installs a clipboard of its own.
    const copied: string[] = [];
    const restore = stubClipboard(async (text) => {
      copied.push(text);
    });
    try {
      const live = container.querySelector("[aria-live=polite]");
      expect(live?.textContent).toBe("");
      await user.click(screen.getByRole("button", { name: "복사" }));
      const message = await screen.findByText(COPY.copiedMessage);
      expect(message === live).toBe(true);
      expect(copied).toEqual([VALUE]);
      expect(live?.className.split(" ")).not.toContain("text-destructive");
    } finally {
      restore();
    }
  });

  test("클립보드가 거부하면 실패를 보이고 값을 선택해 둔다", async () => {
    const screen = render(<SecretField value={VALUE} {...COPY} />);
    const { container } = screen;
    const user = await setupUser();
    let attempts = 0;
    const restore = stubClipboard(async () => {
      attempts += 1;
      throw new Error("denied");
    });
    try {
      await user.click(screen.getByRole("button", { name: "복사" }));
      const live = container.querySelector("[aria-live=polite]");
      await screen.findByText(COPY.copyFailedMessage);
      expect(live?.textContent).toBe(COPY.copyFailedMessage);
      expect(live?.className.split(" ")).toContain("text-destructive");
      expect(attempts).toBe(1);
      expect(globalThis.getSelection?.()?.toString()).toBe(VALUE);
    } finally {
      restore();
    }
  });

  test("A를 복사하고 B를 거쳐 A로 돌아오면 지난 결과를 다시 보이지 않는다", async () => {
    const screen = render(<SecretField value={VALUE} {...COPY} />);
    const { container, rerender } = screen;
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      await user.click(screen.getByRole("button", { name: "복사" }));
      await screen.findByText(COPY.copiedMessage);
      rerender(<SecretField value="ws_FAKE_OTHER" {...COPY} />);
      rerender(<SecretField value={VALUE} {...COPY} />);
      expect(container.querySelector("[aria-live=polite]")?.textContent).toBe(
        "",
      );
    } finally {
      restore();
    }
  });

  test("복사 중에 값이 바뀌면 늦게 온 실패는 알리지도 선택하지도 않는다", async () => {
    const screen = render(<SecretField value={VALUE} {...COPY} />);
    const { container, rerender } = screen;
    const user = await setupUser();
    let refuse: (error: Error) => void = () => {};
    const restore = stubClipboard(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    try {
      globalThis.getSelection?.()?.removeAllRanges();
      await user.click(screen.getByRole("button", { name: "복사" }));
      rerender(<SecretField value="ws_FAKE_OTHER" {...COPY} />);
      refuse(new Error("denied"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(container.querySelector("[aria-live=polite]")?.textContent).toBe(
        "",
      );
      expect(globalThis.getSelection?.()?.toString()).toBe("");
    } finally {
      restore();
    }
  });

  test("복사 중에 A→B→A로 돌아와도 늦게 온 결과는 버린다", async () => {
    const screen = render(<SecretField value={VALUE} {...COPY} />);
    const { container, rerender } = screen;
    const user = await setupUser();
    let refuse: (error: Error) => void = () => {};
    const restore = stubClipboard(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    try {
      globalThis.getSelection?.()?.removeAllRanges();
      await user.click(screen.getByRole("button", { name: "복사" }));
      rerender(<SecretField value="ws_FAKE_OTHER" {...COPY} />);
      rerender(<SecretField value={VALUE} {...COPY} />);
      refuse(new Error("denied"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(container.querySelector("[aria-live=polite]")?.textContent).toBe(
        "",
      );
      expect(globalThis.getSelection?.()?.toString()).toBe("");
    } finally {
      restore();
    }
  });

  test("복사 중에 A→B→A로 돌아온 뒤 늦게 성공해도 복사했다고 알리지 않는다", async () => {
    const screen = render(<SecretField value={VALUE} {...COPY} />);
    const { container, rerender } = screen;
    const user = await setupUser();
    let settle: () => void = () => {};
    const restore = stubClipboard(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    try {
      await user.click(screen.getByRole("button", { name: "복사" }));
      rerender(<SecretField value="ws_FAKE_OTHER" {...COPY} />);
      rerender(<SecretField value={VALUE} {...COPY} />);
      settle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(container.querySelector("[aria-live=polite]")?.textContent).toBe(
        "",
      );
      // The only live region is the field's own: the button adds none.
      expect(container.querySelectorAll("output").length).toBe(0);
    } finally {
      restore();
    }
  });

  test("값이 바뀌면 지난 값의 결과를 지운다", async () => {
    const screen = render(<SecretField value={VALUE} {...COPY} />);
    const { container, rerender } = screen;
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      await user.click(screen.getByRole("button", { name: "복사" }));
      await screen.findByText(COPY.copiedMessage);
      rerender(<SecretField value="ws_FAKE_OTHER" {...COPY} />);
      expect(container.querySelector("[aria-live=polite]")?.textContent).toBe(
        "",
      );
    } finally {
      restore();
    }
  });
});

describe("KeyValueList stack", () => {
  test('stack="sm"이면 sm 아래에서 한 열로 쌓고 sm부터 두 열이다', () => {
    const { container } = render(
      <KeyValueList variant="grid" stack="sm" items={ITEMS} />,
    );
    const list = container.querySelector("dl");
    const classes = list?.className.split(" ") ?? [];
    expect(list?.getAttribute("data-stack")).toBe("sm");
    expect(classes).toContain("grid-cols-1");
    expect(classes).toContain("sm:grid-cols-[140px_minmax(0,1fr)]");
    expect(classes).not.toContain("grid-cols-[140px_minmax(0,1fr)]");
    expect(classes).toContain("gap-y-1");
    expect(classes).toContain("sm:gap-y-2");
  });

  test("stack이 없으면 지금처럼 두 열 고정이다", () => {
    const { container } = render(<KeyValueList variant="grid" items={ITEMS} />);
    const classes = container.querySelector("dl")?.className.split(" ") ?? [];
    expect(classes).toContain("grid-cols-[140px_minmax(0,1fr)]");
    expect(classes).not.toContain("grid-cols-1");
  });
});
