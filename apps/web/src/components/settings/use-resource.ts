'use client';

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api-client';

/**
 * The four states, as a type — DOCUMENT 11 §2, DOCUMENT 27 RULE 27.
 *
 * Modelling them as a discriminated union rather than three booleans is what
 * makes "a screen missing one is not finished" checkable: a component that
 * does not handle `error` will not compile against an exhaustive switch, and a
 * screen cannot accidentally render its empty state while a request is still
 * in flight.
 *
 * `success` is deliberately not in this union. It belongs to a *write*, not to
 * the resource — the data is `ready` either way, and the difference is whether
 * something the user just did succeeded. Each screen keeps that separately.
 */
export type Resource<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: ApiError }
  | { readonly status: 'ready'; readonly value: T };

export interface ResourceHandle<T> {
  readonly state: Resource<T>;
  /** Re-fetch — the "retry" the error state has to offer (DOCUMENT 11 §2). */
  readonly reload: () => void;
  /**
   * Replace the loaded value without a round trip, for the case where a write
   * already returned the new state. DOCUMENT 11 §2, success: "the underlying
   * data visibly updates."
   */
  readonly replace: (value: T) => void;
}

/**
 * Load one resource, and keep it reloadable.
 *
 * `load` is expected to be stable (a `useCallback` in the caller); it is in
 * the dependency list, so an unstable one would re-fetch on every render.
 * The in-flight request is aborted when the component unmounts or reloads, so
 * a slow first response cannot overwrite a newer one.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>): ResourceHandle<T> {
  const [state, setState] = useState<Resource<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    setState({ status: 'loading' });
    load(controller.signal)
      .then((value) => {
        if (live) {
          setState({ status: 'ready', value });
        }
      })
      .catch((error: unknown) => {
        if (!live || controller.signal.aborted) {
          return;
        }
        setState({
          status: 'error',
          // A network failure is not an ApiError, but the screen still has to
          // render something with a retry rather than crash the page.
          error: error instanceof ApiError ? error : new ApiError(0, null),
        });
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [load, attempt]);

  const reload = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  const replace = useCallback((value: T) => {
    setState({ status: 'ready', value });
  }, []);

  return { state, reload, replace };
}
