// analyser.test.ts — the analyser gate: GROUND-TRUTH recovery
// over the synthetic fixture library (fixtures.ts).
//
// Every assertion is against PLANTED truth (the bpm / tonic / mode /
// windows / drop seconds the generators were told to render), never
// against the analyser's own output. Where the analyser is known to
// be wrong, the assertion stays strict and the failure is the
// report — see the two defect notes below, which carry the numbers
// needed to reproduce and fix each one from this suite alone.
//
// ------------------------------------------------------------------
// KNOWN ANALYSER DEFECT D1 — half-tempo reads at frame-integer
// tempos (measured on control renders built for this suite):
// the tempo pass works in 5 ms frames (220 samples @ 44.1 kHz =
// 4.9887 ms). Pure click trains — two independent click shapes
// (decaying-noise bursts; windowed sine pings), no harmonic content
// at all — read EXACT for 93, 115, 120, 122, 126, 130, 160 BPM
// (conf 0.80–0.91) but at EXACTLY HALF tempo for 124, 128, 140 BPM
// under BOTH shapes (conf 0.53–0.93). The failing tempos are exactly
// those whose beat period lies within ≈0.1 of an integer frame
// count (124→96.99, 128→93.97, 140→85.90 frames; the nearest
// passing case, 174→69.12 frames, sits 0.12 off integer). 145 BPM
// (82.95 frames) is a borderline member of the class: it halves for
// decaying-noise clicks — it was forecast to halve before the
// trance fixture was rendered, and did (72.5, conf 0.684–0.843) —
// but reads exact for sine pings (144.8). The grid PHASE anchoring
// on the halved tracks is perfect (beats land ≤11 ms from planted
// clicks — on every other click), so the defect is in period
// selection (the autocorrelation + smallest-lag-≥80% fundamental
// rule in measureTempo), not in anchoring. Affected fixtures:
// club-124, edm-drop-128, rock-140, trance-145.
//
// KNOWN ANALYSER DEFECT D2 — Eb major (tonic 3) key misread:
// pop-112-eb-major's content is exclusively Eb-major diatonic triads
// (tonic chord on half the bars, tonic-heaviest bassline), yet the
// key pass answers G minor with vocals (conf 0.495), D minor
// without them (0.452), Bb major with richer harmonics (0.635) —
// three different wrong answers across constructions, never Eb. The
// misread reproduces through a SECOND, independent generator: a
// gridTrack bassline stack in Eb major @120 also reads D minor
// (0.501), while the identical construction in Ab major reads exact
// (0.759) and the other 17 library keys all read exact. The defect
// is specific to tonic 3 in the analyser's chroma/key pass.
// ------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { ANALYSIS_VERSION, analyseSamples } from "../analyse";
import {
  fixtureFacts,
  fixturePlaylists,
  fixtureReads,
  fixtureTracks,
  type FixtureTrack,
} from "./fixtures";
import { gridTrack, SYNTH_SAMPLE_RATE } from "./synthetics";

const byId = new Map(fixtureTracks.map((t) => [t.id, t]));
function track(id: string): FixtureTrack {
  const t = byId.get(id);
  if (!t) throw new Error(`unknown fixture ${id}`);
  return t;
}

/** Every track except the drifting folk track has a steady grid. */
const CLEAN_TEMPO_IDS = fixtureTracks
  .map((t) => t.id)
  .filter((id) => id !== "folk-unsteady-100-d-major");

// ---------------------------------------------------------------------
// Library shape
// ---------------------------------------------------------------------

describe("fixture library — shape", () => {
  it("has ≥14 tracks, ≥6 distinct Camelot codes, both modes", () => {
    expect(fixtureTracks.length).toBeGreaterThanOrEqual(14);
    const camelots = new Set(fixtureTracks.map((t) => t.truth.camelot));
    expect(camelots.size).toBeGreaterThanOrEqual(6);
    const modes = new Set(fixtureTracks.map((t) => t.truth.mode));
    expect(modes.has("major")).toBe(true);
    expect(modes.has("minor")).toBe(true);
  });

  it("has ≥3 named playlist arcs over real fixture ids", () => {
    expect(fixturePlaylists.length).toBeGreaterThanOrEqual(3);
    for (const arc of fixturePlaylists) {
      expect(arc.trackIds.length).toBeGreaterThanOrEqual(3);
      for (const id of arc.trackIds) expect(byId.has(id)).toBe(true);
    }
  });

  it("every track analysed non-null, versioned, deep, full-length", () => {
    for (const t of fixtureTracks) {
      const read = fixtureReads.get(t.id);
      expect(read, t.id).toBeDefined();
      expect(read?.analysisVersion, t.id).toBe(ANALYSIS_VERSION);
      expect(read?.depth, t.id).toBe("deep");
      const pcmSec = t.pcm().length / SYNTH_SAMPLE_RATE;
      expect(
        Math.abs((read?.durationSec ?? 0) - pcmSec),
        t.id,
      ).toBeLessThanOrEqual(1);
      const facts = fixtureFacts.get(t.id);
      expect(facts, t.id).toBeDefined();
      expect(facts?.minimumPlayMs, t.id).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------
// Control: pure click trains (isolates the analyser from the layers)
// ---------------------------------------------------------------------

describe("control — pure click trains, no harmonic content", () => {
  it("click train @120 BPM reads within ±1 BPM", () => {
    const read = analyseSamples(
      gridTrack({ bpm: 120, seconds: 14, seed: 3, kickAmp: 0 }),
      SYNTH_SAMPLE_RATE,
      { depth: "deep" },
    );
    expect(read).not.toBeNull();
    expect(Math.abs((read?.bpm ?? 0) - 120)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("click train @124 BPM reads within ±1 BPM [defect D1]", () => {
    const read = analyseSamples(
      gridTrack({ bpm: 124, seconds: 14, seed: 3, kickAmp: 0 }),
      SYNTH_SAMPLE_RATE,
      { depth: "deep" },
    );
    expect(read).not.toBeNull();
    expect(Math.abs((read?.bpm ?? 0) - 124)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("click train @145 BPM reads within ±1 BPM [defect D1]", () => {
    const read = analyseSamples(
      gridTrack({ bpm: 145, seconds: 14, seed: 3, kickAmp: 0 }),
      SYNTH_SAMPLE_RATE,
      { depth: "deep" },
    );
    expect(read).not.toBeNull();
    expect(Math.abs((read?.bpm ?? 0) - 145)).toBeLessThanOrEqual(1);
  }, 60_000);
});

// ---------------------------------------------------------------------
// Tempo ground truth
// ---------------------------------------------------------------------

describe("tempo — ground truth ±1 BPM on clean grids", () => {
  for (const id of CLEAN_TEMPO_IDS) {
    it(`${id}: bpm within ±1 of ${track(id).truth.bpm}, grid spacing within 2%`, () => {
      const read = fixtureReads.get(id);
      const truth = track(id).truth.bpm;
      expect(Math.abs((read?.bpm ?? 0) - truth), id).toBeLessThanOrEqual(1);
      // Median beat spacing must match the planted period (this is
      // what a doubled period — defect D1 — violates).
      const beats = read?.grid.beatsMs ?? [];
      const spacings: number[] = [];
      for (let i = 1; i < beats.length; i += 1) {
        spacings.push(beats[i] - beats[i - 1]);
      }
      spacings.sort((a, b) => a - b);
      const median = spacings[Math.floor(spacings.length / 2)] ?? 0;
      const plantedPeriod = 60_000 / truth;
      expect(
        Math.abs(median - plantedPeriod) / plantedPeriod,
        id,
      ).toBeLessThanOrEqual(0.02);
    });
  }

  it("folk-unsteady: the read lands inside the planted drift span", () => {
    // Planted: 100 BPM at t=0 drifting +0.35 %/s to ≈112.6 BPM at
    // t=36 s. A fixed-tempo estimate of a drifting track should
    // land inside that span, not outside it.
    const read = fixtureReads.get("folk-unsteady-100-d-major");
    expect(read?.bpm).toBeGreaterThanOrEqual(98);
    expect(read?.bpm).toBeLessThanOrEqual(116);
  });
});

describe("tempo confidence — the unsteady track is the least certain", () => {
  it("folk tempoConfidence is strictly below tidy club's", () => {
    const folk = fixtureReads.get("folk-unsteady-100-d-major");
    const club = fixtureReads.get("club-124-c-major");
    expect(folk?.tempoConfidence).toBeLessThan(club?.tempoConfidence ?? 0);
  });

  it("folk tempoConfidence is the minimum across the whole library", () => {
    const folk = fixtureReads.get("folk-unsteady-100-d-major");
    for (const t of fixtureTracks) {
      if (t.id === "folk-unsteady-100-d-major") continue;
      expect(
        folk?.tempoConfidence ?? 1,
        `${t.id} should be more confident than the drifting track`,
      ).toBeLessThan(fixtureReads.get(t.id)?.tempoConfidence ?? 0);
    }
  });
});

// ---------------------------------------------------------------------
// Grid anchoring (phase) — distinct from period selection
// ---------------------------------------------------------------------

describe("grid — beats anchor to the planted clicks", () => {
  // Bound: 35 ms. A misanchored grid is off by ~half a beat
  // (hundreds of ms), so 35 ms still catches any real phase
  // failure with an order of magnitude to spare; the bound sits
  // above the observed worst case (house: 30.2 ms over the first
  // 16 beats — a ~23 ms phase offset plus period-refinement error
  // accumulating over the beats) rather than on top of it.
  for (const id of CLEAN_TEMPO_IDS) {
    it(`${id}: first beats within 35 ms of a planted click, 4/4 downbeats`, () => {
      const read = fixtureReads.get(id);
      const periodMs = 60_000 / track(id).truth.bpm;
      const beats = (read?.grid.beatsMs ?? []).slice(1, 17);
      expect(beats.length).toBeGreaterThan(8);
      for (const beat of beats) {
        const rel = (((beat - 300) % periodMs) + periodMs) % periodMs;
        const dist = Math.min(rel, periodMs - rel);
        expect(dist, id).toBeLessThanOrEqual(35);
      }
      expect(read?.grid.beatsPerBar, id).toBe(4);
      const beatSet = new Set(read?.grid.beatsMs ?? []);
      for (const down of read?.grid.downbeatsMs ?? []) {
        expect(beatSet.has(down), id).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------
// Key ground truth
// ---------------------------------------------------------------------

describe("key — tonic + mode + Camelot exact on clean harmonic stacks", () => {
  for (const t of fixtureTracks) {
    it(`${t.id}: reads ${t.truth.tonic}/${t.truth.mode}/${t.truth.camelot} with confidence ≥ 0.5`, () => {
      const key = fixtureReads.get(t.id)?.key;
      expect(key?.tonic, t.id).toBe(t.truth.tonic);
      expect(key?.mode, t.id).toBe(t.truth.mode);
      expect(key?.camelot, t.id).toBe(t.truth.camelot);
      expect(key?.confidence ?? 0, t.id).toBeGreaterThanOrEqual(0.5);
    });
  }

  it("facts keyFit: club (8B) to techno (8A) is the relative key", () => {
    const club = fixtureFacts.get("club-124-c-major");
    const techno = fixtureFacts.get("techno-130-a-minor");
    const fit = club?.keyFitTo(techno!);
    expect(fit?.relation).toBe("relative");
    expect(fit?.score).toBe(0.9);
    expect(fit?.compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Vocals — planted windows read vocal, clean windows read silent
// ---------------------------------------------------------------------

describe("vocals — planted windows", () => {
  it("vocal pop: both planted windows witnessed with mean ≥ 0.5", () => {
    const facts = fixtureFacts.get("vocal-pop-104-g-major");
    const first = facts?.vocals.vocalActivityIn(8000, 20000);
    expect(first?.witnessed).toBe(true);
    expect(first?.mean ?? 0).toBeGreaterThanOrEqual(0.5);
    const second = facts?.vocals.vocalActivityIn(24000, 32000);
    expect(second?.witnessed).toBe(true);
    expect(second?.mean ?? 0).toBeGreaterThanOrEqual(0.5);
  });

  it("vocal pop: the non-vocal intro window reads mean ≤ 0.2", () => {
    const facts = fixtureFacts.get("vocal-pop-104-g-major");
    const quiet = facts?.vocals.vocalActivityIn(2000, 6000);
    expect(quiet?.mean ?? 1).toBeLessThanOrEqual(0.2);
  });

  it("R&B: both planted windows witnessed with mean ≥ 0.5, intro ≤ 0.2", () => {
    const facts = fixtureFacts.get("rnb-92-bb-major");
    const first = facts?.vocals.vocalActivityIn(6000, 18000);
    expect(first?.witnessed).toBe(true);
    expect(first?.mean ?? 0).toBeGreaterThanOrEqual(0.5);
    const second = facts?.vocals.vocalActivityIn(22000, 30000);
    expect(second?.witnessed).toBe(true);
    expect(second?.mean ?? 0).toBeGreaterThanOrEqual(0.5);
    const quiet = facts?.vocals.vocalActivityIn(0, 5000);
    expect(quiet?.mean ?? 1).toBeLessThanOrEqual(0.2);
  });
});

// ---------------------------------------------------------------------
// Drops — planted seconds recovered
// ---------------------------------------------------------------------

describe("drops — planted drop seconds recovered within ±1 s", () => {
  it("EDM: a drop within ±1 s of the planted 18 s, strength ≥ 1.9", () => {
    const drops = fixtureReads.get("edm-drop-128-d-minor")?.drops ?? [];
    const nearest = Math.min(...drops.map((d) => Math.abs(d.atMs - 18000)));
    expect(nearest).toBeLessThanOrEqual(1000);
    const atDrop = drops.find((d) => Math.abs(d.atMs - 18000) <= 1000);
    expect(atDrop?.strength ?? 0).toBeGreaterThanOrEqual(1.9);
  });

  it("hip-hop: a drop within ±1 s of the planted 16 s, strength ≥ 1.9", () => {
    const drops = fixtureReads.get("hiphop-95-c-minor")?.drops ?? [];
    const nearest = Math.min(...drops.map((d) => Math.abs(d.atMs - 16000)));
    expect(nearest).toBeLessThanOrEqual(1000);
    const atDrop = drops.find((d) => Math.abs(d.atMs - 16000) <= 1000);
    expect(atDrop?.strength ?? 0).toBeGreaterThanOrEqual(1.9);
  });
});

// ---------------------------------------------------------------------
// Sections + energy arcs
// ---------------------------------------------------------------------

describe("sections + energy arcs", () => {
  it("loud-quiet-loud rock: ≥3 sections, boundaries within ±1 beat of planted", () => {
    const read = fixtureReads.get("rock-140-g-minor");
    const sections = read?.sections ?? [];
    expect(sections.length).toBeGreaterThanOrEqual(3);
    const beatMs = 60_000 / 140;
    const boundaries = sections.flatMap((s) => [s.startMs, s.endMs]);
    const near = (target: number) =>
      Math.min(...boundaries.map((b) => Math.abs(b - target)));
    expect(near(12000)).toBeLessThanOrEqual(beatMs);
    expect(near(24000)).toBeLessThanOrEqual(beatMs);
    const middle = sections.find((s) => s.startMs <= 18000 && s.endMs >= 18000);
    expect(middle?.kind).toBe("breakdown");
  });

  it("loud-quiet-loud rock: middle-third energy < 30% of the first third", () => {
    const facts = fixtureFacts.get("rock-140-g-minor");
    const first = facts?.energyContour.windowMeanEnergy(0, 12000) ?? 0;
    const middle = facts?.energyContour.windowMeanEnergy(12000, 24000) ?? 1;
    expect(middle).toBeLessThan(0.3 * first);
  });

  it("house build arc: per-quarter energy strictly increases", () => {
    const facts = fixtureFacts.get("house-122-f-major");
    const quarters = [0, 1, 2, 3].map(
      (q) =>
        facts?.energyContour.windowMeanEnergy(q * 9000, (q + 1) * 9000) ?? 0,
    );
    expect(quarters[1]).toBeGreaterThan(quarters[0]);
    expect(quarters[2]).toBeGreaterThan(quarters[1]);
    expect(quarters[3]).toBeGreaterThan(quarters[2]);
    expect(quarters[3]).toBeGreaterThan(2 * quarters[0]);
  });

  it("EDM build + drop shape yields ≥2 sections", () => {
    const read = fixtureReads.get("edm-drop-128-d-minor");
    expect(read?.sections.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------
// Facts — trust lines on confident reads
// ---------------------------------------------------------------------

describe("facts — beatmatch trust on the confident archetypes", () => {
  for (const id of [
    "techno-130-a-minor",
    "house-122-f-major",
    "dnb-174-e-minor",
    "deeptech-115-c-major",
    "jungle-160-b-minor",
  ]) {
    it(`${id}: beatmatchTrusted`, () => {
      expect(fixtureFacts.get(id)?.beatmatchTrusted).toBe(true);
    });
  }
});
