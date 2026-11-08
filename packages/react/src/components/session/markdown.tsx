import {
  Button,
  Code,
  CodeBlock,
  cn,
  Link,
  TableContainer,
} from "@werft-ai/ui";
import type {
  Definition,
  Nodes,
  Parents,
  Root,
  RootContent,
  TableRow,
} from "mdast";
import { type JSX, type ReactNode, useId, useMemo, useState } from "react";

import {
  collectDefinitions,
  foldedBlocks,
  parseMarkdown,
} from "./markdown-text.ts";

export interface MarkdownProps {
  readonly text: string;
  /**
   * Folds a reply of many blocks to its first ones behind a button; without
   * it the reply is always whole.
   */
  readonly fold?: { readonly more: string; readonly less: string } | undefined;
  /** Names a table's scroll area for screen readers; without it none is named. */
  readonly tableLabel?: string | undefined;
  /** Appended to a link's text for screen readers: it opens a new tab. */
  readonly newTabLabel?: string | undefined;
  readonly className?: string | undefined;
}

interface Context {
  readonly definitions: ReadonlyMap<string, Definition>;
  readonly tableLabel: string | undefined;
  readonly newTabLabel: string | undefined;
}

// A link that is not one of these (javascript:, data:, a relative path) is
// shown as its text.
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function nodes(children: readonly Nodes[], ctx: Context): ReactNode[] {
  // The index is the key: a parsed tree is never reordered.
  return children.map((child, index) => render(child, ctx, index));
}

function inline(node: Parents, ctx: Context) {
  return nodes(node.children, ctx);
}

function anchor(
  url: string,
  children: ReactNode,
  ctx: Context,
  key: number,
): ReactNode {
  const href = safeHref(url);
  return href === null ? (
    children
  ) : (
    <Link
      key={key}
      underline="always"
      href={href}
      target="_blank"
      newTabLabel={ctx.newTabLabel}
    >
      {children}
    </Link>
  );
}

function cells(row: TableRow, tag: "th" | "td", ctx: Context, align: Align[]) {
  const Cell = tag;
  return row.children.map((cell, index) => (
    <Cell
      // biome-ignore lint/suspicious/noArrayIndexKey: a parsed tree is never reordered
      key={index}
      style={{ textAlign: align[index] ?? undefined }}
      className={cn(
        "border-b px-3 py-1.5 text-left align-top",
        tag === "th" && "font-medium text-subtle-foreground",
      )}
    >
      {inline(cell, ctx)}
    </Cell>
  ));
}

type Align = "left" | "right" | "center" | null | undefined;

function render(node: Nodes, ctx: Context, key: number): ReactNode {
  switch (node.type) {
    case "text":
      return node.value;
    // Raw HTML is shown as the text the model wrote, never as markup.
    case "html":
      return node.value;
    case "paragraph":
      return (
        <p key={key} className="m-0">
          {inline(node, ctx)}
        </p>
      );
    case "heading":
      // Not a heading element: a reply's own "#" must not reshape the page's
      // outline.
      return (
        <p key={key} className="m-0 font-semibold">
          {inline(node, ctx)}
        </p>
      );
    case "emphasis":
      return <em key={key}>{inline(node, ctx)}</em>;
    case "strong":
      return (
        <strong key={key} className="font-semibold">
          {inline(node, ctx)}
        </strong>
      );
    case "delete":
      return <del key={key}>{inline(node, ctx)}</del>;
    case "inlineCode":
      return (
        <Code key={key} className="rounded-sm bg-muted px-1">
          {node.value}
        </Code>
      );
    case "break":
      return <br key={key} />;
    case "link":
      return anchor(node.url, inline(node, ctx), ctx, key);
    case "linkReference": {
      const target = ctx.definitions.get(node.identifier);
      return target
        ? anchor(target.url, inline(node, ctx), ctx, key)
        : inline(node, ctx);
    }
    // An image is not loaded (the address would leak that the reader opened
    // this); its alt text links to it.
    case "image":
      return anchor(node.url, node.alt || node.url, ctx, key);
    case "imageReference": {
      const target = ctx.definitions.get(node.identifier);
      return target
        ? anchor(target.url, node.alt || target.url, ctx, key)
        : (node.alt ?? "");
    }
    case "footnoteReference":
      return `[${node.label ?? node.identifier}]`;
    case "code":
      return <CodeBlock key={key}>{node.value}</CodeBlock>;
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="m-0 flex flex-col gap-2 border-l-2 pl-3 text-muted-foreground"
        >
          {inline(node, ctx)}
        </blockquote>
      );
    case "list": {
      const List = node.ordered ? "ol" : "ul";
      return (
        <List
          key={key}
          start={node.ordered && node.start != null ? node.start : undefined}
          className={cn(
            "m-0 flex flex-col gap-1 pl-5",
            node.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {inline(node, ctx)}
        </List>
      );
    }
    case "listItem":
      return (
        // Not a flex container: that would drop the list marker.
        <li
          key={key}
          className={cn(
            "pl-0.5 [&>*+*]:mt-1",
            typeof node.checked === "boolean" && "[&>p:first-of-type]:inline",
          )}
        >
          {typeof node.checked === "boolean" ? (
            <span className="mr-1">
              <span aria-hidden="true">{node.checked ? "☑" : "☐"}</span>
              <span className="sr-only">{node.checked ? "[x]" : "[ ]"}</span>
            </span>
          ) : null}
          {inline(node, ctx)}
        </li>
      );
    case "thematicBreak":
      return <hr key={key} className="m-0 border-t" />;
    case "table": {
      const [head, ...body] = node.children;
      const align = node.align ?? [];
      const table = (
        <table className="w-full border-collapse text-control">
          <thead>
            {head ? <tr>{cells(head, "th", ctx, align)}</tr> : null}
          </thead>
          <tbody>
            {body.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a parsed tree is never reordered
              <tr key={index}>{cells(row, "td", ctx, align)}</tr>
            ))}
          </tbody>
        </table>
      );
      return ctx.tableLabel === undefined ? (
        <div key={key} className="overflow-x-auto">
          {table}
        </div>
      ) : (
        <TableContainer key={key} label={ctx.tableLabel}>
          {table}
        </TableContainer>
      );
    }
    case "footnoteDefinition":
      return (
        <div key={key} className="flex flex-col gap-1">
          {inline(node, ctx)}
        </div>
      );
    // Definitions only feed `linkReference`.
    default:
      return null;
  }
}

/**
 * A reply's Markdown drawn as React elements: it never sets HTML, links open
 * only with http, https or mailto, and a long reply can fold between blocks.
 */
export function Markdown({
  text,
  fold,
  tableLabel,
  newTabLabel,
  className,
}: MarkdownProps): JSX.Element {
  const root: Root = useMemo(() => parseMarkdown(text), [text]);
  const definitions = useMemo(() => collectDefinitions(root), [root]);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const { shown, hidden } = fold
    ? foldedBlocks(root, text)
    : { shown: root.children, hidden: 0 };
  const blocks: readonly RootContent[] = open ? root.children : shown;
  return (
    <div
      data-slot="markdown"
      className={cn(
        "flex min-w-0 flex-col gap-2 text-control leading-[1.5] [overflow-wrap:anywhere]",
        className,
      )}
    >
      <div id={bodyId} className="flex min-w-0 flex-col gap-2">
        {nodes(blocks, { definitions, tableLabel, newTabLabel })}
      </div>
      {fold && hidden > 0 ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="self-start px-0"
        >
          {open ? fold.less : fold.more}
        </Button>
      ) : null}
    </div>
  );
}
