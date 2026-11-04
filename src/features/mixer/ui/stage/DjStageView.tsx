import { useEffect, useMemo, useRef, useState } from "react";
import type { Track } from "@/shared/types";
import { usePlayerStore } from "../../../player/store/playerStore";
import type { TrackAnalysis } from "../../engine/analyseTrack";
import { djSession } from "../../engine/djSession";
import { preparedTrack, type PreparedTrack } from "../../engine/trackSource";
import type { DeckIndex } from "../../engine/twoDeckMixer";
import { useDjModeStore } from "../../store/djModeStore";
import { ActivityStrip } from "./ActivityStrip";
import { ControlLevelSwitcher } from "./ControlLevelSwitcher";
import { DeckDisplay } from "./DeckDisplay";
import { DeckPerformanceControls } from "./DeckPerformanceControls";
import { Fader } from "./Fader";
import { JogWheel } from "./JogWheel";
import { PadGrid } from "./PadGrid";
import { PersonalityPanel } from "./PersonalityPanel";
import { StageBackButton } from "./StageBackButton";
import { StageBackCoverProbe } from "./StageBackCoverProbe";
import {
  activityLinesForStage,
  deckRoleLabel,
  landmarkCues,
  sectionSpans,
  waveformBars,
  type ActivitySnapshot,
  type SectionSpan,
  type StageCue,
  type WaveBar,
} from "./stageData";
import type { StageControlIntents } from "./stageSnapshot";
import { StageSnapshotControls } from "./StageSnapshotControls";
import { clearUserCues, loadUserCues, saveUserCue } from "./userCues";
import { WaveformStrip } from "./WaveformStrip";

// The DJ stage (the Pro view's successor): a battle layout — two
// deck panels around a centre mixer — built on the session's
// seams. Each deck panel is driven by the snapshot's per-deck
// truth (the engine seams): the playing deck shows the current
// track, and during a sounding join the other panel shows the
// standing incoming — the track actually sounding on that deck,
// with its own playhead — through the session's standingIncoming
// getter. Outside a join the standby panel shows the queue's
// next track, labelled by deckRoleLabel as "next in queue",
// never that the track is loaded on the deck (preparation is
// in-memory; the snapshot's trackId says null and the panel says
// so). Everything hands-on writes through the session's public
// manual stage (crossfade, per-deck trim and bass cut), its
// public seek, and the engine seams (control level, tempo bias,
// manual loop/roll, deck-move triggers); everything read comes
// from the session's public getters, the player store, and the
// prepared-track cache. The snapshot controls are wired to the
// session's stageSnapshot exposure (EQ/filter/FX/curve through
// the manual setters). There is no master control here on
// purpose: no such seam exists in the manual stage, and the
// player's own volume lives in the player bar. The stage has its
// own way back (Note 25): the StageBackButton closes the view
// from inside it, in both of the stage's states, and closing the
// view never touches the session.

interface DeckStageData {
  prepared: PreparedTrack | undefined;
  analysis: TrackAnalysis | null;
  bars: WaveBar[];
  sections: SectionSpan[];
  cues: StageCue[];
  bpm: number | null;
  keyLabel: string | null;
  tempoConfidence: number | null;
  durationSec: number | null;
}

function useDeckStageData(
  track: Track | null,
  cueVersion: number,
  slowTick: number,
): DeckStageData {
  const trackId = track?.id;
  const trackDurationMs = track?.durationMs;
  return useMemo(() => {
    // slowTick is a deliberate dependency: the prepared cache fills
    // in behind the UI, and the twice-a-second tick is what lets a
    // deck pick its analysis up when it lands.
    void slowTick;
    const prepared = trackId ? preparedTrack(trackId) : undefined;
    const analysis = prepared?.analysis ?? null;
    const bars = analysis ? waveformBars(analysis, 96) : [];
    const sections = analysis ? sectionSpans(analysis) : [];
    const landmarks = analysis ? landmarkCues(analysis) : [];
    const user: StageCue[] = trackId
      ? loadUserCues(trackId).map((cue, i) => ({
          id: `user-${trackId}-${i}-${cue.timeSec}`,
          timeSec: cue.timeSec,
          label: cue.label,
          kind: "user" as const,
        }))
      : [];
    const cues = [...landmarks, ...user]
      .sort((a, z) => a.timeSec - z.timeSec)
      .slice(0, 8);
    const bpm =
      analysis && analysis.beatMap.bpm > 0 ? analysis.beatMap.bpm : null;
    const keyLabel = analysis?.key
      ? `${analysis.key.camelot} (${analysis.key.tonic} ${analysis.key.mode})`
      : null;
    const durationSec = prepared
      ? prepared.buffer.duration
      : trackDurationMs
        ? trackDurationMs / 1000
        : null;
    return {
      prepared,
      analysis,
      bars,
      sections,
      cues,
      bpm,
      keyLabel,
      tempoConfidence: analysis ? analysis.tempoConfidence : null,
      durationSec,
    };
  }, [trackId, trackDurationMs, cueVersion, slowTick]);
}

export function DjStageView() {
  const active = useDjModeStore((state) => state.active);
  const proOpen = useDjModeStore((state) => state.proOpen);
  const blending = useDjModeStore((state) => state.blending);
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const queue = usePlayerStore((state) => state.queue);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const positionMs = usePlayerStore((state) => state.positionMs);
  const durationMs = usePlayerStore((state) => state.durationMs);
  const status = usePlayerStore((state) => state.status);
  const nextTrack = queue[currentIndex + 1] ?? null;

  // --- interpolated playhead -------------------------------------
  // The store's position is written on the session's tick, which is
  // far too coarse for a jog wheel and a playhead. Anchor each store
  // position to the wall clock and interpolate between anchors;
  // while paused the position simply holds at the anchor.
  const anchorRef = useRef({ posMs: positionMs, at: performance.now() });
  const statusRef = useRef(status);
  statusRef.current = status;
  const [displayPosMs, setDisplayPosMs] = useState(positionMs);
  const jogTargetRef = useRef<number | null>(null);
  // The Back pill's element, shared with the Note 26 cover probe:
  // the probe asks the running document what sits on top of the
  // pill and names it in the header if anything foreign does.
  const backButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    anchorRef.current = { posMs: positionMs, at: performance.now() };
  }, [positionMs]);

  useEffect(() => {
    jogTargetRef.current = null;
  }, [currentTrack?.id]);

  useEffect(() => {
    if (!active || !proOpen) return;
    let raf = 0;
    const loop = () => {
      const anchor = anchorRef.current;
      const pos =
        statusRef.current === "playing"
          ? anchor.posMs + (performance.now() - anchor.at)
          : anchor.posMs;
      setDisplayPosMs(pos);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, proOpen]);

  // --- slow tick: session getters are plain reads, re-read twice
  // a second so the activity strip and the prepared states stay
  // honest without subscribing to anything that does not exist.
  const [slowTick, setSlowTick] = useState(0);
  useEffect(() => {
    if (!active || !proOpen) return;
    const id = setInterval(() => setSlowTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [active, proOpen]);

  // --- manual stage state (the old Pro view's pattern) ------------
  const [crossfade, setCrossfadeState] = useState(0);
  const [trims, setTrims] = useState<[number, number]>([100, 100]);
  const [bassCut, setBassCut] = useState<[boolean, boolean]>([false, false]);
  const [cueVersion, setCueVersion] = useState(0);

  // --- the snapshot's per-deck truth (the engine seams) ---------
  // Read once per render, before the deck-data hooks, because the
  // panels are keyed to it: a deck whose snapshot names the
  // current track is the playing deck; a deck the standing
  // incoming names is sounding the incoming; any other standby
  // panel falls back to the queue's next track, labelled as such.
  const playingDeck: DeckIndex = djSession.currentDeckIndex;
  const stageSnap = djSession.stageSnapshot();
  const standing = djSession.standingIncoming;
  const panelTrack = (index: DeckIndex): Track | null => {
    const snapTrackId = stageSnap?.decks[index].trackId ?? null;
    if (
      snapTrackId !== null &&
      currentTrack &&
      snapTrackId === currentTrack.id
    ) {
      return currentTrack;
    }
    if (standing && standing.deckIndex === index) return standing.track;
    return index === playingDeck ? currentTrack : nextTrack;
  };
  const data0 = useDeckStageData(panelTrack(0), cueVersion, slowTick);
  const data1 = useDeckStageData(panelTrack(1), cueVersion, slowTick);

  if (!proOpen) return null;
  if (!active) {
    // The panel was left open as a set ended: the personality
    // panel stays reachable on its own, in the stage's frame —
    // with the way back mounted here too (Note 25: the trap
    // existed in this state as much as in the live one).
    return (
      <div className="w-full border-t border-border-tertiary bg-bg-primary px-3 py-3 text-text-primary">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <StageBackButton buttonRef={backButtonRef} />
          <StageBackCoverProbe targetRef={backButtonRef} />
        </div>
        <PersonalityPanel />
      </div>
    );
  }

  const displayPosSec = displayPosMs / 1000;

  const onCrossfade = (value: number) => {
    setCrossfadeState(value);
    djSession.setCrossfade(value / 50);
  };
  const onTrim = (index: DeckIndex, percent: number) => {
    const next: [number, number] = [...trims];
    next[index] = percent;
    setTrims(next);
    djSession.setDeckTrim(index, percent / 100);
  };
  const onBassCut = (index: DeckIndex) => {
    const next: [boolean, boolean] = [...bassCut];
    next[index] = !next[index];
    setBassCut(next);
    djSession.setDeckBassCut(index, next[index]);
  };

  const handleNudge = (deltaSec: number) => {
    const limitMs =
      durationMs > 0
        ? durationMs
        : data0.prepared && playingDeck === 0
          ? data0.prepared.buffer.duration * 1000
          : data1.prepared && playingDeck === 1
            ? data1.prepared.buffer.duration * 1000
            : 0;
    const base = jogTargetRef.current ?? displayPosMs;
    const target = Math.min(
      Math.max(0, limitMs > 100 ? limitMs - 100 : limitMs),
      Math.max(0, base + deltaSec * 1000),
    );
    jogTargetRef.current = target;
    djSession.seekTo(target);
  };

  const handleWaveformSeek = (sec: number) => {
    jogTargetRef.current = sec * 1000;
    djSession.seekTo(sec * 1000);
  };

  const handleFireCue = (cue: StageCue) => {
    jogTargetRef.current = cue.timeSec * 1000;
    djSession.seekTo(cue.timeSec * 1000);
  };

  const handleSetCue = (track: Track) => {
    const existing = loadUserCues(track.id);
    saveUserCue(track.id, {
      timeSec: Math.max(0, displayPosSec),
      label: `Cue ${existing.length + 1}`,
    });
    setCueVersion((v) => v + 1);
  };

  const handleClearCues = (track: Track) => {
    clearUserCues(track.id);
    setCueVersion((v) => v + 1);
  };

  // --- activity strip ---------------------------------------------
  const running = djSession.isRunning;
  const snapshot: ActivitySnapshot = {
    running,
    paused: djSession.isPaused,
    blending,
    degraded: djSession.degraded,
    plainCutCount: djSession.plainCutCount,
    currentTitle: currentTrack?.title ?? null,
    nextTitle: nextTrack?.title ?? null,
    nextPrepared: nextTrack ? !!preparedTrack(nextTrack.id) : false,
    openRequestCount: djSession.liveRaveOpenRequests.length,
    endReason: djSession.endReason,
  };
  const lines = activityLinesForStage(snapshot, stageSnap?.currentMove ?? null);
  // The level is the session's standing state now (the engine
  // seams): the strip's label reads it, the switcher writes it.
  const controlLevel = stageSnap?.controlLevel ?? djSession.controlLevel;
  const levelLabel = !running
    ? "Manual — DJ off"
    : controlLevel === "assisted"
      ? "Assisted — the brain drives, your grabs hold"
      : controlLevel === "manual"
        ? "Manual — your hands rule the decks"
        : "Fully autonomous";

  const stageIntents: StageControlIntents = {
    onTrimChange: (deck, ratio) => onTrim(deck as DeckIndex, ratio * 100),
    onEqChange: (deck, band, db) => {
      djSession.setDeckEq(deck, band, db);
    },
    onFilterChange: (deck, hz) => {
      djSession.setDeckFilter(deck, hz);
    },
    onCrossfaderCurveChange: (curve) => {
      djSession.setCrossfaderCurve(curve);
    },
    onFxAssign: (kind, assign) => {
      djSession.setFxAssign(kind, assign);
    },
    onFxWetLevel: (kind, side, level) => {
      djSession.setFxSendLevel(kind, side, level);
    },
    onControlLevel: (level) => {
      djSession.setControlLevel(level);
    },
    onTempoBias: (deck, ratio) => {
      djSession.setDeckTempoBias(deck, ratio);
    },
    onManualLoop: (deck, region) => djSession.setManualLoop(deck, region),
    onManualRoll: (deck, beats) => {
      djSession.setManualRoll(deck, beats);
    },
    onDeckMove: (deck, move) => djSession.triggerDeckMove(deck, move),
  };

  const renderDeck = (index: DeckIndex) => {
    const track = panelTrack(index);
    const data = index === 0 ? data0 : data1;
    const snapDeck = stageSnap?.decks[index] ?? null;
    // The deck sounding the store's current track is the playing
    // deck (the snapshot's truth, not the mixer's flipped
    // current); the deck the standing incoming names is sounding
    // the incoming. With no snapshot (no session) the mixer's
    // current deck is the fallback, as before the seams.
    const isPlaying = stageSnap
      ? !!track &&
        !!currentTrack &&
        snapDeck?.trackId === currentTrack.id &&
        track.id === currentTrack.id
      : index === playingDeck;
    const isStanding = !!standing && standing.deckIndex === index;
    const effectiveDurationSec =
      (isPlaying && durationMs > 0 ? durationMs / 1000 : null) ??
      data.durationSec ??
      data.analysis?.beatMap.durationSec ??
      0;
    const elapsedSec = isPlaying
      ? effectiveDurationSec > 0
        ? Math.min(displayPosSec, effectiveDurationSec)
        : displayPosSec
      : isStanding
        ? (snapDeck?.positionSec ?? null)
        : null;

    return (
      <div
        key={index}
        className="min-w-[280px] flex-1 rounded-lg border border-border-primary p-3"
      >
        <DeckDisplay
          deckLabel={`Deck ${index + 1}`}
          role={deckRoleLabel({ isPlaying, blending: isStanding })}
          title={track?.title ?? null}
          artists={track?.artists ?? null}
          bpm={data.bpm}
          tempoConfidence={data.tempoConfidence}
          keyLabel={data.keyLabel}
          elapsedSec={elapsedSec}
          durationSec={effectiveDurationSec > 0 ? effectiveDurationSec : null}
        />

        <div className="mt-2">
          {!track ? (
            <div className="flex h-14 items-center justify-center rounded-md border border-border-primary text-xs text-text-tertiary">
              No track
            </div>
          ) : !data.prepared ? (
            <div className="flex h-14 items-center justify-center rounded-md border border-border-primary text-xs text-text-secondary">
              Analysis not ready
            </div>
          ) : (
            <WaveformStrip
              bars={data.bars}
              sections={data.sections}
              durationSec={effectiveDurationSec}
              positionSec={
                isPlaying
                  ? displayPosSec
                  : isStanding
                    ? (snapDeck?.positionSec ?? null)
                    : null
              }
              onSeek={isPlaying ? handleWaveformSeek : undefined}
            />
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-start gap-3">
          <JogWheel
            positionSec={
              isPlaying
                ? displayPosSec
                : isStanding
                  ? (snapDeck?.positionSec ?? 0)
                  : 0
            }
            durationSec={effectiveDurationSec}
            playing={
              isPlaying
                ? status === "playing"
                : isStanding &&
                  status === "playing" &&
                  snapDeck?.positionSec != null
            }
            bpm={data.bpm}
            keyLabel={data.keyLabel}
            interactive={isPlaying}
            onNudge={isPlaying ? handleNudge : undefined}
            size={148}
          />
          <div className="min-w-[180px] flex-1">
            <PadGrid
              cues={data.cues}
              live={isPlaying}
              onFire={isPlaying ? handleFireCue : undefined}
              canSetCue={isPlaying && !!track}
              onSetCue={
                isPlaying && track ? () => handleSetCue(track) : undefined
              }
              onClearCues={
                isPlaying && track ? () => handleClearCues(track) : undefined
              }
            />
          </div>
        </div>

        {stageSnap && snapDeck ? (
          <DeckPerformanceControls
            deck={index}
            snapshot={snapDeck}
            intents={stageIntents}
            live={isPlaying}
            positionSec={isPlaying ? displayPosSec : snapDeck.positionSec}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className="w-full border-t border-border-tertiary bg-bg-primary px-3 py-3 text-text-primary">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <StageBackButton buttonRef={backButtonRef} />
          <StageBackCoverProbe targetRef={backButtonRef} />
        </div>
        <ControlLevelSwitcher level={controlLevel} intents={stageIntents} />
      </div>

      <div className="mb-3">
        <PersonalityPanel />
      </div>

      <ActivityStrip lines={lines} levelLabel={levelLabel} />

      <div className="mt-3 flex flex-wrap items-stretch gap-3">
        {renderDeck(0)}

        {/* Centre mixer: two channel strips and the crossfader.
            No master control — the manual stage has no such seam. */}
        <div className="flex w-full flex-col gap-3 rounded-lg border border-border-primary p-3 sm:w-[228px]">
          <div className="flex items-start justify-around gap-2">
            {([0, 1] as DeckIndex[]).map((index) => (
              <div key={index} className="flex flex-col items-center gap-2">
                <Fader
                  orientation="vertical"
                  label={`CH ${index + 1} Trim`}
                  value={trims[index]}
                  min={0}
                  max={125}
                  onChange={(v) => onTrim(index, v)}
                  formatValue={(v) => `${Math.round(v)}%`}
                />
                <button
                  type="button"
                  aria-pressed={bassCut[index]}
                  onClick={() => onBassCut(index)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    bassCut[index]
                      ? "bg-red-400/20 text-red-500"
                      : "bg-black/[0.05] text-text-secondary dark:bg-white/[0.09]"
                  }`}
                >
                  Bass {bassCut[index] ? "killed" : "on"}
                </button>
              </div>
            ))}
          </div>

          <div>
            <Fader
              orientation="horizontal"
              label="Crossfader"
              value={crossfade}
              min={-50}
              max={50}
              onChange={onCrossfade}
              formatValue={(v) =>
                v === 0
                  ? "Centre"
                  : v < 0
                    ? `◀ ${Math.round(-v)}`
                    : `${Math.round(v)} ▶`
              }
            />
            <div className="mt-1 text-center text-[11px] text-text-secondary">
              {crossfade === 0
                ? "Centre — the automation is untouched"
                : crossfade < 0
                  ? "Leaning to Deck 1"
                  : "Leaning to Deck 2"}
            </div>
          </div>
        </div>

        {renderDeck(1)}
      </div>

      {stageSnap ? (
        <div className="mt-3">
          <StageSnapshotControls
            snapshot={stageSnap}
            trims={[trims[0] / 100, trims[1] / 100]}
            intents={stageIntents}
          />
        </div>
      ) : null}
    </div>
  );
}
