import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type {
  ApprovalCardMessages,
  PermissionRequest,
} from "./approval-card.tsx";

const { render } = await setupDom();
// After setupDom: this loads @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { ApprovalCard } = await import("./approval-card.tsx");

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

const MESSAGES: ApprovalCardMessages = {
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
  test("입력 보기는 자기 줄에서 카드 전체 폭을 쓰고, 답 버튼은 그 아래 마지막 줄에 있다", async () => {
    const user = await setupUser();
    const view = render(
      <ApprovalCard
        request={REQUEST}
        messages={MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        now={NOW}
      />,
    );
    const article = view.getByRole("article", { name: "Bash asks" });
    const summary = view.getByText("input");
    const details = summary.closest("details") as HTMLElement;
    const buttons = view.getByRole("button", { name: "Allow" })
      .parentElement as HTMLElement;

    await user.click(summary);
    const pre = (await view.findByText(/echo alpha/)).closest("pre");

    // Both are direct children of the card, never sharing a row.
    expect(details.parentElement).toBe(article);
    expect(buttons.parentElement).toBe(article);
    expect(details.contains(buttons)).toBe(false);
    expect(details.contains(pre)).toBe(true);
    expect(buttons).toBe(article.lastElementChild as HTMLElement);
    expect(
      details.compareDocumentPosition(buttons) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
