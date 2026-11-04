import { useTranslation } from "@/languages";
import {
  useLyricsDisplayStore,
  type LyricsTextAlign,
} from "@/features/player/store/lyricsDisplayStore";
import { ToggleSwitch } from "@/shared/ui";
import { SettingBlock, SegmentedControl } from "../controls";

// The Settings surface for the lyrics view's accessibility
// preferences (Settings > Playback, inside the lyrics rows after
// the LRCLIB fallback). It binds the SAME store the full-screen
// lyrics view's accessibility panel binds
// (`useLyricsDisplayStore`), so a change made here is the surface's
// change and vice versa — there is no sync step. The five controls
// mirror the panel's five: Gaussian blur, bigger text, highlight
// lyrics, romanization, and text alignment.

/**
 * Label for a string whose locale key is owed at integration: the
 * translator returns the key itself for a missing entry, so fall
 * back to the English string until the key lands (same pattern as
 * the lyrics panel's `lyricsLabel`).
 */
function settingsLabel(
  t: (key: string) => string,
  key: string,
  fallback: string,
): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function ControlLine({
  label,
  control,
}: {
  label: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[40px] items-center justify-between gap-[14px]">
      <span className="text-pretty text-text-primary text-label font-[500] leading-[18px] tracking-[-0.005em]">
        {label}
      </span>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function LyricsDisplaySetting({
  searchQuery,
}: {
  searchQuery?: string;
}) {
  const { t } = useTranslation();
  const gaussianBlur = useLyricsDisplayStore((state) => state.gaussianBlur);
  const setGaussianBlur = useLyricsDisplayStore(
    (state) => state.setGaussianBlur,
  );
  const biggerText = useLyricsDisplayStore((state) => state.biggerText);
  const setBiggerText = useLyricsDisplayStore((state) => state.setBiggerText);
  const highlightLyrics = useLyricsDisplayStore(
    (state) => state.highlightLyrics,
  );
  const setHighlightLyrics = useLyricsDisplayStore(
    (state) => state.setHighlightLyrics,
  );
  const romanization = useLyricsDisplayStore((state) => state.romanization);
  const setRomanization = useLyricsDisplayStore(
    (state) => state.setRomanization,
  );
  const textAlign = useLyricsDisplayStore((state) => state.textAlign);
  const setTextAlign = useLyricsDisplayStore((state) => state.setTextAlign);

  return (
    <SettingBlock
      title={t("settings.playback.lyrics_display.title")}
      titleKey="settings.playback.lyrics_display.title"
      searchQuery={searchQuery}
    >
      <div className="flex flex-col">
        <ControlLine
          label={t("settings.playback.lyrics_display.gaussian_blur")}
          control={
            <ToggleSwitch checked={gaussianBlur} onChange={setGaussianBlur} />
          }
        />
        <ControlLine
          label={t("settings.playback.lyrics_display.bigger_text")}
          control={
            <ToggleSwitch checked={biggerText} onChange={setBiggerText} />
          }
        />
        <ControlLine
          label={t("settings.playback.lyrics_display.highlight_lyrics")}
          control={
            <ToggleSwitch
              checked={highlightLyrics}
              onChange={setHighlightLyrics}
            />
          }
        />
        <ControlLine
          label={settingsLabel(
            t,
            "settings.playback.lyrics_display.romanization",
            "Romanization",
          )}
          control={
            <ToggleSwitch checked={romanization} onChange={setRomanization} />
          }
        />
        <ControlLine
          label={t("settings.playback.lyrics_display.text_align")}
          control={
            <SegmentedControl<LyricsTextAlign>
              ariaLabel={t("settings.playback.lyrics_display.text_align")}
              value={textAlign}
              onChange={setTextAlign}
              options={[
                {
                  value: "left",
                  label: t("settings.playback.lyrics_display.align_left"),
                },
                {
                  value: "center",
                  label: t("settings.playback.lyrics_display.align_center"),
                },
              ]}
            />
          }
        />
      </div>
    </SettingBlock>
  );
}
