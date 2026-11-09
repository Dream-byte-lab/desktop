import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AimingFill } from "@mingcute/react";
import Header from "./Header";
import Sidebar from "./Sidebar";
import { cn } from "@/shared/lib";
import WindowControlsNotch from "./WindowControlsNotch";
import RightDrawer from "./RightDrawer";
import { FullscreenRouteContext } from "../fullscreenRouteContext";
import DynamicBlurBackground from "./DynamicBlurBackground";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import { useDisableButtonFocus } from "../hooks/useDisableButtonFocus";
import { useWindowPresence } from "../hooks/useWindowPresence";
import { useWindowState } from "../hooks/useWindowState";
import {
  FullscreenPlayer,
  playerEngine,
  MiniPlayer,
  usePlayerStore,
  useGlassBlur,
} from "@/features/player";
import { NOW_PLAYING_MORPH_DURATION_S } from "@/features/player/ui/nowPlayingMorph";
import { WelcomeGreeting } from "@/features/greeting/ui/WelcomeGreeting";
import { FocusMode, useFocusModeStore } from "@/features/focus";
import { PANEL_GLASS_CLASS } from "@/shared/ui/Panel";
import { useDjModeStore } from "@/features/mixer/store/djModeStore";
import { DjPartyPanel } from "@/features/mixer/ui/DjPartyPanel";
import { DjProView } from "@/features/mixer/ui/DjProView";
import { DjSimpleView } from "@/features/mixer/ui/DjSimpleView";
import { useTranslation } from "@/languages";
import { useTheme } from "next-themes";
import {
  AddToPlaylistModal,
  AddToLibraryModal,
  RemoveFromPlaylistModal,
  RemoveFromLibraryModal,
  ImportLikesModal,
  ImportReviewModal,
  FailedImportsModal,
  LocalDropZone,
  CreatePlaylistModal,
  useModalStore,
} from "@/features/library";
import {
  SettingsModal,
  useHasPageBackdrop,
  useEffectiveCoverGlow,
} from "@/features/settings";
import { UpdateModal, UpdateToastBridge } from "@/features/updater";
import { YoutubeSignInNotice } from "@/features/youtube-auth";
import { useSidebarStore } from "@/widgets/sidebar/model/useSidebarStore";

interface AppFrameProps {
  children: React.ReactNode;
}

const RIGHT_DRAWER_WIDTH = 440;
const SIDEBAR_WIDTH = 58;
const SIDEBAR_EXPANDED_WIDTH = 232;
const LEGACY_LAYOUT_STORAGE_KEYS = [
  "liner_right_sidebar",
  "liner_sidebar_position",
  "liner_sidebar_width",
  "liner_queue_popup_open",
] as const;

const AppOverlays = memo(function AppOverlays() {
  return (
    <>
      <WelcomeGreeting />
      <AddToPlaylistModal />
      <AddToLibraryModal />
      <RemoveFromPlaylistModal />
      <RemoveFromLibraryModal />
      <ImportLikesModal />
      <CreatePlaylistModal />
      <ImportReviewModal />
      <FailedImportsModal />
      <LocalDropZone />
      <SettingsModal />
      <UpdateModal />
      <YoutubeSignInNotice />
      <UpdateToastBridge />
    </>
  );
});

export default function AppFrame({ children }: AppFrameProps) {
  const location = useLocation();
  const { pathname, search } = location;
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { isEdgeToEdge } = useWindowState();

  const openSettings = useModalStore((state) => state.openSettings);
  const sidebarCollapsed = useSidebarStore((state) => state.collapsed);

  const [queuePopupOpen, setQueuePopupOpen] = useState(false);
  const fullscreenPlayerOpen = usePlayerStore((state) => state.fullscreen);
  const setFullscreenPlayerOpen = usePlayerStore(
    (state) => state.setFullscreen,
  );
  const focusActive = useFocusModeStore((state) => state.active);
  const enterFocus = useFocusModeStore((state) => state.enter);
  const exitFocus = useFocusModeStore((state) => state.exit);
  const [fullscreenEffectsReady, setFullscreenEffectsReady] = useState(false);

  useEffect(() => {
    if (pathname === "/settings") {
      openSettings();
      navigate("/", { replace: true });
    }
  }, [pathname, openSettings, navigate]);

  useEffect(() => {
    for (const key of LEGACY_LAYOUT_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  }, []);

  const handleQueuePopupToggle = useCallback((open: boolean) => {
    setQueuePopupOpen(open);
  }, []);

  const handleQueuePopupToggleRequest = useCallback(() => {
    setQueuePopupOpen((current) => !current);
  }, []);

  const shouldShowMiniPlayer = useSyncExternalStore(
    playerEngine.subscribe,
    () => {
      const state = playerEngine.getSnapshot();
      return state.currentTrack !== null && state.status !== "idle";
    },
    () => false,
  );

  const hasCurrentTrack = useSyncExternalStore(
    playerEngine.subscribe,
    () => playerEngine.getSnapshot().currentTrack !== null,
    () => false,
  );

  const appFrameRef = useRef<HTMLDivElement>(null);
  const queueDrawerRef = useRef<HTMLDivElement>(null);
  const mainScrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const main = mainScrollRef.current;
    if (main && main.scrollTop !== 0) main.scrollTop = 0;
  }, [pathname, search]);

  const miniPlayerContainerRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const isFullscreenRoute = pathname === "/player";
  const isFullscreenPlayer = isFullscreenRoute || fullscreenPlayerOpen;
  const shellChildrenRef = useRef<React.ReactNode>(null);
  if (!isFullscreenRoute) {
    shellChildrenRef.current = children;
  }
  const isRightDrawerOpen = queuePopupOpen && !isFullscreenPlayer;

  const openFullscreenPlayer = useCallback(() => {
    setFullscreenPlayerOpen(true);
  }, [setFullscreenPlayerOpen]);

  const closeFullscreenPlayer = useCallback(() => {
    setFullscreenPlayerOpen(false);
  }, [setFullscreenPlayerOpen]);

  const handleCloseFullscreen = useCallback(() => {
    if (fullscreenPlayerOpen) {
      setFullscreenPlayerOpen(false);
    } else if (isFullscreenRoute) {
      navigate("/", { replace: true });
    }
  }, [
    fullscreenPlayerOpen,
    isFullscreenRoute,
    navigate,
    setFullscreenPlayerOpen,
  ]);

  useEffect(() => {
    if (isFullscreenPlayer && !hasCurrentTrack) {
      handleCloseFullscreen();
    }
  }, [isFullscreenPlayer, hasCurrentTrack, handleCloseFullscreen]);

  // The overlay below mounts statically — its y-slide has retired so
  // the pill→card morph reads as one motion — so the effects-ready
  // flip its slide's onAnimationComplete used to deliver is now
  // timed to the morph itself: a 380 ms timeout keyed to
  // fullscreenPlayerOpen (NOW_PLAYING_MORPH_DURATION_S). Opening:
  // the flip lands as the morph completes, and until it does the
  // shell stays mounted and measurable under the overlay, which is
  // what lets the pill's artwork travel. Closing: the flag holds
  // through the exit crossfade and the artwork's journey home, then
  // resets so the next open starts unset.
  useEffect(() => {
    const timeoutId = setTimeout(
      () => setFullscreenEffectsReady(fullscreenPlayerOpen),
      NOW_PLAYING_MORPH_DURATION_S * 1000,
    );
    return () => clearTimeout(timeoutId);
  }, [fullscreenPlayerOpen]);

  const openRightPanel = useCallback(() => setQueuePopupOpen(true), []);
  const closeRightPanel = useCallback(() => setQueuePopupOpen(false), []);

  const isBackNavigableRoute =
    pathname === "/artist" ||
    pathname === "/library/playlist" ||
    pathname === "/library/local" ||
    pathname === "/library/cached" ||
    pathname === "/library/saved" ||
    pathname === "/collection";
  const handleEscapeFallback = useCallback(() => {
    if (queuePopupOpen || isFullscreenPlayer) return false;
    if (!isBackNavigableRoute) return false;
    if (window.history.length > 1) navigate(-1);
    else navigate("/library");
    return true;
  }, [isBackNavigableRoute, queuePopupOpen, isFullscreenPlayer, navigate]);

  // The search door (Interface S1): the header/sidebar affordance
  // and the keyboard binding both land on the dedicated page; a
  // submitted query rides along as ?q= when there is one to carry
  // (the sidebar item itself carries none — it is a plain link).
  const openSearchPage = useCallback(() => {
    navigate("/search");
  }, [navigate]);

  // The DJ stage's Escape slot (Note 26): the stage's open state
  // is a view fact in the mixer store, not frame-local state, so
  // the frame reads it from there and hands the shortcut chain
  // the open/close pair the stage-engine seams report prescribed
  // — the stage ranked above the route-back fallback, below the
  // transient layers (Focus, Search, right panel, fullscreen).
  const stageOpen = useDjModeStore((state) => state.proOpen);
  const setProOpen = useDjModeStore((state) => state.setProOpen);
  const closeStage = useCallback(() => {
    setProOpen(false);
  }, [setProOpen]);

  useDisableButtonFocus();
  useWindowPresence();

  useGlobalShortcuts({
    openSearchPage,
    rightPanelOpen: queuePopupOpen,
    openRightPanel,
    closeRightPanel,
    fullscreenOpen: isFullscreenPlayer,
    openFullscreen: openFullscreenPlayer,
    closeFullscreen: handleCloseFullscreen,
    focusOpen: focusActive,
    enterFocus,
    exitFocus,
    stageOpen,
    closeStage,
    onEscapeFallback: handleEscapeFallback,
  });
  useEffect(() => {
    if (isFullscreenPlayer) {
      setQueuePopupOpen(false);
    }
  }, [isFullscreenPlayer]);

  useEffect(() => {
    const onGlobalPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (
        target instanceof Element &&
        (target.closest("[data-dialog-container]") ||
          target.closest("[data-dialog-backdrop]") ||
          target.closest("[data-dropdown-menu]") ||
          // a toast action (e.g. Undo after removing a queue track) must not close the open drawer
          target.closest("[data-toast]"))
      ) {
        return;
      }
      if (queuePopupOpen) {
        if (queueDrawerRef.current?.contains(target)) {
          return;
        }
        if (miniPlayerContainerRef.current?.contains(target)) {
          return;
        }
        if (sidebarRef.current?.contains(target)) {
          return;
        }
        if (
          event.clientY <= 32 ||
          (target instanceof Element && target.closest("[data-window-drag]"))
        ) {
          return;
        }
        if (queuePopupOpen) {
          handleQueuePopupToggle(false);
        }
      }
    };

    document.addEventListener("mousedown", onGlobalPointerDown, true);
    return () => {
      document.removeEventListener("mousedown", onGlobalPointerDown, true);
    };
  }, [queuePopupOpen, handleQueuePopupToggle]);

  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme
    ? resolvedTheme === "dark"
    : typeof document !== "undefined" &&
      (document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") &&
          window.matchMedia?.("(prefers-color-scheme: dark)")?.matches));
  const hasPageBackdrop = useHasPageBackdrop();
  const coverGlow = useEffectiveCoverGlow();
  const glassBlur = useGlassBlur();

  return (
    <div
      ref={appFrameRef}
      className={`app-shell-enter relative flex flex-col h-full w-full overflow-hidden p-1.5 gap-1.5 ${
        isFullscreenPlayer ? "bg-black" : "bg-bg-canvas"
      } ${isEdgeToEdge ? "rounded-none" : "rounded-item"}`}
      style={isEdgeToEdge ? undefined : { clipPath: "inset(0 round 12px)" }}
      onScroll={(e) => {
        if (e.currentTarget.scrollLeft !== 0) e.currentTarget.scrollLeft = 0;
        if (e.currentTarget.scrollTop !== 0) e.currentTarget.scrollTop = 0;
      }}
    >
      {coverGlow ? <DynamicBlurBackground isDark={isDark} /> : null}

      <AnimatePresence>
        {!isFullscreenPlayer && (
          <motion.div
            key="app-header-container"
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="absolute inset-x-1.5 top-1.5 z-[45]"
          >
            <Header />
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={cn(
          "flex-1 min-h-0 flex flex-row w-full gap-1.5 overflow-hidden relative z-10",
          fullscreenPlayerOpen && fullscreenEffectsReady && "invisible",
        )}
      >
        <aside
          ref={sidebarRef}
          className="mt-[56px] shrink-0 z-[45] relative flex flex-col transition-[width] duration-[210ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{
            width: sidebarCollapsed ? SIDEBAR_WIDTH : SIDEBAR_EXPANDED_WIDTH,
          }}
        >
          <Sidebar />
        </aside>

        <div className="flex-1 flex flex-col min-w-0 h-full relative gap-1.5 overflow-hidden">
          <main
            className={cn(
              "flex-1 min-w-0 flex flex-col relative h-full overflow-hidden [--page-inset-top:56px]",
              "rounded-item",
              shouldShowMiniPlayer && hasPageBackdrop
                ? "[--page-inset-bottom:64px] [--floating-inset-bottom:70px]"
                : "[--page-inset-bottom:0px] [--floating-inset-bottom:0px]",
            )}
          >
            <div
              ref={mainScrollRef}
              className={`h-full ${
                isFullscreenPlayer ? "overflow-hidden" : "overflow-y-auto"
              }`}
            >
              <div className="h-full w-full">
                {isFullscreenRoute ? shellChildrenRef.current : children}
              </div>
            </div>

            {!isFullscreenPlayer && (
              <AnimatePresence initial={false}>
                {isRightDrawerOpen && (
                  <motion.aside
                    key="right-drawer"
                    ref={queueDrawerRef}
                    initial={{ x: RIGHT_DRAWER_WIDTH }}
                    animate={{ x: 0 }}
                    exit={{ x: RIGHT_DRAWER_WIDTH }}
                    transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                    className="pointer-events-auto absolute top-(--page-inset-top) bottom-(--floating-inset-bottom) right-0 z-[50]"
                    style={{ width: RIGHT_DRAWER_WIDTH }}
                  >
                    <RightDrawer onClose={closeRightPanel} />
                  </motion.aside>
                )}
              </AnimatePresence>
            )}
          </main>

          {shouldShowMiniPlayer && (
            <div
              ref={miniPlayerContainerRef}
              // Above the right drawer (z-50) so the player's volume/speed/queue
              // popups, which live in this stacking context, aren't hidden by it.
              className={`relative z-[55] w-full shrink-0 ${hasPageBackdrop ? "-mt-[70px]" : ""}`}
            >
              <DjProView />
              <DjSimpleView />
              <DjPartyPanel />
              <MiniPlayer
                embedded
                onQueueOpenChange={handleQueuePopupToggle}
                onQueueToggle={handleQueuePopupToggleRequest}
                onFullscreenOpen={openFullscreenPlayer}
              />
            </div>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {fullscreenPlayerOpen ? (
          <motion.div
            key="fullscreen-player-overlay"
            data-theme="dark"
            className={`dark absolute inset-0 z-[70] overflow-hidden rounded-[inherit] bg-black ${
              fullscreenEffectsReady ? "" : "will-change-transform"
            }`}
          >
            <FullscreenPlayer
              onClose={closeFullscreenPlayer}
              effectsReady={fullscreenEffectsReady}
            />
          </motion.div>
        ) : isFullscreenRoute ? (
          <div
            data-theme="dark"
            className="dark absolute inset-0 z-[70] overflow-hidden rounded-[inherit] bg-black"
          >
            <FullscreenRouteContext.Provider value>
              {children}
            </FullscreenRouteContext.Provider>
          </div>
        ) : null}
      </AnimatePresence>

      <AppOverlays />
      {isFullscreenPlayer && (
        <div
          data-theme="dark"
          className="dark absolute top-1.5 right-1.5 z-[80]"
        >
          <WindowControlsNotch tone="glass" blur={glassBlur} />
        </div>
      )}
      {/* The Focus doorway (Interface Build 6): the annex enters
          Focus "from Now Playing" — a quiet glass pill beside the
          fullscreen player's close notch, in the same forced-dark
          island as the window notch. Esc, this doorway's reverse
          (the pill inside Focus), or the Shift+F binding leaves. */}
      {isFullscreenPlayer && !focusActive && (
        <div
          data-theme="dark"
          className="dark absolute top-1.5 left-[44px] z-[75]"
        >
          <button
            type="button"
            onClick={enterFocus}
            data-no-window-drag
            aria-label={t("focus.enter") || "Focus"}
            className={cn(
              PANEL_GLASS_CLASS,
              "flex h-[26px] cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium text-text-secondary transition-colors select-none hover:text-text-primary active:scale-95 motion-reduce:transition-none",
            )}
          >
            <AimingFill size={13} />
            {t("focus.enter") || "Focus"}
          </button>
        </div>
      )}
      <FocusMode />
    </div>
  );
}
