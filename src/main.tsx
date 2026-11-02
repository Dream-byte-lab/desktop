import React from "react";
import ReactDOM from "react-dom/client";
import { initGlobalErrorHandlers } from "@/shared/utils/globalErrorHandlers";
import { hydrateScreenCache } from "@/shared/cache/screenCache";
import { applyStoredTheme } from "@/shared/utils/storedTheme";

initGlobalErrorHandlers();

const isOverlay = window.location.hash.startsWith("#/overlay");

if (!isOverlay) applyStoredTheme();

// First paint must never wait on the screen cache: if hydration hangs or
// fails (corrupt or oversized cache), the app still starts — worst case it
// starts with an empty cache instead of a window that never paints.
const HYDRATE_TIMEOUT_MS = 2_000;

function hydrateScreenCacheCapped(): Promise<void> {
  return Promise.race([
    hydrateScreenCache().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, HYDRATE_TIMEOUT_MS)),
  ]);
}

async function loadRoot(): Promise<React.ReactElement> {
  if (isOverlay) {
    const { default: OverlayApp } = await import("./app/OverlayApp");
    return <OverlayApp />;
  }
  const [
    { initMainWindowServices },
    { default: App },
    { default: RootErrorBoundary },
  ] = await Promise.all([
    import("./app/mainWindowServices"),
    import("./app/App"),
    import("@/shared/ui/RootErrorBoundary"),
    hydrateScreenCacheCapped(),
  ]);
  initMainWindowServices();
  return (
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  );
}

// A failed first load must never present as an empty (transparent) window:
// fall back to the app's error screen, and if even that cannot load, to
// plain text with a way out. The error boundary lives inside loadRoot(),
// so without this net a startup failure leaves #root empty forever while
// the window sits there looking like a graphics failure.
async function boot(): Promise<void> {
  const rootElement = document.getElementById("root");
  if (!rootElement) return;
  const root = ReactDOM.createRoot(rootElement);
  try {
    const element = await loadRoot();
    root.render(<React.StrictMode>{element}</React.StrictMode>);
  } catch (error) {
    console.error("Linerave failed to start:", error);
    try {
      const { RootErrorFallback } =
        await import("@/shared/ui/RootErrorFallback");
      root.render(
        <RootErrorFallback
          error={error instanceof Error ? error : new Error(String(error))}
          onReload={() => window.location.reload()}
        />,
      );
    } catch {
      rootElement.textContent =
        "Linerave failed to start. Please close and reopen the app.";
    }
  }
}

void boot();
