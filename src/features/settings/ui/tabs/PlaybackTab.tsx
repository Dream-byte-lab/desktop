import { useState, useEffect } from "react";
import { useTranslation } from "@/languages";
import { usePlayerStore } from "@/features/player";
import { useLyricsStore } from "@/features/lyrics";
import { ToggleSwitch } from "@/shared/ui";
import { SettingRow, SettingSection, SegmentedControl } from "../controls";

export function PlaybackTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const autoplaySimilar = usePlayerStore((state) => state.autoplaySimilar);
  const setAutoplaySimilar = usePlayerStore(
    (state) => state.setAutoplaySimilar,
  );
  const trackDoubleClickBehavior = usePlayerStore(
    (state) => state.trackDoubleClickBehavior,
  );
  const setTrackDoubleClickBehavior = usePlayerStore(
    (state) => state.setTrackDoubleClickBehavior,
  );
  const defaultPlaybackContext = usePlayerStore(
    (state) => state.defaultPlaybackContext,
  );
  const setDefaultPlaybackContext = usePlayerStore(
    (state) => state.setDefaultPlaybackContext,
  );
  const lrclibFallbackEnabled = useLyricsStore(
    (state) => state.lrclibFallbackEnabled,
  );
  const setLrclibFallbackEnabled = useLyricsStore(
    (state) => state.setLrclibFallbackEnabled,
  );
  const pauseOnDeviceChange = usePlayerStore(
    (state) => state.pauseOnDeviceChange,
  );
  const setPauseOnDeviceChange = usePlayerStore(
    (state) => state.setPauseOnDeviceChange,
  );
  const keepPlayingWhenScreenOff = usePlayerStore(
    (state) => state.keepPlayingWhenScreenOff,
  );
  const setKeepPlayingWhenScreenOff = usePlayerStore(
    (state) => state.setKeepPlayingWhenScreenOff,
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <SettingSection>
      <SettingRow
        title={t("settings.autoplay_similar.title")}
        description={t("settings.autoplay_similar.description")}
        titleKey="settings.autoplay_similar.title"
        descKey="settings.autoplay_similar.description"
        searchQuery={searchQuery}
        control={
          <ToggleSwitch
            checked={autoplaySimilar}
            onChange={setAutoplaySimilar}
          />
        }
      />

      <SettingRow
        title={t("settings.track_double_click.title")}
        description={t("settings.track_double_click.description")}
        titleKey="settings.track_double_click.title"
        descKey="settings.track_double_click.description"
        searchQuery={searchQuery}
        control={
          mounted ? (
            <SegmentedControl
              ariaLabel={t("settings.track_double_click.title")}
              value={trackDoubleClickBehavior}
              onChange={setTrackDoubleClickBehavior}
              options={[
                {
                  value: "play",
                  label: t("settings.track_double_click.play"),
                },
                {
                  value: "queue",
                  label: t("settings.track_double_click.queue"),
                },
              ]}
            />
          ) : (
            <span />
          )
        }
      />

      <SettingRow
        title={t("settings.default_playback_context.title")}
        description={t("settings.default_playback_context.description")}
        explained
        titleKey="settings.default_playback_context.title"
        descKey="settings.default_playback_context.description"
        searchQuery={searchQuery}
        control={
          mounted ? (
            <SegmentedControl
              ariaLabel={t("settings.default_playback_context.title")}
              value={defaultPlaybackContext}
              onChange={setDefaultPlaybackContext}
              options={[
                {
                  value: "resume",
                  label: t("settings.default_playback_context.resume"),
                },
                {
                  value: "empty",
                  label: t("settings.default_playback_context.empty"),
                },
              ]}
            />
          ) : (
            <span />
          )
        }
      />

      <SettingRow
        title={
          t("settings.playback.lrclib_fallback.title") || "LRCLIB fallback"
        }
        description={
          t("settings.playback.lrclib_fallback.description") ||
          "When the built-in sources have no lyrics for a track, Linerave can ask LRCLIB (lrclib.net), sending the track's title, artist and duration. Lyrics found this way are labelled LRCLIB."
        }
        titleKey="settings.playback.lrclib_fallback.title"
        descKey="settings.playback.lrclib_fallback.description"
        searchQuery={searchQuery}
        control={
          <ToggleSwitch
            checked={lrclibFallbackEnabled}
            onChange={setLrclibFallbackEnabled}
          />
        }
      />

      <SettingRow
        title={t("settings.audio.pause_on_device_change.title")}
        description={t("settings.audio.pause_on_device_change.description")}
        titleKey="settings.audio.pause_on_device_change.title"
        descKey="settings.audio.pause_on_device_change.description"
        searchQuery={searchQuery}
        control={
          <ToggleSwitch
            checked={pauseOnDeviceChange}
            onChange={setPauseOnDeviceChange}
          />
        }
      />

      <SettingRow
        title={
          t("settings.playback.keep_playing_screen_off.title") ||
          "Keep playing when the screen turns off"
        }
        description={
          t("settings.playback.keep_playing_screen_off.description") ||
          "While music is playing or a DJ session is running, Linerave asks the system not to suspend the app, so playback continues after the screen turns off. This cannot override sleep you start yourself, or a lid-close set to sleep in your system's power settings."
        }
        titleKey="settings.playback.keep_playing_screen_off.title"
        descKey="settings.playback.keep_playing_screen_off.description"
        searchQuery={searchQuery}
        control={
          <ToggleSwitch
            checked={keepPlayingWhenScreenOff}
            onChange={setKeepPlayingWhenScreenOff}
          />
        }
      />
    </SettingSection>
  );
}
