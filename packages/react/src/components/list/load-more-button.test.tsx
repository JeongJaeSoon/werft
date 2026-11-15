import { describe, expect, mock, test } from "bun:test";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";

const { render, act } = await setupDom();
const { GridTable, GridTableCell, GridTableRow, GridTableRowOpener } =
  await import("@werft-ai/ui");
const { LoadMoreButton } = await import("./load-more-button.tsx");

const MESSAGES = { more: "더 보기", loading: "불러오는 중…" };

function List({
  rows,
  hasMore,
  loading,
  onLoadMore,
}: {
  readonly rows: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
}) {
  return (
    <div>
      <GridTable aria-label="목록" columns="1fr">
        {Array.from({ length: rows }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed fixture rows
          <GridTableRow key={index}>
            <GridTableCell>
              <GridTableRowOpener aria-label={`행 ${index}`} />
            </GridTableCell>
          </GridTableRow>
        ))}
      </GridTable>
      <LoadMoreButton
        hasMore={hasMore}
        loading={loading}
        onLoadMore={onLoadMore}
        messages={MESSAGES}
      />
    </div>
  );
}

describe("LoadMoreButton", () => {
  test("불러오는 중에는 aria-disabled로 포커스를 지키고 다시 눌러도 부르지 않는다", async () => {
    const onLoadMore = mock();
    const view = render(
      <List rows={2} hasMore={true} loading={false} onLoadMore={onLoadMore} />,
    );
    const button = view.getByRole("button", { name: "더 보기" });
    await act(async () => button.focus());
    const user = await setupUser();
    await user.keyboard("{Enter}");
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.rerender(
      <List rows={2} hasMore={true} loading={true} onLoadMore={onLoadMore} />,
    );
    expect(button.textContent).toBe("불러오는 중…");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement === button).toBe(true);
    await user.keyboard("{Enter}");
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  test("마지막 페이지가 붙어 버튼이 사라지면 포커스가 새로 붙은 첫 행으로 간다", async () => {
    const onLoadMore = mock();
    const view = render(
      <List rows={2} hasMore={true} loading={false} onLoadMore={onLoadMore} />,
    );
    const button = view.getByRole("button", { name: "더 보기" });
    await act(async () => button.focus());
    const user = await setupUser();
    await user.keyboard("{Enter}");
    view.rerender(
      <List rows={2} hasMore={true} loading={true} onLoadMore={onLoadMore} />,
    );
    view.rerender(
      <List rows={4} hasMore={false} loading={false} onLoadMore={onLoadMore} />,
    );
    expect(view.queryByRole("button", { name: "더 보기" })).toBeNull();
    const first = view.getByRole("button", { name: "행 2" });
    expect(document.activeElement === first).toBe(true);
  });

  test("마지막 페이지 뒤에 보일 행이 없으면 포커스가 목록을 감싼 요소로 간다", async () => {
    const onLoadMore = mock();
    const view = render(
      <List rows={0} hasMore={true} loading={false} onLoadMore={onLoadMore} />,
    );
    const button = view.getByRole("button", { name: "더 보기" });
    const scope = button.parentElement;
    await act(async () => button.focus());
    const user = await setupUser();
    await user.keyboard("{Enter}");
    view.rerender(
      <List rows={0} hasMore={true} loading={true} onLoadMore={onLoadMore} />,
    );
    view.rerender(
      <List rows={0} hasMore={false} loading={false} onLoadMore={onLoadMore} />,
    );
    expect(view.queryByRole("button", { name: "더 보기" })).toBeNull();
    expect(scope !== null && document.activeElement === scope).toBe(true);
    expect(scope?.getAttribute("tabindex")).toBe("-1");
  });

  test("포커스가 다른 곳에 있으면 마지막 페이지 뒤에도 옮기지 않는다", async () => {
    const onLoadMore = mock();
    const view = render(
      <List rows={2} hasMore={true} loading={false} onLoadMore={onLoadMore} />,
    );
    const user = await setupUser();
    await user.click(view.getByRole("button", { name: "더 보기" }));
    const elsewhere = view.getByRole("button", { name: "행 0" });
    await act(async () => elsewhere.focus());
    view.rerender(
      <List rows={2} hasMore={true} loading={true} onLoadMore={onLoadMore} />,
    );
    view.rerender(
      <List rows={4} hasMore={false} loading={false} onLoadMore={onLoadMore} />,
    );
    expect(document.activeElement === elsewhere).toBe(true);
  });
});
