import type { JSX, ReactNode } from "react";
import { useEffect, useId, useState } from "react";

import { Input } from "../primitives/input.tsx";
import { ConfirmDialog } from "./confirm-dialog.tsx";

export interface DestructiveActionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly consequence: ReactNode;
  readonly onConfirm: () => void;
  /** What is being destroyed, in the user's words: "결제 담당 에이전트". */
  readonly resourceName: string;
  /**
   * What has to be typed to unlock the button. Defaults to `resourceName`;
   * pass the id when the name is not unique enough to be worth typing.
   */
  readonly matchText?: string | undefined;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * Archiving, deleting and other actions too heavy for one click. Typing the
 * name is the gate (§3 에이전트 카드 "이름 입력 확인"); everything else is
 * `ConfirmDialog`.
 */
export function DestructiveActionDialog({
  open,
  onOpenChange,
  title,
  consequence,
  onConfirm,
  resourceName,
  matchText,
  confirmLabel = "삭제",
  cancelLabel = "취소",
  busy = false,
  className,
}: DestructiveActionDialogProps): JSX.Element {
  const expected = matchText ?? resourceName;
  const inputId = useId();
  const [typed, setTyped] = useState("");

  // Reopening starts from an empty field; a stale match must not carry over.
  // Keyed off `open` rather than `onOpenChange`, because the owner usually
  // closes this dialog itself once the server answers — that path never calls
  // the handler, and the typed name would survive into the next open.
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      consequence={consequence}
      onConfirm={onConfirm}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      busy={busy}
      confirmDisabled={typed.trim() !== expected}
      tone="danger"
      className={className}
    >
      <div className="werft-dialog__match">
        {/* The name sits on its own line instead of inside the sentence:
            Korean particles change with the last letter, and "을(를)" is how
            that leaks into the copy. */}
        <label className="werft-dialog__match-label" htmlFor={inputId}>
          계속하려면 아래 이름을 그대로 입력하세요
        </label>
        <code className="werft-dialog__match-target">{expected}</code>
        <Input
          id={inputId}
          type="text"
          value={typed}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
    </ConfirmDialog>
  );
}
