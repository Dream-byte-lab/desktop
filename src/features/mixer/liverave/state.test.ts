import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DJ_INTENT_STORAGE_KEY,
  readPersistedDjIntent,
  useDjState,
} from "./state";

function resetState(): void {
  localStorage.clear();
  useDjState.setState({
    intent: false,
    active: false,
    blending: false,
    proOpen: false,
    controlLevel: "autonomous",
  });
  localStorage.clear();
}

beforeEach(resetState);

describe("useDjState — defaults", () => {
  it("starts with intent off and everything else ephemeral-off", () => {
    const s = useDjState.getState();
    expect(s.intent).toBe(false);
    expect(s.active).toBe(false);
    expect(s.blending).toBe(false);
    expect(s.proOpen).toBe(false);
    expect(s.controlLevel).toBe("autonomous");
  });

  it("setters move their own field only", () => {
    const s = useDjState.getState();
    s.setActive(true);
    s.setBlending(true);
    s.setProOpen(true);
    s.setControlLevel("manual");
    const next = useDjState.getState();
    expect(next.active).toBe(true);
    expect(next.blending).toBe(true);
    expect(next.proOpen).toBe(true);
    expect(next.controlLevel).toBe("manual");
    expect(next.intent).toBe(false);
  });

  it("an unknown control level falls back to autonomous", () => {
    useDjState.getState().setControlLevel("bogus" as never);
    expect(useDjState.getState().controlLevel).toBe("autonomous");
  });
});

describe("useDjState — intent persistence", () => {
  it("writes intent under the v2 key on change, as a plain boolean string", () => {
    useDjState.getState().setIntent(true);
    expect(localStorage.getItem(DJ_INTENT_STORAGE_KEY)).toBe("true");
    expect(readPersistedDjIntent()).toBe(true);
    useDjState.getState().setIntent(false);
    expect(localStorage.getItem(DJ_INTENT_STORAGE_KEY)).toBe("false");
    expect(readPersistedDjIntent()).toBe(false);
  });

  it("persists intent changed via raw setState too (wiring's door)", () => {
    useDjState.setState({ intent: true });
    expect(localStorage.getItem(DJ_INTENT_STORAGE_KEY)).toBe("true");
  });

  it("the ephemeral fields are never persisted", () => {
    const s = useDjState.getState();
    s.setActive(true);
    s.setBlending(true);
    s.setProOpen(true);
    s.setControlLevel("assisted");
    expect(localStorage.length).toBe(0);
  });

  it("readPersistedDjIntent tolerates garbage and absence", () => {
    expect(readPersistedDjIntent()).toBe(false);
    localStorage.setItem(DJ_INTENT_STORAGE_KEY, "{not json");
    expect(readPersistedDjIntent()).toBe(false);
    localStorage.setItem(DJ_INTENT_STORAGE_KEY, "true");
    expect(readPersistedDjIntent()).toBe(true);
  });

  it("storage failures are swallowed — setIntent still works", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota / private mode");
      });
    try {
      expect(() => useDjState.getState().setIntent(true)).not.toThrow();
      expect(useDjState.getState().intent).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
