import type { ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface ProfileLayoutProps {
  header: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Profile layout family — banner/avatar header, actions, and tabs.
 *
 * Assigned screens: Artist profile; Genre profile; User profile.
 */
export default function ProfileLayout({
  header,
  children,
  className,
}: ProfileLayoutProps) {
  return (
    <div className={cn("flex w-full flex-col gap-[28px]", className)}>
      {header}
      {children}
    </div>
  );
}
