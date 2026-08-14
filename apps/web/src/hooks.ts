import { useCallback, useEffect, useRef, useState } from 'react';

/** Short polling keeps Phase 2 free of WebSocket operational complexity. */
export function usePoll<T>(
  load: () => Promise<T>,
  intervalMs: number,
  enabled = true,
): {
  data: T | null;
  error: string | null;
  refresh: () => Promise<void>;
  setData: (value: T) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [enabled, intervalMs, refresh]);

  return { data, error, refresh, setData };
}

/** Remember the invite link beside its room so the host can re-share it. */
export function rememberInvite(roomId: string, inviteToken: string): void {
  try {
    globalThis.localStorage.setItem(`quorum.invite.${roomId}`, inviteToken);
  } catch {
    // Storage is a convenience only; the create screen still shows the link.
  }
}

export function recallInvite(roomId: string): string | null {
  try {
    return globalThis.localStorage.getItem(`quorum.invite.${roomId}`);
  } catch {
    return null;
  }
}
