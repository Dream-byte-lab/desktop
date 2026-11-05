import { useEffect, useState } from "react";

/**
 * The overlay's artwork-derived accent: the average colour of the current
 * cover, lifted into a band that stays visible on dark glass.
 *
 * Cost discipline (the overlay lives on the user's ARM tablet): the cover
 * is drawn once into a 12x12 canvas — 144 pixels — when the track changes,
 * never per frame, never animated. The blurred glass backdrop itself is a
 * static <img> the compositor rasterises once per track. Results are
 * cached per source URL for the life of the window. Any failure (no
 * canvas, CORS-tainted image, decode error) yields null and the caller
 * falls back to the theme accent.
 */
const SAMPLE_PX = 12;
const cache = new Map<string, string | null>();

function normaliseTint(r: number, g: number, b: number): string {
  // Pull 25% toward the colour's own luminance so neon covers calm down,
  // then scale so the strongest channel lands in a visible mid band.
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mix = (c: number) => c * 0.75 + lum * 0.25;
  let [mr, mg, mb] = [mix(r), mix(g), mix(b)];
  const max = Math.max(mr, mg, mb, 1);
  const scale = 196 / max;
  mr = Math.min(255, mr * scale);
  mg = Math.min(255, mg * scale);
  mb = Math.min(255, mb * scale);
  return `rgb(${Math.round(mr)}, ${Math.round(mg)}, ${Math.round(mb)})`;
}

function sampleTint(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = SAMPLE_PX;
          canvas.height = SAMPLE_PX;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, SAMPLE_PX, SAMPLE_PX);
          const data = ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data;
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            n += 1;
          }
          if (!n) return resolve(null);
          resolve(normaliseTint(r / n, g / n, b / n));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    } catch {
      resolve(null);
    }
  });
}

export function useArtworkTint(src: string | null | undefined): string | null {
  const [tint, setTint] = useState<string | null>(() =>
    src ? (cache.get(src) ?? null) : null,
  );

  useEffect(() => {
    if (!src) {
      setTint(null);
      return;
    }
    if (cache.has(src)) {
      setTint(cache.get(src) ?? null);
      return;
    }
    let cancelled = false;
    void sampleTint(src).then((result) => {
      cache.set(src, result);
      if (!cancelled) setTint(result);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return tint;
}
