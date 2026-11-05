// Booth.tsx — the Booth (§10.3): the full-height take-over view,
// "the booth at night". It LANDS on its centre PERFORMANCE COLUMN
// — what the brain is doing — with the expert tier subordinate
// inside it, reached deliberately and labelled as such.
//
// - Two deck platters: circular artwork discs (cover art resolved
//   from the player queue by the stage snapshot's track ids)
//   rotating while their deck plays, at a speed scaled by the
//   deck's real rate. Dragging platter A seeks deck A through the
//   session's transport seam. Beneath each platter the deck's
//   facts from the stage snapshot (BPM, Camelot key, energy now,
//   beatmatch trust, and the track's energy contour in the platter
//   area) render as numerals; a deck whose facts the session does
//   not hold says exactly that instead of inventing numerals.
// - Centre column: the drawn next join's candidate pool as cards
//   (session.nextJoinPreview.pool — technique, suitability bar,
//   evidence chips; the drawn pick lit), the activity feed (the
//   session's narration, verbatim), and the behaviour ledger
//   (records + distribution counted from session.getBehaviourLog).
// - Personalities + sliders: the shared PersonalityPanel on
//   settings.ts.
// - EXPERT TIER: manual moves over the SAME engine — the session's
//   triggerDeckMove family triggers (which ask the same authors as
//   the autonomous path, bypassing only the draw), curateRemaining
//   with its honest refusal reasons surfaced verbatim, and the
//   control-level switch (autonomous → assisted → manual). The
//   performer's lower-level manual seams (fx sends, trims,
//   crossfader) are NOT exposed through the session seam, so they
//   are not rendered here — see the tier's own note.

import { useMemo, useRef, useState } from "react";
import {
  liveRaveSession,
  type DeckMoveRequest,
  type LiveRaveSession,
} from "@/features/mixer/liverave/session";
import {
  useDjState,
  type DjControlLevel,
} from "@/features/mixer/liverave/state";
import { useDjSettings } from "@/features/mixer/liverave/settings";
import { usePlayerStore } from "@/features/player/store/playerStore";
import type { Track } from "@/shared/types";
import { PersonalityPanel } from "./PersonalityPanel";
import {
  distributionOf,
  evidenceChips,
  formatClock,
  formatTimeOfDay,
  isFallbackReason,
  moveLabel,
  personalityColour,
  useSessionView,
} from "./sessionView";

const CONTROL_LEVELS: DjControlLevel[] = ["autonomous", "assisted", "manual"];

/**
 * A deck's energy contour, drawn from the held facts' bins: the
 * track's measured RMS shape across its span, normalised to its
 * own peak. Rendered only when the facts carry bins at all.
 */
function DeckContour({ bins }: { bins: { atMs: number; rms: number }[] }) {
  if (bins.length === 0) return null;
  const peak = Math.max(...bins.map((bin) => bin.rms), 0);
  const lastAt = Math.max(...bins.map((bin) => bin.atMs), 1);
  const points = bins
    .map((bin) => {
      const x = (bin.atMs / lastAt) * 100;
      const y = peak > 0 ? 26 - (bin.rms / peak) * 24 : 26;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      data-deck-contour
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      className="mt-1 h-[28px] w-full text-white/55"
      role="img"
      aria-label="Energy contour of the loaded track"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const MOVE_BUTTONS: { kind: DeckMoveRequest["kind"]; label: string }[] = [
  { kind: "stop-exit", label: "Stop exit" },
  { kind: "scratch-in", label: "Scratch in" },
  { kind: "scratch-out", label: "Scratch out" },
];

export function Booth({
  session = liveRaveSession,
}: {
  session?: LiveRaveSession;
}) {
  const active = useDjState((state) => state.active);
  const proOpen = useDjState((state) => state.proOpen);
  const setProOpen = useDjState((state) => state.setProOpen);
  const controlLevel = useDjState((state) => state.controlLevel);
  const setControlLevel = useDjState((state) => state.setControlLevel);
  const personalityId = useDjSettings((state) => state.personalityId);
  const queue = usePlayerStore((state) => state.queue);
  const smartGuestIds = usePlayerStore((state) => state.smartGuestIds);

  const open = active && proOpen;
  const view = useSessionView(session, open);
  const [expertMessage, setExpertMessage] = useState<string | null>(null);
  const [expertBusy, setExpertBusy] = useState(false);

  const distribution = useMemo(
    () => distributionOf(view.behaviour),
    [view.behaviour],
  );
  const accent = personalityColour(personalityId);

  const trackById = useMemo(() => {
    const map = new Map<string, Track>();
    for (const track of queue) map.set(track.id, track);
    return map;
  }, [queue]);

  const dragRef = useRef<{ angle: number; positionMs: number } | null>(null);

  if (!open) return null;

  const preview = view.preview;
  const decks = view.snapshot?.decks ?? [null, null];

  const applyControlLevel = (level: DjControlLevel) => {
    setControlLevel(level);
    session.setControlLevel(level);
  };

  const runMove = async (kind: DeckMoveRequest["kind"]) => {
    setExpertBusy(true);
    try {
      const result = await session.triggerDeckMove({ kind });
      setExpertMessage(
        result.ok
          ? `Performed ${moveLabel(result.recipe.family, result.recipe.technique)} — authored by the same authors as the autonomous path.`
          : `Refused: ${result.reason}`,
      );
    } catch (error) {
      setExpertMessage(
        `Refused: ${error instanceof Error ? error.message : "the move threw"}`,
      );
    } finally {
      setExpertBusy(false);
    }
  };

  const runCurate = async () => {
    setExpertBusy(true);
    try {
      const result = await session.curateRemaining();
      setExpertMessage(
        result.ok
          ? "The rest of the set was re-ordered as a DJ set."
          : `Curate refused: ${result.reason}`,
      );
    } catch (error) {
      setExpertMessage(
        `Curate refused: ${error instanceof Error ? error.message : "curation threw"}`,
      );
    } finally {
      setExpertBusy(false);
    }
  };

  // Platter A drag = seek deck A through the transport seam: the
  // drag's angular sweep maps to the same fraction of the track.
  const platterAngle = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    return Math.atan2(y, x);
  };
  const onPlatterDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const deck = decks[0];
    if (!deck?.trackId) return;
    dragRef.current = {
      angle: platterAngle(event),
      positionMs: deck.positionMs,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPlatterMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const deck = decks[0];
    if (!drag || !deck?.trackId) return;
    const track = trackById.get(deck.trackId);
    const durationMs = track?.durationMs ?? 0;
    if (durationMs <= 0) return;
    let delta = platterAngle(event) - drag.angle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const target = drag.positionMs + (delta / (Math.PI * 2)) * durationMs;
    session.seekTo(Math.min(durationMs, Math.max(0, target)));
    dragRef.current = { angle: platterAngle(event), positionMs: target };
  };
  const onPlatterUp = () => {
    dragRef.current = null;
  };

  return (
    <section
      aria-label="The Booth — DJ performance view"
      data-testid="booth"
      className="relative flex min-h-[520px] w-full flex-col overflow-hidden rounded-t-item text-[#f2f0f7] bg-[linear-gradient(165deg,#201631_0%,#17121f_50%,#100c18_100%)]"
    >
      <style>{`@keyframes booth-spin { to { transform: rotate(360deg); } }`}</style>

      <header className="flex flex-wrap items-center gap-3 px-5 pt-4">
        <h2 className="text-sm font-black tracking-[0.28em] uppercase">
          The Booth
        </h2>
        <span
          className="rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.14em] uppercase"
          style={{ background: `${accent}2e`, color: accent }}
        >
          {personalityId.replace(/-/g, " ")}
        </span>
        <span className="text-[11px] text-white/50">
          Watching the brain first — hands-on control lives in the expert tier
          below.
        </span>
        <button
          type="button"
          onClick={() => setProOpen(false)}
          aria-label="Leave the Booth"
          className="ml-auto cursor-pointer rounded-full border border-white/20 px-3 py-1.5 text-[11px] font-bold tracking-[0.14em] text-white/85 uppercase"
        >
          Leave
        </button>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto px-5 py-4 lg:grid-cols-[240px_1fr_300px]">
        {/* Deck platters ------------------------------------------ */}
        <div className="flex flex-row gap-4 lg:flex-col" data-booth-decks>
          {(["A", "B"] as const).map((side, index) => {
            const deck = decks[index];
            const track = deck?.trackId
              ? trackById.get(deck.trackId)
              : undefined;
            const spinSeconds = deck && deck.rate > 0 ? 3.6 / deck.rate : 3.6;
            return (
              <div key={side} className="flex-1" data-deck={side}>
                <div
                  role={side === "A" ? "slider" : undefined}
                  aria-label={
                    side === "A"
                      ? "Deck A platter — drag to seek"
                      : `Deck ${side} platter`
                  }
                  aria-valuetext={
                    deck ? `${formatClock(deck.positionMs)} played` : undefined
                  }
                  onPointerDown={side === "A" ? onPlatterDown : undefined}
                  onPointerMove={side === "A" ? onPlatterMove : undefined}
                  onPointerUp={side === "A" ? onPlatterUp : undefined}
                  className="relative mx-auto aspect-square w-full max-w-[210px] touch-none overflow-hidden rounded-full border border-white/15 bg-black/50 select-none"
                  style={{
                    boxShadow: deck?.playing
                      ? `0 0 26px ${accent}44`
                      : undefined,
                  }}
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      animation: `booth-spin ${spinSeconds}s linear infinite`,
                      animationPlayState: deck?.playing ? "running" : "paused",
                    }}
                  >
                    {track?.coverUrl ? (
                      <img
                        src={track.coverUrl}
                        alt=""
                        draggable={false}
                        className="h-full w-full object-cover opacity-90"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle,#2c2140,#17121f_70%)] text-3xl font-black text-white/25">
                        {side}
                      </div>
                    )}
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-[11px] font-black text-white">
                      {side}
                    </span>
                  </div>
                </div>
                <div className="mt-2 text-center">
                  <p className="truncate text-sm font-bold text-white">
                    {track
                      ? track.title
                      : deck?.trackId
                        ? "Not in the player queue"
                        : "Empty deck"}
                  </p>
                  <p className="text-[11px] text-white/55">
                    {deck
                      ? `${formatClock(deck.positionMs)} · rate ${deck.rate.toFixed(2)}× · ${deck.playing ? "playing" : "held"}`
                      : "No deck state yet"}
                  </p>
                  {deck &&
                    (deck.facts ? (
                      <div data-deck-facts="present" className="mt-1.5">
                        <p className="flex items-baseline justify-center gap-3 tabular-nums">
                          <span
                            data-deck-bpm
                            className="text-xl font-black tracking-tight text-white"
                          >
                            {deck.facts.bpm !== null
                              ? `${Math.round(deck.facts.bpm)}`
                              : "—"}
                            <span className="ml-1 text-[10px] font-bold tracking-[0.14em] text-white/50 uppercase">
                              BPM
                            </span>
                          </span>
                          <span
                            data-deck-key
                            className="text-xl font-black tracking-tight text-white"
                          >
                            {deck.facts.keyCamelot ?? "—"}
                            <span className="ml-1 text-[10px] font-bold tracking-[0.14em] text-white/50 uppercase">
                              key
                            </span>
                          </span>
                          <span
                            data-deck-energy
                            className="text-xl font-black tracking-tight text-white"
                          >
                            {deck.facts.energyNow.toFixed(2)}
                            <span className="ml-1 text-[10px] font-bold tracking-[0.14em] text-white/50 uppercase">
                              energy
                            </span>
                          </span>
                        </p>
                        <p className="mt-0.5 text-[10px] tracking-wide text-white/45 uppercase">
                          {deck.facts.beatmatchTrusted
                            ? "beatmatch trusted"
                            : "beatmatch untrusted"}
                        </p>
                        <DeckContour bins={deck.facts.energyContour} />
                      </div>
                    ) : (
                      <p
                        data-deck-facts="absent"
                        className="mt-1.5 text-[11px] text-white/45"
                      >
                        No analysis held for this deck yet
                      </p>
                    ))}
                </div>
              </div>
            );
          })}
          <p className="text-[11px] leading-snug text-white/40">
            Deck facts are the session's held analysis for the loaded track; a
            deck without one says so above. Platter A drag seeks through the
            transport seam; deck B has no seek seam.
          </p>
        </div>

        {/* Centre performance column ------------------------------- */}
        <div className="flex min-w-0 flex-col gap-5" data-performance-column>
          <section aria-label="Candidate pool">
            <h3 className="text-[11px] font-semibold tracking-[0.18em] text-white/50 uppercase">
              Next join — the candidate pool
            </h3>
            {preview ? (
              <>
                <p className="mt-1 text-xs text-white/60">
                  Drawn:{" "}
                  <span className="font-bold text-white">
                    {moveLabel(preview.family, preview.technique)}
                  </span>{" "}
                  into {preview.trackTitle} · suitability{" "}
                  {Math.round(preview.suitability * 100)}% · pool of{" "}
                  {preview.poolSize}
                  {smartGuestIds.includes(preview.trackId) && (
                    <span
                      title="Added by Smart Shuffle — not part of this playlist"
                      className="ml-2 align-middle rounded-full border border-white/25 px-2 py-[1px] text-[10px] font-medium tracking-wide text-white/60 uppercase"
                    >
                      Guest
                    </span>
                  )}
                </p>
                <div
                  className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
                  data-pool-cards
                >
                  {preview.pool.map((entry, i) => {
                    const drawn =
                      entry.trackId === preview.trackId &&
                      entry.family === preview.family &&
                      entry.technique === preview.technique &&
                      Math.abs(entry.suitability - preview.suitability) < 0.001;
                    const entryTrack = trackById.get(entry.trackId);
                    return (
                      <article
                        key={`${entry.trackId}-${entry.family}-${entry.technique ?? ""}-${i}`}
                        data-pool-card={drawn ? "drawn" : "candidate"}
                        className="rounded-xl border p-3"
                        style={{
                          borderColor: drawn
                            ? accent
                            : "rgba(255,255,255,0.10)",
                          background: drawn
                            ? `${accent}1f`
                            : "rgba(255,255,255,0.04)",
                          boxShadow: drawn ? `0 0 16px ${accent}40` : undefined,
                        }}
                      >
                        <p className="text-sm font-extrabold tracking-tight text-white">
                          {moveLabel(entry.family, entry.technique)}
                        </p>
                        <p className="truncate text-[11px] text-white/60">
                          into {entryTrack ? entryTrack.title : entry.trackId}
                          {drawn ? " · drawn pick" : ""}
                          {smartGuestIds.includes(entry.trackId) && (
                            <span
                              title="Added by Smart Shuffle — not part of this playlist"
                              className="ml-2 align-middle rounded-full border border-white/25 px-2 py-[1px] text-[10px] font-medium tracking-wide text-white/60 uppercase"
                            >
                              Guest
                            </span>
                          )}
                        </p>
                        <div
                          className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
                          role="img"
                          aria-label={`Suitability ${Math.round(entry.suitability * 100)} percent`}
                        >
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.round(entry.suitability * 100)}%`,
                              background: drawn ? accent : "#9d8cff",
                            }}
                          />
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {evidenceChips(entry.evidence)
                            .slice(0, 3)
                            .map((chip) => (
                              <span
                                key={chip.key}
                                className="rounded-full border border-white/12 bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/70"
                              >
                                {chip.label} {Math.round(chip.value * 100)}%
                              </span>
                            ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-white/60" data-pool-empty>
                No join drawn yet — the pool appears here when the brain authors
                and draws the next join.
              </p>
            )}
          </section>

          <section aria-label="Activity feed">
            <h3 className="text-[11px] font-semibold tracking-[0.18em] text-white/50 uppercase">
              Activity — the session, in its own words
            </h3>
            {view.activity.length > 0 ? (
              <ol className="mt-2 flex flex-col gap-1" data-activity-feed>
                {[...view.activity]
                  .slice(-12)
                  .reverse()
                  .map((event, i) => (
                    <li
                      key={`${event.at}-${i}`}
                      className="rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-xs text-white/80"
                    >
                      <span className="mr-2 font-bold tracking-wide text-white/50 uppercase">
                        {event.kind}
                      </span>
                      {event.text}
                      <span className="ml-2 text-white/35">
                        {formatTimeOfDay(event.at)}
                      </span>
                    </li>
                  ))}
              </ol>
            ) : (
              <p className="mt-2 text-sm text-white/60" data-activity-empty>
                Nothing narrated yet.
              </p>
            )}
          </section>

          <section aria-label="Behaviour ledger">
            <h3 className="text-[11px] font-semibold tracking-[0.18em] text-white/50 uppercase">
              Ledger — every join and fallback, recorded
            </h3>
            {distribution.total > 0 ? (
              <>
                <p
                  className="mt-1 text-[11px] text-white/55"
                  data-ledger-distribution
                >
                  {distribution.total} records · families:{" "}
                  {Object.entries(distribution.byFamily)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(", ")}{" "}
                  · techniques:{" "}
                  {Object.entries(distribution.byTechnique)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(", ") || "none"}{" "}
                  · reasons:{" "}
                  {Object.entries(distribution.byReason)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(", ")}
                </p>
                <ol className="mt-2 flex flex-col gap-1" data-ledger-records>
                  {[...view.behaviour]
                    .slice(-8)
                    .reverse()
                    .map((record, i) => (
                      <li
                        key={`${record.at}-${i}`}
                        className="flex items-baseline justify-between gap-3 rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-xs text-white/80"
                      >
                        <span>
                          {isFallbackReason(record.reason)
                            ? `FALLBACK · ${record.reason}`
                            : moveLabel(record.family, record.technique) ||
                              record.reason}
                        </span>
                        <span className="text-white/45">
                          {record.reason}
                          {record.suitability !== null
                            ? ` · ${Math.round(record.suitability * 100)}%`
                            : ""}{" "}
                          · pool {record.poolSize}
                        </span>
                      </li>
                    ))}
                </ol>
              </>
            ) : (
              <p className="mt-2 text-sm text-white/60" data-ledger-empty>
                No joins recorded yet tonight.
              </p>
            )}
          </section>

          {/* Expert tier ------------------------------------------ */}
          <section
            aria-label="Expert tier — manual control"
            data-expert-tier
            className="rounded-xl border border-dashed border-white/15 p-3"
          >
            <h3 className="text-[11px] font-semibold tracking-[0.18em] text-white/50 uppercase">
              Expert tier — manual moves over the same engine
            </h3>
            <p className="mt-1 text-[11px] leading-snug text-white/45">
              These triggers ask the same authors the autonomous DJ uses — they
              bypass only the draw and the minimum-play floor, never the
              authoring. Refusals are shown with the engine's own reason. The
              performer's fx sends, trims and crossfader are not exposed through
              the session seam, so they are not offered here.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold text-white/60">
                Control level
              </span>
              {CONTROL_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  data-control-level={level}
                  aria-pressed={controlLevel === level}
                  onClick={() => applyControlLevel(level)}
                  className="cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase"
                  style={{
                    background:
                      controlLevel === level
                        ? accent
                        : "rgba(255,255,255,0.07)",
                    color: controlLevel === level ? "#17121f" : "#f2f0f7",
                  }}
                >
                  {level}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {MOVE_BUTTONS.map((move) => (
                <button
                  key={move.kind}
                  type="button"
                  data-deck-move={move.kind}
                  disabled={expertBusy}
                  onClick={() => void runMove(move.kind)}
                  className="cursor-pointer rounded-lg bg-white/[0.08] px-3 py-2 text-xs font-bold text-white transition-transform active:scale-95 disabled:opacity-40"
                >
                  {move.label}
                </button>
              ))}
              <button
                type="button"
                data-curate
                disabled={expertBusy}
                onClick={() => void runCurate()}
                className="cursor-pointer rounded-lg bg-white/[0.08] px-3 py-2 text-xs font-bold text-white transition-transform active:scale-95 disabled:opacity-40"
              >
                Reorder rest as a DJ set
              </button>
            </div>
            {expertMessage && (
              <p
                role="status"
                data-expert-message
                className="mt-2 text-xs text-white/75"
              >
                {expertMessage}
              </p>
            )}
          </section>
        </div>

        {/* Personality + sliders rail ------------------------------ */}
        <div className="min-w-0" data-booth-settings>
          <PersonalityPanel />
        </div>
      </div>
    </section>
  );
}

/** The player-bar toggle that opens the Booth (replaces the old pro toggle's role). */
export function BoothToggle({
  className,
  activeClassName,
}: {
  className?: string;
  activeClassName?: string;
}) {
  const active = useDjState((state) => state.active);
  const proOpen = useDjState((state) => state.proOpen);
  const setProOpen = useDjState((state) => state.setProOpen);

  // Until DJ mode is on, this control does not exist in the
  // interface at all — the plain press-play experience stays clean.
  if (!active) return null;

  return (
    <button
      type="button"
      aria-label="Open the Booth"
      aria-pressed={proOpen}
      title="The Booth — watch the DJ's brain, personalities, sliders and the expert tier"
      className={`${className ?? ""} ${proOpen ? (activeClassName ?? "") : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => setProOpen(!proOpen)}
      style={{
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.08em",
      }}
    >
      BOOTH
    </button>
  );
}
