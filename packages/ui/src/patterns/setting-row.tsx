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
 * One setting in a `RowList variant="joined"`: title and description on the
 * left, the control on the right, centred on the row. Below 640px a row with
 * a description keeps the control on the title's first line and runs the
 * description under both, full width; the status words drop out there, since
 * the control's own state says the same.
 */
export function SettingRow({
  title,
  badge,
  description,
  meta,
  status,
  control,
  actions,
  className,
  ...props
}: SettingRowProps): JSX.Element {
  const labelled = control !== undefined && control !== null;
  const below = Boolean(description) || (meta !== undefined && meta !== null);
  // Only a description runs under the control on a phone; a row of values
  // keeps them beside it, the control centred on the row as on a desktop.
  const spans = Boolean(description);
  const body = (
    <>
      <span className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-2 self-center leading-5">
        {labelled ? (
          <FieldLabel htmlFor={ownId(control)} className={TITLE}>
            {title}
          </FieldLabel>
        ) : (
          <span className={TITLE}>{title}</span>
        )}
        {badge}
      </span>
      {below ? (
        <span
          className={cn(
            "row-start-2 flex min-w-0 flex-col gap-[var(--werft-row-line-gap)] leading-4",
            // Beside the control, a long address must break, not run under it.
            spans ? "col-span-2 sm:col-span-1" : "col-start-1 wrap-anywhere",
          )}
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
            "col-start-2 row-start-1 flex flex-wrap items-center justify-end gap-2",
            spans ? "self-start sm:self-center sm:row-span-2" : "self-center",
            below && !spans && "row-span-2",
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
        "grid grid-cols-[minmax(0,1fr)_auto] content-center items-start gap-y-[var(--werft-row-line-gap)] sm:items-center",
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
