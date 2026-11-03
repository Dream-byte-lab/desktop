import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { sidebarNavItems } from "@/features/navigation/data/navigation";
import { useTranslation } from "@/languages";
import { Tooltip } from "@/shared/ui";
import { cn } from "@/shared/lib";
import { useOfflineModeStore } from "@/features/connectivity";

export interface SidebarNavItemsProps {
  searchOpen: boolean;
  onSearchToggle: () => void;
}

export function SidebarNavItems({
  searchOpen,
  onSearchToggle,
}: SidebarNavItemsProps) {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const offline = useOfflineModeStore((state) => state.offline);

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  const isRouteActive = (href: string) => {
    if (pendingHref) return href === pendingHref;
    if (href === "/") {
      return pathname === "/" || pathname === "/home";
    }
    return pathname === href || pathname?.startsWith(`${href}/`);
  };

  const isItemActive = (id: string, href?: string) => {
    if (id === "search") {
      return searchOpen;
    }
    return href ? isRouteActive(href) : false;
  };

  return (
    <>
      {sidebarNavItems
        .filter((item) => item.id !== "settings")
        .filter((item) => !offline || item.id === "library")
        .map((item) => {
          const active = isItemActive(item.id, item.href);
          const Icon = item.Icon;
          const tooltipLabel = t(`common.sidebar.${item.id}`) || item.label;

          if (item.id === "search") {
            return (
              <Tooltip
                key={item.id}
                content={tooltipLabel}
                side="right"
                sideOffset={12}
              >
                <button
                  type="button"
                  aria-pressed={searchOpen}
                  onClick={onSearchToggle}
                  className={cn(
                    "group relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-full border-0 p-0 cursor-pointer active:scale-[0.96] transition-all duration-150 motion-reduce:transition-none",
                    active ? "bg-accent-primary/15" : "hover:bg-fill",
                  )}
                >
                  <Icon
                    size={26}
                    className={cn(
                      "relative z-10 transition-opacity duration-150 ease-out",
                      active
                        ? "text-accent-primary opacity-100"
                        : "text-text-primary opacity-55 group-hover:opacity-90",
                    )}
                  />
                </button>
              </Tooltip>
            );
          }

          return (
            <Tooltip
              key={item.id}
              content={tooltipLabel}
              side="right"
              sideOffset={12}
            >
              <Link
                key={item.id}
                to={item.href!}
                aria-current={active ? "page" : undefined}
                onPointerDown={(event) => {
                  if (event.button === 0) setPendingHref(item.href!);
                }}
                onPointerLeave={(event) => {
                  if (event.buttons & 1) setPendingHref(null);
                }}
                onPointerCancel={() => setPendingHref(null)}
                className={cn(
                  "group relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-full cursor-pointer active:scale-[0.96] transition-all duration-150 motion-reduce:transition-none",
                  active ? "bg-accent-primary/15" : "hover:bg-fill",
                )}
              >
                <Icon
                  size={26}
                  className={cn(
                    "relative z-10",
                    active
                      ? "text-accent-primary opacity-100"
                      : "text-text-primary opacity-55 transition-opacity duration-150 ease-out group-hover:opacity-90",
                  )}
                />
              </Link>
            </Tooltip>
          );
        })}
    </>
  );
}
