import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnifiedUsage } from '@open-design/contracts';

// Polls the daemon's `GET /api/unified/usage` proxy for the signed-in user's
// account usage. The daemon answers 404 when OpenDesign isn't running inside
// the UnifiedApp host (no broker) — surfaced as `unavailable` so the caller
// can simply render nothing rather than an error.
//
// Refresh cadence is deliberately gentle (usage moves slowly): on mount, every
// ~90s, and whenever the window regains focus. Each load aborts the previous
// in-flight request so a focus burst can't stack duplicate fetches.

const POLL_MS = 90_000;

export interface UnifiedUsageState {
  /**
   * Last successful usage snapshot, or null before the first load. Deliberately
   * RETAINED across transient refresh failures (see `error`) so consumers show
   * the last-known values instead of flickering away on a single failed poll.
   */
  data: UnifiedUsage | null;
  loading: boolean;
  /** Daemon reports usage isn't available here (not in the UnifiedApp host). */
  unavailable: boolean;
  /**
   * Set when the most recent refresh failed (non-404). `data` is kept as the
   * last-good snapshot; usage changes slowly and the next poll self-heals.
   */
  error: string | null;
}

export function useUnifiedUsage(): UnifiedUsageState & { refresh: () => void } {
  const [state, setState] = useState<UnifiedUsageState>({
    data: null,
    loading: true,
    unavailable: false,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // Only the most recent load() may write state. A slow request that resolves
    // after a newer one was issued (e.g. a focus burst) must not clobber the
    // fresher result — aborting the old fetch doesn't stop an already-arrived
    // body from finishing its `.json()` and calling setState.
    const isCurrent = () => abortRef.current === ac;
    try {
      const resp = await fetch('/api/unified/usage', { signal: ac.signal });
      if (!isCurrent()) return;
      if (resp.status === 404) {
        setState({ data: null, loading: false, unavailable: true, error: null });
        return;
      }
      if (!resp.ok) {
        setState((s) => ({
          ...s,
          loading: false,
          unavailable: false,
          error: `usage ${resp.status}`,
        }));
        return;
      }
      const json = (await resp.json()) as { usage: UnifiedUsage };
      if (!isCurrent()) return;
      setState({
        data: json.usage ?? null,
        loading: false,
        unavailable: false,
        error: null,
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      if (!isCurrent()) return;
      setState((s) => ({ ...s, loading: false, unavailable: false, error: String(err) }));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      abortRef.current?.abort();
    };
  }, [load]);

  return { ...state, refresh: load };
}
