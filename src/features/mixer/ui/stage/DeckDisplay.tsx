// One deck's readout: which deck, what role it holds tonight, the
// track on it, and the numbers a DJ glances at — tempo (with an
// honest low-confidence note when the analysis is unsure), key, and
// elapsed / remaining time. Pure render.

import { STANDARD_PROFILE } from "../../engine/decisionProfile";

interface DeckDisplayProps {
  deckLabel: string;
  role: string;
  title: string | null;
  artists: string | null;
  bpm: number | null;
  tempoConfidence: number | null;
  keyLabel: string | null;
  elapsedSec: number | null;
  durationSec: number | null;
}

function formatTime(totalSec: number): string {
  const safe = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function DeckDisplay({
  deckLabel,
  role,
  title,
  artists,
  bpm,
  tempoConfidence,
  keyLabel,
  elapsedSec,
  durationSec,
}: DeckDisplayProps) {
  // The note means "below the STANDARD mixing floor": under the
  // standard profile's minimum tempo confidence the planner will
  // not beatmatch this track at all. The line is the floor itself,
  // not a display-side guess — and it sits on the repaired
  // mean-centred confidence scale (note27-c2-fix.md): the old 0.5
  // line belonged to the uncentred statistic, on which a real
  // song reads ~0.17 and wore this label while mixing fine.
  const lowConfidence =
    tempoConfidence !== null &&
    tempoConfidence < STANDARD_PROFILE.minTempoConfidence;
  const remainingSec =
    elapsedSec !== null && durationSec !== null
      ? Math.max(0, durationSec - elapsedSec)
      : null;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
          {deckLabel} · {role}
        </span>
      </div>
      <div className="truncate text-sm font-semibold text-text-primary">
        {title ?? "—"}
      </div>
      <div className="truncate text-xs text-text-secondary">
        {artists ?? ""}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-text-secondary">
        <span>
          {bpm !== null ? `${bpm.toFixed(1)} BPM` : "— BPM"}
          {lowConfidence ? (
            <span style={{ color: "var(--accent-warning)" }}>
              {" "}
              (low confidence)
            </span>
          ) : null}
        </span>
        {keyLabel ? (
          <span style={{ color: "var(--accent-secondary)" }}>{keyLabel}</span>
        ) : null}
        <span>
          {elapsedSec !== null ? formatTime(elapsedSec) : "—:—"}
          {remainingSec !== null ? ` / -${formatTime(remainingSec)}` : ""}
          {durationSec !== null ? ` of ${formatTime(durationSec)}` : ""}
        </span>
      </div>
    </div>
  );
}
