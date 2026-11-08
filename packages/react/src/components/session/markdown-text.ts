import type { Nodes, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * A reply as a tree. Raw HTML stays an `html` node, which the renderer shows
 * as text, so nothing the model wrote becomes markup. A reply the parser
 * cannot read stays visible as one paragraph.
 */
export function parseMarkdown(source: string): Root {
  try {
    return fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
  } catch {
    return {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: source }] },
      ],
    };
  }
}

// Containers whose children are lines or cells of their own: a space apart.
const BLOCK_CONTAINERS: ReadonlySet<Nodes["type"]> = new Set([
  "root",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "footnoteDefinition",
]);

function plain(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
    case "html":
      return node.value;
    // The renderer links an image by its alt text, or its address without one.
    case "image":
      return node.alt || node.url;
    case "imageReference":
      return node.alt ?? "";
    case "break":
    case "thematicBreak":
      return " ";
    default:
      return "children" in node
        ? (node.children as Nodes[])
            .map(plain)
            .join(BLOCK_CONTAINERS.has(node.type) ? " " : "")
        : "";
  }
}

/**
 * A reply with its Markdown marks taken off, on one line, for the spots that
 * show only a start of it. `max` ends it with "…".
 */
export function markdownPlainText(source: string, max?: number): string {
  const text = plain(parseMarkdown(source)).replace(/\s+/g, " ").trim();
  if (max === undefined || text.length <= max) return text;
  // A cut between a surrogate pair's halves would leave a lone half.
  return `${text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/** A reply longer than this many characters of source folds. */
export const FOLD_AT = 3000;
// How much source a folded reply still shows, in whole top-level blocks.
const FOLDED_SHOWS = 1500;

/**
 * The top-level blocks a folded reply shows, cut between blocks so a list,
 * table or code block is never half drawn. `hidden` is 0 when the reply is
 * short or is one block, which is shown whole.
 */
export function foldedBlocks(
  root: Root,
  source: string,
): { readonly shown: readonly RootContent[]; readonly hidden: number } {
  if (source.length <= FOLD_AT) return { shown: root.children, hidden: 0 };
  const shown: RootContent[] = [];
  let visible = 0;
  for (const block of root.children) {
    // A link definition draws nothing: it neither counts nor ends the fold.
    const draws = block.type !== "definition";
    const end = block.position?.end.offset ?? 0;
    if (draws && visible > 0 && end > FOLDED_SHOWS) break;
    shown.push(block);
    if (draws) visible += 1;
  }
  const hidden = root.children
    .slice(shown.length)
    .filter((block) => block.type !== "definition").length;
  return { shown, hidden };
}
