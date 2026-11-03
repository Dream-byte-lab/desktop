import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface SplitLayoutProps {
  main: ReactNode;
  aside: ReactNode;
  asideWidth?: number;
  className?: string;
}

/**
 * Split layout family — two coordinated columns/panels that stack on
 * small screens and sit side by side on large screens.
 *
 * Assigned screens: Expanded Now Playing; full-screen Lyrics; queue
 * page; Track details; Audio Control Center.
 */
export default function SplitLayout({
  main,
  aside,
  asideWidth = 340,
  className,
}: SplitLayoutProps) {
  return (
    <div
      className={cn("flex w-full flex-col gap-[24px] lg:flex-row", className)}
    >
      <div className="min-w-0 flex-1">{main}</div>
      <div
        className="w-full shrink-0 lg:w-(--split-aside-width)"
        style={
          {
            "--split-aside-width": `${asideWidth}px`,
          } as CSSProperties
        }
      >
        {aside}
      </div>
    </div>
  );
}
