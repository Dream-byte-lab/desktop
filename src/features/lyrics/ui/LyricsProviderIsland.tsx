import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LeftLine,
  RightLine,
  CheckFill,
  DownLine,
  TimeLine,
  AddLine,
  MinimizeLine,
  Refresh1Line,
} from "@mingcute/react";
import {
  useLyricsStore,
  type LyricsProviderOption,
} from "../store/lyricsStore";
import { lyricsCache } from "../store/lyricsCache";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib";

function formatOffsetBadge(ms: number): string {
  if (ms === 0) return "0.0s";
  const sign = ms > 0 ? "+" : "";
  const abs = Math.abs(ms);
  if (abs % 100 === 0) {
    return `${sign}${(ms / 1000).toFixed(1)}s`;
  }
  return `${sign}${(ms / 1000).toFixed(2)}s`;
}

export function LyricsProviderIsland() {
  const { t } = useTranslation();
  const {
    availableProviders,
    activeProvider,
    selectProvider,
    braccatoLyrics,
    rawFormat,
    offsetMs,
    setOffset,
    adjustOffset,
    resetOffset,
    currentLyricsTrackId,
  } = useLyricsStore();

  // Wave 4 (wrong-lyrics remedy): the wrong-source mark for the
  // current track, read from the lyrics cache — its only home. It is
  // refreshed when the track changes or the dropdown opens, and this
  // island updates it directly when it writes a mark. Marking never
  // changes what is on screen; it only steers later plays.
  const [wrongProvider, setWrongProvider] = useState<{
    provider: string;
    markedAt: number;
  } | null>(null);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [offsetOpen, setOffsetOpen] = useState(false);
  const [unit, setUnit] = useState<"ms" | "s">("ms");
  const [inputValue, setInputValue] = useState(String(offsetMs));
  const isInputFocusedRef = useRef(false);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isInputFocusedRef.current) {
      if (unit === "ms") {
        setInputValue(String(offsetMs));
      } else {
        setInputValue(String(offsetMs / 1000));
      }
    }
  }, [offsetMs, unit]);

  useEffect(() => {
    setWrongProvider(
      currentLyricsTrackId
        ? (lyricsCache.get(currentLyricsTrackId)?.wrongProvider ?? null)
        : null,
    );
  }, [currentLyricsTrackId, dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen && !offsetOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
        setOffsetOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDropdownOpen(false);
        setOffsetOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dropdownOpen, offsetOpen]);

  const handleInputChange = useCallback(
    (val: string) => {
      setInputValue(val);
      const parsed = parseFloat(val);
      if (!isNaN(parsed)) {
        const targetMs =
          unit === "ms" ? Math.round(parsed) : Math.round(parsed * 1000);
        if (targetMs >= -60000 && targetMs <= 60000) {
          setOffset(targetMs);
        }
      }
    },
    [unit, setOffset],
  );

  const isCurrentPlain =
    rawFormat === "plain" ||
    (braccatoLyrics.length > 0 &&
      braccatoLyrics.every(
        (l) => (l.startTimeMs ?? 0) === 0 && (l.durationMs ?? 0) === 0,
      ));

  if (availableProviders.length === 0 || braccatoLyrics.length === 0) {
    return null;
  }

  const currentIndex = Math.max(
    0,
    availableProviders.findIndex((p) => p.provider === activeProvider),
  );
  const currentProvider =
    availableProviders[currentIndex] ?? availableProviders[0];
  const hasMultiple = availableProviders.length > 1;

  // Wave 4: an explicit pick switches now AND persists per track, so
  // the next play of this track opens on the chosen source
  const pickProvider = (provider: string) => {
    selectProvider(provider);
    if (currentLyricsTrackId) {
      lyricsCache.rememberUserProvider(currentLyricsTrackId, provider);
    }
  };

  const syncLabel = (option: LyricsProviderOption): string => {
    const level = option.syncLevel ?? option.candidate?.syncLevel;
    if (level === "word_level" || level === "syllable_level") {
      return t("player.lyrics_source_word") || "Word-synced";
    }
    if (level === "line_level") {
      return t("player.lyrics_source_line") || "Line-synced";
    }
    return t("player.lyrics_source_plain") || "Plain";
  };

  const activeMarked =
    wrongProvider?.provider === currentProvider.provider.toLowerCase().trim();
  const switchTarget = availableProviders.find(
    (p) => p.provider !== currentProvider.provider,
  );

  const handleMarkWrong = () => {
    if (!currentLyricsTrackId) return;
    lyricsCache.markWrongProvider(
      currentLyricsTrackId,
      currentProvider.provider,
    );
    setWrongProvider({
      provider: currentProvider.provider.toLowerCase().trim(),
      markedAt: Date.now(),
    });
  };

  const handleUnmark = () => {
    if (!currentLyricsTrackId) return;
    lyricsCache.clearWrongProvider(currentLyricsTrackId);
    setWrongProvider(null);
  };

  const handleSwitchToTarget = () => {
    if (!switchTarget) return;
    pickProvider(switchTarget.provider);
    setDropdownOpen(false);
  };

  const handlePrev = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget?.blur();
    if (!hasMultiple) return;
    const nextIdx =
      (currentIndex - 1 + availableProviders.length) %
      availableProviders.length;
    pickProvider(availableProviders[nextIdx].provider);
  };

  const handleNext = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget?.blur();
    if (!hasMultiple) return;
    const nextIdx = (currentIndex + 1) % availableProviders.length;
    pickProvider(availableProviders[nextIdx].provider);
  };

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center pointer-events-auto select-none"
    >
      <div
        className={cn(
          "inline-flex items-center h-[26px] min-h-[26px] max-h-[26px] box-border gap-[2px] text-white",
        )}
      >
        {hasMultiple && (
          <button
            type="button"
            onClick={handlePrev}
            aria-label="Previous provider"
            className="w-[26px] h-[26px] min-w-[26px] min-h-[26px] max-h-[26px] rounded-control flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 active:scale-95 transition-all border-none bg-transparent cursor-pointer"
          >
            <LeftLine size={14} />
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            if (hasMultiple) {
              setOffsetOpen(false);
              setDropdownOpen((v) => !v);
            }
          }}
          className={`flex items-center gap-[6px] h-[26px] min-h-[26px] max-h-[26px] px-[8px] rounded-control text-caption font-[500] text-white transition-all border-none bg-transparent ${
            hasMultiple ? "hover:bg-white/10 cursor-pointer" : "cursor-default"
          }`}
        >
          <span className="truncate max-w-[120px]">
            {currentProvider.provider}
          </span>
          {hasMultiple && (
            <span className="text-[10px] font-mono text-white/50">
              {currentIndex + 1}/{availableProviders.length}
            </span>
          )}
          {hasMultiple && (
            <DownLine
              size={12}
              className={`text-white/50 transition-transform duration-150 ${
                dropdownOpen ? "rotate-180" : ""
              }`}
            />
          )}
        </button>

        {hasMultiple && (
          <button
            type="button"
            onClick={handleNext}
            aria-label="Next provider"
            className="w-[26px] h-[26px] min-w-[26px] min-h-[26px] max-h-[26px] rounded-control flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 active:scale-95 transition-all border-none bg-transparent cursor-pointer"
          >
            <RightLine size={14} />
          </button>
        )}

        {!isCurrentPlain && (
          <>
            <div className="w-[1px] h-[14px] bg-white/15 mx-[1px]" />

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                adjustOffset(-100);
              }}
              aria-label={`${t("player.earlier")} (-0.1s)`}
              title={`${t("player.earlier")} (-0.1s)`}
              className="w-[26px] h-[26px] min-w-[26px] min-h-[26px] max-h-[26px] rounded-control flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 active:scale-95 transition-all border-none bg-transparent cursor-pointer"
            >
              <MinimizeLine size={12} />
            </button>

            <button
              type="button"
              onClick={() => {
                setDropdownOpen(false);
                setOffsetOpen((v) => !v);
              }}
              className={`flex items-center gap-[4px] h-[26px] min-h-[26px] max-h-[26px] px-[6px] rounded-control text-caption font-mono transition-all border-none bg-transparent hover:bg-white/10 cursor-pointer ${
                offsetMs !== 0
                  ? "text-white font-[600]"
                  : "text-white/80 font-[500]"
              }`}
              title={t("player.lyrics_offset")}
            >
              <TimeLine
                size={12}
                className={offsetMs !== 0 ? "text-white" : "text-white/50"}
              />
              <span>{formatOffsetBadge(offsetMs)}</span>
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                adjustOffset(100);
              }}
              aria-label={`${t("player.later")} (+0.1s)`}
              title={`${t("player.later")} (+0.1s)`}
              className="w-[26px] h-[26px] min-w-[26px] min-h-[26px] max-h-[26px] rounded-control flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 active:scale-95 transition-all border-none bg-transparent cursor-pointer"
            >
              <AddLine size={12} />
            </button>
          </>
        )}
      </div>

      <AnimatePresence>
        {dropdownOpen && hasMultiple && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute top-full left-0 mt-[6px] min-w-[140px] rounded-lg border border-white/10 bg-black/80 backdrop-blur-2xl p-[4px] z-50 flex flex-col gap-[2px] text-white"
          >
            {availableProviders.map((option, idx) => {
              const isActive = option.provider === currentProvider.provider;
              return (
                <button
                  key={option.provider}
                  type="button"
                  onClick={() => {
                    pickProvider(option.provider);
                    setDropdownOpen(false);
                  }}
                  className={`flex items-center justify-between gap-[8px] w-full px-[8px] py-[6px] rounded-control text-caption transition-colors border-none cursor-pointer text-left ${
                    isActive
                      ? "bg-white/15 text-white font-[500]"
                      : "bg-transparent text-white/70 hover:bg-white/10 hover:text-white font-[400]"
                  }`}
                >
                  <span className="truncate">{option.provider}</span>
                  <span className="flex items-center gap-[6px] shrink-0">
                    <span className="text-[10px] font-[400] text-white/40">
                      {syncLabel(option)}
                    </span>
                    {isActive ? (
                      <CheckFill size={14} className="text-white shrink-0" />
                    ) : (
                      <span className="text-[10px] font-mono text-white/40 shrink-0">
                        {idx + 1}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}

            {/* Wave 4 footer: the wrong-source remedy for the active
                source. Everything here is device-local — the mark is
                recorded in the lyrics cache on this device only, and
                nothing is sent anywhere. */}
            <div className="h-[1px] bg-white/10 mx-[4px] my-[2px]" />
            {activeMarked ? (
              <>
                <div className="px-[8px] py-[4px] text-[11px] font-[500] text-white/50">
                  {t("player.lyrics_marked_wrong") || "Marked as wrong"}
                </div>
                {switchTarget ? (
                  <button
                    type="button"
                    onClick={handleSwitchToTarget}
                    className="flex items-center w-full px-[8px] py-[6px] rounded-control text-caption font-[400] text-white/70 hover:bg-white/10 hover:text-white transition-colors border-none bg-transparent cursor-pointer text-left"
                  >
                    {t("player.lyrics_switch_to", {
                      provider: switchTarget.provider,
                    }) || `Switch to ${switchTarget.provider}`}
                  </button>
                ) : (
                  <div className="px-[8px] py-[4px] text-[11px] font-[400] text-white/50">
                    {t("player.lyrics_no_alternative") ||
                      "No other source was found for this track"}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleUnmark}
                  className="flex items-center w-full px-[8px] py-[6px] rounded-control text-caption font-[400] text-white/70 hover:bg-white/10 hover:text-white transition-colors border-none bg-transparent cursor-pointer text-left"
                >
                  {t("player.lyrics_unmark") || "Unmark"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleMarkWrong}
                className="flex items-center w-full px-[8px] py-[6px] rounded-control text-caption font-[400] text-white/70 hover:bg-white/10 hover:text-white transition-colors border-none bg-transparent cursor-pointer text-left"
              >
                {t("player.lyrics_wrong") || "These lyrics are wrong"}
              </button>
            )}
          </motion.div>
        )}

        {offsetOpen && !isCurrentPlain && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute top-full right-0 mt-[6px] w-[260px] rounded-item bg-black/80 backdrop-blur-2xl p-[12px] z-50 flex flex-col gap-[10px] text-white"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-[6px]">
                <TimeLine size={14} className="text-white" />
                <span className="text-caption font-[600] text-white">
                  {t("player.lyrics_offset")}
                </span>
              </div>
              {offsetMs !== 0 && (
                <button
                  type="button"
                  onClick={resetOffset}
                  className="inline-flex items-center gap-[4px] px-[6px] py-[2px] rounded-control text-[11px] font-[500] text-white/70 hover:text-white hover:bg-white/10 border-none bg-transparent cursor-pointer transition-colors"
                >
                  <Refresh1Line size={11} />
                  <span>{t("player.reset")}</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-[6px] bg-white/[0.06] rounded-lg p-[4px]">
              <button
                type="button"
                onClick={() => adjustOffset(unit === "ms" ? -50 : -100)}
                aria-label="Decrease offset"
                className="w-[26px] h-[26px] rounded-control flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 active:scale-95 transition-all border-none bg-transparent cursor-pointer shrink-0"
              >
                <MinimizeLine size={12} />
              </button>

              <div className="flex-1 flex items-center justify-center min-w-0">
                <input
                  type="text"
                  value={inputValue}
                  onFocus={() => {
                    isInputFocusedRef.current = true;
                  }}
                  onBlur={() => {
                    isInputFocusedRef.current = false;
                    if (unit === "ms") {
                      setInputValue(String(offsetMs));
                    } else {
                      setInputValue(String(offsetMs / 1000));
                    }
                  }}
                  onChange={(e) => handleInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      adjustOffset(unit === "ms" ? 50 : 100);
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      adjustOffset(unit === "ms" ? -50 : -100);
                    } else if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder="0"
                  className="w-full text-center text-body font-mono font-[600] text-white bg-transparent border-none outline-none p-0"
                />
              </div>

              <button
                type="button"
                onClick={() => adjustOffset(unit === "ms" ? 50 : 100)}
                aria-label="Increase offset"
                className="w-[26px] h-[26px] rounded-control flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 active:scale-95 transition-all border-none bg-transparent cursor-pointer shrink-0"
              >
                <AddLine size={12} />
              </button>

              <div className="flex items-center bg-white/10 rounded-control p-[2px] shrink-0">
                <button
                  type="button"
                  onClick={() => setUnit("ms")}
                  className={`px-[5px] py-[2px] text-[10px] font-mono rounded-[4px] border-none cursor-pointer transition-all ${
                    unit === "ms"
                      ? "bg-white/20 text-white font-[600]"
                      : "bg-transparent text-white/50 hover:text-white/80"
                  }`}
                >
                  ms
                </button>
                <button
                  type="button"
                  onClick={() => setUnit("s")}
                  className={`px-[5px] py-[2px] text-[10px] font-mono rounded-[4px] border-none cursor-pointer transition-all ${
                    unit === "s"
                      ? "bg-white/20 text-white font-[600]"
                      : "bg-transparent text-white/50 hover:text-white/80"
                  }`}
                >
                  s
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-[6px]">
              <div className="flex items-center justify-between text-[10px] font-[500] text-white/50 px-[2px]">
                <span>{t("player.earlier")} (-)</span>
                <span>{t("player.later")} (+)</span>
              </div>
              <div className="grid grid-cols-4 gap-[4px]">
                {[-1000, -500, -200, -100].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    onClick={() => adjustOffset(delta)}
                    className="py-[4px] text-[11px] font-mono rounded-control bg-white/[0.08] hover:bg-white/15 text-white/70 hover:text-white transition-all active:scale-95 text-center border-none cursor-pointer"
                  >
                    {delta / 1000}s
                  </button>
                ))}
                {[100, 200, 500, 1000].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    onClick={() => adjustOffset(delta)}
                    className="py-[4px] text-[11px] font-mono rounded-control bg-white/[0.08] hover:bg-white/15 text-white/70 hover:text-white transition-all active:scale-95 text-center border-none cursor-pointer"
                  >
                    +{delta / 1000}s
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
