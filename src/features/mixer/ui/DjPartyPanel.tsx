import { useMemo, useState } from "react";
import { renderSVG } from "uqr";
import { partyHost } from "../engine/partyHost";
import { useDjModeStore } from "../store/djModeStore";
import { usePartyStore } from "../store/partyStore";

// The host's party panel: liveRave's front door, on the host's own
// screen. It follows the house rule — invisible unless DJ mode is
// on, so the seamless app shows no trace of it. Closed, it is one
// quiet button. Open, it is the invitation and the guardrails:
//
// - the invite card: a QR code guests scan, with the join address
//   underneath for anyone who would rather type it;
// - the live request feed, wearing the same status words the
//   guests see on their phones;
// - the room's reactions, tallied as they land;
// - the kill switch (pause requests — the music never stops) and
//   the do-not-play list the DJ brain enforces against everyone.

function statusChipClass(status: string): string {
  if (status === "coming soon" || status === "played") {
    return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  }
  if (status === "not tonight") {
    return "bg-red-500/15 text-red-600 dark:text-red-400";
  }
  return "bg-black/[0.06] text-text-secondary dark:bg-white/[0.08]";
}

export function DjPartyPanel() {
  const djActive = useDjModeStore((state) => state.active);
  const party = usePartyStore();
  const [blockInput, setBlockInput] = useState("");
  const joinUrl = party.addresses[0] ?? "";
  const qrDataUrl = useMemo(() => {
    if (!joinUrl) return "";
    const svg = renderSVG(joinUrl);
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }, [joinUrl]);

  if (!djActive) return null;

  if (!party.open) {
    return (
      <div className="flex justify-center px-3 pb-1">
        <button
          type="button"
          onClick={() => void partyHost.start()}
          className="rounded-full border border-border-tertiary bg-bg-primary/80 px-4 py-1.5 text-xs font-semibold text-text-secondary backdrop-blur-md transition-colors hover:text-text-primary"
        >
          Open a liveRave party
        </button>
      </div>
    );
  }

  const addBlock = () => {
    const value = blockInput.trim();
    if (!value) return;
    if (!party.doNotPlay.includes(value)) {
      partyHost.setDoNotPlay([...party.doNotPlay, value]);
    }
    setBlockInput("");
  };

  return (
    <div className="mx-3 mb-2 rounded-2xl border border-border-tertiary bg-bg-primary/90 p-4 shadow-xl backdrop-blur-md">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex shrink-0 flex-col items-center gap-2">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="QR code to join the party"
              className="h-36 w-36 rounded-xl bg-white p-1.5"
            />
          ) : null}
          <div className="max-w-40 text-center text-xs font-medium break-all text-text-primary">
            {joinUrl || "No local network found"}
          </div>
          <div className="text-[11px] text-text-secondary">
            Guests: same Wi-Fi, scan or type
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-text-primary">
              Party is live
            </div>
            <div className="text-xs text-text-secondary">
              🔥 {party.reactions.fire} · ❤️ {party.reactions.heart} · 👏{" "}
              {party.reactions.clap}
            </div>
          </div>

          <div className="mt-2 space-y-1">
            {party.feed.slice(0, 6).map((item) => (
              <div
                key={item.recordId}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="min-w-0 truncate text-text-primary">
                  {item.title}
                  <span className="text-text-secondary"> · {item.artist}</span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusChipClass(item.status)}`}
                >
                  {item.status}
                </span>
              </div>
            ))}
            {party.feed.length === 0 ? (
              <div className="text-sm text-text-secondary">
                No requests yet — the room is listening.
              </div>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => partyHost.setPaused(!party.paused)}
              className="rounded-full border border-border-tertiary px-3 py-1 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary"
            >
              {party.paused ? "Resume requests" : "Pause requests"}
            </button>
            <button
              type="button"
              onClick={() => void partyHost.stop()}
              className="rounded-full border border-border-tertiary px-3 py-1 text-xs font-semibold text-red-500 transition-colors hover:text-red-600"
            >
              End party
            </button>
          </div>

          <div className="mt-3">
            <div className="flex gap-2">
              <input
                value={blockInput}
                onChange={(event) => setBlockInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addBlock();
                }}
                placeholder="Do not play: block an artist…"
                className="min-w-0 flex-1 rounded-full border border-border-tertiary bg-transparent px-3 py-1 text-xs text-text-primary outline-none placeholder:text-text-secondary"
              />
              <button
                type="button"
                onClick={addBlock}
                className="rounded-full border border-border-tertiary px-3 py-1 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary"
              >
                Block
              </button>
            </div>
            {party.doNotPlay.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {party.doNotPlay.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() =>
                      partyHost.setDoNotPlay(
                        party.doNotPlay.filter((entry) => entry !== value),
                      )
                    }
                    className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400"
                    title="Remove from the do-not-play list"
                  >
                    {value} ×
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
