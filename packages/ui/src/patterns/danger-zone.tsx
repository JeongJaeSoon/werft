import {
  type ComponentProps,
  type JSX,
  type ReactNode,
  type Ref,
  useId,
} from "react";

import { RowList } from "../primitives/row-list.tsx";
import { DisabledReason } from "./disabled-reason.tsx";
import { RowAction } from "./row-action.tsx";
import { SettingRow } from "./setting-row.tsx";

export type DangerZoneProps = Omit<ComponentProps<"section">, "title"> & {
  /** "Danger zone" in the reader's language. */
  readonly title: ReactNode;
  readonly titleAs?: "h2" | "h3" | undefined;
  /** For a page whose section links point at the heading. */
  readonly titleId?: string | undefined;
  /** `DangerZoneRow`s. */
  readonly children: ReactNode;
};

/**
 * The last section of a settings screen, holding what is hard to undo:
 * a red heading over one red-bordered box, a row per action. The danger
 * foreground holds AA on every surface in both themes (tokens.css test), so
 * the border drawn in it clears the 3:1 a component edge needs. Every zone
 * looks the same: `className` on the section places it on the page (scroll
 * and focus targets, a section-sized gap above it), and the heading, gap and
 * box sit in a wrapper it cannot reach.
 */
export function DangerZone({
  title,
  titleAs: Heading = "h2",
  titleId,
  children,
  ...props
}: DangerZoneProps): JSX.Element {
  const ownId = useId();
  const headingId = titleId ?? ownId;
  return (
    <section data-slot="danger-zone" aria-labelledby={headingId} {...props}>
      {/* A page may zero the row padding so unframed rows sit on its edge;
          rows inside the red box need it back, as in SettingsSection. */}
      <div className="flex flex-col gap-3 [--werft-row-padding-x:var(--werft-space-4)]">
        <Heading
          id={headingId}
          className="m-0 font-medium text-body text-destructive leading-5"
        >
          {title}
        </Heading>
        <RowList variant="joined" className="border-destructive">
          {children}
        </RowList>
      </div>
    </section>
  );
}

/*
 * The row says what is done to what ("Delete team"); the button only says
 * what is done ("Delete") and is named after the row, so a screen reader
 * moving between buttons hears the target too. The button's word has to
 * appear unbroken in that name (label in name). The title is red and the
 * button filled red with white text, both AA in either theme (tokens.css
 * test); the description stays muted. It is a `SettingRow tone="danger"`,
 * so its button sits where every setting row's does.
 */
export type DangerZoneRowProps = (
  | {
      /** What the action does, naming its target: "Delete the GitHub App". */
      readonly title: string;
      /** The button's name, when the row title is not the right one. */
      readonly actionName?: string | undefined;
    }
  | {
      readonly title: Exclude<ReactNode, string>;
      /** A title that is not plain text cannot name the button. */
      readonly actionName: string;
    }
) & {
  /** One line on what is lost. */
  readonly description: ReactNode;
  /** The button's word alone: "Delete". */
  readonly actionLabel: string;
  /** Opens the confirmation; the row never acts by itself. */
  readonly onAction: () => void;
  readonly disabled?: boolean | undefined;
  /** Why the action is unavailable; the button is disabled and says so. */
  readonly reason?: ReactNode | undefined;
  readonly actionRef?: Ref<HTMLButtonElement> | undefined;
};

export function DangerZoneRow({
  title,
  description,
  actionLabel,
  actionName,
  onAction,
  disabled = false,
  reason,
  actionRef,
}: DangerZoneRowProps): JSX.Element {
  const withheld = reason !== undefined && reason !== null;
  const name = actionName ?? (typeof title === "string" ? title : actionLabel);
  // Right ends align down the zone; each width follows its label.
  const button = (
    <RowAction
      ref={actionRef}
      variant="destructive"
      aria-label={name}
      disabled={disabled || withheld}
      onClick={onAction}
    >
      {actionLabel}
    </RowAction>
  );
  return (
    <SettingRow
      data-slot="danger-zone-row"
      tone="danger"
      title={title}
      description={description}
      actions={
        withheld ? (
          <DisabledReason reason={reason} label={name}>
            {button}
          </DisabledReason>
        ) : (
          button
        )
      }
    />
  );
}
