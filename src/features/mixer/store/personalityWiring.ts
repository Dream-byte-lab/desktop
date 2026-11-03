import { djSession } from "../engine/djSession";
import {
  resolveDecisionSettings,
  type PersonalityId,
  type ResolvedDecisionSettings,
  type SliderSettings,
} from "../engine/personality";
import { activeSlidersOf, usePersonalityStore } from "./personalityStore";

// Personality wiring (revamp slice R4): the personality store is
// the listener's standing temperament, and the DJ session spends
// it — this wiring is the one place the two meet. Whenever the
// store speaks, the current (personality, sliders) are resolved
// through the pure resolver and handed to the session, which
// stores them and points its brain at the resolved profile.
//
// Applying is a plain brain-profile assignment via the session, so
// re-applying on every notification is cheap and unconditional —
// there is no diffing to get wrong. The wiring never writes the
// store, so it cannot loop.
//
// The deps are injected behind narrow interfaces (the
// djIntentWiring pattern) so the wiring is unit-testable against a
// fake session and a fake settings source.

/** The slice of the DJ session the wiring needs. */
export interface PersonalitySession {
  setDecisionSettings: (settings: ResolvedDecisionSettings) => void;
}

/** The settings state the wiring resolves from, on each notice. */
export interface PersonalitySettingsState {
  personalityId: PersonalityId;
  sliders: SliderSettings;
}

export interface PersonalityWiringDeps {
  session: PersonalitySession;
  getSettingsState: () => PersonalitySettingsState;
  subscribe: (listener: () => void) => () => void;
}

export interface PersonalityWiring {
  dispose: () => void;
}

export function createPersonalityWiring(
  deps: PersonalityWiringDeps,
): PersonalityWiring {
  const apply = (): void => {
    const { personalityId, sliders } = deps.getSettingsState();
    deps.session.setDecisionSettings(
      resolveDecisionSettings(personalityId, sliders),
    );
  };
  // The standing temperament applies the moment the wiring exists:
  // a session created later still starts from the listener's
  // settings, not from a change that happens to come after.
  apply();
  const unsubscribe = deps.subscribe(apply);
  return {
    dispose: () => {
      unsubscribe();
    },
  };
}

let singleton: PersonalityWiring | null = null;

/** Creates (once) the app's wiring against the real store/session. */
export function initPersonalityWiring(): PersonalityWiring {
  if (singleton) return singleton;
  singleton = createPersonalityWiring({
    session: djSession,
    getSettingsState: () => {
      const state = usePersonalityStore.getState();
      return {
        personalityId: state.personalityId,
        sliders: activeSlidersOf(state),
      };
    },
    subscribe: (listener) => usePersonalityStore.subscribe(() => listener()),
  });
  return singleton;
}
