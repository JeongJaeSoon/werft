import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { withLeading } from "./leading.ts";

export type CodeProps = ComponentProps<"code"> & {
  /**
   * `inherit` takes the parent's size and weight, for code inside body text
   * or a row's main value; a code mark standing on its own stays 12px.
   */
  readonly size?: "caption" | "inherit" | undefined;
};

/** Code inside a line of text: the mono face at 12px, with no fill (v4). */
export function Code({
  size = "caption",
  className,
  ...props
}: CodeProps): JSX.Element {
  return (
    <code
      data-slot="code"
      className={cn(
        "rounded-sm bg-muted px-1.5 py-0.5 font-mono",
        size === "caption"
          ? "font-normal text-caption"
          : "[font-size:inherit] [font-weight:inherit]",
        className,
      )}
      {...props}
    />
  );
}

export type CodeBlockProps = ComponentProps<"pre">;

/**
 * Mockup v4's `.code`: lines of code or tool output, wrapped rather than
 * scrolled, so a long line never widens a 390px page.
 */
export function CodeBlock({
  className,
  children,
  ...props
}: CodeBlockProps): JSX.Element {
  return (
    <pre
      data-slot="code-block"
      className={withLeading(
        cn(
          "m-0 whitespace-pre-wrap wrap-anywhere rounded-control border bg-muted px-3 py-2 font-mono font-normal text-caption text-foreground",
          className,
        ),
        "leading-[1.6]",
      )}
      {...props}
    >
      {/* The UA's `code` face would replace the kit's mono list. */}
      <code className="font-mono">{children}</code>
    </pre>
  );
}
