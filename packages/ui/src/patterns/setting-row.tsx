import {
  type ComponentProps,
  isValidElement,
  type JSX,
  type ReactNode,
} from "react";

import { cn } from "../foundations/cn.ts";
import { Field, FieldDescription, FieldLabel } from "../primitives/field.tsx";
import { RowListItem } from "../primitives/row-list.tsx";

export type SettingRowProps = Omit<ComponentProps<"li">, "title"> & {
  readonly title: ReactNode;
  /** A Badge after the title, outside the control's name. */
  readonly badge?: ReactNode | undefined;
  readonly description?: ReactNode | undefined;
  /** Lines under the description, such as a value or a time. */
  readonly meta?: ReactNode | undefined;
  /** Words for the control's state, before it. Not part of its name; hidden below 640px. */
  readonly status?: ReactNode | undefined;
  /**
   * One form control (Switch, NativeSelect). The title becomes its name and
   * the description its description.
   */
  readonly control?: ReactNode | undefined;
  /** Buttons. They keep their own names. */
  readonly actions?: ReactNode | undefined;
  /** `danger`: a red title, for a row in a DangerZone. */
  readonly tone?: "default" | "danger" | undefined;
};

const TITLE = "m-0 font-medium text-control leading-5";
const DESCRIPTION = "m-0 text-caption text-subtle-foreground leading-4";

// A control keeps an id its caller gave it, so the title must point there
// instead of at the Field's generated one.
function ownId(control: ReactNode): string | undefined {
  if (!isValidElement<{ id?: unknown }>(control)) return undefined;
  return typeof control.props.id === "string" ? control.props.id : undefined;
}

/**
 * One setting in a `RowList variant="joined"`, or one action in a
 * DangerZone: title and description on the left, the control or buttons on
 * the right. At every width the text keeps to its column and the right
 * column is centred on the whole row; nothing drops under the text on a
 * phone. The status words drop out below 640px, since the control's own
 * state says the same.
 */
export function SettingRow({
  title,
  badge,
  description,
  meta,
  status,
  control,
  actions,
  tone = "default",
  className,
  ...props
}: SettingRowProps): JSX.Element {
  const labelled = control !== undefined && control !== null;
  const below = Boolean(description) || (meta !== undefined && meta !== null);
  const titleClass = cn(TITLE, tone === "danger" && "text-destructive");
  const body = (
    <>
      <span className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-2 self-center leading-5">
        {labelled ? (
          <FieldLabel htmlFor={ownId(control)} className={titleClass}>
            {title}
          </FieldLabel>
        ) : (
          <span className={titleClass}>{title}</span>
        )}
        {badge}
      </span>
      {below ? (
        <span
          // Beside the control, a long address must break, not run under it.
          className="col-start-1 row-start-2 flex min-w-0 flex-col gap-[var(--werft-row-line-gap)] wrap-anywhere leading-4"
        >
          {description ? (
            labelled ? (
              <FieldDescription className={cn(DESCRIPTION, "nth-last-2:mt-0")}>
                {description}
              </FieldDescription>
            ) : (
              <p className={DESCRIPTION}>{description}</p>
            )
          ) : null}
          {meta}
        </span>
      ) : null}
      {labelled || status || actions ? (
        <div
          className={cn(
            "col-start-2 row-start-1 flex flex-wrap items-center justify-end gap-2 self-center",
            below && "row-span-2",
          )}
        >
          {status ? <span className="hidden sm:contents">{status}</span> : null}
          {control}
          {actions}
        </div>
      ) : null}
    </>
  );
  return (
    <RowListItem
      data-slot="setting-row"
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] content-center items-center gap-y-[var(--werft-row-line-gap)]",
        className,
      )}
      {...props}
    >
      {labelled ? (
        // The Field only lends its ids; its children lay out in the row.
        <Field orientation="horizontal" className="contents">
          {body}
        </Field>
      ) : (
        body
      )}
    </RowListItem>
  );
}
