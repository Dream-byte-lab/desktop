import { useEffect, useState } from "react";
import { Fader } from "./Fader";
import type {
  StageControlIntents,
  StageDeckIndex,
  StageDeckMove,
  StageDeckSnapshot,
} from "./stageSnapshot";

// One deck's performance controls (the engine seams): the tempo
// bias, the manual loop and slip roll, and the deck-move
// triggers — every control driven by the snapshot's truth and
// written through the intents, on the stage's standing
// discipline: render what the snapshot carries, never claim a
// state it doesn't. Active states (an armed loop, an open roll,
// the standing bias) are read back from the snapshot, not
// remembered locally, so what the surface shows is what the
// session holds. Local state is only the host's pending choices
// (which loop length to arm next) and the refusal notice: when
// the session refuses a trigger or a loop, the surface says so
// out loud instead of silently doing nothing.

const LOOP_BEAT_CHOICES = [4, 8, 16] as const;
const ROLL_BEAT_CHOICES = [0.5, 1, 2] as const;

const STOP_MOVES: { move: StageDeckMove; label: string }[] = [
  { move: "brake", label: "Brake" },
  { move: "vinyl-stop", label: "Vinyl stop" },
  { move: "spinback", label: "Spinback" },
];

const SCRATCH_MOVES: { move: StageDeckMove; label: string }[] = [
  { move: "baby", label: "Baby" },
  { move: "chirp", label: "Chirp" },
  { move: "transformer", label: "Transformer" },
  { move: "flare", label: "Flare" },
];

interface DeckPerformanceControlsProps {
  deck: StageDeckIndex;
  snapshot: StageDeckSnapshot;
  intents: StageControlIntents;
  /** True when this deck is the playing deck (the session's own truth). */
  live: boolean;
  /** The deck's playhead in track seconds, for arming a loop from here. */
  positionSec: number | null;
}

export function DeckPerformanceControls({
  deck,
  snapshot,
  intents,
  live,
  positionSec,
}: DeckPerformanceControlsProps) {
  const [loopBeats, setLoopBeats] = useState<number>(8);
  const [notice, setNotice] = useState<string | null>(null);

  // A refusal belongs to the track it was refused on; a new
  // track on the deck clears it.
  useEffect(() => {
    setNotice(null);
  }, [snapshot.trackId]);

  const hasSeams =
    intents.onTempoBias !== undefined ||
    intents.onManualLoop !== undefined ||
    intents.onManualRoll !== undefined ||
    intents.onDeckMove !== undefined;
  if (!hasSeams) return null;

  const biasPercent = Math.round((snapshot.tempoBias - 1) * 1000) / 10;

  const handleLoopToggle = () => {
    if (!intents.onManualLoop) return;
    if (snapshot.manualLoop) {
      intents.onManualLoop(deck, null);
      setNotice(null);
      return;
    }
    if (positionSec === null) {
      setNotice("No playhead to loop from on this deck.");
      return;
    }
    const armed = intents.onManualLoop(deck, {
      startSec: positionSec,
      beats: loopBeats,
    });
    setNotice(armed ? null : "That loop can't be armed right now.");
  };

  const handleRollToggle = (beats: number) => {
    if (!intents.onManualRoll) return;
    intents.onManualRoll(
      deck,
      snapshot.manualRollBeats === beats ? null : beats,
    );
    setNotice(null);
  };

  const handleMove = (move: StageDeckMove) => {
    if (!intents.onDeckMove) return;
    const performed = intents.onDeckMove(deck, move);
    setNotice(performed ? null : "That move can't be performed right now.");
  };

  const moveButtonClass =
    "rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-semibold text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white/[0.09]";

  return (
    <div className="mt-3 border-t border-border-primary pt-3">
      {/* Tempo bias: a standing per-deck planner correction. */}
      {intents.onTempoBias ? (
        <div className="flex items-center gap-3">
          <div className="min-w-[150px] flex-1">
            <Fader
              orientation="horizontal"
              label={`Deck ${deck + 1} tempo bias`}
              value={biasPercent}
              min={-9}
              max={15}
              onChange={(v) => intents.onTempoBias?.(deck, 1 + v / 100)}
              formatValue={(v) =>
                v === 0 ? "Neutral" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`
              }
            />
          </div>
          {snapshot.tempoBias !== 1 ? (
            <button
              type="button"
              onClick={() => intents.onTempoBias?.(deck, 1)}
              className={moveButtonClass}
            >
              Reset
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1 text-[11px] text-text-secondary">
        Tempo bias — what the planner believes this deck's tempo is; joins are
        authored against it.
      </div>

      {/* Manual loop + slip roll: hands on the playing deck. */}
      {intents.onManualLoop || intents.onManualRoll ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {intents.onManualLoop ? (
            <>
              <div className="inline-flex overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.09]">
                {LOOP_BEAT_CHOICES.map((beats) => (
                  <button
                    key={beats}
                    type="button"
                    aria-pressed={loopBeats === beats}
                    disabled={!live || !!snapshot.manualLoop}
                    onClick={() => setLoopBeats(beats)}
                    className={`cursor-pointer px-2 py-1 text-[11px] font-semibold ${
                      loopBeats === beats
                        ? "bg-black/[0.12] text-text-primary dark:bg-white/[0.18]"
                        : "text-text-secondary hover:text-text-primary"
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    {beats}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={!live && !snapshot.manualLoop}
                onClick={handleLoopToggle}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  snapshot.manualLoop
                    ? "bg-red-400/20 text-red-500"
                    : "bg-black/[0.05] text-text-secondary hover:text-text-primary dark:bg-white/[0.09]"
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {snapshot.manualLoop
                  ? `Looping ${snapshot.manualLoop.beats} beats — release`
                  : "Loop from here"}
              </button>
            </>
          ) : null}
          {intents.onManualRoll ? (
            <>
              <span className="text-[11px] font-semibold text-text-secondary">
                Roll
              </span>
              {ROLL_BEAT_CHOICES.map((beats) => (
                <button
                  key={beats}
                  type="button"
                  aria-pressed={snapshot.manualRollBeats === beats}
                  disabled={!live}
                  onClick={() => handleRollToggle(beats)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    snapshot.manualRollBeats === beats
                      ? "bg-red-400/20 text-red-500"
                      : "bg-black/[0.05] text-text-secondary hover:text-text-primary dark:bg-white/[0.09]"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {beats}
                </button>
              ))}
            </>
          ) : null}
        </div>
      ) : null}

      {/* Deck moves: the R1 stops and R2 scratches, by hand. */}
      {intents.onDeckMove ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {STOP_MOVES.map(({ move, label }) => (
            <button
              key={move}
              type="button"
              disabled={!live}
              onClick={() => handleMove(move)}
              className={moveButtonClass}
            >
              {label}
            </button>
          ))}
          <span className="text-[11px] font-semibold text-text-secondary">
            Scratch
          </span>
          {SCRATCH_MOVES.map(({ move, label }) => (
            <button
              key={move}
              type="button"
              disabled={!live}
              onClick={() => handleMove(move)}
              className={moveButtonClass}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {!live && snapshot.trackId === null ? (
        <div className="mt-2 text-[11px] text-text-tertiary">
          This deck holds no track — a prepared track waits in memory, not on
          the deck, until a join performs it here.
        </div>
      ) : null}
      {notice ? (
        <div className="mt-2 text-[11px] text-red-500">{notice}</div>
      ) : null}
    </div>
  );
}
