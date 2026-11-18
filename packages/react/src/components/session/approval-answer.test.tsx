import { describe, expect, mock, test } from "bun:test";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type { ReactElement } from "react";
import type { ApprovalCardProps, PermissionRequest } from "./approval-card.tsx";
import type { ApprovalRowMessages } from "./approval-row.tsx";

const { render, within } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { ApprovalCard } = await import("./approval-card.tsx");
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

type Props = Omit<ApprovalCardProps, "messages">;

// The card and the row draw their own buttons over one denial hook and
// form; every answer behaviour is asserted the same way on both.
const SURFACES: readonly {
  readonly name: string;
  readonly draw: (props: Props) => ReactElement;
  readonly allow: string;
  readonly deny: string;
}[] = [
  {
    name: "ApprovalCard",
    draw: (props) => <ApprovalCard {...props} messages={MESSAGES} />,
    allow: "Allow",
    deny: "Deny",
  },
  {
    name: "ApprovalRow",
    draw: (props) => <ApprovalRow {...props} messages={MESSAGES} />,
    allow: "Allow: Bash · 0192f0c4",
    deny: "Deny: Bash · 0192f0c4",
  },
];

for (const surface of SURFACES) {
  describe(`${surface.name}의 답`, () => {
    const props = (over: Partial<Props> = {}): Props => ({
      request: REQUEST,
      onAllow: () => {},
      onDeny: () => {},
      now: NOW,
      ...over,
    });

    test("승인은 한 번 눌러 글 없이 보낸다", async () => {
      const user = await setupUser();
      const onAllow = mock((..._args: unknown[]) => {});
      const view = render(surface.draw(props({ onAllow })));
      await user.click(view.getByRole("button", { name: surface.allow }));
      expect(onAllow).toHaveBeenCalledTimes(1);
      expect(onAllow.mock.calls[0]).toEqual([]);
      // No field to type an allow's text into.
      expect(view.queryByRole("textbox")).toBeNull();
    });

    test("거부는 폼을 펼치고 초점이 이유 칸으로 간다", async () => {
      const user = await setupUser();
      const onDeny = mock((_reason: string) => {});
      const view = render(surface.draw(props({ onDeny })));
      await user.click(view.getByRole("button", { name: surface.deny }));
      const reason = view.getByRole("textbox", { name: "Reason" });
      expect(document.activeElement === reason).toBe(true);
      // The answer buttons give way to the form while it is open.
      expect(view.queryByRole("button", { name: surface.allow })).toBeNull();
      expect(onDeny).not.toHaveBeenCalled();
    });

    test("이유 없이 거부를 보낼 수 있다", async () => {
      const user = await setupUser();
      const onDeny = mock((_reason: string) => {});
      const view = render(surface.draw(props({ onDeny })));
      await user.click(view.getByRole("button", { name: surface.deny }));
      const submit = view.getByRole("button", { name: "Send denial" });
      expect((submit as HTMLButtonElement).disabled).toBe(false);
      await user.click(submit);
      expect(onDeny.mock.calls).toEqual([[""]]);
    });

    test("이유를 적으면 앞뒤 공백을 뺀 글이 간다", async () => {
      const user = await setupUser();
      const onDeny = mock((_reason: string) => {});
      const view = render(surface.draw(props({ onDeny })));
      await user.click(view.getByRole("button", { name: surface.deny }));
      await user.keyboard("  not this file  ");
      await user.click(view.getByRole("button", { name: "Send denial" }));
      expect(onDeny.mock.calls).toEqual([["not this file"]]);
    });

    test("공백만 적으면 이유 없이 보낸다", async () => {
      const user = await setupUser();
      const onDeny = mock((_reason: string) => {});
      const view = render(surface.draw(props({ onDeny })));
      await user.click(view.getByRole("button", { name: surface.deny }));
      await user.keyboard("   ");
      await user.click(view.getByRole("button", { name: "Send denial" }));
      expect(onDeny.mock.calls).toEqual([[""]]);
    });

    test("취소하면 폼이 닫히고 초점이 거부 버튼으로 돌아간다", async () => {
      const user = await setupUser();
      const onDeny = mock((_reason: string) => {});
      const view = render(surface.draw(props({ onDeny })));
      await user.click(view.getByRole("button", { name: surface.deny }));
      await user.tab();
      await user.tab();
      expect(document.activeElement?.textContent).toBe("Cancel");
      await user.keyboard("{Enter}");
      expect(view.queryByRole("textbox")).toBeNull();
      expect(
        document.activeElement ===
          view.getByRole("button", { name: surface.deny }),
      ).toBe(true);
      expect(onDeny).not.toHaveBeenCalled();
    });

    test("취소한 뒤 다시 펼치면 이유 칸이 비어 있다", async () => {
      const user = await setupUser();
      const view = render(surface.draw(props()));
      await user.click(view.getByRole("button", { name: surface.deny }));
      await user.keyboard("not this file");
      await user.click(view.getByRole("button", { name: "Cancel" }));
      await user.click(view.getByRole("button", { name: surface.deny }));
      const reason = view.getByRole("textbox", { name: "Reason" });
      expect((reason as HTMLTextAreaElement).value).toBe("");
    });

    test("보내기가 거절되면 적은 이유가 칸에 남는다", async () => {
      const user = await setupUser();
      const onDeny = mock((_reason: string) => {});
      const view = render(surface.draw(props({ onDeny })));
      await user.click(view.getByRole("button", { name: surface.deny }));
      await user.keyboard("not this file");
      await user.click(view.getByRole("button", { name: "Send denial" }));
      view.rerender(surface.draw(props({ onDeny, pending: true })));
      view.rerender(surface.draw(props({ onDeny, error: "refused" })));
      const reason = view.getByRole("textbox", { name: "Reason" });
      expect((reason as HTMLTextAreaElement).value).toBe("not this file");
      await user.click(view.getByRole("button", { name: "Send denial" }));
      expect(onDeny.mock.calls).toEqual([["not this file"], ["not this file"]]);
    });

    test("한 요청을 취소해도 다른 요청의 이유는 그대로다", async () => {
      const user = await setupUser();
      const other = { ...REQUEST, request_id: "req_2" };
      const view = render(
        <>
          <div data-testid="one">{surface.draw(props())}</div>
          <div data-testid="two">{surface.draw(props({ request: other }))}</div>
        </>,
      );
      const one = within(view.getByTestId("one"));
      const two = within(view.getByTestId("two"));
      await user.click(one.getByRole("button", { name: surface.deny }));
      await user.keyboard("first");
      await user.click(two.getByRole("button", { name: surface.deny }));
      await user.keyboard("second");
      await user.click(one.getByRole("button", { name: "Cancel" }));
      const kept = two.getByRole("textbox", { name: "Reason" });
      expect((kept as HTMLTextAreaElement).value).toBe("second");
    });

    test("보내는 중에는 두 번 보내지 않는다", async () => {
      const user = await setupUser();
      const onAllow = mock((..._args: unknown[]) => {});
      const onDeny = mock((_reason: string) => {});
      const view = render(surface.draw(props({ onAllow, onDeny })));
      await user.click(view.getByRole("button", { name: surface.deny }));
      view.rerender(surface.draw(props({ onAllow, onDeny, pending: true })));
      const submit = view.getByRole("button", { name: "Send denial" });
      expect(submit.getAttribute("aria-disabled")).toBe("true");
      await user.click(submit);
      expect(onDeny).not.toHaveBeenCalled();
      // Queries read the whole document: the next draw stands alone.
      view.unmount();

      const sending = render(
        surface.draw(props({ onAllow, onDeny, pending: true })),
      );
      for (const name of [surface.allow, surface.deny]) {
        const button = sending.getByRole("button", { name });
        expect(button.getAttribute("aria-disabled")).toBe("true");
        await user.click(button);
      }
      expect(onAllow).not.toHaveBeenCalled();
      expect(sending.queryByRole("textbox")).toBeNull();
    });

    test("보내는 동안 초점이 누른 버튼에 남는다", async () => {
      const user = await setupUser();
      const view = render(surface.draw(props()));
      const allow = view.getByRole("button", { name: surface.allow });
      allow.focus();
      await user.keyboard("{Enter}");
      // As the block draws the request on its way: pending, and the rest off.
      view.rerender(surface.draw(props({ pending: true, disabled: true })));
      // This DOM keeps focus on a disabled button where Chrome drops it, so
      // the button must also not be disabled.
      expect((allow as HTMLButtonElement).disabled).toBe(false);
      expect(document.activeElement === allow).toBe(true);
      view.unmount();

      const denying = render(surface.draw(props()));
      await user.click(denying.getByRole("button", { name: surface.deny }));
      const submit = denying.getByRole("button", { name: "Send denial" });
      submit.focus();
      await user.keyboard("{Enter}");
      denying.rerender(surface.draw(props({ pending: true, disabled: true })));
      expect((submit as HTMLButtonElement).disabled).toBe(false);
      expect(document.activeElement === submit).toBe(true);
      // Text typed while the denial is on its way would be dropped.
      expect(
        (
          denying.getByRole("textbox", {
            name: "Reason",
          }) as HTMLTextAreaElement
        ).readOnly,
      ).toBe(true);
    });

    test("펼친 채 만료되면 폼이 사라지고 초점이 만료 안내로 간다", async () => {
      const user = await setupUser();
      const view = render(surface.draw(props()));
      await user.click(view.getByRole("button", { name: surface.deny }));
      expect(view.getByRole("textbox", { name: "Reason" })).toBeTruthy();
      // The screen's clock at the expiry lapses the request at once, so the
      // test needs no real time; the timer path has its own tests.
      view.rerender(
        surface.draw(props({ now: Date.parse(REQUEST.expires_at) })),
      );
      expect(view.container.querySelector("textarea")).toBeNull();
      expect(document.activeElement === view.getByText("expired")).toBe(true);
    });
  });
}
