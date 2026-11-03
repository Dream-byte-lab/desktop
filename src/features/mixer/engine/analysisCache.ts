import { linerDb } from "@/shared/storage";
import {
  ANALYSIS_VERSION,
  type AnalysisDepth,
  type TrackAnalysis,
} from "./analyseTrack";

// The analysis cache (Step 5, slice S5-1): a track is analysed at
// most once per audio version, ever.
//
// Analyses persist in linerDb's `analyses` store, and this module is
// that store's only reader/writer. The trust rule is the REA lesson
// (Spotify invalidates a recipe when the audio or beat map changes),
// applied to our own cache: a stored analysis is served only when
// BOTH its analysis version AND its audio fingerprint match the
// audio the caller actually decoded. A re-rip, a different edit, a
// remaster — any of them changes the fingerprint and the stored
// analysis is simply not believed; the caller re-analyses and the
// new result replaces the old record.
//
// Records carry their depth ("fast" | "deep"): a fast record is
// real, but it is not a deep one, and callers that need the deep
// read treat it as a reason to deepen, not as the finished article.
//
// Cache failures never break preparation: a get that throws is a
// miss, a put that throws is forgotten. Analysis is an optimisation
// of certainty, never a dependency of playback.

export interface AnalysisCacheHit {
  depth: AnalysisDepth;
  analysis: TrackAnalysis;
}

/**
 * Returns the stored analysis for a track when — and only when — it
 * describes exactly this audio at the current analysis version.
 */
export async function getCachedAnalysis(
  trackId: string,
  audioHash: string,
): Promise<AnalysisCacheHit | null> {
  try {
    const record = await linerDb.getAnalysis(trackId);
    if (!record) return null;
    if (record.audioHash !== audioHash) return null;
    if (record.analysisVersion !== ANALYSIS_VERSION) return null;
    const analysis = record.analysis as TrackAnalysis | null;
    if (!analysis) return null;
    if (analysis.analysisVersion !== ANALYSIS_VERSION) return null;
    if (analysis.audioHash !== audioHash) return null;
    // A record that lost its structure somewhere is a miss, not a
    // partial truth a consumer could mistake for the real thing.
    if (!analysis.sections || !analysis.beatMap?.grid) return null;
    return {
      depth: record.depth === "fast" ? "fast" : "deep",
      analysis,
    };
  } catch {
    return null;
  }
}

/** Stores an analysis under its track, keyed by its own fingerprint. */
export async function putCachedAnalysis(
  trackId: string,
  analysis: TrackAnalysis,
): Promise<void> {
  try {
    if (!analysis.audioHash) return;
    if (analysis.analysisVersion !== ANALYSIS_VERSION) return;
    await linerDb.putAnalysis({
      trackId,
      audioHash: analysis.audioHash,
      analysisVersion: ANALYSIS_VERSION,
      depth: analysis.depth ?? "deep",
      analysis,
      savedAt: Date.now(),
    });
  } catch {
    // Forgotten on purpose — see the header.
  }
}

/** Drops a track's stored analysis, whatever state it was in. */
export async function deleteCachedAnalysis(trackId: string): Promise<void> {
  try {
    await linerDb.deleteAnalysis(trackId);
  } catch {
    // Nothing to forget loudly about.
  }
}
