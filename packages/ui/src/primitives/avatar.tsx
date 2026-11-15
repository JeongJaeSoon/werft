import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

/** Mockup v4's `.avatar`: initials on a fill, no image. */
export const avatarVariants = cva(
  "inline-grid flex-none select-none place-items-center font-medium",
  {
    variants: {
      size: {
        default: "size-6 text-2xs",
        lg: "size-8 text-caption",
        // Beside a 20px line over a 16px one, spanning both; pinned to the
        // first line when the text wraps past two.
        "two-line": "size-(--werft-size-tile-two-line) self-start text-control",
      },
      shape: {
        circle: "rounded-full",
        square: "rounded-control",
      },
      tone: {
        default: "bg-active text-muted-foreground",
        1: "bg-(color:--werft-avatar-1-bg) text-(color:--werft-avatar-1-fg)",
        2: "bg-(color:--werft-avatar-2-bg) text-(color:--werft-avatar-2-fg)",
        3: "bg-(color:--werft-avatar-3-bg) text-(color:--werft-avatar-3-fg)",
        4: "bg-(color:--werft-avatar-4-bg) text-(color:--werft-avatar-4-fg)",
      },
    },
    defaultVariants: { size: "default", shape: "circle", tone: "default" },
  },
);

export type AvatarProps = Omit<ComponentProps<"span">, "children"> &
  VariantProps<typeof avatarVariants> & {
    /** One or two letters; the name itself goes in `label` or beside it. */
    readonly initials: string;
    /**
     * The person or agent's name, for an avatar shown without its name
     * beside it. Left out, the avatar is decoration and screen readers skip
     * it, so the visible name is not read twice.
     */
    readonly label?: string | undefined;
  };

export function Avatar({
  className,
  size,
  shape,
  tone,
  initials,
  label,
  ...props
}: AvatarProps): JSX.Element {
  const named = label !== undefined && label !== "";
  return (
    <span
      data-slot="avatar"
      className={cn(avatarVariants({ size, shape, tone }), className)}
      {...props}
      // After the rest, so a stray role or aria-* cannot undo the rule.
      {...(named
        ? {
            role: "img",
            "aria-label": label,
            "aria-labelledby": undefined,
            "aria-hidden": undefined,
          }
        : {
            role: undefined,
            "aria-label": undefined,
            "aria-labelledby": undefined,
            "aria-hidden": true,
          })}
    >
      {initials}
    </span>
  );
}

/** The same name gets the same colour on every screen and visit. */
export function avatarTone(key: string): 1 | 2 | 3 | 4 {
  let sum = 0;
  for (const char of key) sum += char.codePointAt(0) ?? 0;
  return ((sum % 4) + 1) as 1 | 2 | 3 | 4;
}

/**
 * Up to two letters: the first of the first two words, or the first two.
 * Words with no letter or digit (brackets, emoji) are skipped; a name with
 * none at all keeps its leading symbols rather than an empty mark.
 */
export function avatarInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const pick = (only: (char: string) => boolean) => {
    const kept = words
      .map((word) => [...word].filter(only))
      .filter((chars) => chars.length > 0);
    const letters =
      words.length > 1
        ? kept.slice(0, 2).map((chars) => chars[0] ?? "")
        : (kept[0] ?? []).slice(0, 2);
    return letters.join("").toUpperCase();
  };
  return pick((char) => /[\p{L}\p{N}]/u.test(char)) || pick(() => true);
}
