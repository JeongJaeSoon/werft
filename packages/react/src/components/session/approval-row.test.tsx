import { describe, expect, mock, test } from "bun:test";

import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type { PermissionRequest } from "./approval-card.tsx";
import type { ApprovalRowMessages } from "./approval-row.tsx";

const { render, waitFor } = await setupDom();
// After setupDom: this loads @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { ApprovalRow } = await import("./approval-row.tsx");

const NOW = Date.parse("2026-10-21T01:00:00.000Z");

const REQUEST: PermissionRequest = {
  request_id: "req_1",
  turn_id: "1",
  attempt_id: "att_1",
  kind: "permission",
  tool: "Bash",
  input: { command: "echo alpha > hello.txt" },
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: "2026-10-21T01:10:00.000Z",
};

const MESSAGES: ApprovalRowMessages = {
  title: (tool) => `${tool} asks`,
  input: "input",
  expires: (at) => `expires ${at}`,
  expired: "expired",
  allow: "Allow",
  deny: "Deny",
  allowName: (tool) => `Allow: ${tool} · 0192f0c4`,
  denyName: (tool) => `Deny: ${tool} · 0192f0c4`,
  denyReason: "Reason",
  denySubmit: "Send denial",
  cancel: "Cancel",
};

const ALLOW = "Allow: Bash · 0192f0c4";
const DENY = "Deny: Bash · 0192f0c4";

describe("ApprovalRow", () => {
  test("답 버튼은 보이는 글자로 시작하고 무엇을 승인하는지 이름에 담는다", () => {
    const { getByRole } = render(
      <ApprovalRow
        request={REQUEST}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        now={NOW}
      />,
    );
    const allow = getByRole("button", { name: ALLOW });
    expect(allow.textContent).toBe("Allow");
    expect(getByRole("button", { name: DENY }).textContent).toBe("Deny");
    // One article per request, named by its title, as the card is.
    expect(getByRole("article", { name: "Bash asks" })).toBeTruthy();
  });

  test("제목·대상·기한·입력 보기와 답 버튼이 한 줄에 있고, 버튼은 줄 끝에 있다", () => {
    const view = render(
      <ApprovalRow
        request={REQUEST}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        now={NOW}
        locale="en"
        subject={<a href="#s">s-1…</a>}
      />,
    );
    // The title line reads as the card's does.
    const title = view.getByText("Bash asks").parentElement as HTMLElement;
    expect(title.textContent).toMatch(/^Bash asks·s-1…·expires [^·]+$/);
    const text = title.parentElement as HTMLElement;
    expect(text.contains(view.getByText("input"))).toBe(true);
    const buttons = view.getByRole("button", { name: ALLOW })
      .parentElement as HTMLElement;
    const line = buttons.parentElement as HTMLElement;
    expect(text.parentElement === line).toBe(true);
    expect(line.lastElementChild === buttons).toBe(true);
    expect(line.className).toContain("justify-end");
  });

  test("heading이 있으면 좁은 줄에서 배지가 제목 아래로 내려가고 둘 다 줄 폭을 넘지 않는다", () => {
    const view = render(
      <ApprovalRow
        request={REQUEST}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        now={NOW}
        locale="en"
        heading="Deploy check"
      />,
    );
    const heading = view.getByText("Deploy check");
    const line = heading.parentElement as HTMLElement;
    expect(line.className).toContain("flex-wrap");
    expect(heading.className).toContain("max-w-full");
    const badge = view.getByText("Bash asks").parentElement as HTMLElement;
    expect(badge.parentElement === line).toBe(true);
    expect(badge.className).toContain("max-w-full");
  });

  test("입력은 펼칠 때만 줄 아래에 보이고, 입력 보기는 줄에 남는다", async () => {
    const user = await setupUser();
    const view = render(
      <ApprovalRow
        request={REQUEST}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        now={NOW}
      />,
    );
    expect(view.container.querySelector("pre")).toBeNull();
    const summary = view.getByText("input");
    await user.click(summary);
    const pre = (await view.findByText(/echo alpha/)).closest(
      "pre",
    ) as HTMLElement;
    expect(pre.getAttribute("data-slot")).toBe("code-block");
    // Long input wraps, and a tall one scrolls inside its own box.
    for (const name of ["whitespace-pre-wrap", "max-h-60", "overflow-y-auto"])
      expect(pre.className.split(" ")).toContain(name);
    const line = view.getByRole("button", { name: ALLOW }).parentElement
      ?.parentElement as HTMLElement;
    expect(line.contains(summary)).toBe(true);
    expect(line.contains(pre)).toBe(false);
    expect(summary.getAttribute("aria-controls")).toBe(pre.id);
  });

  test("키보드만으로 허용한다", async () => {
    const user = await setupUser();
    const onAllow = mock(() => {});
    render(
      <ApprovalRow
        request={REQUEST}
        messages={MESSAGES}
        onAllow={onAllow}
        onDeny={() => {}}
        now={NOW}
      />,
    );
    // The folded input is the first stop, then the actions. happy-dom does
    // not open <details> from the keyboard, so opening it is not checked here.
    await user.tab();
    expect(document.activeElement?.tagName).toBe("SUMMARY");
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(ALLOW);
    await user.keyboard("{Enter}");
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  test("거부는 이유를 적어야 보내지고, 취소하면 거부 버튼으로 돌아간다", async () => {
    const user = await setupUser();
    const onDeny = mock((_reason: string) => {});
    const { getByRole, getByLabelText } = render(
      <ApprovalRow
        request={REQUEST}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={onDeny}
        now={NOW}
      />,
    );
    getByRole("button", { name: DENY }).focus();
    await user.keyboard("{Enter}");
    const reason = getByLabelText("Reason");
    expect(document.activeElement === reason).toBe(true);
    // The answer buttons give way to the form while it is open.
    expect(document.querySelector(`[aria-label="${ALLOW}"]`)).toBeNull();
    const submit = getByRole("button", { name: "Send denial" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("   ");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Cancel");
    await user.keyboard("{Enter}");
    expect(document.activeElement === getByRole("button", { name: DENY })).toBe(
      true,
    );
    expect(onDeny).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    await user.keyboard("  not this file  ");
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Send denial");
    await user.keyboard("{Enter}");
    expect(onDeny).toHaveBeenCalledWith("not this file");
  });

  test("만료되면 답할 버튼 없이 만료로 읽힌다", () => {
    const { container } = render(
      <ApprovalRow
        request={REQUEST}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        now={Date.parse(REQUEST.expires_at)}
      />,
    );
    expect(container.textContent).toContain("expired");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("허용 버튼에 포커스를 둔 채 만료되면 포커스가 만료 안내로 간다", async () => {
    const now = Date.now();
    const { getByRole, getByText, container } = render(
      <ApprovalRow
        request={{
          ...REQUEST,
          expires_at: new Date(now + 50).toISOString(),
        }}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        now={now}
      />,
    );
    expect(container.querySelectorAll("button").length).toBe(2);
    getByRole("button", { name: ALLOW }).focus();
    await waitFor(() =>
      expect(document.activeElement === getByText("expired")).toBe(true),
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("포커스가 행 밖에 있으면 만료가 포커스를 가져가지 않는다", async () => {
    const now = Date.now();
    const { getByRole, getByText } = render(
      <>
        <button type="button">elsewhere</button>
        <ApprovalRow
          request={{
            ...REQUEST,
            expires_at: new Date(now + 50).toISOString(),
          }}
          messages={MESSAGES}
          onAllow={() => {}}
          onDeny={() => {}}
          now={now}
        />
      </>,
    );
    const elsewhere = getByRole("button", { name: "elsewhere" });
    elsewhere.focus();
    await waitFor(() => expect(getByText("expired")).toBeTruthy());
    expect(document.activeElement === elsewhere).toBe(true);
  });

  test("보내는 중·답할 수 없을 때는 버튼이 막히고 거절 이유가 경고로 보인다", () => {
    const { getByRole, rerender } = render(
      <ApprovalRow
        request={REQUEST}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        now={NOW}
        pending
        error="request expired"
      />,
    );
    expect(
      (getByRole("button", { name: ALLOW }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(getByRole("article").getAttribute("aria-busy")).toBe("true");
    expect(getByRole("alert").textContent).toBe("request expired");
    rerender(
      <ApprovalRow
        request={REQUEST}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        now={NOW}
        disabled
      />,
    );
    expect(
      (getByRole("button", { name: DENY }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
