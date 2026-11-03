import type { ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface ListLayoutProps {
  children?: ReactNode;
  divided?: boolean;
  className?: string;
}

/**
 * List layout family — rows and tables in the established row languages.
 *
 * Assigned screens: Songs; Recently Added; Downloads; Search songs
 * block; Charts; Radio station list; Listening History; album/playlist
 * track tables.
 */
export default function ListLayout({
  children,
  divided = false,
  className,
}: ListLayoutProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col",
        divided && "divide-y divide-border-primary/50",
        className,
      )}
    >
      {children}
    </div>
  );
}
