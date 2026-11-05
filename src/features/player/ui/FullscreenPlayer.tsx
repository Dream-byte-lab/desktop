import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayerStore } from "../store/playerStore";
import { useGlassBlur, useKawarpEnabled } from "../store/visualModeStore";
import { Notch } from "@/shared/ui";
import { FullscreenTopNotch } from "./FullscreenTopNotch";
import { LyricsNotchStatus } from "./LyricsNotchStatus";
import { FullscreenFrameGlass } from "./FullscreenFrameGlass";
import { useLyricsStore, LyricsProviderIsland } from "@/features/lyrics";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { PlayerUiElements } from "./PlayerUiElements";
import { DownLine, Text2Line } from "@mingcute/react";
import { LyricsFullscreenView } from "./LyricsFullscreenView";
import { lyricsLabel } from "./LyricsAccessibilityPanel";
import { preloadCoverArt, useCoverSrc } from "@/features/covers";
import KawarpWrapper from "./KawarpWrapper";
import AmbientLayer from "./AmbientLayer";
import { BetaVisualsWarning } from "./BetaVisualsWarning";
import { useTranslation } from "@/languages";
import { NOW_PLAYING_MORPH_TRANSITION } from "./nowPlayingMorph";
import { consumeLyricsViewOpenRequest } from "./lyricsOpenIntent";

const KAWARP_FADE_IN_MS = 600;

// The queue drawer — the same component the player bar's queue
// button opens in the shell. Loaded lazily: it is only needed when
// the queue is actually opened from here, and the dynamic import
// keeps the player <-> navigation component cycle out of the static
// module graph.
const RightDrawer = lazy(() => import("@/features/navigation/ui/RightDrawer"));

// Mirrors RIGHT_DRAWER_WIDTH in AppFrame's shell drawer.
const QUEUE_DRAWER_WIDTH = 440;

export interface FullscreenPlayerProps {
  effectsReady?: boolean;
  onClose: () => void;
}

export function FullscreenPlayer({
  effectsReady = true,
  onClose,
}: FullscreenPlayerProps) {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const nextCoverUrl = usePlayerStore(
    (s) => s.queue[s.currentIndex + 1]?.coverUrl,
  );
  const coverUrl = currentTrack?.coverUrl;
  const kawarpSrc = useCoverSrc(coverUrl);

  useEffect(() => {
    if (!currentTrack) {
      onClose();
    }
  }, [currentTrack, onClose]);

  const {
    braccatoLyrics,
    lyricsLoading,
    lyricsError,
    plainLyrics,
    instrumental,
    availableProviders,
    currentLyricsTrackId,
  } = useLyricsStore();

  const onError = useCallback((err: Error) => {
    console.error("kawarp load error:", err);
  }, []);

  const kawarpEnabled = useKawarpEnabled();
  const glassBlur = useGlassBlur();
  const reduceMotion = useReducedMotion();
  const [queueOpen, setQueueOpen] = useState(false);
  const toggleQueue = useCallback(() => setQueueOpen((open) => !open), []);
  // A lyrics request from the playback bar (its lyrics button) is
  // consumed once, here, so the surface opens straight into the
  // lyrics view instead of the split view.
  const [lyricsViewOpen, setLyricsViewOpen] = useState(() =>
    consumeLyricsViewOpenRequest(),
  );
  const [kawarpShown, setKawarpShown] = useState(false);
  const [kawarpWasEnabled, setKawarpWasEnabled] = useState(kawarpEnabled);
  if (kawarpWasEnabled !== kawarpEnabled) {
    setKawarpWasEnabled(kawarpEnabled);
    setKawarpShown(false);
  }
  const onKawarpLoad = useCallback(() => {
    setTimeout(() => setKawarpShown(true), KAWARP_FADE_IN_MS);
  }, []);

  useEffect(() => {
    void preloadCoverArt(coverUrl);
    void preloadCoverArt(nextCoverUrl);
  }, [coverUrl, nextCoverUrl]);

  const currentTrackId = currentTrack?.id;
  const isMatchingTrack = Boolean(
    currentTrackId && currentLyricsTrackId === currentTrackId,
  );
  const hasLyrics = isMatchingTrack && braccatoLyrics.length > 0;
  const showProviderIsland = hasLyrics && availableProviders.length > 0;
  const isInstrumental =
    isMatchingTrack &&
    !lyricsLoading &&
    !hasLyrics &&
    !lyricsError &&
    (instrumental || plainLyrics === "[INSTRUMENTAL]");
  const isLyricsLoading = !hasLyrics && lyricsLoading;
  const isLyricsMissing = isMatchingTrack && !hasLyrics && !lyricsLoading;

  // The full-screen Lyrics view (reference 27) is the only lyrics
  // surface: it replaces the Now Playing surface while it is open.
  // The split view carries no lyrics column of its own anymore —
  // lyrics live in the dedicated view, reached from here by the
  // lyrics button or by the playback bar's one-shot intent.
  if (lyricsViewOpen && currentTrack) {
    return <LyricsFullscreenView onExit={() => setLyricsViewOpen(false)} />;
  }

  return (
    <div
      data-theme="dark"
      className="dark relative h-full w-full overflow-hidden bg-black text-white"
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={
          reduceMotion
            ? { ...NOW_PLAYING_MORPH_TRANSITION, duration: 0.18 }
            : NOW_PLAYING_MORPH_TRANSITION
        }
        className="absolute inset-0 overflow-hidden"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{ backgroundColor: "var(--color-bg-primary)" }}
        />
        {(kawarpSrc || coverUrl) && (!kawarpShown || !kawarpEnabled) && (
          <img
            src={kawarpSrc || coverUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover pointer-events-none"
            style={{
              filter: "blur(64px) saturate(1.3)",
              transform: "scale(1.3)",
            }}
          />
        )}
        {effectsReady && kawarpEnabled ? (
          <KawarpWrapper
            src={kawarpSrc}
            onLoad={onKawarpLoad}
            onError={onError}
          />
        ) : null}
        <AmbientLayer trackId={currentTrackId} />
      </motion.div>

      <div className="absolute inset-0 z-[1] bg-black/40" />

      <FullscreenFrameGlass />

      <motion.div
        initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.18 } }}
        style={{ transformOrigin: "50% 100%" }}
        transition={NOW_PLAYING_MORPH_TRANSITION}
        className="absolute inset-1.5 z-10 flex"
      >
        <div className="flex-1 flex flex-col items-center justify-center gap-5">
          <PlayerUiElements
            onClose={onClose}
            layout="horizontal"
            onQueueToggle={toggleQueue}
            queueOpen={queueOpen}
          />
        </div>
      </motion.div>

      <AnimatePresence initial={false}>
        {queueOpen && (
          <motion.aside
            key="fullscreen-queue-drawer"
            initial={{ x: QUEUE_DRAWER_WIDTH }}
            animate={{ x: 0 }}
            exit={{ x: QUEUE_DRAWER_WIDTH }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="absolute top-1.5 bottom-1.5 right-1.5 z-20 max-w-[92vw]"
            style={{ width: QUEUE_DRAWER_WIDTH }}
          >
            <Suspense fallback={null}>
              <RightDrawer onClose={() => setQueueOpen(false)} />
            </Suspense>
          </motion.aside>
        )}
      </AnimatePresence>

      <div className="absolute top-1.5 left-1/2 z-30 flex -translate-x-1/2 justify-center pointer-events-none">
        <FullscreenTopNotch>
          <BetaVisualsWarning docked={false} />
          {showProviderIsland && <LyricsProviderIsland />}
          {isLyricsLoading && <LyricsNotchStatus kind="loading" />}
          {isLyricsMissing && (
            <LyricsNotchStatus
              kind={isInstrumental ? "instrumental" : "missing"}
            />
          )}
        </FullscreenTopNotch>
      </div>

      <div className="absolute top-1.5 left-1.5 z-30 flex gap-1.5">
        <Notch align="start" tone="glass" blur={glassBlur}>
          <button
            type="button"
            aria-label={t("player.close_fullscreen")}
            onClick={onClose}
            data-no-window-drag
            className="inline-flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-control border-none bg-transparent text-white/70 transition-colors select-none hover:bg-white/10 hover:text-white active:scale-95"
          >
            <DownLine size={16} />
          </button>
        </Notch>
        <Notch align="start" tone="glass" blur={glassBlur}>
          <button
            type="button"
            aria-label={lyricsLabel(
              t,
              "player.lyrics_view.open",
              "Open lyrics",
            )}
            onClick={() => setLyricsViewOpen(true)}
            data-no-window-drag
            className="inline-flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-control border-none bg-transparent text-white/70 transition-colors select-none hover:bg-white/10 hover:text-white active:scale-95"
          >
            <Text2Line size={16} />
          </button>
        </Notch>
      </div>
    </div>
  );
}

export default function PlayerPage() {
  const navigate = useNavigate();
  return <FullscreenPlayer onClose={() => navigate(-1)} />;
}
