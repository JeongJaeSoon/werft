import { describe, expect, mock, test } from "bun:test";

import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type {
  ApprovalCardMessages,
  PermissionRequest,
} from "./approval-card.tsx";
import type { ComposerMessages } from "./composer.tsx";

const { render, waitFor } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { ApprovalCard } = await import("./approval-card.tsx");
const { Composer } = await import("./composer.tsx");
const { Message } = await import("./message.tsx");

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

const APPROVAL: ApprovalCardMessages = {
  title: (tool) => `${tool} asks`,
  input: "input",
  expires: (at) => `expires ${at}`,
  expired: "expired",
  allow: "Allow",
  deny: "Deny",
  denyReason: "Reason",
  denySubmit: "Send denial",
  cancel: "Cancel",
};

describe("ApprovalCard", () => {
  test("키보드만으로 허용한다", async () => {
    const user = await setupUser();
    const onAllow = mock(() => {});
    render(
      <ApprovalCard
        request={REQUEST}
        messages={APPROVAL}
        onAllow={onAllow}
        onDeny={() => {}}
        now={NOW}
      />,
    );
    // The folded input is the first stop, then the actions.
    await user.tab();
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Allow");
    await user.keyboard("{Enter}");
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  test("제목 줄에 대상과 기한을 함께 두고, 답 버튼은 입력 보기와 다른 줄에 내용 폭으로 둔다", () => {
    const view = render(
      <ApprovalCard
        request={REQUEST}
        messages={APPROVAL}
        onAllow={() => {}}
        onDeny={() => {}}
        now={NOW}
        locale="en"
        subject={<a href="#s">s-1…</a>}
      />,
    );
    const title = view.getByText("Bash asks").parentElement as HTMLElement;
    expect(title.textContent).toMatch(/^Bash asks·s-1…·expires /);
    const allow = view.getByRole("button", { name: "Allow" });
    const deny = view.getByRole("button", { name: "Deny" });
    expect(allow.className).not.toContain("flex-1");
    expect(deny.className).not.toContain("flex-1");
    const row = allow.parentElement as HTMLElement;
    expect(row.contains(view.getByText("input"))).toBe(false);
  });

  test("거부는 이유를 적어야 보내지고, 취소하면 거부 버튼으로 돌아간다", async () => {
    const user = await setupUser();
    const onDeny = mock((_reason: string) => {});
    const { getByRole, getByLabelText } = render(
      <ApprovalCard
        request={REQUEST}
        messages={APPROVAL}
        onAllow={() => {}}
        onDeny={onDeny}
        now={NOW}
      />,
    );
    getByRole("button", { name: "Deny" }).focus();
    await user.keyboard("{Enter}");
    const reason = getByLabelText("Reason");
    expect(document.activeElement).toBe(reason);
    expect(
      (getByRole("button", { name: "Send denial" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Cancel");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(getByRole("button", { name: "Deny" }));

    await user.keyboard("{Enter}");
    await user.keyboard("  not this file  ");
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Send denial");
    await user.keyboard("{Enter}");
    expect(onDeny).toHaveBeenCalledWith("not this file");
  });

  test("만료되면 답할 버튼 없이 만료로 읽힌다", () => {
    const { container } = render(
      <ApprovalCard
        request={REQUEST}
        messages={APPROVAL}
        onAllow={() => {}}
        onDeny={() => {}}
        now={Date.parse(REQUEST.expires_at)}
      />,
    );
    expect(container.textContent).toContain("expired");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("열어 둔 채 만료 시각이 지나면 다시 그리지 않아도 답할 버튼이 사라진다", async () => {
    const now = Date.now();
    const { container } = render(
      <ApprovalCard
        request={{
          ...REQUEST,
          expires_at: new Date(now + 50).toISOString(),
        }}
        messages={APPROVAL}
        onAllow={() => {}}
        onDeny={() => {}}
        now={now}
      />,
    );
    expect(container.querySelectorAll("button").length).toBe(2);
    await waitFor(() => expect(container.textContent).toContain("expired"));
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("허용 버튼에 포커스를 둔 채 만료되면 포커스가 만료 안내로 간다", async () => {
    const now = Date.now();
    const { getByRole, getByText } = render(
      <ApprovalCard
        request={{
          ...REQUEST,
          expires_at: new Date(now + 50).toISOString(),
        }}
        messages={APPROVAL}
        onAllow={() => {}}
        onDeny={() => {}}
        now={now}
      />,
    );
    getByRole("button", { name: "Allow" }).focus();
    await waitFor(() =>
      expect(document.activeElement).toBe(getByText("expired")),
    );
  });

  test("포커스가 카드 밖에 있으면 만료가 포커스를 가져가지 않는다", async () => {
    const now = Date.now();
    const { getByRole, getByText } = render(
      <>
        <button type="button">elsewhere</button>
        <ApprovalCard
          request={{
            ...REQUEST,
            expires_at: new Date(now + 50).toISOString(),
          }}
          messages={APPROVAL}
          onAllow={() => {}}
          onDeny={() => {}}
          now={now}
        />
      </>,
    );
    const elsewhere = getByRole("button", { name: "elsewhere" });
    elsewhere.focus();
    await waitFor(() => expect(getByText("expired")).toBeTruthy());
    expect(document.activeElement).toBe(elsewhere);
  });

  test("보내는 중에는 버튼이 막히고 거절 이유가 경고로 보인다", () => {
    const { getByRole } = render(
      <ApprovalCard
        request={REQUEST}
        messages={APPROVAL}
        onAllow={() => {}}
        onDeny={() => {}}
        now={NOW}
        pending
        error="request expired"
      />,
    );
    expect(
      (getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(getByRole("alert").textContent).toBe("request expired");
  });
});

const COMPOSER: ComposerMessages = {
  label: "Message",
  send: "Send",
  queued: "Waiting to send",
};

describe("Composer", () => {
  test("Tab으로 전송 버튼에 닿고, 접수된 뒤에만 입력을 비운다", async () => {
    const user = await setupUser();
    const onSend = mock((_text: string) => Promise.resolve());
    const { getByLabelText } = render(
      <Composer messages={COMPOSER} onSend={onSend} />,
    );
    await user.tab();
    const field = getByLabelText("Message") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    await user.keyboard("run the tests");
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Send");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("run the tests");
    await waitFor(() => expect(field.value).toBe(""));
  });

  test("응답 전에는 다시 보내지 않고, 그사이 새로 쓴 글은 지우지 않는다", async () => {
    const user = await setupUser();
    let accept = () => {};
    const onSend = mock(
      (_text: string) =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const { getByLabelText } = render(
      <Composer messages={COMPOSER} onSend={onSend} />,
    );
    const field = getByLabelText("Message") as HTMLTextAreaElement;
    await user.click(field);
    await user.keyboard("first{Control>}{Enter}{Enter}{/Control}");
    expect(onSend).toHaveBeenCalledTimes(1);
    await user.clear(field);
    await user.keyboard("second");
    accept();
    await waitFor(() =>
      expect(
        (document.querySelector("button") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(field.value).toBe("second");
  });

  test("Ctrl+Enter로 보내고, 거절되면 쓴 글을 남긴다", async () => {
    const user = await setupUser();
    const onSend = mock((_text: string) => Promise.reject(new Error("no")));
    const { getByLabelText } = render(
      <Composer messages={COMPOSER} onSend={onSend} />,
    );
    const field = getByLabelText("Message") as HTMLTextAreaElement;
    await user.click(field);
    await user.keyboard("keep me{Control>}{Enter}{/Control}");
    expect(onSend).toHaveBeenCalledWith("keep me");
    await Promise.resolve();
    expect(field.value).toBe("keep me");
  });

  test("빈 입력·막힌 세션은 보내지 않고 이유와 대기 목록을 보인다", () => {
    const { getByRole, getByLabelText } = render(
      <Composer
        messages={COMPOSER}
        onSend={() => {}}
        disabled
        disabledReason="session stopped"
        queued={[{ id: "q1", text: "then deploy" }]}
      />,
    );
    expect(
      (getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(getByLabelText("Message").getAttribute("aria-describedby")).toBe(
      document.querySelector('[data-slot="field-description"]')?.id ?? "",
    );
    expect(
      getByRole("list", { name: "Waiting to send" }).textContent,
    ).toContain("then deploy");
  });
});

describe("Message", () => {
  test("빈 본문은 그리지 않는다", () => {
    const { container } = render(
      <Message from="assistant" author="Agent" text={"  \n "} />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("보낸 메시지는 접수 문구와 거절 이유를 함께 보인다", () => {
    const { getByRole } = render(
      <Message
        from="user"
        author="You"
        text="run the tests"
        receipt={{ status: "failed", label: "Not sent" }}
        error="session is paused"
      />,
    );
    const article = getByRole("article");
    expect(article.dataset.from).toBe("user");
    expect(article.textContent).toContain("Not sent");
    expect(article.textContent).toContain("session is paused");
  });
});
