import { DIAG_ENDPOINTS } from "./diagnostics";
import type { ConnectionProbe } from "./classify";

const API_PROBE_TIMEOUT_MS = 6000;

async function probeApi(): Promise<ConnectionProbe["api"]> {
  try {
    const res = await fetch(`${DIAG_ENDPOINTS.api}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

/**
 * The desktop bridge normally answers "is the internet itself
 * up?" so a failed API call can be told apart from a dead
 * connection. A browser has no bridge: without a substitute, every
 * API failure falls back to "offline" even on a healthy network
 * (upstream's conservative desktop fallback). The substitute: any
 * HTTP answer at all from another of the service's origins proves
 * the internet path works — only a network-level failure counts
 * against it.
 */
async function probeInternetFallback(): Promise<boolean> {
  try {
    await fetch(`${DIAG_ENDPOINTS.covers}/`, {
      cache: "no-store",
      signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

export async function probeConnection(): Promise<ConnectionProbe> {
  const deviceOnline =
    typeof navigator === "undefined" ? true : navigator.onLine;
  const bridge =
    typeof window !== "undefined" ? window.linerElectron?.probeNetwork : null;
  const [api, net] = await Promise.all([
    probeApi(),
    bridge ? bridge().catch(() => null) : Promise.resolve(null),
  ]);
  const internet = net
    ? net.internet
    : api.ok
      ? true
      : await probeInternetFallback();
  return {
    deviceOnline,
    api,
    internet,
    youtube: net ? net.youtube : null,
    youtubeFailure: net?.youtubeFailure ?? null,
    country: net?.country ?? null,
  };
}
