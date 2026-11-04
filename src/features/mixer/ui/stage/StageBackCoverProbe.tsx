import { useEffect, useState, type RefObject } from "react";

// DIAGNOSTIC INSTRUMENTATION — Note 26. Removable in one slice:
// delete this file, its two mounts in DjStageView, and the
// `buttonRef` prop on StageBackButton, and the stage is exactly
// as it was.
//
// Why it exists: the stage's Back pill is verified correct in
// source (the diagnosis read the shipped blob layer by layer and
// exonerated every code suspect), yet in the running app it
// shows no hover or press feedback and does not fire — not even
// from the keyboard. If something that exists only in the
// running app is taking the pointer, code reading cannot see it;
// the app itself has to say what it is. So on mount, and once
// more after a short settle, this probe asks the document what
// element actually sits on top of the pill's centre
// (document.elementFromPoint). The normal case — the pill, or
// one of its own children, is on top — renders nothing at all:
// zero visible change. Only when a foreign element covers the
// pill does it render a small chip naming that element (tag, id,
// first class), worded so the user can read it aloud verbatim.
//
// The probe must never take the stage down with it: every check
// is wrapped, and any environment without a usable
// elementFromPoint (jsdom stubs it; tests mock it) simply yields
// no finding.

const SETTLE_MS = 750;

function describeCover(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const className = typeof el.className === "string" ? el.className : "";
  const firstClass = className.trim().split(/\s+/).filter(Boolean)[0];
  return `${tag}${id}${firstClass ? `.${firstClass}` : ""}`;
}

export function StageBackCoverProbe({
  targetRef,
}: {
  targetRef: RefObject<HTMLButtonElement | null>;
}) {
  const [cover, setCover] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      try {
        const target = targetRef.current;
        if (!target || typeof document.elementFromPoint !== "function") {
          return;
        }
        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const top = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (!top || top === target || target.contains(top)) {
          setCover(null);
          return;
        }
        setCover(describeCover(top));
      } catch {
        // A diagnostic probe swallows its own failures; the
        // stage's behaviour never depends on it.
      }
    };
    check();
    const timer = setTimeout(check, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [targetRef]);

  if (cover === null) return null;
  return (
    <span
      data-stage-back-cover-probe
      role="note"
      className="inline-flex items-center rounded-full bg-amber-400/20 px-2.5 py-1 text-[11px] font-semibold text-amber-600 select-none dark:text-amber-300"
    >
      Back button covered by: {cover}
    </span>
  );
}
