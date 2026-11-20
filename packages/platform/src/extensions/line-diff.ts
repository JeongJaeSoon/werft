/** Cells of the LCS table past which a change is too large to show. */
const MAX_CELLS = 4_000_000;
const CONTEXT = 3;

type Op = { kind: " " | "-" | "+"; line: string };

/**
 * A unified line diff (`@@ -a,b +c,d @@` hunks with three lines of context)
 * from `before` to `after`, or null when the changed middle of the two is
 * too large to compare. Equal texts give "".
 */
export function unifiedLineDiff(before: string, after: string): string | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) return null;

  const ops: Op[] = a.slice(0, head).map((line) => ({ kind: " ", line }));
  ops.push(...middleOps(midA, midB));
  for (const line of a.slice(a.length - tail)) ops.push({ kind: " ", line });
  return hunks(ops);
}

function middleOps(a: string[], b: string[]): Op[] {
  const width = b.length + 1;
  // lcs[i * width + j]: the longest common subsequence of a[i..] and b[j..].
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] as number) + 1
          : Math.max(
              lcs[(i + 1) * width + j] as number,
              lcs[i * width + j + 1] as number,
            );
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] as string });
      i++;
      j++;
    } else if (
      (lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)
    ) {
      ops.push({ kind: "-", line: a[i] as string });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] as string });
      j++;
    }
  }
  for (; i < a.length; i++) ops.push({ kind: "-", line: a[i] as string });
  for (; j < b.length; j++) ops.push({ kind: "+", line: b[j] as string });
  return ops;
}

function hunks(ops: Op[]): string {
  const changed = ops.flatMap((op, at) => (op.kind === " " ? [] : [at]));
  const out: string[] = [];
  let index = 0;
  while (index < changed.length) {
    const start = Math.max(0, (changed[index] as number) - CONTEXT);
    let end = (changed[index] as number) + CONTEXT + 1;
    while (
      index + 1 < changed.length &&
      (changed[index + 1] as number) - CONTEXT <= end
    ) {
      index++;
      end = (changed[index] as number) + CONTEXT + 1;
    }
    end = Math.min(end, ops.length);
    index++;
    let oldStart = 1;
    let newStart = 1;
    for (const op of ops.slice(0, start)) {
      if (op.kind !== "+") oldStart++;
      if (op.kind !== "-") newStart++;
    }
    const body = ops.slice(start, end);
    const oldCount = body.filter((op) => op.kind !== "+").length;
    const newCount = body.filter((op) => op.kind !== "-").length;
    out.push(
      `@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`,
      ...body.map((op) => `${op.kind}${op.line}`),
    );
  }
  return out.join("\n");
}
