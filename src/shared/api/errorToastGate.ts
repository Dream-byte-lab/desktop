/**
 * Coalescing gate for the API layer's global error toasts
 * (Note 30 F2). Every API failure used to announce itself over
 * the whole app — including failures from background requests
 * nobody was looking at (a playback-event POST, a lyrics search,
 * a history page) — so one upstream wobble could stack the same
 * "Server error" toast again and again while the caller's own
 * surface was already showing the failure with a retry.
 *
 * The gate claims one announcement per family per window; the
 * error itself is untouched and still throws to the caller.
 * Families coalesce independently: a network failure does not
 * suppress a later server announcement, or vice versa.
 */
export const ERROR_TOAST_COALESCE_MS = 3 * 60_000;

export type ErrorToastFamily = "server" | "timeout" | "network";

const lastClaimedAt = new Map<ErrorToastFamily, number>();

/**
 * Returns true (and records the claim) when this family may
 * announce now; false when it already announced within the
 * window. The window is anchored at the last announcement, not
 * the last attempt, so a continuous failure stream re-announces
 * once per window instead of never.
 */
export function claimErrorToast(family: ErrorToastFamily): boolean {
  const now = Date.now();
  const last = lastClaimedAt.get(family);
  if (last !== undefined && now - last < ERROR_TOAST_COALESCE_MS) return false;
  lastClaimedAt.set(family, now);
  return true;
}

export function resetErrorToastGate(): void {
  lastClaimedAt.clear();
}
