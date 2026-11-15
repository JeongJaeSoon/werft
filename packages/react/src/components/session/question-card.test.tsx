import { describe, expect, mock, test } from "bun:test";

import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type {
  QuestionAnswer,
  QuestionCardMessages,
  QuestionRequest,
} from "./question-card.tsx";

const { render, waitFor } = await setupDom();
// After setupDom: the card loads @werft-ai/ui, whose Radix decides at import
// time whether a DOM exists.
const { QuestionCard } = await import("./question-card.tsx");

const NOW = Date.parse("2026-10-21T01:00:00.000Z");

const REQUEST: QuestionRequest = {
  request_id: "req_q",
  turn_id: "1",
  attempt_id: "att_1",
  kind: "question",
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: "2026-10-21T01:10:00.000Z",
  questions: [
    {
      question_id: "q_color",
      prompt: "Which colour?",
      options: [
        { option_id: "red", label: "Red" },
        { option_id: "blue", label: "Blue" },
      ],
      multi_select: false,
      allow_free_text: false,
    },
    {
      question_id: "q_tools",
      prompt: "Which tools?",
      options: [
        { option_id: "git", label: "git" },
        { option_id: "bun", label: "bun" },
      ],
      multi_select: true,
      allow_free_text: true,
    },
  ],
};

const MESSAGES: QuestionCardMessages = {
  title: "Question",
  expires: (at) => `expires ${at}`,
  expired: "expired",
  freeText: "Other",
  unanswered: "Pick one or write an answer.",
  submit: "Send answer",
};

describe("QuestionCard", () => {
  test("하나 고르기·여러 개 고르기·직접 쓰기를 해서 보낸다", async () => {
    const user = await setupUser();
    const onSubmit = mock((_answers: QuestionAnswer[]) => {});
    const { getByRole } = render(
      <QuestionCard
        request={REQUEST}
        messages={MESSAGES}
        onSubmit={onSubmit}
        now={NOW}
      />,
    );
    await user.click(getByRole("radio", { name: "Blue" }));
    expect(
      (getByRole("radio", { name: "Blue" }) as HTMLElement).dataset.state,
    ).toBe("checked");
    getByRole("checkbox", { name: "git" }).focus();
    await user.keyboard(" ");
    await user.tab();
    await user.keyboard(" ");
    await user.tab();
    await user.keyboard("  zig  ");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith([
      { question_id: "q_color", selected_option_ids: ["blue"] },
      {
        question_id: "q_tools",
        selected_option_ids: ["git", "bun"],
        free_text: "zig",
      },
    ]);
  });

  test("답하지 않은 질문이 있으면 보내지 않고 그 질문 아래에 알린다", async () => {
    const user = await setupUser();
    const onSubmit = mock((_answers: QuestionAnswer[]) => {});
    const { getByRole, getAllByRole } = render(
      <QuestionCard
        request={REQUEST}
        messages={MESSAGES}
        onSubmit={onSubmit}
        now={NOW}
      />,
    );
    await user.click(getByRole("radio", { name: "Red" }));
    await user.click(getByRole("button", { name: "Send answer" }));
    expect(onSubmit).not.toHaveBeenCalled();
    const alerts = getAllByRole("alert");
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      "Pick one or write an answer.",
    ]);
    expect(alerts[0]?.closest("fieldset")?.textContent).toContain(
      "Which tools?",
    );
    // Whitespace alone is no answer.
    await user.type(getByRole("textbox", { name: "Other" }), "   ");
    await user.click(getByRole("button", { name: "Send answer" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("만료되면 보낼 버튼이 없고 고를 수도 없다", () => {
    const { queryByRole, getByRole, getByText } = render(
      <QuestionCard
        request={REQUEST}
        messages={MESSAGES}
        onSubmit={() => {}}
        now={Date.parse(REQUEST.expires_at)}
      />,
    );
    expect(getByText("expired")).toBeTruthy();
    expect(queryByRole("button", { name: "Send answer" })).toBeNull();
    expect(
      (getByRole("checkbox", { name: "git" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("보낼 버튼에 포커스를 둔 채 만료되면 포커스가 만료 안내로 간다", async () => {
    const now = Date.now();
    const { getByRole, getByText } = render(
      <QuestionCard
        request={{ ...REQUEST, expires_at: new Date(now + 50).toISOString() }}
        messages={MESSAGES}
        onSubmit={() => {}}
        now={now}
      />,
    );
    getByRole("button", { name: "Send answer" }).focus();
    await waitFor(() =>
      expect(document.activeElement).toBe(getByText("expired")),
    );
  });

  test("보내는 중에는 막히고 거절 이유가 경고로 보인다", () => {
    const { getByRole } = render(
      <QuestionCard
        request={REQUEST}
        messages={MESSAGES}
        onSubmit={() => {}}
        pending
        error="already answered"
        now={NOW}
      />,
    );
    expect(
      (getByRole("button", { name: "Send answer" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(getByRole("alert").textContent).toBe("already answered");
  });

  test("직접 입력만으로도, 고른 것과 함께도 같은 모양의 답을 보낸다", async () => {
    const user = await setupUser();
    const onSubmit = mock((_answers: QuestionAnswer[]) => {});
    const { getByRole } = render(
      <QuestionCard
        request={REQUEST}
        messages={MESSAGES}
        onSubmit={onSubmit}
        now={NOW}
      />,
    );
    await user.click(getByRole("radio", { name: "Red" }));
    await user.type(getByRole("textbox", { name: "Other" }), "zig");
    await user.click(getByRole("button", { name: "Send answer" }));
    await user.click(getByRole("checkbox", { name: "bun" }));
    await user.click(getByRole("button", { name: "Send answer" }));
    expect(onSubmit.mock.calls).toEqual([
      [
        [
          { question_id: "q_color", selected_option_ids: ["red"] },
          {
            question_id: "q_tools",
            selected_option_ids: [],
            free_text: "zig",
          },
        ],
      ],
      [
        [
          { question_id: "q_color", selected_option_ids: ["red"] },
          {
            question_id: "q_tools",
            selected_option_ids: ["bun"],
            free_text: "zig",
          },
        ],
      ],
    ]);
  });

  test("선택지는 번호가 붙은 줄이고, 번호 키로 고르며 마지막 번호는 직접 입력으로 간다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <QuestionCard
        request={REQUEST}
        messages={MESSAGES}
        onSubmit={() => {}}
        now={NOW}
      />,
    );
    const red = getByRole("radio", { name: "Red" }) as HTMLElement;
    red.focus();
    await user.keyboard("2");
    expect(
      (getByRole("radio", { name: "Blue" }) as HTMLElement).dataset.state,
    ).toBe("checked");
    const git = getByRole("checkbox", { name: "git" });
    git.focus();
    await user.keyboard("2");
    expect(
      getByRole("checkbox", { name: "bun" }).getAttribute("aria-checked"),
    ).toBe("true");
    await user.keyboard("3");
    const text = getByRole("textbox", { name: "Other" });
    expect(document.activeElement === text).toBe(true);
    // Digits typed into the text stay text.
    await user.keyboard("12");
    expect((text as HTMLInputElement).value).toBe("12");
  });

  test("선택지가 없는 질문은 직접 입력이 처음부터 펼쳐져 있다", async () => {
    const user = await setupUser();
    const onSubmit = mock((_answers: QuestionAnswer[]) => {});
    const { getByRole, queryByRole } = render(
      <QuestionCard
        request={{
          ...REQUEST,
          questions: [
            {
              question_id: "q_why",
              prompt: "Why?",
              options: [],
              multi_select: false,
              allow_free_text: true,
            },
          ],
        }}
        messages={MESSAGES}
        onSubmit={onSubmit}
        now={NOW}
      />,
    );
    expect(queryByRole("button", { name: "Other" })).toBeNull();
    await user.type(getByRole("textbox", { name: "Other" }), "because");
    await user.click(getByRole("button", { name: "Send answer" }));
    expect(onSubmit).toHaveBeenCalledWith([
      { question_id: "q_why", selected_option_ids: [], free_text: "because" },
    ]);
  });

  test("하나 고르기는 질문 글로 이름 붙은 radiogroup이고 화살표 키로 고른다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <QuestionCard
        request={REQUEST}
        messages={MESSAGES}
        onSubmit={() => {}}
        now={NOW}
      />,
    );
    const group = getByRole("radiogroup", { name: "Which colour?" });
    expect(getByRole("group", { name: "Which tools?" }).tagName).toBe(
      "FIELDSET",
    );
    const red = getByRole("radio", { name: "Red" });
    await user.click(red);
    // One Tab stop per group: Tab from the first radio skips Blue, and
    // Shift+Tab comes back to the checked one.
    await user.tab();
    expect(
      document.activeElement === getByRole("checkbox", { name: "git" }),
    ).toBe(true);
    await user.tab({ shift: true });
    expect(document.activeElement === red).toBe(true);
    // Radix moves focus in a timeout and checks the radio only while the
    // arrow is still down, as it is under a real key press.
    await user.keyboard("{ArrowRight>}");
    const blue = getByRole("radio", { name: "Blue" }) as HTMLElement;
    await waitFor(() => expect(blue.dataset.state).toBe("checked"));
    await user.keyboard("{/ArrowRight}");
    expect(group.contains(document.activeElement)).toBe(true);
    expect(document.activeElement === blue).toBe(true);
  });

  test("여러 개 고르기는 체크박스를 Space로 켜고 끈다", async () => {
    const user = await setupUser();
    const { getByRole, getByText } = render(
      <QuestionCard
        request={REQUEST}
        messages={MESSAGES}
        onSubmit={() => {}}
        now={NOW}
      />,
    );
    const git = getByRole("checkbox", { name: "git" }) as HTMLElement;
    git.focus();
    await user.keyboard(" ");
    expect(git.getAttribute("aria-checked")).toBe("true");
    await user.keyboard(" ");
    expect(git.getAttribute("aria-checked")).toBe("false");
    // The chip is the label: a click on its text toggles once.
    await user.click(getByText("bun"));
    expect(
      getByRole("checkbox", { name: "bun" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});
