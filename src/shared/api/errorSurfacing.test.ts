import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pins for the Note 30 F2/F4 fixes, driven through the real
// request pipeline with the network and the app's neighbours
// stubbed: the global "Server error" toast coalesces per family
// (the error still throws, unchanged), and resolveApiErrorMessage
// only reads a coded 403 as an expired session.

const { showToast, recordConnectivityFailure } = vi.hoisted(() => ({
  showToast: vi.fn(),
  recordConnectivityFailure: vi.fn(),
}));

vi.mock("@/shared/ui/Toast", () => ({ showToast }));
vi.mock("@/languages", () => ({
  createTranslatorSync: () => (key: string) => key,
  getStoredLocale: () => "en",
}));
vi.mock("./auth-session", () => ({
  getAuthSession: () => null,
  getValidAccessToken: async () => null,
  getSessionExpiryMs: () => null,
  refreshAuthSession: async () => null,
  setAuthSession: () => {},
}));
vi.mock("./requestSigner", () => ({
  signApiRequest: async () => ({}),
  syncServerTime: () => {},
}));
vi.mock("./clientCatalog", () => ({ clientCatalog: {} }));
vi.mock("./localImports", () => ({ getLocalImportHandler: () => undefined }));
vi.mock("./proofOfWorkRunner", () => ({
  solvePow: async () => {
    throw new Error("not in tests");
  },
}));
vi.mock("./humanCheck", () => ({
  isHumanCheckMode: () => false,
  runHumanCheck: async () => {
    throw new Error("not in tests");
  },
}));
vi.mock("@/features/player/store/playerStore", () => ({
  usePlayerStore: { getState: () => ({ currentTrack: null }) },
}));
vi.mock("@/shared/media/local", () => ({ isLocalTrackId: () => false }));
vi.mock("@/features/connectivity", () => ({
  connectionToastsMuted: () => false,
  isConnectivityFailure: () => false,
  isPlaybackPath: () => false,
  recordConnectivityFailure,
  statusOf: () => 0,
  stripQuery: (path: string) => path.split("?")[0],
}));
vi.mock("@/features/connectivity/engine/offlineController", () => ({
  enterOfflineMode: vi.fn(),
}));

import { api, ApiError, resolveApiErrorMessage } from "./api";
import {
  claimErrorToast,
  ERROR_TOAST_COALESCE_MS,
  resetErrorToastGate,
} from "./errorToastGate";

let now = 1_700_000_000_000;

function serverToastCount(): number {
  return showToast.mock.calls.filter((call) => {
    const options = call[2] as { id?: unknown } | undefined;
    return (
      typeof options?.id === "string" && options.id.startsWith("server-error-")
    );
  }).length;
}

beforeEach(() => {
  resetErrorToastGate();
  showToast.mockClear();
  recordConnectivityFailure.mockClear();
  now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "boom" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("global server-error toast coalescing (F2)", () => {
  it("announces the first 5xx, suppresses repeats in the window, and still throws", async () => {
    await expect(api.getMe()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
    });
    expect(serverToastCount()).toBe(1);

    await expect(api.getMe()).rejects.toMatchObject({ status: 500 });
    await expect(api.getMe()).rejects.toMatchObject({ status: 500 });
    expect(serverToastCount()).toBe(1);
  });

  it("announces again once the window has passed", async () => {
    await expect(api.getMe()).rejects.toMatchObject({ status: 500 });
    expect(serverToastCount()).toBe(1);

    now += ERROR_TOAST_COALESCE_MS + 1;
    await expect(api.getMe()).rejects.toMatchObject({ status: 500 });
    expect(serverToastCount()).toBe(2);
  });

  it("coalesces each family independently, anchored at the last announcement", () => {
    expect(claimErrorToast("server")).toBe(true);
    expect(claimErrorToast("server")).toBe(false);
    expect(claimErrorToast("network")).toBe(true);
    expect(claimErrorToast("timeout")).toBe(true);
    expect(claimErrorToast("network")).toBe(false);

    now += ERROR_TOAST_COALESCE_MS - 1;
    expect(claimErrorToast("server")).toBe(false);
    now += 1;
    expect(claimErrorToast("server")).toBe(true);
  });
});

describe("resolveApiErrorMessage 403 (F4)", () => {
  const t = (key: string) => key;

  it("reads a coded 403 as an expired session", () => {
    expect(
      resolveApiErrorMessage(
        new ApiError(403, "Forbidden", "SESSION_EXPIRED"),
        t,
        "custom.fallback",
      ),
    ).toBe("common.error_session_expired");
  });

  it("lets a bare 403 fall through to the caller's fallback", () => {
    expect(
      resolveApiErrorMessage(
        new ApiError(403, "Forbidden"),
        t,
        "custom.fallback",
      ),
    ).toBe("custom.fallback");
  });

  it("keeps the neighbouring mappings unchanged", () => {
    expect(
      resolveApiErrorMessage(
        new ApiError(401, "Unauthorized"),
        t,
        "custom.fallback",
      ),
    ).toBe("common.error_session_expired");
    expect(
      resolveApiErrorMessage(new ApiError(500, "Boom"), t, "custom.fallback"),
    ).toBe("common.error_server");
    expect(
      resolveApiErrorMessage(new ApiError(0, "Offline"), t, "custom.fallback"),
    ).toBe("common.error_network");
    expect(
      resolveApiErrorMessage(new Error("weird"), t, "custom.fallback"),
    ).toBe("custom.fallback");
  });
});
