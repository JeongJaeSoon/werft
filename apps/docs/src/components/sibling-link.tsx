import type { ReactNode } from "react";
import { withBasePath } from "@/lib/shared";

/** A link to a site Next does not build (/api) on the same Pages origin. */
export function SiblingLink({
  href,
  children,
}: {
  href: `/${string}`;
  children: ReactNode;
}) {
  return <a href={withBasePath(href)}>{children}</a>;
}
