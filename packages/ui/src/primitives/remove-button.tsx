import { X } from "lucide-react";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type RemoveButtonProps = Omit<
  ComponentProps<"button">,
  "type" | "children" | "aria-label"
> & {
  /** Names what goes: "김민지 빼기". The button shows only an ×. */
  readonly "aria-label": string;
};

/*
 * The × that takes one item out of a picked list, such as a chip. A 20px
 * round target with the control's focus outline; withheld, it fades to 0.5
 * like every control and does not hover.
 */
export function RemoveButton({
  className,
  ...props
}: RemoveButtonProps): JSX.Element {
  return (
    <button
      type="button"
      data-slot="remove-button"
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-[background-color,color] enabled:hover:bg-hover enabled:hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-50 motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      <X aria-hidden="true" className="size-3" strokeWidth={2} />
    </button>
  );
}
