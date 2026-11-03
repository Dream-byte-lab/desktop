import type { StageCue } from "./stageData";

// The performance pads: eight slots in a 4x2 grid over the deck's
// cues (analysis landmarks merged with the listener's own cues by
// the parent). On the live deck each filled pad is a button that
// fires its cue; on the standby deck the same slots are display
// chips — a pad you cannot press cannot lie about what it does.
// Under a live deck, the owner can also drop a cue at the current
// position or clear the deck track's own cues.

interface PadGridProps {
  cues: StageCue[];
  live: boolean;
  onFire?: (cue: StageCue) => void;
  onSetCue?: () => void;
  canSetCue?: boolean;
  onClearCues?: () => void;
}

function formatTime(totalSec: number): string {
  const safe = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const KIND_DOT: Record<StageCue["kind"], string> = {
  intro: "rgba(148,140,190,0.9)",
  section: "rgba(148,140,190,0.9)",
  drop: "rgba(63,214,143,0.95)",
  outro: "rgba(148,140,190,0.9)",
  user: "var(--accent-warning)",
};

export function PadGrid({
  cues,
  live,
  onFire,
  onSetCue,
  canSetCue,
  onClearCues,
}: PadGridProps) {
  const slots: (StageCue | null)[] = Array.from(
    { length: 8 },
    (_, i) => cues[i] ?? null,
  );

  return (
    <div>
      <div className="grid grid-cols-4 gap-1.5">
        {slots.map((cue, index) => {
          if (!cue) {
            return (
              <div
                key={`empty-${index}`}
                className="flex h-11 items-center justify-center rounded-md border border-dashed border-border-primary text-[10px] tabular-nums text-text-tertiary"
                aria-hidden="true"
              >
                {index + 1}
              </div>
            );
          }
          const body = (
            <>
              <span className="flex min-w-0 items-center gap-1">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: KIND_DOT[cue.kind] }}
                  aria-hidden="true"
                />
                <span className="truncate">{cue.label}</span>
              </span>
              <span className="tabular-nums text-text-secondary">
                {formatTime(cue.timeSec)}
              </span>
            </>
          );
          if (live) {
            return (
              <button
                key={cue.id}
                type="button"
                onClick={() => onFire?.(cue)}
                className="flex h-11 flex-col items-start justify-center gap-0.5 rounded-md border border-border-secondary bg-black/[0.04] px-2 text-left text-[10px] font-semibold text-text-primary transition-colors hover:bg-black/[0.08] dark:bg-white/[0.05] dark:hover:bg-white/[0.1]"
                title={`Jump to ${cue.label} at ${formatTime(cue.timeSec)}`}
              >
                {body}
              </button>
            );
          }
          return (
            <div
              key={cue.id}
              className="flex h-11 flex-col items-start justify-center gap-0.5 rounded-md border border-border-primary px-2 text-[10px] font-semibold text-text-secondary"
            >
              {body}
            </div>
          );
        })}
      </div>

      {canSetCue ? (
        <div className="mt-1.5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => onSetCue?.()}
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-text-primary"
            style={{ background: "var(--accent-primary)", color: "#fff" }}
          >
            Set cue here
          </button>
          {onClearCues ? (
            <button
              type="button"
              onClick={() => onClearCues()}
              className="text-[11px] font-medium text-text-secondary underline-offset-2 hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
