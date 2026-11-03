import { useState } from "react";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib";
import { SettingBlock } from "../controls";
import {
  ACCENT_FAMILIES,
  guardCustomAccent,
  normalizeHex,
  type AccentFamilyId,
} from "../../lib/accent";
import { useAccentStore } from "../../store/accentStore";

// The accent picker (Settings > Appearance; Interface Build 6).
// A curated family derived from the icon sweep, plus one custom
// slot guarded for contrast (design read, Open Question 2 — RULED).
// This component only writes the accent store; useAccentSync applies
// the choice to the document. Swatch gradients preview each family's
// dark-register stops (dark is the design's primary register); the
// spring stop of the preview is the family's guarded primary.

function familyGradient(id: AccentFamilyId): string {
  const stops = ACCENT_FAMILIES.find((family) => family.id === id)!.dark;
  return `linear-gradient(120deg, ${stops.lime} 0%, ${stops.spring} 52%, ${stops.teal} 100%)`;
}

export function AccentSetting({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const choice = useAccentStore((state) => state.choice);
  const customHex = useAccentStore((state) => state.customHex);
  const setChoice = useAccentStore((state) => state.setChoice);
  const setCustomHex = useAccentStore((state) => state.setCustomHex);
  const [rejected, setRejected] = useState(false);

  // The guard's standing verdict on the stored custom colour, so
  // the adjusted note is the truth whenever the custom slot is
  // active — not only in the moment of picking.
  const guarded = customHex ? guardCustomAccent(customHex) : null;
  const showAdjusted = choice === "custom" && guarded?.adjusted === true;

  const handleCustomPick = (raw: string) => {
    const hex = normalizeHex(raw);
    if (!hex) return;
    const verdict = guardCustomAccent(hex);
    if (!verdict) {
      // Refused honestly: nothing is stored, nothing is applied,
      // and the note says why.
      setRejected(true);
      return;
    }
    setRejected(false);
    setCustomHex(hex);
    setChoice("custom");
  };

  return (
    <SettingBlock
      title={t("settings.accent.title")}
      description={t("settings.accent.description")}
      titleKey="settings.accent.title"
      descKey="settings.accent.description"
      searchQuery={searchQuery}
    >
      <div className="flex flex-wrap items-start gap-[10px]">
        {ACCENT_FAMILIES.map((family) => {
          const active = choice === family.id;
          const label = t(`settings.accent.families.${family.id}`);
          return (
            <button
              key={family.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setRejected(false);
                setChoice(family.id);
              }}
              className="group flex w-[86px] flex-col items-center gap-[6px] border-0 bg-transparent p-0 cursor-pointer"
            >
              <span
                className={cn(
                  "h-[40px] w-full rounded-item transition-shadow",
                  active
                    ? "ring-2 ring-accent-primary ring-offset-2 ring-offset-bg-panel"
                    : "ring-1 ring-border-primary group-hover:ring-border-tertiary",
                )}
                style={{ background: familyGradient(family.id) }}
              />
              <span
                className={cn(
                  "text-[12px]",
                  active
                    ? "font-semibold text-text-primary"
                    : "text-text-secondary",
                )}
              >
                {label}
              </span>
            </button>
          );
        })}

        {/* The custom slot: the swatch is the colour input itself. */}
        <div className="flex w-[86px] flex-col items-center gap-[6px]">
          <label
            className={cn(
              "relative block h-[40px] w-full overflow-hidden rounded-item transition-shadow cursor-pointer",
              choice === "custom"
                ? "ring-2 ring-accent-primary ring-offset-2 ring-offset-bg-panel"
                : "ring-1 ring-border-primary hover:ring-border-tertiary",
            )}
            style={
              customHex
                ? { background: customHex }
                : {
                    background:
                      "repeating-conic-gradient(var(--fill) 0% 25%, transparent 0% 50%) 0 0 / 12px 12px",
                  }
            }
          >
            <input
              type="color"
              aria-label={t("settings.accent.custom_label")}
              value={customHex ?? "#3fd68f"}
              onClick={() => {
                if (customHex) {
                  setRejected(false);
                  setChoice("custom");
                }
              }}
              onChange={(event) => handleCustomPick(event.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
          <span
            className={cn(
              "text-[12px]",
              choice === "custom"
                ? "font-semibold text-text-primary"
                : "text-text-secondary",
            )}
          >
            {t("settings.accent.families.custom")}
          </span>
        </div>
      </div>

      {customHex && choice === "custom" ? (
        <p className="m-0 text-[12px] text-text-secondary tabular-nums">
          {t("settings.accent.custom_label")}: {customHex.toUpperCase()}
        </p>
      ) : null}

      {showAdjusted && guarded ? (
        <p className="m-0 flex flex-wrap items-center gap-x-[6px] gap-y-[2px] text-[12px] text-text-secondary">
          <span>{t("settings.accent.adjusted_note")}</span>
          <span className="inline-flex items-center gap-[4px] tabular-nums">
            {t("settings.theme.dark")}
            <span
              className="inline-block h-[10px] w-[10px] rounded-full ring-1 ring-border-primary"
              style={{ background: guarded.dark.spring }}
            />
            {guarded.dark.spring.toUpperCase()}
          </span>
          <span className="inline-flex items-center gap-[4px] tabular-nums">
            {t("settings.theme.light")}
            <span
              className="inline-block h-[10px] w-[10px] rounded-full ring-1 ring-border-primary"
              style={{ background: guarded.light.spring }}
            />
            {guarded.light.spring.toUpperCase()}
          </span>
        </p>
      ) : null}

      {rejected ? (
        <p className="m-0 text-[12px] text-accent-warning">
          {t("settings.accent.rejected_note")}
        </p>
      ) : null}
    </SettingBlock>
  );
}
