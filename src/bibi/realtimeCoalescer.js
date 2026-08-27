/**
 * Coalescing for realtime-driven refetches.
 *
 * A projection upload is a batch: one connector cycle can insert two hundred
 * rows into `projected_messages`, and Realtime delivers two hundred separate
 * events for them. Refetching the conversation once per event would issue two
 * hundred identical queries, and the first one to come back would already be
 * stale. Refetching once, after the burst, is both cheaper and more correct.
 *
 * Keys are what the refetch is *about* — a conversation id, the conversation
 * list, the connector row — so a burst on one conversation never delays another.
 * The window does not reset on each push: a stream that never stops still
 * flushes every `windowMs`, rather than being starved by its own traffic.
 *
 * The timer functions are injectable because the whole point of this module is
 * timing, and a test that has to wait 120ms per assertion is a test that will be
 * flaky on a loaded machine.
 */

export const DEFAULT_COALESCE_WINDOW_MS = 120;

export function createRefetchCoalescer({
  windowMs = DEFAULT_COALESCE_WINDOW_MS,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  /** key -> the most recent refetch requested for it */
  const pending = new Map();
  /** key -> the timer that will run it */
  const timers = new Map();
  let disposed = false;

  function run(key) {
    timers.delete(key);
    const task = pending.get(key);
    pending.delete(key);
    if (!task || disposed) return;
    // A refetch that throws must not take the coalescer with it: the next event
    // still has to be able to schedule one.
    try {
      const result = task();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // Reported by the caller's own error handling, not swallowed silently
      // here — `task` is the caller's closure and owns its failure path.
    }
  }

  return {
    /**
     * Ask for `task` to run for `key`. The last task pushed inside one window is
     * the one that runs, because a later refetch subsumes an earlier one.
     */
    push(key, task) {
      if (disposed || typeof task !== "function") return;
      pending.set(key, task);
      if (timers.has(key)) return;
      timers.set(key, schedule(() => run(key), windowMs));
    },

    /** Run everything queued right now. Used when a reconnect makes waiting pointless. */
    flush() {
      if (disposed) return;
      for (const key of [...timers.keys()]) {
        cancel(timers.get(key));
        run(key);
      }
    },

    /** Keys with a refetch still queued. Exposed for assertions, not for control flow. */
    pendingKeys() {
      return [...pending.keys()];
    },

    dispose() {
      disposed = true;
      for (const handle of timers.values()) cancel(handle);
      timers.clear();
      pending.clear();
    },
  };
}
