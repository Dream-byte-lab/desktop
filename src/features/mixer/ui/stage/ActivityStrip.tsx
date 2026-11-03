import type { ActivityLine } from "./stageData";

// The stage's status line: who is in control (the level chip) and
// what the session is doing right now (the activity lines, coloured
// by tone). Pure render — every fact arrives as a prop.

interface ActivityStripProps {
  lines: ActivityLine[];
  levelLabel: string;
}

const TONE_DOT: Record<ActivityLine["tone"], string> = {
  live: "var(--accent-primary)",
  prep: "var(--accent-warning)",
  warn: "#f87171",
  idle: "rgba(148,140,190,0.6)",
};

const TONE_TEXT_CLASS: Record<ActivityLine["tone"], string> = {
  live: "text-text-primary",
  prep: "text-text-primary",
  warn: "text-red-400",
  idle: "text-text-secondary",
};

export function ActivityStrip({ lines, levelLabel }: ActivityStripProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em]"
        style={{
          borderColor: "var(--accent-primary)",
          color: "var(--accent-primary)",
        }}
      >
        {levelLabel}
      </span>
      {lines.map((line, index) => (
        <span
          key={`${line.tone}-${index}`}
          className={`flex items-center gap-1.5 text-[11px] ${TONE_TEXT_CLASS[line.tone]}`}
          style={
            line.tone === "live"
              ? { color: "var(--accent-primary)" }
              : line.tone === "prep"
                ? { color: "var(--accent-warning)" }
                : undefined
          }
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: TONE_DOT[line.tone] }}
            aria-hidden="true"
          />
          {line.text}
        </span>
      ))}
    </div>
  );
}
