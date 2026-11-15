import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

/*
 * shadcn/ui new-york Dialog — the only place packages/ui imports the Radix
 * dialog. Changed from upstream: no built-in close (X) button, since every
 * dialog here states its own way out, and no tw-animate-css classes; motion
 * comes from the caller's styles, which also own reduced-motion. The overlay
 * reads the overlay token instead of `bg-black/50`: colours live in tokens.css.
 * Sized to console v35: 440px wide, 16px padding, a 14px title.
 */

export function Dialog(
  props: ComponentProps<typeof DialogPrimitive.Root>,
): JSX.Element {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogTrigger(
  props: ComponentProps<typeof DialogPrimitive.Trigger>,
): JSX.Element {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogPortal(
  props: ComponentProps<typeof DialogPrimitive.Portal>,
): JSX.Element {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

export function DialogClose(
  props: ComponentProps<typeof DialogPrimitive.Close>,
): JSX.Element {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>): JSX.Element {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-50 bg-(--werft-color-overlay)", className)}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  overlayClassName,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  readonly overlayClassName?: string | undefined;
}): JSX.Element {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-card border bg-background p-4 shadow-pop sm:max-w-[27.5rem]",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>): JSX.Element {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-medium text-body leading-5", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>): JSX.Element {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-description text-muted-foreground", className)}
      {...props}
    />
  );
}
