import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEUTRAL_SHAPING, NEUTRAL_SLIDERS, resolveShaping } from "./shaping";
import {
  DJ_SETTINGS_STORAGE_KEY,
  resolveCurrentShaping,
  subscribeShaping,
  useDjSettings,
} from "./settings";

function resetSettings(): void {
  localStorage.clear();
  useDjSettings.getState().reset();
  localStorage.clear();
}

beforeEach(resetSettings);

describe("useDjSettings — defaults", () => {
  it("autonomous, neutral sliders, server mixing OFF with no base URL", () => {
    const s = useDjSettings.getState();
    expect(s.personalityId).toBe("autonomous");
    expect(s.sliders).toEqual({ ...NEUTRAL_SLIDERS });
    expect(s.serverMixingEnabled).toBe(false);
    expect(s.serverBaseUrl).toBe("");
  });

  it("reset restores the defaults after edits", () => {
    const s = useDjSettings.getState();
    s.setPersonality("battle");
    s.setSlider("intensity", 1);
    s.setServerMixing(true, "https://mix.example");
    s.reset();
    const next = useDjSettings.getState();
    expect(next.personalityId).toBe("autonomous");
    expect(next.sliders).toEqual({ ...NEUTRAL_SLIDERS });
    expect(next.serverMixingEnabled).toBe(false);
    expect(next.serverBaseUrl).toBe("");
  });

  it("sliders clamp to [0, 1] and non-finite values are ignored", () => {
    const s = useDjSettings.getState();
    s.setSlider("intensity", 7);
    expect(useDjSettings.getState().sliders.intensity).toBe(1);
    s.setSlider("intensity", Number.NaN);
    expect(useDjSettings.getState().sliders.intensity).toBe(1);
  });
});

describe("useDjSettings — persistence", () => {
  it("writes one JSON document under the v1 key on change", () => {
    const s = useDjSettings.getState();
    s.setPersonality("club");
    s.setSlider("scratching", 1);
    s.setServerMixing(true, "https://mix.example");
    const raw = localStorage.getItem(DJ_SETTINGS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const doc = JSON.parse(raw as string) as Record<string, unknown>;
    expect(doc.personalityId).toBe("club");
    expect((doc.sliders as Record<string, number>).scratching).toBe(1);
    expect((doc.sliders as Record<string, number>).intensity).toBe(0.5);
    expect(doc.serverMixingEnabled).toBe(true);
    expect(doc.serverBaseUrl).toBe("https://mix.example");
  });

  it("setServerMixing without a URL leaves the stored URL alone", () => {
    const s = useDjSettings.getState();
    s.setServerBaseUrl("https://mix.example");
    s.setServerMixing(true);
    expect(useDjSettings.getState().serverBaseUrl).toBe("https://mix.example");
    expect(useDjSettings.getState().serverMixingEnabled).toBe(true);
  });

  it("a fresh module instance rehydrates from the persisted document", async () => {
    localStorage.setItem(
      DJ_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        personalityId: "house",
        sliders: { ...NEUTRAL_SLIDERS, effects: 0.9 },
        serverMixingEnabled: true,
        serverBaseUrl: "https://mix.example",
      }),
    );
    vi.resetModules();
    const fresh = await import("./settings");
    const s = fresh.useDjSettings.getState();
    expect(s.personalityId).toBe("house");
    expect(s.sliders.effects).toBe(0.9);
    expect(s.sliders.intensity).toBe(0.5);
    expect(s.serverMixingEnabled).toBe(true);
    expect(s.serverBaseUrl).toBe("https://mix.example");
  });
});

describe("settings — shaping resolution", () => {
  it("at defaults the resolved shaping is the identity (deep-equal NEUTRAL_SHAPING)", () => {
    const shaping = resolveCurrentShaping(useDjSettings.getState());
    expect(shaping.affinities).toEqual(NEUTRAL_SHAPING.affinities);
    expect(shaping.bends).toEqual(NEUTRAL_SHAPING.bends);
    expect(shaping).toEqual(NEUTRAL_SHAPING);
    expect(shaping).toEqual(
      resolveShaping("autonomous", { ...NEUTRAL_SLIDERS }),
    );
  });

  it("raising the scratching slider moves the scratch affinity up (documented direction)", () => {
    useDjSettings.getState().setSlider("scratching", 1);
    const shaping = resolveCurrentShaping(useDjSettings.getState());
    expect(shaping.affinity("scratch-in")).toBeGreaterThan(1);
    expect(shaping.affinity("scratch-in")).toBeCloseTo(1.35, 5);
    expect(shaping.bends.scratchDensity).toBeGreaterThan(1);
    // And the plain blend bends slightly down, per shaping.ts's table.
    expect(shaping.affinity("blend")).toBeLessThan(1);
  });

  it("subscribeShaping pushes on shaping changes only — not on subscribe, not on server edits", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeShaping(listener);
    expect(listener).not.toHaveBeenCalled();

    useDjSettings.getState().setServerMixing(true, "https://mix.example");
    expect(listener).not.toHaveBeenCalled();

    useDjSettings.getState().setSlider("effects", 1);
    expect(listener).toHaveBeenCalledTimes(1);
    const pushed = listener.mock.calls[0][0] as ReturnType<
      typeof resolveCurrentShaping
    >;
    expect(pushed.affinity("fx")).toBeGreaterThan(1);

    useDjSettings.getState().setPersonality("battle");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    useDjSettings.getState().setSlider("effects", 0);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
