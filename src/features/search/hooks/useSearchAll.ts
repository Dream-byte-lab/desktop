import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiSearchItem } from "@/shared/api";

export interface UseSearchAllOptions {
  enabled: boolean;
  limit: number;
  debounceMs: number;
}

export interface UseSearchAllResult {
  items: ApiSearchItem[];
  loading: boolean;
  hasLoaded: boolean;
  error: Error | null;
  partialWarning?: string;
  runNow: () => void;
}

export function useSearchAll(
  query: string,
  options: UseSearchAllOptions,
): UseSearchAllResult {
  const [items, setItems] = useState<ApiSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [partialWarning, setPartialWarning] = useState<string | undefined>();

  const latestRequestIdRef = useRef(0);
  const lastFetchedQueryRef = useRef("");
  const trimmed = query.trim();
  const shouldRunSearch = options.enabled && trimmed.length >= 2;

  const runRequest = useCallback(async (requestId: number, q: string) => {
    setLoading(true);
    try {
      const res = await api.search(q, "all");
      if (requestId !== latestRequestIdRef.current) return;
      setItems(res.items);
      setError(null);
      setPartialWarning(undefined);
      lastFetchedQueryRef.current = q;
      setHasLoaded(true);
    } catch (err) {
      if (requestId !== latestRequestIdRef.current) return;
      setItems([]);
      // The Search page must tell a failed search from an empty one
      // (the S0 lesson): the error rides the result exactly as the
      // four per-type hooks already expose theirs.
      setError(err instanceof Error ? err : new Error(String(err)));
      setPartialWarning(undefined);
      setHasLoaded(true);
    } finally {
      if (requestId === latestRequestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (trimmed.length < 2) {
      latestRequestIdRef.current += 1;
      setItems([]);
      setHasLoaded(false);
      setLoading(false);
      setError(null);
      setPartialWarning(undefined);
      lastFetchedQueryRef.current = "";
      return;
    }

    if (!options.enabled) return;

    if (lastFetchedQueryRef.current === trimmed && items.length > 0) {
      setLoading(false);
      setHasLoaded(true);
      return;
    }

    setLoading(true);
    const requestId = ++latestRequestIdRef.current;
    const timer = setTimeout(() => {
      if (lastFetchedQueryRef.current === trimmed && items.length > 0) {
        setLoading(false);
        setHasLoaded(true);
        return;
      }
      void runRequest(requestId, trimmed);
    }, options.debounceMs ?? 320);

    return () => {
      clearTimeout(timer);
    };
  }, [items.length, options.debounceMs, options.enabled, runRequest, trimmed]);

  const runNow = useCallback(() => {
    if (!shouldRunSearch) return;
    const requestId = ++latestRequestIdRef.current;
    void runRequest(requestId, trimmed);
  }, [runRequest, shouldRunSearch, trimmed]);

  return { items, loading, hasLoaded, error, partialWarning, runNow };
}
