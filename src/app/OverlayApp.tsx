import { ThemeProvider } from "next-themes";
import GlobalTooltip from "@/shared/ui/GlobalTooltip";
import { OverlayPlayer } from "@/features/overlay/ui/OverlayPlayer";
import { useAccentSync } from "@/features/settings/hooks/useAccentSync";
import { getAuthSession } from "@/shared/api/auth-session";
import "./globals.css";

function AccentSync() {
  useAccentSync();
  return null;
}

export default function OverlayApp() {
  if (!getAuthSession()) {
    window.linerElectron?.closeOverlay?.();
    return null;
  }

  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="dark"
      enableSystem={false}
      forcedTheme="dark"
    >
      <GlobalTooltip />
      <AccentSync />
      <OverlayPlayer />
    </ThemeProvider>
  );
}
