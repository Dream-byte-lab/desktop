import { CheckLine, CloseLine, WheelchairLine } from "@mingcute/react";
import { cn } from "@/shared/lib";
import { useTranslation } from "@/languages";
import {
  useLyricsDisplayStore,
  type LyricsTextAlign,
} from "../store/lyricsDisplayStore";

/**
 * Labels for strings whose locale keys are owed at integration: the
 * translator returns the key itself for a missing entry, so fall
 * back to the English string until the key lands (and name every
 * key in the build report).
 */
export function lyricsLabel(
  t: (key: string) => string,
  key: string,
  fallback: string,
): string {
  const value = t(key);
  return value === key ? fallback : value;
}

interface DisplayToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Reference 27's pill toggle: light track, knob carrying a check. */
function DisplayToggle({ label, checked, onChange }: DisplayToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="flex w-full cursor-pointer items-center gap-3 border-none bg-transparent py-1 text-left select-none"
    >
      <span
        aria-hidden
        className={cn(
          "relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors duration-200",
          checked ? "bg-white/85" : "bg-white/15",
        )}
      >
        <span
          className={cn(
            "absolute top-1/2 flex h-[22px] w-[22px] -translate-y-1/2 items-center justify-center rounded-full transition-all duration-200",
            checked
              ? "left-[22px] bg-white text-black shadow"
              : "left-[2px] bg-white/45 text-transparent",
          )}
        >
          <CheckLine size={13} strokeWidth={3} />
        </span>
      </span>
      <span className="text-sm text-white/90">{label}</span>
    </button>
  );
}

interface LyricsAccessibilityPanelProps {
  onClose: () => void;
}

/**
 * Reference 27's accessibility overlay: the lyrics view's own
 * controls, living on the surface they affect. Every control writes
 * the shared lyrics-display store — the same store Settings mirrors
 * as the global defaults — so a change here and a change there are
 * one fact, applied live.
 */
export function LyricsAccessibilityPanel({
  onClose,
}: LyricsAccessibilityPanelProps) {
  const { t } = useTranslation();
  const gaussianBlur = useLyricsDisplayStore((s) => s.gaussianBlur);
  const biggerText = useLyricsDisplayStore((s) => s.biggerText);
  const highlightLyrics = useLyricsDisplayStore((s) => s.highlightLyrics);
  const textAlign = useLyricsDisplayStore((s) => s.textAlign);
  const setGaussianBlur = useLyricsDisplayStore((s) => s.setGaussianBlur);
  const setBiggerText = useLyricsDisplayStore((s) => s.setBiggerText);
  const setHighlightLyrics = useLyricsDisplayStore((s) => s.setHighlightLyrics);
  const setTextAlign = useLyricsDisplayStore((s) => s.setTextAlign);

  const title = lyricsLabel(
    t,
    "player.lyrics_display.accessibility",
    "Accessibility",
  );

  const alignOptions: { value: LyricsTextAlign; key: string; text: string }[] =
    [
      {
        value: "left",
        key: "player.lyrics_display.align_left",
        text: "Left",
      },
      {
        value: "center",
        key: "player.lyrics_display.align_center",
        text: "Center",
      },
    ];

  return (
    <section
      aria-label={title}
      className="w-[248px] rounded-[20px] border border-white/10 bg-black/60 p-4 shadow-2xl backdrop-blur-xl"
    >
      <header className="mb-2 flex items-center gap-2">
        <WheelchairLine size={19} className="text-white/90" />
        <h2 className="flex-1 text-[15px] font-semibold text-white">{title}</h2>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="inline-flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-white/60 transition-colors select-none hover:bg-white/10 hover:text-white active:scale-95"
        >
          <CloseLine size={15} />
        </button>
      </header>

      <div className="flex flex-col gap-1.5">
        <DisplayToggle
          label={lyricsLabel(
            t,
            "player.lyrics_display.gaussian_blur",
            "Gaussian blur",
          )}
          checked={gaussianBlur}
          onChange={setGaussianBlur}
        />
        <DisplayToggle
          label={lyricsLabel(
            t,
            "player.lyrics_display.bigger_text",
            "Bigger text",
          )}
          checked={biggerText}
          onChange={setBiggerText}
        />
        <DisplayToggle
          label={lyricsLabel(
            t,
            "player.lyrics_display.highlight_lyrics",
            "Highlight lyrics",
          )}
          checked={highlightLyrics}
          onChange={setHighlightLyrics}
        />
      </div>

      <p className="mt-3 mb-1.5 text-[13px] text-white/55">
        {lyricsLabel(t, "player.lyrics_display.text_align", "Text Align")}
      </p>
      <div
        role="radiogroup"
        aria-label={lyricsLabel(
          t,
          "player.lyrics_display.text_align",
          "Text Align",
        )}
        className="flex rounded-full bg-white/10 p-1"
      >
        {alignOptions.map((option) => {
          const active = textAlign === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setTextAlign(option.value)}
              className={cn(
                "flex-1 cursor-pointer rounded-full border-none py-1 text-sm transition-colors select-none",
                active
                  ? "bg-white font-semibold text-black"
                  : "bg-transparent text-white/60 hover:text-white",
              )}
            >
              {lyricsLabel(t, option.key, option.text)}
            </button>
          );
        })}
      </div>
    </section>
  );
}
