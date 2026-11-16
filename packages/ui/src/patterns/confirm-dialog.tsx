import type { JSX, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { cn } from "../foundations/cn.ts";
import { Button } from "../primitives/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/dialog.tsx";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  /**
   * What actually happens if they go through with it — stated in the user's
   * own terms. Required, because a confirmation without a consequence is a
   * speed bump, not a decision.
   */
  readonly consequence: ReactNode;
  /**
   * The name of what the action hits, on its own line under the consequence,
   * for a title that does not already say it.
   */
  readonly target?: ReactNode | undefined;
  readonly onConfirm: () => void;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  /**
   * The request is in flight. The owner keeps the dialog open until the server
   * answers: 승인·활성화·취소에 optimistic 성공을 쓰지 않는다 (§1).
   */
  readonly busy?: boolean | undefined;
  readonly confirmDisabled?: boolean | undefined;
  /** The id of what says why the confirm button is disabled. */
  readonly confirmDescribedBy?: string | undefined;
  readonly tone?: "default" | "danger" | undefined;
  /**
   * `alertdialog` when the dialog interrupts a flow to demand a decision,
   * such as before ending something that is running.
   */
  readonly role?: "dialog" | "alertdialog" | undefined;
  /** Extra controls between the consequence and the buttons. */
  readonly children?: ReactNode | undefined;
  readonly className?: string | undefined;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  target,
  onConfirm,
  confirmLabel = "확인",
  cancelLabel = "취소",
  busy = false,
  confirmDisabled = false,
  confirmDescribedBy,
  tone = "default",
  role = "dialog",
  children,
  className,
}: ConfirmDialogProps): JSX.Element {
  /*
   * Who to give the keyboard back to. Radix restores focus to `Dialog.Trigger`,
   * but the screens own their buttons and never mount one, so its ref is empty
   * and focus falls to <body> — a keyboard user loses their place.
   *
   * Tracked by watching focus rather than read at open time: Radix skips its
   * own open event when a child already took focus (an `autoFocus` input), and
   * by the time any effect of ours runs the opener is no longer current. The
   * last thing focused outside *this* content is the opener — outside this one
   * specifically, so a dialog opened from within another returns to the button
   * inside it.
   *
   * The marker attribute rather than a ref: React attaches a parent's ref after
   * the subtree is in the DOM, so an `autoFocus` child fires before we could
   * recognise our own content by it. The attribute is already there.
   */
  const instanceId = useId();
  // Mounted already open (`{open && <ConfirmDialog …>}`): the listener below
  // is installed too late to have seen the opener, but nothing has moved focus
  // yet at this point either. A lazy initialiser, so a render React abandons
  // leaves nothing behind.
  const [openerAtMount] = useState<HTMLElement | null>(() =>
    open && typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null,
  );
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent): void => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest) return;
      const own = document.querySelector(`[data-werft-dialog="${instanceId}"]`);
      // While this one is open, nothing inside any dialog is an opener — not
      // its own controls, and not a dialog opened on top of it, which lives in
      // its own portal rather than inside this content.
      if (own && target.closest("[data-werft-dialog]")) return;
      openerRef.current = target;
    };
    document.addEventListener("focusin", remember);
    return () => {
      document.removeEventListener("focusin", remember);
    };
  }, [instanceId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Radix wires aria-labelledby/aria-describedby to the Title and
          Description below, and owns Escape and the focus trap. The `werft-*`
          classes are unlayered, so they win over the primitive's utilities
          and the dialog keeps its look and its reduced-motion rule. The
          utilities reset below are the ones `werft-*` does not set: Tailwind's
          `translate` would stack on `.werft-dialog`'s `transform`, and the
          title and description would shrink to shadcn's type scale. */}
      <DialogContent
        role={role}
        overlayClassName="werft-dialog__overlay"
        data-werft-dialog={instanceId}
        className={cn("werft-dialog translate-x-0 translate-y-0", className)}
        data-tone={tone}
        data-busy={busy || undefined}
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current ?? openerAtMount;
          // Gone from the page — the screen that owned it was torn down with
          // the dialog. Nothing to return to, so leave Radix's fallback.
          if (!opener?.isConnected) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        <DialogTitle className="werft-dialog__title leading-[inherit]">
          {title}
        </DialogTitle>
        <DialogDescription className="werft-dialog__consequence text-[length:inherit]">
          {consequence}
          {/* Inside the description, so the name is read with it. */}
          {target === undefined || target === null ? null : (
            <span
              data-slot="confirm-target"
              className="mt-2 block font-medium text-foreground [overflow-wrap:anywhere]"
            >
              {target}
            </span>
          )}
        </DialogDescription>
        {children}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={tone === "danger" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            aria-describedby={confirmDescribedBy}
          >
            {busy ? (
              <span className="werft-button__spinner" aria-hidden="true" />
            ) : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
