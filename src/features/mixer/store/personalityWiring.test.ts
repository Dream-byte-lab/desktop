import { beforeEach, describe, expect, it, vi } from "vitest";
import { STANDARD_PROFILE } from "../engine/decisionProfile";
import {
  DEFAULT_CURATION_BENDS,
  type ResolvedDecisionSettings,
} from "../engine/personality";

// The personality wiring, driven against a fake session recording
// every setDecisionSettings call (the djIntentWiring.test.ts
// construction: an injected deps seam, the real module mocked
// out). The settings source here is the real personality store, so
// changing the store is exactly what the wiring hears.

vi.mock("../engine/djSession", () => ({
  djSession: {
    setDecisionSettings: vi.fn(() => {}),
  },
}));

import {
  createPersonalityWiring,
  type PersonalitySession,
  type PersonalityWiring,
} from "./personalityWiring";
import {
  activeSlidersOf,
  readPersistedPersonalityState,
  usePersonalityStore,
} from "./personalityStore";

interface Harness {
  wiring: PersonalityWiring;
  calls: ResolvedDecisionSettings[];
  session: PersonalitySession;
}

function makeHarness(): Harness {
  const calls: ResolvedDecisionSettings[] = [];
  const session: PersonalitySession = {
    setDecisionSettings: (settings) => {
      calls.push(settings);
    },
  };
  const wiring = createPersonalityWiring({
    session,
    getSettingsState: () => {
      const state = usePersonalityStore.getState();
      return {
        personalityId: state.personalityId,
        sliders: activeSlidersOf(state),
      };
    },
    subscribe: (listener) => usePersonalityStore.subscribe(() => listener()),
  });
  return { wiring, calls, session };
}

describe("personalityWiring", () => {
  beforeEach(() => {
    localStorage.clear();
    usePersonalityStore.setState(readPersistedPersonalityState());
  });

  it("creation applies once, with STANDARD_PROFILE by identity at autonomous defaults", () => {
    const h = makeHarness();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].profile).toBe(STANDARD_PROFILE);
    expect(h.calls[0].curation).toEqual(DEFAULT_CURATION_BENDS);
    expect(h.calls[0].arcShapeLean).toBeNull();
    h.wiring.dispose();
  });

  it("changing the store to battle re-applies with profile.id battle", () => {
    const h = makeHarness();
    usePersonalityStore.getState().setPersonality("battle");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].profile.id).toBe("battle");
    expect(h.calls[1].profile).not.toBe(STANDARD_PROFILE);
    h.wiring.dispose();
  });

  it("moving a slider re-applies the resolved settings", () => {
    const h = makeHarness();
    usePersonalityStore.getState().setPersonality("battle");
    expect(h.calls).toHaveLength(2);
    const before = h.calls[1];
    usePersonalityStore.getState().setSlider("intensity", 1);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].profile.id).toBe("battle");
    // The bend is real: battle at full intensity blends longer
    // than battle at neutral intensity.
    expect(h.calls[2].profile.standardBlendBeats).toBeGreaterThan(
      before.profile.standardBlendBeats,
    );
    h.wiring.dispose();
  });

  it("dispose stops further applications", () => {
    const h = makeHarness();
    h.wiring.dispose();
    usePersonalityStore.getState().setPersonality("club");
    expect(h.calls).toHaveLength(1);
  });
});
