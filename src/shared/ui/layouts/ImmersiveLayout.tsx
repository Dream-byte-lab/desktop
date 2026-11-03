import type { ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface ImmersiveLayoutProps {
  children?: ReactNode;
  className?: string;
}

/**
 * Immersive layout family — the surface is the experience; content is
 * centred in a full-bleed, overflow-clipped stage.
 *
 * Assigned screens: Full Now Playing.
 */
export default function ImmersiveLayout({
  children,
  className,
}: ImmersiveLayoutProps) {
  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}
