import { useEffect, useState } from "react";
import { ArrowLeftLine, WheelchairLine } from "@mingcute/react";
import { usePlayerStore } from "../store/playerStore";
import { useGlassBlur } from "../store/visualModeStore";
import { useLyricsDisplayStore } from "../store/lyricsDisplayStore";
import { cn } from "@/shared/lib";
import { Notch } from "@/shared/ui";
import { FullscreenTopNotch } from "./FullscreenTopNotch";
import { LyricsNotchStatus } from "./LyricsNotchStatus";
import { FullscreenFrameGlass } from "./FullscreenFrameGlass";
import { useLyricsStore, LyricsProviderIsland } from "@/features/lyrics";
import { preloadCoverArt, useCoverSrc } from "@/features/covers";
import { CanvasLyricsView } from "./CanvasLyricsView";
import { FullscreenTimeline } from "./FullscreenTimeline";
import { FullscreenTransportControls } from "./FullscreenTransportControls";
import {
  LyricsAccessibilityPanel,
  lyricsLabel,
} from "./LyricsAccessibilityPanel";
import { useRadioRecommendations } from "../hooks/useRadioRecommendations";
import { playerEngine } from "../engine/playerEngine";
import { useTranslation } from "@/languages";
import type { Track } from "@/shared/types/track";

/**
 * The full-screen Lyrics view (built to reference 27; visual
 * register governed by reference 28): the artwork as a circular,
 * record-like header cropped by the top edge, title / artist /
 * year, the Next / Lyrics / Recommended tab pill, and the
 * synchronised lyrics in the user's chosen register — with the
 * accessibility overlay (blur, bigger text, highlight, text align)
 * living on the surface itself. Reference 28's register: the
 * artwork's glow gathers at the top of the screen and the room
 * falls away to near-black below it, and the lyrics column's
 * context lines dim with their distance from the sung line (the
 * falloff itself lives in the canvas scene).
 *
 * Recommended is wired to the real radio source seeded by the
 * current track; Next shows the actual next track in the queue.
 * Playback state, lyrics state and the sync renderer are the same
 * ones the Now Playing surface uses — this view is presentation.
 */

type LyricsViewTab = "next" | "lyrics" | "recommended";

function formatMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function TrackRow({
  track,
  onPlay,
}: {
  track: Track;
  onPlay?: (track: Track) => void;
}) {
  const content = (
    <>
      <img
        src={track.coverUrl}
        alt=""
        draggable={false}
        className="h-[44px] w-[44px] shrink-0 rounded-[8px] object-cover"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-white">
          {track.title}
        </span>
        <span className="block truncate text-[13px] text-white/55">
          {track.artists}
        </span>
      </span>
      <span className="shrink-0 text-[13px] text-white/45 tabular-nums">
        {formatMs(track.durationMs)}
      </span>
    </>
  );
  if (!onPlay) {
    return <div className="flex items-center gap-3 px-2 py-1.5">{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onPlay(track)}
      className="flex w-full cursor-pointer items-center gap-3 rounded-[12px] border-none bg-transparent px-2 py-1.5 text-left transition-colors select-none hover:bg-white/5 active:scale-[0.99]"
    >
      {content}
    </button>
  );
}

export interface LyricsFullscreenViewProps {
  /** Leaves the lyrics view, back to the Now Playing surface. */
  onExit: () => void;
}

export function LyricsFullscreenView({ onExit }: LyricsFullscreenViewProps) {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const {
    braccatoLyrics,
    lyricsLoading,
    plainLyrics,
    instrumental,
    availableProviders,
    currentLyricsTrackId,
  } = useLyricsStore();
  const gaussianBlur = useLyricsDisplayStore((s) => s.gaussianBlur);
  const textAlign = useLyricsDisplayStore((s) => s.textAlign);
  const glassBlur = useGlassBlur();
  const [tab, setTab] = useState<LyricsViewTab>("lyrics");
  const [panelOpen, setPanelOpen] = useState(false);

  const coverUrl = currentTrack?.coverUrl;
  const coverSrc = useCoverSrc(coverUrl) || coverUrl;
  const radio = useRadioRecommendations(
    tab === "recommended" ? currentTrack?.id : undefined,
  );

  useEffect(() => {
    void preloadCoverArt(coverUrl);
  }, [coverUrl]);

  if (!currentTrack) return null;

  const currentTrackId = currentTrack.id;
  const isMatchingTrack = currentLyricsTrackId === currentTrackId;
  const hasLyrics = isMatchingTrack && braccatoLyrics.length > 0;
  const showProviderIsland = hasLyrics && availableProviders.length > 0;
  const isInstrumental =
    isMatchingTrack &&
    !lyricsLoading &&
    !hasLyrics &&
    (instrumental || plainLyrics === "[INSTRUMENTAL]");
  const showPlain =
    isMatchingTrack &&
    !hasLyrics &&
    !lyricsLoading &&
    Boolean(plainLyrics) &&
    plainLyrics !== "[INSTRUMENTAL]";
  const isLyricsLoading = !hasLyrics && lyricsLoading;
  const year = currentTrack.releaseDate?.match(/^\d{4}/)?.[0];
  const upNext = queue.slice(currentIndex + 1, currentIndex + 9);
  const nextTrack = upNext[0];

  const tabs: { id: LyricsViewTab; key: string; text: string }[] = [
    { id: "next", key: "player.lyrics_view.tab_next", text: "Next" },
    { id: "lyrics", key: "player.lyrics_view.tab_lyrics", text: "Lyrics" },
    {
      id: "recommended",
      key: "player.lyrics_view.tab_recommended",
      text: "Recommended",
    },
  ];

  return (
    <div
      data-theme="dark"
      className="dark relative h-full w-full overflow-hidden bg-black text-white"
    >
      {/* Atmosphere: the artwork, blurred — or, with Gaussian blur
          off, a flat indigo field merely tinted by the artwork. The
          composition (header, tabs, lyrics) is identical either way. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{ backgroundColor: "var(--color-bg-primary)" }}
      />
      {coverSrc && gaussianBlur && (
        <img
          src={coverSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          style={{
            filter: "blur(64px) saturate(1.3)",
            transform: "scale(1.3)",
          }}
        />
      )}
      {coverSrc && !gaussianBlur && (
        <img
          src={coverSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-10"
        />
      )}
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0 z-[1]",
          gaussianBlur ? "bg-black/40" : "bg-black/55",
        )}
      />
      {/* Reference 28's fall: the glow belongs to the top of the
          room, around the record; below the tab pill the screen
          deepens toward black so the lyrics column floats in a
          dark room rather than on a uniformly lit wash. A shading
          layer only — the composition above it is unchanged, with
          blur on or off. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 z-[1]"
        style={{
          background:
            "linear-gradient(to bottom, rgba(0, 0, 0, 0) 24%, rgba(0, 0, 0, 0.42) 60%, rgba(0, 0, 0, 0.85) 100%)",
        }}
      />

      <FullscreenFrameGlass />

      <div className="absolute inset-1.5 z-10 flex flex-col items-center">
        {/* The record header: a circular crop of the artwork, cut by
            the top edge of the screen, glowing in the artwork's own
            light while blur is on. */}
        <div className="relative h-[186px] w-full shrink-0">
          {coverSrc && (
            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[46%]">
              {gaussianBlur && (
                <img
                  src={coverSrc}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  className="absolute inset-0 h-full w-full scale-110 rounded-full object-cover opacity-70 blur-2xl"
                />
              )}
              <img
                src={coverSrc}
                alt=""
                draggable={false}
                className={cn(
                  "relative block h-[352px] w-[352px] rounded-full object-cover",
                  !gaussianBlur && "ring-1 ring-white/15",
                )}
              />
              <span
                aria-hidden="true"
                className="absolute top-1/2 left-1/2 h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/85 shadow"
              />
            </div>
          )}
        </div>

        <h1 className="max-w-[82vw] shrink-0 truncate text-center text-[32px] leading-tight font-bold">
          {currentTrack.title}
        </h1>
        <div className="mt-1.5 flex shrink-0 items-center gap-2 text-sm text-white/70">
          {coverSrc && (
            <img
              src={coverSrc}
              alt=""
              draggable={false}
              className="h-[20px] w-[20px] rounded-full object-cover"
            />
          )}
          <span className="truncate">{currentTrack.artists}</span>
          {year && <span className="shrink-0">• {year}</span>}
        </div>

        <div
          role="tablist"
          aria-label={lyricsLabel(t, "player.lyrics_view.tab_lyrics", "Lyrics")}
          className="mt-4 inline-flex shrink-0 rounded-full bg-black/35 p-1 ring-1 ring-white/10 backdrop-blur-md"
        >
          {tabs.map((entry) => {
            const active = tab === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(entry.id)}
                className={cn(
                  "cursor-pointer rounded-full border-none px-4 py-1.5 text-sm transition-colors select-none",
                  active
                    ? "bg-white/15 font-semibold text-white"
                    : "bg-transparent text-white/55 hover:text-white",
                )}
              >
                {lyricsLabel(t, entry.key, entry.text)}
              </button>
            );
          })}
        </div>

        <div className="flex min-h-0 w-full max-w-[860px] flex-1 flex-col px-6">
          {tab === "lyrics" && hasLyrics && (
            <CanvasLyricsView lyrics={braccatoLyrics} />
          )}

          {tab === "lyrics" && showPlain && (
            <div className="min-h-0 flex-1 overflow-y-auto py-4">
              <p
                className={cn(
                  "mx-auto max-w-[640px] text-[19px] leading-[1.75] font-medium whitespace-pre-line text-white/85",
                  textAlign === "left" ? "text-left" : "text-center",
                )}
              >
                {plainLyrics}
              </p>
            </div>
          )}

          {tab === "lyrics" && !hasLyrics && !showPlain && (
            <div className="flex flex-1 items-center justify-center">
              <Notch align="center" tone="glass" blur={glassBlur}>
                <LyricsNotchStatus
                  kind={
                    isLyricsLoading
                      ? "loading"
                      : isInstrumental
                        ? "instrumental"
                        : "missing"
                  }
                />
              </Notch>
            </div>
          )}

          {tab === "next" && (
            <div className="mx-auto min-h-0 w-full max-w-[560px] flex-1 overflow-y-auto py-4">
              {nextTrack ? (
                <>
                  <div className="flex items-center gap-4 rounded-[16px] bg-white/5 p-4">
                    <img
                      src={nextTrack.coverUrl}
                      alt=""
                      draggable={false}
                      className="h-[72px] w-[72px] shrink-0 rounded-[10px] object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-lg font-semibold">
                        {nextTrack.title}
                      </p>
                      <p className="truncate text-sm text-white/60">
                        {nextTrack.artists}
                      </p>
                      {nextTrack.album && (
                        <p className="truncate text-sm text-white/40">
                          {nextTrack.album.title}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-sm text-white/50 tabular-nums">
                      {formatMs(nextTrack.durationMs)}
                    </span>
                  </div>
                  {upNext.length > 1 && (
                    <>
                      <p className="mt-5 mb-1.5 text-[12px] font-medium tracking-[0.08em] text-white/45 uppercase">
                        {lyricsLabel(
                          t,
                          "player.lyrics_view.up_next",
                          "Up next",
                        )}
                      </p>
                      {upNext.slice(1).map((track) => (
                        <TrackRow key={track.id} track={track} />
                      ))}
                    </>
                  )}
                </>
              ) : (
                <p className="pt-10 text-center text-[15px] text-white/50">
                  {lyricsLabel(
                    t,
                    "player.lyrics_view.no_next",
                    "Nothing up next",
                  )}
                </p>
              )}
            </div>
          )}

          {tab === "recommended" && (
            <div className="mx-auto min-h-0 w-full max-w-[560px] flex-1 overflow-y-auto py-4">
              <p className="mb-2 text-center text-[13px] text-white/45">
                {lyricsLabel(
                  t,
                  "player.lyrics_view.recommended_basis",
                  "Radio based on this track",
                )}
              </p>
              {radio.loading && (
                <div className="flex justify-center pt-8" role="status">
                  <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-white/70 border-t-transparent" />
                </div>
              )}
              {!radio.loading && radio.tracks.length === 0 && (
                <p className="pt-6 text-center text-[15px] text-white/50">
                  {lyricsLabel(
                    t,
                    "player.lyrics_view.recommended_empty",
                    "No recommendations right now",
                  )}
                </p>
              )}
              {radio.tracks.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  onPlay={(picked) =>
                    void playerEngine.playTrack(picked, radio.tracks)
                  }
                />
              ))}
            </div>
          )}
        </div>

        <div className="z-10 flex w-[min(600px,88vw)] shrink-0 flex-col items-center pt-1 pb-5">
          <FullscreenTimeline />
          <FullscreenTransportControls />
        </div>
      </div>

      {showProviderIsland && (
        <div className="pointer-events-none absolute top-1.5 left-1/2 z-30 flex -translate-x-1/2 justify-center">
          <FullscreenTopNotch>
            <LyricsProviderIsland />
          </FullscreenTopNotch>
        </div>
      )}

      <div className="absolute top-1.5 left-1.5 z-30">
        <Notch align="start" tone="glass" blur={glassBlur}>
          <button
            type="button"
            aria-label={lyricsLabel(
              t,
              "player.lyrics_view.back",
              "Back to player",
            )}
            onClick={onExit}
            data-no-window-drag
            className="inline-flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-control border-none bg-transparent text-white/70 transition-colors select-none hover:bg-white/10 hover:text-white active:scale-95"
          >
            <ArrowLeftLine size={16} />
          </button>
        </Notch>
      </div>

      <div className="absolute top-1.5 right-1.5 z-30">
        <Notch align="end" tone="glass" blur={glassBlur}>
          <button
            type="button"
            aria-label={lyricsLabel(
              t,
              "player.lyrics_display.accessibility",
              "Accessibility",
            )}
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((open) => !open)}
            data-no-window-drag
            className={cn(
              "inline-flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-control border-none transition-colors select-none active:scale-95",
              panelOpen
                ? "bg-white/15 text-white"
                : "bg-transparent text-white/70 hover:bg-white/10 hover:text-white",
            )}
          >
            <WheelchairLine size={16} />
          </button>
        </Notch>
      </div>

      {panelOpen && (
        <div className="absolute top-1/2 right-5 z-40 -translate-y-1/2">
          <LyricsAccessibilityPanel onClose={() => setPanelOpen(false)} />
        </div>
      )}
    </div>
  );
}
