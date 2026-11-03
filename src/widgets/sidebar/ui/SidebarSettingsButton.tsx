import { sidebarNavItems } from "@/features/navigation/data/navigation";
import { useTranslation } from "@/languages";
import { useModalStore } from "@/features/library";
import { Tooltip } from "@/shared/ui";
import { cn } from "@/shared/lib";

export interface SidebarSettingsButtonProps {
  expanded?: boolean;
}

export function SidebarSettingsButton({
  expanded = false,
}: SidebarSettingsButtonProps) {
  const { t } = useTranslation();
  const settingsOpen = useModalStore((state) => state.settingsOpen);
  const toggleSettings = useModalStore((state) => state.toggleSettings);

  const settingsItem = sidebarNavItems.find((item) => item.id === "settings");
  if (!settingsItem) return null;

  const Icon = settingsItem.Icon;
  const tooltipLabel = t("common.sidebar.settings") || settingsItem.label;

  if (expanded) {
    return (
      <button
        type="button"
        aria-pressed={settingsOpen}
        onClick={toggleSettings}
        className={cn(
          "group relative flex h-[38px] w-full items-center gap-[10px] rounded-full px-[11px] border-0 bg-transparent text-left cursor-pointer active:scale-[0.98] transition-all duration-150 motion-reduce:transition-none",
          settingsOpen ? "bg-accent-primary/15" : "hover:bg-fill",
        )}
      >
        <Icon
          size={22}
          className={cn(
            "relative z-10 shrink-0 transition-opacity duration-150 ease-out",
            settingsOpen
              ? "text-accent-primary opacity-100"
              : "text-text-primary opacity-55 group-hover:opacity-90",
          )}
        />
        <span
          className={cn(
            "relative z-10 truncate text-[13px] font-medium",
            settingsOpen ? "text-accent-primary" : "text-text-primary",
          )}
        >
          {tooltipLabel}
        </span>
      </button>
    );
  }

  return (
    <Tooltip content={tooltipLabel} side="right" sideOffset={12}>
      <button
        type="button"
        aria-pressed={settingsOpen}
        onClick={toggleSettings}
        className={cn(
          "group relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-full border-0 p-0 cursor-pointer active:scale-[0.96] transition-all duration-150 motion-reduce:transition-none",
          settingsOpen ? "bg-accent-primary/15" : "hover:bg-fill",
        )}
      >
        <Icon
          size={26}
          className={cn(
            "relative z-10 transition-opacity duration-150 ease-out",
            settingsOpen
              ? "text-accent-primary opacity-100"
              : "text-text-primary opacity-55 group-hover:opacity-90",
          )}
        />
      </button>
    </Tooltip>
  );
}
