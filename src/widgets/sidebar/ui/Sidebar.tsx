import { memo } from "react";
import { ListCollapseFill, ListExpansionFill } from "@mingcute/react";
import { SidebarNavItems } from "./SidebarNavItems";
import { SidebarSettingsButton } from "./SidebarSettingsButton";
import { SidebarAccountStatus } from "./SidebarAccountStatus";
import { useSidebarStore } from "../model/useSidebarStore";
import { useTranslation } from "@/languages";
import { Tooltip } from "@/shared/ui";
import { cn } from "@/shared/lib";

export interface SidebarProps {
  searchOpen: boolean;
  onSearchToggle: () => void;
}

function Sidebar({ searchOpen, onSearchToggle }: SidebarProps) {
  const collapsed = useSidebarStore((state) => state.collapsed);
  const toggle = useSidebarStore((state) => state.toggle);
  const { t } = useTranslation();

  const collapseLabel = collapsed
    ? t("common.sidebar.expand") || "Expand"
    : t("common.sidebar.collapse") || "Collapse";
  const ToggleIcon = collapsed ? ListExpansionFill : ListCollapseFill;

  return (
    <div
      className={cn(
        "h-full w-full rounded-panel flex flex-col overflow-hidden border border-rim bg-bg-glass backdrop-blur-[16px] backdrop-saturate-150 shadow-[0_8px_28px_rgba(36,27,77,0.14)] dark:shadow-[0_8px_28px_rgba(8,4,28,0.35)]",
      )}
    >
      <nav className="relative flex-1 min-h-0 overflow-y-auto flex flex-col">
        <SidebarNavItems
          searchOpen={searchOpen}
          onSearchToggle={onSearchToggle}
        />
      </nav>

      <div
        className={cn(
          "shrink-0",
          collapsed
            ? "pt-[16px] pb-[16px] flex flex-col justify-center items-center gap-[20px]"
            : "pt-[12px] pb-[12px]",
        )}
      >
        {collapsed ? (
          <>
            <SidebarAccountStatus expanded={false} />
            <SidebarSettingsButton expanded={false} />
            <Tooltip content={collapseLabel} side="right" sideOffset={12}>
              <button
                type="button"
                aria-label={collapseLabel}
                onClick={toggle}
                className={cn(
                  "group relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-full border-0 p-0 cursor-pointer active:scale-[0.96] transition-all duration-150 motion-reduce:transition-none hover:bg-fill",
                )}
              >
                <ToggleIcon
                  size={26}
                  className="relative z-10 text-text-primary opacity-55 transition-opacity duration-150 ease-out group-hover:opacity-90"
                />
              </button>
            </Tooltip>
          </>
        ) : (
          <div className="mx-[10px] flex flex-col gap-[2px]">
            <SidebarAccountStatus expanded />
            <SidebarSettingsButton expanded />
            <button
              type="button"
              onClick={toggle}
              className={cn(
                "group relative flex h-[38px] w-full items-center gap-[10px] rounded-full px-[11px] border-0 bg-transparent text-left cursor-pointer active:scale-[0.98] transition-all duration-150 motion-reduce:transition-none hover:bg-fill",
              )}
            >
              <ToggleIcon
                size={22}
                className="relative z-10 shrink-0 text-text-primary opacity-55 transition-opacity duration-150 ease-out group-hover:opacity-90"
              />
              <span className="relative z-10 truncate text-[13px] font-medium text-text-primary">
                {collapseLabel}
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(Sidebar);
