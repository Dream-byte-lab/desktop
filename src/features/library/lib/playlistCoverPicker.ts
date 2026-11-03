import { showToast } from "@/shared/ui";
import { fileToCustomCoverDataUrl, setCustomCover } from "./playlistIdentity";

/**
 * Open the OS file picker for one playlist's custom cover and store
 * the (downscaled) result locally. Shared by every surface that offers
 * "Change cover" (library grid menu, playlist page menu, Liked Songs
 * page menu) so the pick → downscale → persist → toast flow is
 * identical everywhere. Labels are passed in already translated (with
 * their English fallbacks) by the caller.
 */
export function openPlaylistCoverPicker(
  playlistId: string,
  labels: { updated: string; failed: string },
): void {
  if (typeof document === "undefined") return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    void (async () => {
      try {
        const dataUrl = await fileToCustomCoverDataUrl(file);
        if (!setCustomCover(playlistId, dataUrl)) {
          throw new Error("Custom cover could not be saved");
        }
        showToast(labels.updated, "checkmark");
      } catch {
        showToast(labels.failed, "error");
      }
    })();
  };
  input.click();
}
