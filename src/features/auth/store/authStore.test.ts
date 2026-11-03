import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the player feature pulls lottie/canvas ui that jsdom cannot load; initialize() never touches it
const player = vi.hoisted(() => ({
  stopAndClear: vi.fn(async () => {}),
  hasActivePlayback: vi.fn(() => false),
}));
vi.mock("@/features/player", () => ({ playerEngine: player }));

import { useAuthStore } from "./authStore";
import {
  api,
  ApiError,
  getAuthSession,
  setAuthSession,
  type AuthTokens,
} from "@/shared/api";

const stored = {
  accessToken: "expired-access",
  refreshToken: "refresh-1",
  user: { id: "u1", username: "leo" },
} as unknown as AuthTokens;

describe("authStore.initialize — expired access token at launch", () => {
  beforeEach(() => {
    setAuthSession(stored);
    useAuthStore.setState({ status: "initializing", user: null });
    vi.spyOn(api, "getMe").mockRejectedValue(new ApiError(401, "Unauthorized"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setAuthSession(null);
  });

  it("keeps the session when the refresh fails for a transient reason (server down)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error code: 525", { status: 525 }),
    );

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(getAuthSession()?.refreshToken).toBe("refresh-1");
  });

  it("signs out when the server rejects the refresh token", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: "INVALID_REFRESH_TOKEN" }), {
          status: 401,
        }),
    );

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().status).toBe("guest");
    expect(getAuthSession()).toBeNull();
  });

  it("stays signed in when a refresh 401 carries no token verdict", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("{}", { status: 401 }),
    );

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(getAuthSession()?.refreshToken).toBeTruthy();
  });
});

describe("signing out clears the player", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    player.stopAndClear.mockReset();
    player.stopAndClear.mockImplementation(async () => {});
    player.hasActivePlayback.mockReset();
    player.hasActivePlayback.mockImplementation(() => false);
    setAuthSession(null);
  });

  it("logout stops playback while the old account's token still exists", async () => {
    setAuthSession(stored);
    useAuthStore.setState({ status: "authenticated", user: stored.user });
    let sessionDuringStop: unknown = "not called";
    player.stopAndClear.mockImplementation(async () => {
      if (sessionDuringStop === "not called")
        sessionDuringStop = getAuthSession();
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await useAuthStore.getState().logout();

    expect(sessionDuringStop).toMatchObject({ refreshToken: "refresh-1" });
    expect(getAuthSession()).toBeNull();
    expect(useAuthStore.getState().status).toBe("guest");
  });

  it("clears the player whenever the app ends up signed out", async () => {
    useAuthStore.setState({ status: "initializing", user: null });
    await useAuthStore.getState().initialize();
    expect(useAuthStore.getState().status).toBe("guest");
    expect(player.stopAndClear).toHaveBeenCalled();
  });

  it("does not clear the player on an unprompted drop to guest while playback is active", () => {
    player.hasActivePlayback.mockReturnValue(true);
    useAuthStore.setState({ status: "authenticated", user: stored.user });

    useAuthStore.setState({ status: "guest", user: null });

    expect(useAuthStore.getState().status).toBe("guest");
    expect(player.stopAndClear).not.toHaveBeenCalled();
  });

  it("still clears the player on a drop to guest when nothing is playing", () => {
    player.hasActivePlayback.mockReturnValue(false);
    useAuthStore.setState({ status: "authenticated", user: stored.user });

    useAuthStore.setState({ status: "guest", user: null });

    expect(player.stopAndClear).toHaveBeenCalledTimes(1);
  });

  it("explicit logout clears the player even while playback is active", async () => {
    setAuthSession(stored);
    player.hasActivePlayback.mockReturnValue(true);
    useAuthStore.setState({ status: "authenticated", user: stored.user });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await useAuthStore.getState().logout();

    // Once, by logout's own clear — the watcher on the status flip is
    // guarded by the active playback and does not clear a second time.
    expect(player.stopAndClear).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().status).toBe("guest");
    expect(getAuthSession()).toBeNull();
  });

  it("does not hang logout when the player never finishes", async () => {
    vi.useFakeTimers();
    try {
      setAuthSession(stored);
      useAuthStore.setState({ status: "authenticated", user: stored.user });
      player.stopAndClear.mockImplementation(() => new Promise(() => {}));
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 204 }),
      );
      const loggingOut = useAuthStore.getState().logout();
      await vi.advanceTimersByTimeAsync(3_000);
      await loggingOut;
      expect(useAuthStore.getState().status).toBe("guest");
    } finally {
      vi.useRealTimers();
    }
  });
});
