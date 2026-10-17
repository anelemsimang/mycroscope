import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { errorMessage } from './api';

/** Loads data, reloads on screen focus, and exposes refresh/error state. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(async (mode: 'initial' | 'refresh' | 'silent' = 'silent') => {
    const id = ++seq.current;
    if (mode === 'initial') setLoading(true);
    if (mode === 'refresh') setRefreshing(true);
    try {
      const result = await loader();
      if (id === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(errorMessage(e));
    } finally {
      if (id === seq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, deps);

  const loadedOnce = useRef(false);
  const seenLoader = useRef<typeof run | null>(null);
  useFocusEffect(useCallback(() => {
    const first = !loadedOnce.current;
    const filtersChanged = seenLoader.current !== null && seenLoader.current !== run;
    seenLoader.current = run;
    loadedOnce.current = true;
    if (first || filtersChanged) {
      setData(null);
      run('initial');
    } else {
      run('silent');
    }
  }, [run]));

  return { data, error, loading, refreshing, refresh: () => run('refresh'), reload: () => run('silent') };
}
