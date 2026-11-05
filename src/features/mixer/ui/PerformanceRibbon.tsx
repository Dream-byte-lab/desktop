// PerformanceRibbon.tsx — the Performance Ribbon (§10.2): the
// automatic DJ's default face, "the booth at night".
//
// A full-width performing band above the player bar, three zones:
// - NOW: the live join as two overlapping ribbons. The ribbons are
//   the drawn recipe's real gain curves (recipe.ts keyframes in
//   beat space, sampled here) — outgoing draining, incoming rising
//   — with the technique named in large type from
//   stageSnapshot().currentMove. Mid-track (no join sounding) it
//   shows the playing track with its position and its energy level
//   from setArc. The session exposes NO per-track energy contour,
//   so no contour is drawn — that absence is stated, not faked.
// - NEXT: the authored next join from session.nextJoinPreview —
//   family/technique, target track, suitability, pool size, and
//   WHY chips from the recipe's own authored evidence components.
// - THE NIGHT SO FAR: performed joins as glyphs from the behaviour
//   record (fallbacks labelled FALLBACK with their reason) over
//   the set's energy skyline (session.setArc).
// Right end: the DJ's transport and the DJ switch. DJ off renders
// nothing at all — the plain player is untouched.

import { useMemo } from "react";
import { Pause, Play, SkipNext, SkipPrevious } from "@solar-icons/react";
import {
  liveRaveSession,
  type LiveRaveSession,
} from "@/features/mixer/liverave/session";
import { useDjState } from "@/features/mixer/liverave/state";
import { valueAt, type KeyframedCurve } from "@/features/mixer/liverave/recipe";
import { noteDeliberateStop } from "@/features/mixer/liverave/wiring";
import { usePlayerStore } from "@/features/player/store/playerStore";
import {
  distributionOf,
  evidenceChips,
  formatClock,
  isFallbackReason,
  moveLabel,
  useSessionView,
} from "./sessionView";

const BAND =
  "relative w-full overflow-hidden rounded-t-item text-[#f2f0f7] " +
  "bg-[linear-gradient(160deg,#1d1529_0%,#17121f_55%,#120e1a_100%)]";

function ribbonPoints(curve: KeyframedCurve, overlapBeats: number): string {
  const beats = Math.max(1, overlapBeats);
  const points: string[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i += 1) {
    const beat = (i / steps) * beats;
    const x = (i / steps) * 100;
    const y = 34 - Math.min(1, Math.max(0, valueAt(curve, beat))) * 30;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(" ");
}

export function PerformanceRibbon({
  session = liveRaveSession,
}: {
  session?: LiveRaveSession;
}) {
  const active = useDjState((state) => state.active);
  const blending = useDjState((state) => state.blending);
  const intent = useDjState((state) => state.intent);
  const setIntent = useDjState((state) => state.setIntent);
  const setProOpen = useDjState((state) => state.setProOpen);
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const smartGuestIds = usePlayerStore((state) => state.smartGuestIds);

  const view = useSessionView(session, active);
  const preview = view.preview;
  const move = view.snapshot?.currentMove ?? null;

  const distribution = useMemo(
    () => distributionOf(view.behaviour),
    [view.behaviour],
  );

  if (!active) return null;

  const deckA = view.snapshot?.decks[0] ?? null;
  const durationMs = currentTrack?.durationMs ?? 0;
  const positionMs = deckA?.positionMs ?? 0;
  const progress =
    durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  const currentEnergy =
    view.arc.played.length > 0
      ? view.arc.played[view.arc.played.length - 1]
      : null;
  const paused = session.isPaused;

  const switchOff = () => {
    setIntent(false);
    noteDeliberateStop();
    session.stop();
    usePlayerStore.getState().setStatus("paused");
  };

  return (
    <section
      aria-label="DJ performance ribbon"
      data-testid="performance-ribbon"
      className={BAND}
    >
      <div className="flex flex-wrap items-stretch gap-x-6 gap-y-3 px-4 py-3">
        {/* NOW ---------------------------------------------------- */}
        <div className="min-w-[220px] flex-1" data-ribbon-zone="now">
          <p className="text-[10px] font-semibold tracking-[0.22em] text-white/45 uppercase">
            Now
          </p>
          {blending && move ? (
            <>
              <p
                className="mt-0.5 text-2xl leading-none font-black tracking-tight text-white"
                data-now-move
              >
                {moveLabel(move.family, move.technique)}
              </p>
              <p className="mt-1 text-xs text-white/60">{move.label}</p>
            </>
          ) : currentTrack ? (
            <>
              <p
                className="mt-0.5 truncate text-2xl leading-none font-black tracking-tight text-white"
                data-now-track
              >
                {currentTrack.title}
              </p>
              <p className="mt-1 text-xs text-white/60">
                {currentTrack.artists} · {formatClock(positionMs)}
                {durationMs > 0 ? ` / ${formatClock(durationMs)}` : ""}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-white/60">Preparing the set…</p>
          )}

          {blending && preview ? (
            <svg
              viewBox="0 0 100 36"
              preserveAspectRatio="none"
              className="mt-2 h-9 w-full"
              role="img"
              aria-label="Live join curves: outgoing gain draining, incoming gain rising, from the drawn recipe"
              data-now-ribbons
            >
              <polyline
                points={ribbonPoints(
                  preview.recipe.curves.gainA,
                  preview.recipe.overlapBeats,
                )}
                fill="none"
                stroke="#9d8cff"
                strokeWidth="1.6"
                opacity="0.75"
              />
              <polyline
                points={ribbonPoints(
                  preview.recipe.curves.gainB,
                  preview.recipe.overlapBeats,
                )}
                fill="none"
                stroke="#ffb300"
                strokeWidth="1.6"
              />
            </svg>
          ) : blending ? (
            <p className="mt-2 text-[11px] text-white/45">
              Join sounding — the session no longer holds its recipe preview, so
              no curves are drawn.
            </p>
          ) : (
            <div className="mt-2" data-now-progress>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-[#9d8cff]"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-white/45">
                {currentEnergy !== null
                  ? `Energy level ${Math.round(currentEnergy * 100)}% from this track's read · the session exposes no energy contour, so none is drawn`
                  : "Energy read for this track is not available yet"}
              </p>
            </div>
          )}
        </div>

        {/* NEXT --------------------------------------------------- */}
        <div className="min-w-[220px] flex-1" data-ribbon-zone="next">
          <p className="text-[10px] font-semibold tracking-[0.22em] text-white/45 uppercase">
            Next
          </p>
          {preview ? (
            <div data-next-join>
              <p className="mt-0.5 text-lg leading-tight font-extrabold tracking-tight text-white">
                {moveLabel(preview.family, preview.technique)}
                <span className="font-semibold text-white/70">
                  {" "}
                  into {preview.trackTitle}
                </span>
                {smartGuestIds.includes(preview.trackId) && (
                  <span
                    title="Added by Smart Shuffle — not part of this playlist"
                    className="ml-2 align-middle rounded-full border border-white/25 px-2 py-[1px] text-[10px] font-medium tracking-wide text-white/60 uppercase"
                  >
                    Guest
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-[11px] text-white/55">
                Suitability {Math.round(preview.suitability * 100)}% · drawn
                from a pool of {preview.poolSize}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1" data-next-why>
                {evidenceChips(preview.recipe.authored.evidence).map((chip) => (
                  <span
                    key={chip.key}
                    className="rounded-full border border-white/15 bg-white/[0.06] px-2 py-0.5 text-[10px] text-white/75"
                  >
                    {chip.label} {Math.round(chip.value * 100)}%
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-1 text-sm text-white/60" data-next-empty>
              No join drawn yet — the DJ is still preparing or authoring the
              next move.
            </p>
          )}
        </div>

        {/* THE NIGHT SO FAR --------------------------------------- */}
        <div className="min-w-[220px] flex-1" data-ribbon-zone="night">
          <p className="text-[10px] font-semibold tracking-[0.22em] text-white/45 uppercase">
            The night so far
          </p>
          {view.behaviour.length > 0 ? (
            <ol
              className="mt-1.5 flex flex-wrap items-center gap-1"
              data-set-timeline
            >
              {view.behaviour.map((record, i) => (
                <li
                  key={`${record.at}-${i}`}
                  data-timeline-glyph={
                    isFallbackReason(record.reason) ? "fallback" : record.reason
                  }
                  title={`${record.pairTrackIds[0]} → ${record.pairTrackIds[1]} · ${record.reason}`}
                  className={
                    isFallbackReason(record.reason)
                      ? "rounded border border-dashed border-white/30 px-1.5 py-0.5 text-[10px] font-semibold text-white/60"
                      : "rounded bg-white/[0.09] px-1.5 py-0.5 text-[10px] font-semibold text-white/85"
                  }
                >
                  {isFallbackReason(record.reason)
                    ? `FALLBACK · ${record.reason}`
                    : moveLabel(record.family, record.technique) ||
                      record.reason}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-[11px] text-white/45" data-timeline-empty>
              No joins performed yet tonight.
            </p>
          )}
          {distribution.total > 0 && (
            <p className="mt-1 text-[10px] text-white/40">
              {distribution.total} recorded ·{" "}
              {Object.entries(distribution.byReason)
                .map(([reason, count]) => `${reason} ${count}`)
                .join(" · ")}
            </p>
          )}
          <div
            className="mt-2 flex h-7 items-end gap-[2px]"
            data-energy-skyline
            role="img"
            aria-label="Energy skyline of played and upcoming tracks"
          >
            {[...view.arc.played, ...view.arc.upcoming].length === 0 ? (
              <span className="text-[11px] text-white/45">
                No energy reads yet — tracks are still being prepared.
              </span>
            ) : (
              <>
                {view.arc.played.map((energy, i) => (
                  <span
                    key={`p-${i}`}
                    className="w-2 rounded-sm bg-[#9d8cff]/70"
                    style={{ height: `${Math.max(12, energy * 100)}%` }}
                  />
                ))}
                {view.arc.upcoming.map((energy, i) => (
                  <span
                    key={`u-${i}`}
                    className="w-2 rounded-sm border border-white/35 bg-transparent"
                    style={{ height: `${Math.max(12, energy * 100)}%` }}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {/* Transport + switch -------------------------------------- */}
        <div
          className="flex items-center gap-2 self-center"
          data-ribbon-transport
        >
          <button
            type="button"
            aria-label="Previous track"
            onClick={() => session.skipPrevious()}
            className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/[0.08] text-white transition-transform active:scale-95"
          >
            <SkipPrevious size={18} />
          </button>
          <button
            type="button"
            aria-label={paused ? "Resume the set" : "Pause the set"}
            onClick={() => (paused ? session.resume() : session.pause())}
            className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-white text-[#17121f] transition-transform active:scale-95"
          >
            {paused ? <Play size={20} /> : <Pause size={20} />}
          </button>
          <button
            type="button"
            aria-label="Next track"
            onClick={() => session.skipNext()}
            className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/[0.08] text-white transition-transform active:scale-95"
          >
            <SkipNext size={18} />
          </button>
          <button
            type="button"
            onClick={() => setProOpen(true)}
            className="ml-1 cursor-pointer rounded-full border border-white/20 px-3 py-2 text-[11px] font-bold tracking-[0.14em] text-white/85 uppercase"
          >
            Booth
          </button>
          <button
            type="button"
            aria-label="Switch DJ off"
            aria-pressed={intent}
            onClick={switchOff}
            className="cursor-pointer rounded-full bg-[#ff3d81]/20 px-3 py-2 text-[11px] font-bold tracking-[0.14em] text-[#ff8fb8] uppercase"
          >
            DJ off
          </button>
        </div>
      </div>
    </section>
  );
}
