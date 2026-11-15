import { cva, type VariantProps } from "class-variance-authority";
import {
  type ComponentProps,
  createContext,
  type JSX,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";

/*
 * shadcn/ui new-york Field. Changed from upstream: a Field wires itself up.
 * Upstream leaves `id`, `htmlFor` and `aria-describedby` to the caller; here
 * the Field mints the ids, FieldLabel points at the control, and the single
 * control inside (Input, Textarea, NativeSelect, Checkbox, RadioGroupItem)
 * reads them through `useFieldControl`. Each FieldDescription and FieldError
 * registers the id it renders with, so `aria-describedby` only names elements
 * that are on the page, and a mounted FieldError marks the control
 * `aria-invalid`. The parts register in an effect, so server-rendered HTML
 * lacks them until hydration; nothing here renders on a server. FieldLabel is
 * a native <label>
 * rather than Radix Label, Field drops its unnamed `role="group"` (FieldSet
 * is the named group), FieldSeparator and FieldTitle are left out, and there
 * are no `dark:` variants.
 */

type FieldPart = "description" | "error";

interface FieldContextValue {
  readonly controlId: string;
  readonly parts: Readonly<Record<FieldPart, readonly string[]>>;
  /** Adds a rendered part's id; the returned function takes it back out. */
  readonly register: (part: FieldPart, id: string) => () => void;
}

const FieldContext = createContext<FieldContextValue | null>(null);

interface FieldControlProps {
  readonly id?: string | undefined;
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-invalid"?: ComponentProps<"input">["aria-invalid"];
}

/**
 * The id and ARIA a control inside a Field should carry. Values the caller set
 * explicitly win; a caller's `aria-describedby` is kept and the Field's parts
 * are appended.
 */
export function useFieldControl<P extends FieldControlProps>(props: P): P {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy = [
    props["aria-describedby"],
    ...field.parts.description,
    ...field.parts.error,
  ]
    .filter(Boolean)
    .join(" ");
  const hasError = field.parts.error.length > 0;
  return {
    ...props,
    id: props.id ?? field.controlId,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": props["aria-invalid"] ?? (hasError || undefined),
  };
}

/** The id a part renders with, registered with its Field under that id. */
function usePartId(part: FieldPart, id: string | undefined): string {
  const generated = useId();
  const ownId = id ?? generated;
  const register = useContext(FieldContext)?.register;
  useLayoutEffect(() => register?.(part, ownId), [register, part, ownId]);
  return ownId;
}

export function FieldSet({
  className,
  ...props
}: ComponentProps<"fieldset">): JSX.Element {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        "flex flex-col gap-6",
        "has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3",
        className,
      )}
      {...props}
    />
  );
}

export function FieldLegend({
  className,
  variant = "legend",
  ...props
}: ComponentProps<"legend"> & {
  readonly variant?: "legend" | "label" | undefined;
}): JSX.Element {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        "mb-3 font-medium",
        "data-[variant=legend]:text-body",
        "data-[variant=label]:text-control",
        className,
      )}
      {...props}
    />
  );
}

export function FieldGroup({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-4 data-[slot=checkbox-group]:gap-3 [&>[data-slot=field-group]]:gap-4",
        className,
      )}
      {...props}
    />
  );
}

export const fieldVariants = cva(
  "group/field flex w-full gap-2 data-[invalid=true]:text-destructive",
  {
    variants: {
      orientation: {
        vertical: ["flex-col [&>*]:w-full [&>.sr-only]:w-auto"],
        horizontal: [
          "flex-row items-center",
          "[&>[data-slot=field-label]]:flex-auto",
          "has-[>[data-slot=field-content]]:items-start has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        ],
        responsive: [
          "flex-col @md/field-group:flex-row @md/field-group:items-center [&>*]:w-full @md/field-group:[&>*]:w-auto [&>.sr-only]:w-auto",
          "@md/field-group:[&>[data-slot=field-label]]:flex-auto",
          "@md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        ],
      },
    },
    defaultVariants: { orientation: "vertical" },
  },
);

export type FieldProps = ComponentProps<"div"> &
  VariantProps<typeof fieldVariants>;

export function Field({
  className,
  orientation = "vertical",
  ...props
}: FieldProps): JSX.Element {
  const id = useId();
  const [parts, setParts] = useState<FieldContextValue["parts"]>({
    description: [],
    error: [],
  });
  // Stable, or each registration would re-run every part's effect forever.
  const register = useCallback((part: FieldPart, partId: string) => {
    setParts((current) => ({
      ...current,
      [part]: [...current[part], partId],
    }));
    return () =>
      setParts((current) => ({
        ...current,
        [part]: current[part].filter((other) => other !== partId),
      }));
  }, []);
  const value = useMemo<FieldContextValue>(
    () => ({ controlId: `${id}-control`, parts, register }),
    [id, parts, register],
  );
  return (
    <FieldContext.Provider value={value}>
      <div
        data-slot="field"
        data-orientation={orientation}
        data-invalid={parts.error.length > 0 || undefined}
        className={cn(fieldVariants({ orientation }), className)}
        {...props}
      />
    </FieldContext.Provider>
  );
}

export function FieldContent({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="field-content"
      className={cn(
        "group/field-content flex flex-1 flex-col gap-1 leading-snug",
        className,
      )}
      {...props}
    />
  );
}

export function FieldLabel({
  className,
  htmlFor,
  ...props
}: ComponentProps<"label">): JSX.Element {
  const field = useContext(FieldContext);
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor comes from the Field or the caller
    <label
      data-slot="field-label"
      htmlFor={htmlFor ?? field?.controlId}
      className={cn(
        "group/field-label peer/field-label flex w-fit select-none items-center gap-2 font-medium text-control leading-snug group-data-[disabled=true]/field:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        "has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-card has-[>[data-slot=field]]:border [&>*]:data-[slot=field]:p-4",
        "has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5",
        "has-[>[data-slot=field]]:cursor-pointer has-[>[data-slot=field]]:has-[:disabled]:cursor-not-allowed has-[>[data-slot=field]]:not-has-[:disabled,[data-state=checked]]:hover:border-border-strong has-[>[data-slot=field]]:not-has-[:disabled,[data-state=checked]]:hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

export function FieldDescription({
  className,
  id,
  ...props
}: ComponentProps<"p">): JSX.Element {
  return (
    <p
      data-slot="field-description"
      id={usePartId("description", id)}
      className={cn(
        "font-normal text-caption text-muted-foreground leading-normal group-has-[[data-orientation=horizontal]]/field:text-balance",
        "nth-last-2:-mt-1 last:mt-0 [[data-variant=legend]+&]:-mt-1",
        "[&>a:hover]:text-link [&>a]:underline [&>a]:underline-offset-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Renders nothing without children (an empty string counts as none), so a
 * form can always place it and only fill it when there is an error; only a
 * rendered error marks the control invalid.
 */
export function FieldError({
  className,
  children,
  ...props
}: ComponentProps<"div">): JSX.Element | null {
  if (
    children === undefined ||
    children === null ||
    children === false ||
    children === ""
  ) {
    return null;
  }
  return (
    <FieldErrorMessage className={className} {...props}>
      {children}
    </FieldErrorMessage>
  );
}

function FieldErrorMessage({
  className,
  id,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      role="alert"
      data-slot="field-error"
      id={usePartId("error", id)}
      className={cn(
        "font-normal text-caption text-destructive leading-normal",
        className,
      )}
      {...props}
    />
  );
}
