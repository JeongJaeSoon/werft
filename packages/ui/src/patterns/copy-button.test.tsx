import { describe, expect, test } from "bun:test";
import { createRef, useId } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, waitFor } = await setupDom();
const { CopyButton } = await import("./copy-button.tsx");

const VALUE = "ak_FAKE0000000000000000000000";

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

const icon = (button: HTMLElement) =>
  button.querySelector("svg")?.getAttribute("class") ?? "";

describe("CopyButton", () => {
  test("복사하면 값을 클립보드에 쓰고 성공을 넘긴 뒤 Check와 복사됨 문구로 바뀐다", async () => {
    const results: boolean[] = [];
    const screen = render(
      <CopyButton
        value={VALUE}
        label="복사"
        copiedLabel="복사됨"
        onResult={(ok) => results.push(ok)}
      />,
    );
    const user = await setupUser();
    // After setupUser, which installs a clipboard of its own.
    const copied: string[] = [];
    const restore = stubClipboard(async (text) => {
      copied.push(text);
    });
    try {
      const button = screen.getByRole("button", { name: "복사" });
      expect(button.getAttribute("type")).toBe("button");
      expect(icon(button)).toContain("lucide-copy");
      await user.click(button);
      await waitFor(() => expect(results).toEqual([true]));
      expect(copied).toEqual([VALUE]);
      expect(button.textContent).toBe("복사됨");
      expect(button.hasAttribute("data-copied")).toBe(true);
      expect(icon(button)).toContain("lucide-check");
    } finally {
      restore();
    }
  });

  test("클립보드가 거부하면 실패를 넘기고 대체 입력칸에 포커스하며 복사 상태로 바뀌지 않는다", async () => {
    const results: boolean[] = [];
    const field = createRef<HTMLInputElement>();
    const screen = render(
      <>
        <input ref={field} readOnly value={VALUE} aria-label="키" />
        <CopyButton
          value={VALUE}
          label="복사"
          copiedLabel="복사됨"
          copiedMessage="복사됨"
          fallbackField={field}
          onResult={(ok) => results.push(ok)}
        />
      </>,
    );
    const user = await setupUser();
    const restore = stubClipboard(async () => {
      throw new Error("denied");
    });
    try {
      const button = screen.getByRole("button", { name: "복사" });
      await user.click(button);
      await waitFor(() => expect(results).toEqual([false]));
      expect(document.activeElement === field.current).toBe(true);
      expect(button.textContent).toBe("복사");
      expect(icon(button)).toContain("lucide-copy");
      expect(screen.getByRole("status").textContent).toBe("");
    } finally {
      restore();
    }
  });

  test("클립보드가 없는 환경도 실패로 넘긴다", async () => {
    const results: boolean[] = [];
    const screen = render(
      <CopyButton
        value={VALUE}
        label="복사"
        onResult={(ok) => results.push(ok)}
      />,
    );
    const user = await setupUser();
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    try {
      await user.click(screen.getByRole("button", { name: "복사" }));
      await waitFor(() => expect(results).toEqual([false]));
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("아이콘만 있는 버튼은 aria-label로 이름이 고정되고 성공은 status로 알린다", async () => {
    const screen = render(
      <CopyButton
        value={VALUE}
        aria-label="키 ID 복사"
        copiedMessage="복사됨"
        variant="ghost"
        size="sm"
      />,
    );
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      const button = screen.getByRole("button", { name: "키 ID 복사" });
      expect(button.textContent).toBe("");
      const status = screen.getByRole("status");
      expect(status.tagName).toBe("OUTPUT");
      expect(status.className.split(" ")).toContain("sr-only");
      expect(status.textContent).toBe("");
      await user.click(button);
      await waitFor(() => expect(status.textContent).toBe("복사됨"));
      expect(
        screen.getByRole("button", { name: "키 ID 복사" }) === button,
      ).toBe(true);
      expect(button.textContent).toBe("");
      expect(icon(button)).toContain("lucide-check");
      expect(button.dataset.size).toBe("sm");
    } finally {
      restore();
    }
  });

  test("copiedMessage가 없으면 status 영역을 두지 않고, icon none이면 글자만, iconClassName은 아이콘에 붙는다", () => {
    const screen = render(
      <>
        <CopyButton value={VALUE} label="복사" icon="none" />
        <CopyButton value={VALUE} label="ID 복사" iconClassName="size-3.5" />
      </>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "복사" }).querySelector("svg"),
    ).toBeNull();
    expect(icon(screen.getByRole("button", { name: "ID 복사" }))).toContain(
      "size-3.5",
    );
  });

  test("icon copy는 성공한 뒤에도 Copy 아이콘을 둔다", async () => {
    const screen = render(
      <CopyButton value={VALUE} aria-label="초대 명령 복사" icon="copy" />,
    );
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      const button = screen.getByRole("button", { name: "초대 명령 복사" });
      await user.click(button);
      await waitFor(() =>
        expect(button.hasAttribute("data-copied")).toBe(true),
      );
      expect(icon(button)).toContain("lucide-copy");
    } finally {
      restore();
    }
  });

  test("다시 복사해 성공하면 status에 새 알림 노드를 넣는다", async () => {
    const screen = render(
      <CopyButton value={VALUE} aria-label="복사" copiedMessage="복사됨" />,
    );
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      const button = screen.getByRole("button", { name: "복사" });
      const status = screen.getByRole("status");
      await user.click(button);
      await waitFor(() => expect(status.textContent).toBe("복사됨"));
      const first = status.firstElementChild;
      await user.click(button);
      await waitFor(() =>
        expect(status.firstElementChild === first).toBe(false),
      );
      expect(status.textContent).toBe("복사됨");
    } finally {
      restore();
    }
  });

  describe("늦게 끝난 복사", () => {
    type Pending = { readonly settle: (ok: boolean) => void };
    async function setup(initial: string) {
      const results: Array<[boolean, string]> = [];
      const field = createRef<HTMLInputElement>();
      const props = {
        label: "복사",
        copiedLabel: "복사됨",
        fallbackField: field,
        onResult: (ok: boolean, copied: string) => results.push([ok, copied]),
      };
      const view = (value: string) => (
        <>
          <input ref={field} readOnly value={value} aria-label="값" />
          <CopyButton value={value} {...props} />
        </>
      );
      const screen = render(view(initial));
      const user = await setupUser();
      const pending: Pending[] = [];
      const restore = stubClipboard(
        () =>
          new Promise<void>((resolve, reject) => {
            pending.push({
              settle: (ok) => (ok ? resolve() : reject(new Error("denied"))),
            });
          }),
      );
      const button = screen.getByRole("button", { name: "복사" });
      const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
      return { screen, user, button, pending, results, restore, view, settled };
    }

    test("값이 바뀌면 복사 상태가 풀리고, 그 전에 시작한 복사는 결과만 그 값으로 넘긴다", async () => {
      const t = await setup("first");
      try {
        await t.user.click(t.button);
        await waitFor(() => expect(t.pending.length).toBe(1));
        t.pending[0]?.settle(true);
        await waitFor(() => expect(t.results).toEqual([[true, "first"]]));
        expect(t.button.textContent).toBe("복사됨");

        t.screen.rerender(t.view("second"));
        expect(t.button.textContent).toBe("복사");

        await t.user.click(t.button);
        await waitFor(() => expect(t.pending.length).toBe(2));
        t.screen.rerender(t.view("third"));
        t.pending[1]?.settle(true);
        await waitFor(() => expect(t.results.length).toBe(2));
        expect(t.results[1]).toEqual([true, "second"]);
        expect(t.button.textContent).toBe("복사");
      } finally {
        t.restore();
      }
    });

    test("A→B→A로 돌아와도 A에서 시작한 실패가 지금 버튼에 포커스를 옮기거나 상태를 바꾸지 않는다", async () => {
      const t = await setup("A");
      try {
        await t.user.click(t.button);
        await waitFor(() => expect(t.pending.length).toBe(1));
        t.screen.rerender(t.view("B"));
        t.screen.rerender(t.view("A"));
        t.button.focus();
        t.pending[0]?.settle(false);
        await waitFor(() => expect(t.results).toEqual([[false, "A"]]));
        expect(document.activeElement === t.button).toBe(true);
      } finally {
        t.restore();
      }
    });

    test("같은 값을 두 번 누르면 앞 클릭이 늦게 실패해도 뒤 클릭의 성공이 남는다", async () => {
      const t = await setup("same");
      try {
        await t.user.click(t.button);
        await t.user.click(t.button);
        await waitFor(() => expect(t.pending.length).toBe(2));
        t.pending[1]?.settle(true);
        await waitFor(() => expect(t.results).toEqual([[true, "same"]]));
        t.button.focus();
        t.pending[0]?.settle(false);
        await t.settled();
        expect(t.results).toEqual([[true, "same"]]);
        expect(t.button.textContent).toBe("복사됨");
        expect(document.activeElement === t.button).toBe(true);
      } finally {
        t.restore();
      }
    });
  });
});

// WCAG 2.5.3 (axe label-content-name-mismatch): the text inside the button
// is part of its name. axe itself needs a canvas happy-dom lacks, so the
// rule is checked by hand here.
describe("CopyButton 이름과 보이는 글자", () => {
  const labelInName = (button: HTMLElement, name: string) =>
    name
      .toLowerCase()
      .includes((button.textContent ?? "").trim().toLowerCase());

  test("이름은 보이는 '복사'이고, 대상은 설명으로 잇는다", async () => {
    const screen = render(
      <CopyButton
        value={VALUE}
        label="복사"
        copiedLabel="복사됨"
        description={`키 ID ${VALUE}`}
      />,
    );
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      const button = screen.getByRole("button", { name: "복사" });
      expect(button.hasAttribute("aria-label")).toBe(false);
      const describedBy = button.getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(describedBy)?.textContent).toBe(
        `키 ID ${VALUE}`,
      );
      await user.click(button);
      const copied = await screen.findByRole("button", { name: "복사됨" });
      expect(labelInName(copied, "복사됨")).toBe(true);
      expect(copied.getAttribute("aria-describedby")).toBe(describedBy);
    } finally {
      restore();
    }
  });

  test("호출한 쪽의 aria-describedby 뒤에 설명을 붙인다", () => {
    function WithHint() {
      const hint = useId();
      return (
        <>
          <span id={hint}>힌트</span>
          <CopyButton
            value={VALUE}
            label="복사"
            aria-describedby={hint}
            description="키 ID"
          />
        </>
      );
    }
    const screen = render(<WithHint />);
    const ids = (
      screen
        .getByRole("button", { name: "복사" })
        .getAttribute("aria-describedby") ?? ""
    ).split(" ");
    expect(document.getElementById(ids[0] ?? "")?.textContent).toBe("힌트");
    expect(document.getElementById(ids[1] ?? "")?.textContent).toBe("키 ID");
  });

  test("aria-label로 이름을 고정하면 '복사됨'은 버튼 밖 status에 보이고 한 번만 알린다", async () => {
    const screen = render(
      <CopyButton
        value={VALUE}
        variant="ghost"
        size="sm"
        aria-label={`ID ${VALUE} 복사`}
        copiedLabel="복사했습니다"
        copiedMessage="복사했습니다"
      />,
    );
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      const name = `ID ${VALUE} 복사`;
      const button = screen.getByRole("button", { name });
      await user.click(button);
      const status = screen.getByRole("status");
      await waitFor(() => expect(status.textContent).toBe("복사했습니다"));
      // Visible, outside the button, and the only live region.
      expect(status.className.split(" ")).not.toContain("sr-only");
      expect(button.contains(status)).toBe(false);
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(button.textContent).toBe("");
      expect(labelInName(button, name)).toBe(true);
      expect(icon(button)).toContain("lucide-check");
    } finally {
      restore();
    }
  });
});

describe("CopyButton 알림", () => {
  test("copiedLabel만 주면 바뀐 문구를 숨긴 status로도 알린다", async () => {
    const screen = render(
      <CopyButton value={VALUE} label="복사" copiedLabel="복사했습니다" />,
    );
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      const status = screen.getByRole("status");
      expect(status.className.split(" ")).toContain("sr-only");
      await user.click(screen.getByRole("button", { name: "복사" }));
      await waitFor(() => expect(status.textContent).toBe("복사했습니다"));
      expect(screen.getAllByRole("status")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("aria-labelledby로 이름을 고정해도 '복사됨'은 버튼 밖에 둔다", async () => {
    function Labelled() {
      const id = useId();
      return (
        <>
          <span id={id}>키 ID 복사</span>
          <CopyButton value={VALUE} aria-labelledby={id} copiedLabel="복사됨" />
        </>
      );
    }
    const screen = render(<Labelled />);
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      const button = screen.getByRole("button", { name: "키 ID 복사" });
      const status = screen.getByRole("status");
      // Out of the flow while empty, so it adds no gap.
      expect(status.className).toContain("empty:absolute");
      await user.click(button);
      await waitFor(() => expect(status.textContent).toBe("복사됨"));
      expect(button.textContent).toBe("");
    } finally {
      restore();
    }
  });
});
