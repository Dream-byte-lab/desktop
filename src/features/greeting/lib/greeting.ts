// The welcome greeting's words. When the app opens, it greets the
// listener by name, and what it says follows the time of day — a
// small moment of the app feeling alive and personal instead of
// static. Pure and testable: given a moment and an optional name, it
// returns the headline and a short musical subline.

export interface Greeting {
  headline: string;
  subline: string;
}

interface Band {
  /** First hour (local, 0–23) this band covers. */
  fromHour: number;
  headline: string;
  subline: string;
}

// Ordered by the hour each band starts; the last band wraps past
// midnight into the first.
const BANDS: Band[] = [
  {
    fromHour: 5,
    headline: "Good morning",
    subline: "Let's ease into the day.",
  },
  {
    fromHour: 12,
    headline: "Happy lunch",
    subline: "A good moment for a breather.",
  },
  {
    fromHour: 14,
    headline: "Good afternoon",
    subline: "Keep the day moving.",
  },
  {
    fromHour: 17,
    headline: "Good evening",
    subline: "Time to unwind — or turn it up.",
  },
  {
    fromHour: 22,
    headline: "Up late",
    subline: "The quiet hours have the best songs.",
  },
];

function bandForHour(hour: number): Band {
  let current = BANDS[BANDS.length - 1];
  for (const band of BANDS) {
    if (hour >= band.fromHour) current = band;
  }
  return current;
}

/** The five time-of-day bands, in the order BANDS defines them. */
export type GreetingBandId =
  "morning" | "midday" | "afternoon" | "evening" | "latenight";

const BAND_IDS: GreetingBandId[] = [
  "morning",
  "midday",
  "afternoon",
  "evening",
  "latenight",
];

/** Which band a moment falls in — the composer's view of greetingAt's bands. */
export function greetingBandIdAt(date: Date): GreetingBandId {
  const band = bandForHour(date.getHours());
  return BAND_IDS[BANDS.indexOf(band)];
}

/** The greeting for a moment, addressed to a name when one is known. */
export function greetingAt(date: Date, name?: string): Greeting {
  const band = bandForHour(date.getHours());
  const headline = name ? `${band.headline}, ${name}` : band.headline;
  return { headline, subline: band.subline };
}
