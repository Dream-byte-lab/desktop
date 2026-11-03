import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { userDisplayName } from "@/entities/user";
import { useAuthStore } from "@/features/auth";
import { composeFreshGreeting } from "../lib/compose";
import { GreetingVisualizer } from "./GreetingVisualizer";
import {
  deriveSessionContext,
  loadGreetingMemory,
  recordShowing,
  saveGreetingMemory,
} from "../lib/greetingMemory";

// The welcome greeting: the first thing the app says when it opens.
// It greets the account holder by name (when signed in), follows the
// time of day, rises in with a gentle animation, and then gets out of
// the way on its own. It never blocks anything — the container takes
// no pointer events — and it appears once per launch. The words are
// composed fresh for this exact moment (see lib/compose.ts) and
// recorded in the no-repeat memory, so the listener never sees the
// same greeting twice.
//
// The surface (design reference 34): a minimal glass band in the
// design foundation's material — behind the greeting text, a frosted
// layer; behind the frost, a live visualizer breathing on a slow
// heartbeat (see ui/GreetingVisualizer.tsx). The words and their
// cadence are unchanged; only the surface they speak through moved.

const SHOW_DELAY_MS = 500;
const VISIBLE_MS = 4600;

export function WelcomeGreeting() {
  const user = useAuthStore((state) => state.user);
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);

  const now = useMemo(() => new Date(), []);
  const [greeting] = useState(() => {
    const memory = loadGreetingMemory();
    const context = deriveSessionContext(memory, now);
    const fresh = composeFreshGreeting(
      {
        date: now,
        name: userDisplayName(user),
        context,
        rng: Math.random,
      },
      memory,
    );
    saveGreetingMemory(recordShowing(memory, fresh.hash, now));
    return fresh.greeting;
  });
  const dateLine = now.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  useEffect(() => {
    const show = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    const hide = setTimeout(
      () => setVisible(false),
      SHOW_DELAY_MS + VISIBLE_MS,
    );
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-50 flex justify-center px-4">
      <AnimatePresence>
        {visible ? (
          <motion.div
            key="welcome-greeting"
            initial={
              reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.97 }
            }
            animate={
              reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }
            }
            exit={{ opacity: 0, y: reduceMotion ? 0 : -8 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="relative overflow-hidden rounded-panel text-center shadow-xl ring-1 ring-inset ring-rim"
            role="status"
          >
            <GreetingVisualizer active={visible} />
            <div
              aria-hidden
              className="absolute inset-0 bg-surface-glass backdrop-blur-[16px] backdrop-saturate-150"
            />
            <div className="relative px-5 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-secondary">
                {dateLine}
              </div>
              <div className="mt-0.5 text-xl font-semibold text-text-primary">
                {greeting.headline}
              </div>
              <div className="text-sm text-text-secondary">
                {greeting.subline}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
