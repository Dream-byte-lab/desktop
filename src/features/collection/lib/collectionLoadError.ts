import { ApiError } from "@/shared/api";
import { LocalMixNotFoundError } from "./localMixResolver";

/**
 * Why a collection load ended with nothing to show. A genuine
 * not-found (the collection does not exist — including a Daily
 * Mix whose day has rolled over, which is by design) must stay
 * visually distinct from a load FAILURE (the collection may well
 * exist; we just couldn't reach it), because only the second one
 * deserves a retry.
 */
export type CollectionLoadError =
  { kind: "not-found" } | { kind: "failed"; cause: unknown };

/**
 * The discrimination rule, decidable from the rejection's shape:
 * a rejection is a genuine NOT-FOUND only if it is the local mix
 * resolver's named error or an ApiError with status 404.
 * Everything else — fetch TypeErrors, 5xx, aborts — is a FAILURE.
 */
export function classifyCollectionLoadError(
  cause: unknown,
): CollectionLoadError {
  if (cause instanceof LocalMixNotFoundError) return { kind: "not-found" };
  if (cause instanceof ApiError && cause.status === 404) {
    return { kind: "not-found" };
  }
  return { kind: "failed", cause };
}

export type CollectionLoadFailureHint = "offline" | "server";

/**
 * The one honest "why" line for a failed load, only where the
 * cause proves it: the browser reporting itself offline, a
 * network-level failure (fetch TypeError, or the API layer's
 * status-0 network error) reads as a connection problem; a 5xx
 * answer reads as a server problem. A status-0 TIMEOUT proves
 * neither side — a slow server is not a connection problem — so
 * it gets no line. Anything else proves nothing and gets no line.
 */
export function collectionLoadFailureHint(
  cause: unknown,
): CollectionLoadFailureHint | null {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "offline";
  }
  if (cause instanceof ApiError) {
    if (cause.status >= 500) return "server";
    if (cause.status === 0) {
      if (cause.code === "TIMEOUT_ERROR") return null;
      return "offline";
    }
    return null;
  }
  if (cause instanceof TypeError) return "offline";
  return null;
}
