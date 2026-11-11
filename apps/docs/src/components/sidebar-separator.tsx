"use client";
import type * as PageTree from "fumadocs-core/page-tree";
import { BookOpen, Server } from "lucide-react";
import { SECTION_DEPLOY, SECTION_USE } from "@/lib/sidebar-sections";

const icons = { [SECTION_USE]: BookOpen, [SECTION_DEPLOY]: Server };

/** A sidebar section heading: the guide and the self-hosting halves. */
export function SidebarSectionSeparator({
  item,
}: {
  item: PageTree.Separator;
}) {
  const Icon = item.$id ? icons[item.$id as keyof typeof icons] : undefined;
  // Only the second section gets a rule above it; `first:` does not apply
  // because the sidebar renders other elements before the first heading.
  const ruled = item.$id === SECTION_DEPLOY;
  return (
    <p
      className={`mb-2 flex items-center gap-2 px-2 font-semibold text-fd-foreground text-sm ${ruled ? "mt-6 border-fd-border border-t pt-5" : "mt-2"}`}
    >
      {Icon && <Icon aria-hidden className="size-4 text-fd-primary" />}
      {item.name}
    </p>
  );
}
