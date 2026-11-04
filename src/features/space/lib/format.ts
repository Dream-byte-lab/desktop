// Presentation formatting for the Your Space surfaces (interface
// slice S2). Language-neutral shapes live here (m:ss, clock time);
// anything with words in it goes through locale keys in the
// components, and dates go through Intl with the app's locale.

/** "14 Feb" — plus the year when it is not the current one. */
export function formatDay(ms: number, locale: string, nowMs: number): string {
  const withYear = new Date(ms).getFullYear() !== new Date(nowMs).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(ms));
}

/** Local clock time, e.g. "4:32 PM" / "16:32" per locale. */
export function formatTimeOfDay(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** Played duration as m:ss (h:mm:ss past an hour). Language-neutral. */
export function formatPlayedMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(n);
}
