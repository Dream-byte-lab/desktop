import { useAuthStore } from "@/features/auth";
import { useModalStore } from "@/features/library";
import { useTranslation } from "@/languages";
import { Tooltip, UserAvatar } from "@/shared/ui";
import { cn } from "@/shared/lib";

export interface SidebarAccountStatusProps {
  expanded?: boolean;
}

export function SidebarAccountStatus({
  expanded = false,
}: SidebarAccountStatusProps) {
  const { t } = useTranslation();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const toggleSettings = useModalStore((state) => state.toggleSettings);

  const displayName =
    user?.displayName ||
    user?.username ||
    (status === "authenticated" ? "Account" : "Guest");
  const subline =
    status === "authenticated"
      ? t("common.sidebar.signed_in") || "Signed in"
      : t("common.sidebar.guest") || "Guest";

  if (expanded) {
    return (
      <button
        type="button"
        onClick={toggleSettings}
        className={cn(
          "group relative flex h-[38px] w-full items-center gap-[10px] rounded-full px-[11px] border-0 bg-transparent text-left cursor-pointer active:scale-[0.98] transition-all duration-150 motion-reduce:transition-none hover:bg-fill",
        )}
      >
        <span className="relative z-10 shrink-0">
          <UserAvatar user={user} size={26} />
        </span>
        <span className="relative z-10 flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-text-primary leading-tight">
            {displayName}
          </span>
          <span className="truncate text-[11px] text-text-tertiary leading-tight">
            {subline}
          </span>
        </span>
      </button>
    );
  }

  return (
    <Tooltip content={displayName} side="right" sideOffset={12}>
      <button
        type="button"
        onClick={toggleSettings}
        aria-label={displayName}
        className={cn(
          "group relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-full border-0 p-0 cursor-pointer active:scale-[0.96] transition-all duration-150 motion-reduce:transition-none hover:bg-fill",
        )}
      >
        <UserAvatar user={user} size={26} />
      </button>
    </Tooltip>
  );
}
