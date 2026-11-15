import {
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
} from "@werft-ai/ui";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { SECTIONS } from "../workspace-settings.tsx";
import { useCurrentSection } from "./use-current-section.ts";
import { usePageFits } from "./use-page-fits.ts";

export type SectionNavGroup = {
  /** Left out for the first group. */
  readonly label?: string;
  readonly items: readonly { readonly id: string; readonly label: string }[];
};

/**
 * An integration tab's page (GitHub, Slack) with the list of its sections
 * beside it: a link jumps to its section and marks it current, and the list
 * hides on a wide window while the whole page fits.
 */
export function SectionNavLayout({
  label,
  groups,
  children,
}: {
  readonly label: string;
  readonly groups: readonly SectionNavGroup[];
  readonly children: ReactNode;
}) {
  const items = groups.flatMap((group) => group.items);
  const [current, setCurrent] = useCurrentSection(items.map((item) => item.id));
  const jumped = useRef<string>(undefined);
  // With nothing to scroll to, the wide list only takes room from the page.
  const [fits, watchPage] = usePageFits();
  // The list also hides when the window widens past lg while the page fits.
  useLayoutEffect(() => {
    if (!fits) return;
    const leave = () => {
      const nav = document.activeElement?.closest("[data-slot=side-nav]");
      if (!nav || nav.getClientRects().length > 0) return;
      document.getElementById(current ?? "")?.focus({ preventScroll: true });
    };
    leave();
    window.addEventListener("resize", leave);
    return () => window.removeEventListener("resize", leave);
  }, [fits, current]);
  const link = (item: SectionNavGroup["items"][number]) => (
    <SideNavLink
      key={item.id}
      href={`#${item.id}`}
      current={current === item.id ? "location" : undefined}
      onClick={(event) => {
        // Stay off the URL hash: the router owns the location.
        event.preventDefault();
        const target = document.getElementById(item.id);
        target?.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
        target?.focus({ preventScroll: true });
        jumped.current = item.id;
        setCurrent(item.id);
      }}
    >
      {item.label}
    </SideNavLink>
  );
  return (
    <SideNavLayout
      nav={
        <SideNav
          aria-label={label}
          className={fits ? "lg:hidden" : undefined}
          current={items.find((item) => item.id === current)?.label}
          // Folding the list sends focus to its button; take it back to the
          // section the link jumped to.
          onPick={() =>
            document
              .getElementById(jumped.current ?? "")
              ?.focus({ preventScroll: true })
          }
        >
          {groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <SideNavGroup key={group.label ?? ""} label={group.label}>
                {group.items.map(link)}
              </SideNavGroup>
            ))}
        </SideNav>
      }
    >
      <div ref={watchPage} className={SECTIONS}>
        {children}
      </div>
    </SideNavLayout>
  );
}
