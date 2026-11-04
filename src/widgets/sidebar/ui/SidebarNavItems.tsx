import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import {
  sidebarSections,
  getSidebarItem,
  type NavItem,
} from "@/features/navigation/data/navigation";
import { useTranslation } from "@/languages";
import { Tooltip } from "@/shared/ui";
import { cn } from "@/shared/lib";
import { useOfflineModeStore } from "@/features/connectivity";
import { usePinnedPlaylistIds } from "@/features/library/lib/playlistIdentity";
import { useSidebarStore } from "../model/useSidebarStore";

export function SidebarNavItems() {
  const { pathname, search } = useLocation();
  const { t } = useTranslation();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const offline = useOfflineModeStore((state) => state.offline);
  const collapsed = useSidebarStore((state) => state.collapsed);
  const pinnedIds = usePinnedPlaylistIds();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  const isRouteActive = (item: NavItem) => {
    const href = item.href;
    if (!href) return false;
    if (pendingHref) return href === pendingHref;
    switch (item.id) {
      case "home":
        return pathname === "/" || pathname === "/home";
      case "your_space":
        // Exact match only: /space/history belongs to the
        // Listening History entry below it, not to this parent.
        return pathname === "/space";
      case "favorites":
        return (
          pathname === "/library/saved" ||
          pathname?.startsWith("/library/saved/")
        );
      case "downloads":
        return (
          pathname === "/library/cached" ||
          pathname?.startsWith("/library/cached/")
        );
      case "library": {
        if (
          pathname === "/library/saved" ||
          pathname?.startsWith("/library/saved/") ||
          pathname === "/library/cached" ||
          pathname?.startsWith("/library/cached/")
        ) {
          return false;
        }
        // A pinned playlist's own sidebar row (the Pinned section)
        // is the more specific entry: Library yields to it, exactly
        // as it yields to Favorites and Downloads above.
        if (pathname === "/library/playlist") {
          const openId = new URLSearchParams(search).get("id");
          if (openId && pinnedIds.includes(openId)) return false;
        }
        return pathname === href || pathname?.startsWith(`${href}/`);
      }
      default:
        return pathname === href || pathname?.startsWith(`${href}/`);
    }
  };

  const isItemActive = (item: NavItem) => isRouteActive(item);

  const renderPill = (active: boolean): ReactNode => {
    if (!active) return null;
    if (reduceMotion) {
      return (
        <span className="absolute inset-0 rounded-full bg-accent-primary/15" />
      );
    }
    return (
      <motion.span
        layoutId="sidebar-active-pill"
        className="absolute inset-0 rounded-full bg-accent-primary/15"
        transition={{ duration: 0.21, ease: [0.22, 1, 0.36, 1] }}
      />
    );
  };

  const renderItem = (item: NavItem) => {
    const active = isItemActive(item);
    const Icon = item.Icon;
    const label = t(`common.sidebar.${item.id}`) || item.label;

    if (!collapsed) {
      // Expanded row
      const rowClass = cn(
        "group relative flex h-[38px] w-full items-center gap-[10px] rounded-full px-[11px] cursor-pointer active:scale-[0.98] transition-all duration-150 motion-reduce:transition-none",
        !active && "hover:bg-fill",
      );
      const iconClass = cn(
        "relative z-10 shrink-0 transition-opacity duration-150 ease-out",
        active
          ? "text-accent-primary opacity-100"
          : "text-text-primary opacity-55 group-hover:opacity-90",
      );
      const labelEl = (
        <span
          className={cn(
            "relative z-10 truncate text-[13px] font-medium",
            active ? "text-accent-primary" : "text-text-primary",
          )}
        >
          {label}
        </span>
      );

      return (
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
          className={rowClass}
        >
          {renderPill(active)}
          <Icon size={22} className={iconClass} />
          {labelEl}
        </Link>
      );
    }

    // Rail (collapsed) capsule — today's rendering
    return (
      <Tooltip key={item.id} content={label} side="right" sideOffset={12}>
        <Link
          to={item.href!}
          aria-current={active ? "page" : undefined}
          aria-label={label}
          onPointerDown={(event) => {
            if (event.button === 0) setPendingHref(item.href!);
          }}
          onPointerLeave={(event) => {
            if (event.buttons & 1) setPendingHref(null);
          }}
          onPointerCancel={() => setPendingHref(null)}
          className={cn(
            "group relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-full cursor-pointer active:scale-[0.96] transition-all duration-150 motion-reduce:transition-none",
            !active && "hover:bg-fill",
          )}
        >
          {renderPill(active)}
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
  };

  const visibleSections = sidebarSections
    .map((section) => {
      const items = section.itemIds
        .map((id) => getSidebarItem(id))
        .filter((item): item is NavItem => Boolean(item))
        .filter((item) => !offline || item.id === "library");
      return { section, items };
    })
    .filter(({ items }) => items.length > 0);

  if (!collapsed) {
    return (
      <div className="flex flex-col">
        {visibleSections.map(({ section, items }) => (
          <div key={section.id}>
            <div className="px-[21px] pt-[18px] pb-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
              {t(`common.sidebar.section_${section.id}`) || section.label}
            </div>
            <div className="mx-[10px] flex flex-col gap-[2px]">
              {items.map((item) => renderItem(item))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-[20px] pt-[16px]">
      {visibleSections.map(({ section, items }, index) => (
        <div key={section.id} className="flex flex-col items-center gap-[20px]">
          {index > 0 && (
            <div className="flex justify-center">
              <div className="w-[24px] border-t border-border-primary/50" />
            </div>
          )}
          {items.map((item) => renderItem(item))}
        </div>
      ))}
    </div>
  );
}
