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
 * Handle returned by {@link mergeAbortSignals}.
 * Call `dispose()` when the merged operation finishes so fallback listeners
 * attached to long-lived source signals are removed (noop under AbortSignal.any).
 */
export interface MergedAbortHandle {
  signal: AbortSignal;
  dispose: () => void;
}

/**
 * Merge multiple abort signals into one that aborts when any input aborts.
 * Prefer AbortSignal.any when available (Node 20+ / modern Bun).
 *
 * On runtimes without AbortSignal.any, listeners are attached to each source.
 * Always call `dispose()` after the operation completes (success or failure)
 * so unused listeners do not accumulate on long-lived signals.
 */
export function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined | null>
): MergedAbortHandle {
  const noopDispose = () => {};
  const active = signals.filter((s): s is AbortSignal => s != null);

  if (active.length === 0) {
    return { signal: new AbortController().signal, dispose: noopDispose };
  }
  if (active.length === 1) {
    return { signal: active[0], dispose: noopDispose };
  }

  const anyFn = (AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof anyFn === 'function') {
    return { signal: anyFn.call(AbortSignal, active), dispose: noopDispose };
  }

  const controller = new AbortController();
  let disposed = false;

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const signal of active) {
      signal.removeEventListener('abort', onAbort);
    }
  };

  const onAbort = (event: Event) => {
    const target = event.target as AbortSignal;
    // Detach from every source — `{ once: true }` only drops the firing one.
    dispose();
    if (!controller.signal.aborted) {
      controller.abort(target.reason);
    }
  };

  for (const signal of active) {
    if (signal.aborted) {
      // Remove listeners already attached to earlier live sources before
      // returning — otherwise dispose would be a noop and those listeners leak.
      dispose();
      controller.abort(signal.reason);
      return { signal: controller.signal, dispose: noopDispose };
    }
    signal.addEventListener('abort', onAbort);
  }

  return { signal: controller.signal, dispose };
}
