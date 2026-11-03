import { useTranslation } from "@/languages";
import {
  usePlayerBarSizeStore,
  type PlayerBarPinnedSize,
} from "@/features/player/ui/playerBarSize";
import { SettingRow, SegmentedControl } from "../controls";

// The Settings surface for the playback pill's size (Settings >
// Appearance, after Theme). It only writes the player-bar store:
// `pinned` in that store is what MiniPlayer reads through
// `resolveBarExpanded`, so Auto is the store's unpinned `null`,
// Standard pins "standard", and Expanded pins "expanded". The
// SegmentedControl works in plain string choices, so Auto is its
// "auto" choice mapped to and from the store's `null`.

type PlaybackBarChoice = "auto" | PlayerBarPinnedSize;

function choiceForPinned(
  pinned: PlayerBarPinnedSize | null,
): PlaybackBarChoice {
  return pinned ?? "auto";
}

function pinnedForChoice(
  choice: PlaybackBarChoice,
): PlayerBarPinnedSize | null {
  return choice === "auto" ? null : choice;
}

export function PlaybackBarSetting({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const pinned = usePlayerBarSizeStore((state) => state.pinned);
  const setPinned = usePlayerBarSizeStore((state) => state.setPinned);

  return (
    <SettingRow
      title={t("settings.playback_bar.title")}
      description={t("settings.playback_bar.description")}
      titleKey="settings.playback_bar.title"
      descKey="settings.playback_bar.description"
      searchQuery={searchQuery}
      control={
        <SegmentedControl<PlaybackBarChoice>
          ariaLabel={t("settings.playback_bar.title")}
          value={choiceForPinned(pinned)}
          onChange={(choice) => setPinned(pinnedForChoice(choice))}
          options={[
            { value: "auto", label: t("settings.playback_bar.auto") },
            { value: "standard", label: t("settings.playback_bar.standard") },
            { value: "expanded", label: t("settings.playback_bar.expanded") },
          ]}
        />
      }
    />
  );
}
