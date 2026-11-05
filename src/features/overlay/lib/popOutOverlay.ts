// The main window's way to ask for the overlay player: bring
// the small always-on-top overlay window up over other apps,
// so the listener can reach the player without switching to
// the app. This rides the overlay's existing bridge — the
// same one the global shortcut uses. The bridge has no
// separate "show" call, so popping out means asking whether
// the overlay is already open and toggling it only when it
// is not: a second press never hides what the first raised.
//
// Every failure along the bridge is swallowed and reported
// as false. In the web build there is no bridge at all, and
// a failed read of the overlay's state never guesses — a
// pop-out that cannot happen must never break the player
// bar, nor hide an overlay it meant to raise.
export async function popOutOverlay(): Promise<boolean> {
  const bridge =
    typeof window !== "undefined" ? window.linerElectron : undefined;
  if (!bridge?.toggleOverlay) return false;
  try {
    const alreadyOpen = bridge.isOverlayOpen
      ? await bridge.isOverlayOpen()
      : false;
    if (alreadyOpen) return true;
    return await bridge.toggleOverlay();
  } catch {
    return false;
  }
}
