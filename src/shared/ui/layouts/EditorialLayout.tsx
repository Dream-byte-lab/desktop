import type { ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface EditorialLayoutProps {
  hero?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Editorial layout family — featured pieces, rails, and sectioned
 * storytelling. Unity comes from the shared tokens, not from forcing
 * every page into the same card grid.
 *
 * Assigned screens: Home; Discover; Library overview; Listening
 * dashboard; Listening statistics.
 */
export default function EditorialLayout({
  hero,
  children,
  className,
}: EditorialLayoutProps) {
  return (
    <div className={cn("flex min-h-0 w-full flex-col gap-[32px]", className)}>
      {hero}
      {children}
    </div>
  );
}
