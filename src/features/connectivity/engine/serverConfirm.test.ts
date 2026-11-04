import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pins for the Note 30 F1 fix: a server-side classification must
// be confirmed by one re-probe before the ConnectionIssueModal
// opens, and an unreachable verdict lands on its own issue. The
// network is a switchable health endpoint plus the desktop
// bridge; fake timers own the confirmation delay.

const showToast = vi.fn();

vi.mock("@/shared/ui/Toast", () => ({ showToast }));
vi.mock("@/languages", () => ({
  createTranslatorSync: () => (key: string) => key,
  getStoredLocale: () => "en",
}));

type HealthMode = "ok" | "down" | "error500";

let healthMode: HealthMode = "down";
let healthCalls = 0;

function installNetwork() {
  healthCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/health")) {
        healthCalls += 1;
        if (healthMode === "down") throw new TypeError("Failed to fetch");
        if (healthMode === "error500")
          return new Response("{}", { status: 503 });
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
  const probeNetwork = vi.fn(async () => ({
    internet: true,
    youtube: true,
    youtubeFailure: null,
    country: "DE",
  }));
  Object.assign(window, { linerElectron: { probeNetwork } });
}

function setDeviceOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
}

async function loadFeature() {
  const offline = await import("../store/offlineModeStore");
  const connectivity = await import("../store/connectivityStore");
  const controller = await import("./offlineController");
  return { ...offline, ...connectivity, ...controller };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  showToast.mockClear();
  localStorage.clear();
  setDeviceOnline(true);
  healthMode = "down";
  installNetwork();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "linerElectron");
});

describe("server issue confirmation", () => {
  it("a single server classification opens nothing", async () => {
    const {
      useOfflineModeStore,
      presentDetectedIssue,
      SERVER_CONFIRM_DELAY_MS,
    } = await loadFeature();

    expect(await useOfflineModeStore.getState().check()).toBe(
      "server_unreachable",
    );
    presentDetectedIssue();
    expect(useOfflineModeStore.getState().issue).toBeNull();

    await vi.advanceTimersByTimeAsync(SERVER_CONFIRM_DELAY_MS - 1);
    expect(useOfflineModeStore.getState().issue).toBeNull();
    expect(healthCalls).toBe(1);
  });

  it("a second consecutive server classification opens the modal", async () => {
    const {
      useOfflineModeStore,
      presentDetectedIssue,
      SERVER_CONFIRM_DELAY_MS,
    } = await loadFeature();

    expect(await useOfflineModeStore.getState().check()).toBe(
      "server_unreachable",
    );
    presentDetectedIssue();
    await vi.advanceTimersByTimeAsync(SERVER_CONFIRM_DELAY_MS);

    expect(healthCalls).toBe(2);
    expect(useOfflineModeStore.getState().issue).toBe("server_unreachable");
    expect(useOfflineModeStore.getState().offline).toBe(false);
  });

  it("a 5xx health answer confirms into the server issue", async () => {
    healthMode = "error500";
    const {
      useOfflineModeStore,
      presentDetectedIssue,
      SERVER_CONFIRM_DELAY_MS,
    } = await loadFeature();

    expect(await useOfflineModeStore.getState().check()).toBe("server_error");
    presentDetectedIssue();
    expect(useOfflineModeStore.getState().issue).toBeNull();

    await vi.advanceTimersByTimeAsync(SERVER_CONFIRM_DELAY_MS);
    expect(useOfflineModeStore.getState().issue).toBe("server");
  });

  it("server then healthy opens nothing", async () => {
    const {
      useOfflineModeStore,
      presentDetectedIssue,
      SERVER_CONFIRM_DELAY_MS,
    } = await loadFeature();

    expect(await useOfflineModeStore.getState().check()).toBe(
      "server_unreachable",
    );
    presentDetectedIssue();

    healthMode = "ok";
    await vi.advanceTimersByTimeAsync(SERVER_CONFIRM_DELAY_MS);

    expect(useOfflineModeStore.getState().verdict).toBe("online");
    expect(useOfflineModeStore.getState().issue).toBeNull();
  });

  it("the trip feed goes through the same confirmation", async () => {
    const {
      useOfflineModeStore,
      useConnectivityStore,
      initOfflineMode,
      SERVER_CONFIRM_DELAY_MS,
    } = await loadFeature();
    initOfflineMode();

    const { recordFailure } = useConnectivityStore.getState();
    for (let i = 0; i < 3; i += 1)
      recordFailure({ method: "GET", path: "/v1/me", status: 0, latencyMs: 5 });
    // Let the trip's own check settle: it classified the server
    // down, but the modal must not be open yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(useOfflineModeStore.getState().verdict).toBe("server_unreachable");
    expect(useOfflineModeStore.getState().issue).toBeNull();

    await vi.advanceTimersByTimeAsync(SERVER_CONFIRM_DELAY_MS);
    expect(useOfflineModeStore.getState().issue).toBe("server_unreachable");
  });

  it("the unreachable issue mutes api toasts like the server issue does", async () => {
    const { useOfflineModeStore, connectionToastsMuted } = await loadFeature();
    expect(connectionToastsMuted()).toBe(false);
    useOfflineModeStore.getState().openIssue("server_unreachable");
    expect(connectionToastsMuted()).toBe(true);
    useOfflineModeStore.getState().closeIssue();
    expect(connectionToastsMuted()).toBe(false);
  });
});
