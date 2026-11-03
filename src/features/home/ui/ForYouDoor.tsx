import { memo } from "react";
import { CompassFill, RightLine } from "@mingcute/react";
import { useStableNavigate } from "@/shared/hooks/useStableNavigate";
import { useTranslation } from "@/languages";

export interface ForYouDoorProps {
  marginTop?: string;
}

// The Home door into the For You feed: a plain full-width row —
// icon chip, two lines, chevron — in the matte content register.
function ForYouDoor({ marginTop = "mt-[22px]" }: ForYouDoorProps) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();

  return (
    <div className={`${marginTop} px-3`}>
      <button
        type="button"
        onClick={() => navigate("/for-you")}
        className="flex w-full cursor-pointer items-center gap-[12px] rounded-item p-[8px] text-left transition-colors duration-150 ease-out hover:bg-border-alpha-14"
      >
        <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[12px] bg-border-alpha-14 text-text-secondary">
          <CompassFill size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-label font-semibold text-text-primary">
            {t("forYou.doorTitle")}
          </span>
          <span className="truncate text-body text-text-tertiary">
            {t("forYou.doorSubtitle")}
          </span>
        </span>
        <span className="flex shrink-0 items-center justify-center text-text-tertiary">
          <RightLine size={18} />
        </span>
      </button>
    </div>
  );
}

export default memo(ForYouDoor);
