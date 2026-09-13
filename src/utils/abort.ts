// ============================================================================
// Abort helpers - shared AbortSignal utilities
// ============================================================================

/**
 * Create an AbortError consistent with fetch/DOM semantics.
 */
export function createAbortError(message = 'This operation was aborted'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * True when an error represents user/agent cancellation (DOMException or named Error).
 *
 * TimeoutError is intentionally excluded: native operation timeouts (e.g. from
 * AbortSignal.timeout() used for request deadlines) are not evidence that the
 * agent's own AbortSignal fired. Call sites that need to treat agent abort as
 * terminal should also check `signal.aborted`.
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: string }).name;
  // Operation timeouts must not be conflated with agent/user cancellation.
  if (name === 'TimeoutError') {
    return false;
  }
  if (name === 'AbortError') {
    return true;
  }
  // Some runtimes reject with plain Errors whose message mentions abort
  if (
    error instanceof Error &&
    /aborted|AbortError/i.test(error.message) &&
    !/timeout/i.test(error.message)
  ) {
    return true;
  }
  return false;
}

/**
 * Throw if the signal is already aborted.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
  }
  throw signal.reason instanceof Error ? signal.reason : createAbortError();
}

/**
 * Delay that rejects immediately when the signal aborts (including mid-wait).
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : createAbortError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : createAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Merge multiple abort signals into one that aborts when any input aborts.
 * Prefer AbortSignal.any when available (Node 20+ / modern Bun).
 */
export function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined | null>
): AbortSignal {
  const active = signals.filter((s): s is AbortSignal => s != null);

  if (active.length === 0) {
    return new AbortController().signal;
  }
  if (active.length === 1) {
    return active[0];
  }

  const anyFn = (AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof anyFn === 'function') {
    return anyFn.call(AbortSignal, active);
  }

  const controller = new AbortController();
  const onAbort = (event: Event) => {
    const target = event.target as AbortSignal;
    controller.abort(target.reason);
  };

  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
}
