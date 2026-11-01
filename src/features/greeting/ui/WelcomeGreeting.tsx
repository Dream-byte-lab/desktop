import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { userDisplayName } from "@/entities/user";
import { useAuthStore } from "@/features/auth";
import { greetingAt } from "../lib/greeting";

// The welcome greeting: the first thing the app says when it opens.
// It greets the account holder by name (when signed in), follows the
// time of day, rises in with a gentle animation, and then gets out of
// the way on its own. It never blocks anything — the container takes
// no pointer events — and it appears once per launch.

const SHOW_DELAY_MS = 500;
const VISIBLE_MS = 4600;

export function WelcomeGreeting() {
  const user = useAuthStore((state) => state.user);
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);

  const now = useMemo(() => new Date(), []);
  const greeting = greetingAt(now, userDisplayName(user));
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
            className="rounded-2xl border border-border-tertiary bg-bg-primary/90 px-5 py-3 text-center shadow-xl backdrop-blur-md"
            role="status"
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-secondary">
              {dateLine}
            </div>
            <div className="mt-0.5 text-xl font-semibold text-text-primary">
              {greeting.headline}
            </div>
            <div className="text-sm text-text-secondary">
              {greeting.subline}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
