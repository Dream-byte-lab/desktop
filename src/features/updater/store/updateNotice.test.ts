import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UPDATE_NOTICED_VERSION_KEY } from "./updaterStore";

type Handlers = {
  available?: (info: any) => void;
  progress?: (progress: any) => void;
  downloaded?: (info: { version: string }) => void;
  error?: (err: { message: string }) => void;
};

let current: typeof import("./updaterStore") | null = null;

async function freshStore() {
  vi.resetModules();
  current = await import("./updaterStore");
  return current;
}

function stubElectron() {
  const handlers: Handlers = {};
  const quitAndInstall = vi.fn().mockResolvedValue(true);
  const checkForUpdates = vi.fn().mockResolvedValue({ available: false });
  const downloadUpdate = vi.fn().mockResolvedValue({ success: true });

  window.linerElectron = {
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    onUpdateAvailable: vi.fn((cb: any) => {
      handlers.available = cb;
      return () => {};
    }),
    onUpdateDownloadProgress: vi.fn((cb: any) => {
      handlers.progress = cb;
      return () => {};
    }),
    onUpdateDownloaded: vi.fn((cb: any) => {
      handlers.downloaded = cb;
      return () => {};
    }),
    onUpdateError: vi.fn((cb: any) => {
      handlers.error = cb;
      return () => {};
    }),
  } as any;

  return { handlers, quitAndInstall, checkForUpdates, downloadUpdate };
}

describe("updateNotice (once-per-version renderer notice)", () => {
  beforeEach(() => {
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
    // Also attempt cleanup of any previously imported store instance.
    try {
      current?.useUpdaterStore.getState().reset();
    } catch {}
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
  });

  afterEach(() => {
    try {
      current?.useUpdaterStore.getState().reset();
    } catch {}
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Leave no electron stub behind for other test files sharing the env.
    (window as any).linerElectron = undefined;
  });

  it("notices a newly downloaded version and persists it", async () => {
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
    const { useUpdaterStore } = await freshStore();
    const { handlers } = stubElectron();

    const cleanup = useUpdaterStore.getState().initUpdaterListeners();
    handlers.downloaded?.({ version: "0.1.11" });

    const state = useUpdaterStore.getState();
    expect(state.status).toBe("downloaded");
    expect(state.noticeVersion).toBe("0.1.11");
    expect(state.noticedVersion).toBe("0.1.11");
    expect(localStorage.getItem(UPDATE_NOTICED_VERSION_KEY)).toBe("0.1.11");
    cleanup();
  });

  it("dismissing does not re-notify the same version, does not install, and keeps downloaded status", async () => {
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
    const { useUpdaterStore } = await freshStore();
    const { handlers, quitAndInstall } = stubElectron();

    const cleanup = useUpdaterStore.getState().initUpdaterListeners();
    handlers.downloaded?.({ version: "0.1.11" });
    expect(useUpdaterStore.getState().noticeVersion).toBe("0.1.11");

    useUpdaterStore.getState().dismissNotice();

    expect(useUpdaterStore.getState().noticeVersion).toBeNull();
    expect(useUpdaterStore.getState().status).toBe("downloaded");
    expect(quitAndInstall).not.toHaveBeenCalled();

    handlers.downloaded?.({ version: "0.1.11" });

    expect(useUpdaterStore.getState().noticeVersion).toBeNull();
    expect(useUpdaterStore.getState().status).toBe("downloaded");
    expect(quitAndInstall).not.toHaveBeenCalled();
    cleanup();
  });

  it("notices a newer version after a previous one was noticed", async () => {
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
    const { useUpdaterStore } = await freshStore();
    const { handlers } = stubElectron();

    const cleanup = useUpdaterStore.getState().initUpdaterListeners();
    handlers.downloaded?.({ version: "0.1.11" });
    expect(useUpdaterStore.getState().noticeVersion).toBe("0.1.11");
    useUpdaterStore.getState().dismissNotice();

    handlers.downloaded?.({ version: "0.1.12" });

    expect(useUpdaterStore.getState().noticeVersion).toBe("0.1.12");
    expect(useUpdaterStore.getState().noticedVersion).toBe("0.1.12");
    expect(localStorage.getItem(UPDATE_NOTICED_VERSION_KEY)).toBe("0.1.12");
    cleanup();
  });

  it("does not re-notify a version noticed before a restart (cross-restart)", async () => {
    // Seed storage BEFORE the fresh module is imported, so its
    // initial noticedVersion is read from localStorage.
    localStorage.setItem(UPDATE_NOTICED_VERSION_KEY, "0.1.11");
    const { useUpdaterStore } = await freshStore();
    expect(useUpdaterStore.getState().noticedVersion).toBe("0.1.11");
    expect(useUpdaterStore.getState().noticeVersion).toBeNull();

    const { handlers } = stubElectron();
    const cleanup = useUpdaterStore.getState().initUpdaterListeners();

    handlers.downloaded?.({ version: "0.1.11" });
    expect(useUpdaterStore.getState().noticeVersion).toBeNull();

    handlers.downloaded?.({ version: "0.1.12" });
    expect(useUpdaterStore.getState().noticeVersion).toBe("0.1.12");
    expect(localStorage.getItem(UPDATE_NOTICED_VERSION_KEY)).toBe("0.1.12");
    cleanup();
  });

  it("installUpdate calls quitAndInstall exactly once and clears the notice", async () => {
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
    const { useUpdaterStore } = await freshStore();
    const { handlers, quitAndInstall } = stubElectron();

    const cleanup = useUpdaterStore.getState().initUpdaterListeners();
    handlers.downloaded?.({ version: "0.1.11" });
    expect(useUpdaterStore.getState().noticeVersion).toBe("0.1.11");

    await useUpdaterStore.getState().installUpdate();

    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    expect(useUpdaterStore.getState().noticeVersion).toBeNull();
    cleanup();
  });

  it("availability and progress alone never create a notice", async () => {
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
    const { useUpdaterStore } = await freshStore();
    const { handlers } = stubElectron();

    const cleanup = useUpdaterStore.getState().initUpdaterListeners();

    handlers.available?.({ version: "0.1.11" });
    expect(useUpdaterStore.getState().status).toBe("available");
    expect(useUpdaterStore.getState().noticeVersion).toBeNull();

    handlers.progress?.({
      percent: 50,
      transferred: 1024,
      total: 2048,
      bytesPerSecond: 1024,
    });
    expect(useUpdaterStore.getState().status).toBe("downloading");
    expect(useUpdaterStore.getState().noticeVersion).toBeNull();
    expect(localStorage.getItem(UPDATE_NOTICED_VERSION_KEY)).toBeNull();
    cleanup();
  });

  it("is silent in dev when window.linerElectron is undefined", async () => {
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
    const { useUpdaterStore } = await freshStore();
    (window as any).linerElectron = undefined;

    let cleanup: (() => void) | undefined;
    expect(() => {
      cleanup = useUpdaterStore.getState().initUpdaterListeners();
    }).not.toThrow();
    expect(typeof cleanup).toBe("function");
    expect(useUpdaterStore.getState().noticeVersion).toBeNull();
    cleanup?.();
  });

  it("test mode never notices and never writes the storage key", async () => {
    localStorage.removeItem(UPDATE_NOTICED_VERSION_KEY);
    const { useUpdaterStore } = await freshStore();
    // Even with an electron stub present, the simulated path must stay silent.
    stubElectron();

    vi.useFakeTimers();
    try {
      useUpdaterStore.getState().triggerTestUpdate();
      const startPromise = useUpdaterStore.getState().startDownload();
      vi.advanceTimersByTime(5000);
      await startPromise;

      const state = useUpdaterStore.getState();
      expect(state.status).toBe("downloaded");
      expect(state.noticeVersion).toBeNull();
      expect(localStorage.getItem(UPDATE_NOTICED_VERSION_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
