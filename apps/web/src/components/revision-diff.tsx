import { CodeBlock, Text } from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

export type DiffLine = {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
};

// The LCS table's cells; past this the middle shows as removed, then added.
const LCS_CELLS_MAX = 1_000_000;

/**
 * Line diff by longest common subsequence over what lies between the common
 * head and tail; a middle too large for O(n·m) is shown removed, then added.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  // An empty text has no lines, not one empty line.
  const all = {
    a: before === "" ? [] : before.split("\n"),
    b: after === "" ? [] : after.split("\n"),
  };
  let head = 0;
  while (
    head < all.a.length &&
    head < all.b.length &&
    all.a[head] === all.b[head]
  )
    head++;
  let tail = 0;
  while (
    tail < all.a.length - head &&
    tail < all.b.length - head &&
    all.a[all.a.length - 1 - tail] === all.b[all.b.length - 1 - tail]
  )
    tail++;
  const same = (lines: string[]) =>
    lines.map((text): DiffLine => ({ kind: "same", text }));
  const a = all.a.slice(head, all.a.length - tail);
  const b = all.b.slice(head, all.b.length - tail);
  const middle =
    (a.length + 1) * (b.length + 1) > LCS_CELLS_MAX
      ? [
          ...a.map((text): DiffLine => ({ kind: "removed", text })),
          ...b.map((text): DiffLine => ({ kind: "added", text })),
        ]
      : lcsLines(a, b);
  return [
    ...same(all.a.slice(0, head)),
    ...middle,
    ...same(all.a.slice(all.a.length - tail)),
  ];
}

function lcsLines(a: string[], b: string[]): DiffLine[] {
  const width = b.length + 1;
  // lcs[i][j]: common lines between a[i..] and b[j..], flattened row-major.
  const lcs = new Int32Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && left === right) {
      lines.push({ kind: "same", text: left });
      i++;
      j++;
    } else if (
      left !== undefined &&
      (right === undefined || at(i + 1, j) >= at(i, j + 1))
    ) {
      lines.push({ kind: "removed", text: left });
      i++;
    } else {
      lines.push({ kind: "added", text: right ?? "" });
      j++;
    }
  }
  return lines;
}

const MARK = { same: " ", added: "+", removed: "-" } as const;
export const DIFF_LINE = {
  same: "block",
  added: "block bg-[var(--werft-tone-progress-bg)]",
  removed: "block bg-[var(--werft-tone-danger-bg)] line-through",
} as const;

// Text as written; anything else as its JSON.
const asText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** Two revisions of the same document, side by side as one annotated text. */
export function RevisionDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
}: {
  readonly before: unknown;
  readonly after: unknown;
  readonly beforeLabel: string;
  readonly afterLabel: string;
}) {
  const { t } = useI18n();
  const lines = diffLines(asText(before), asText(after));
  const changed = lines.some((line) => line.kind !== "same");
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2">
      <figcaption>
        <Text as="div" variant="sub">
          {t("diff.caption", { before: beforeLabel, after: afterLabel })}
        </Text>
      </figcaption>
      {changed ? (
        <CodeBlock>
          {lines.map((line, index) => (
            <span
              // Lines repeat, so position is the only stable identity here.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              className={DIFF_LINE[line.kind]}
              data-kind={line.kind}
            >
              <span className="inline-block w-[1.5ch]" aria-hidden="true">
                {MARK[line.kind]}
              </span>
              {line.kind === "same" ? null : (
                <span className="sr-only">
                  {t(line.kind === "added" ? "diff.added" : "diff.removed")}
                </span>
              )}
              {line.text}
              {"\n"}
            </span>
          ))}
        </CodeBlock>
      ) : (
        <Text variant="sub">{t("diff.same")}</Text>
      )}
    </figure>
  );
}
