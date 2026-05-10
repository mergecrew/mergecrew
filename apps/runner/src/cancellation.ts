/**
 * Tracks the AbortControllers of in-flight steps so a `run-cancel` pubsub
 * message can abort every step that belongs to the cancelled run.
 *
 * One coordinator per runner process; each `runStep` call registers its
 * AbortController on entry and unregisters at cleanup.
 *
 * The map is `Map<runId, Set<AbortController>>` because a single runner
 * process can run multiple steps from the same run concurrently (BullMQ
 * worker concurrency > 1) — a cancellation has to abort all of them.
 */
export class CancellationCoordinator {
  private readonly inflight = new Map<string, Set<AbortController>>();

  register(runId: string, controller: AbortController): () => void {
    let set = this.inflight.get(runId);
    if (!set) {
      set = new Set();
      this.inflight.set(runId, set);
    }
    set.add(controller);
    return () => {
      const s = this.inflight.get(runId);
      if (!s) return;
      s.delete(controller);
      if (s.size === 0) this.inflight.delete(runId);
    };
  }

  /**
   * Abort every controller currently registered for `runId`.
   * Returns how many steps were signalled — useful for logging.
   */
  cancelRun(runId: string, reason?: string): number {
    const set = this.inflight.get(runId);
    if (!set || set.size === 0) return 0;
    const message = reason ? `run cancelled: ${reason}` : 'run cancelled';
    let n = 0;
    for (const c of set) {
      try {
        c.abort(new Error(message));
        n++;
      } catch {
        // Already aborted; ignore.
      }
    }
    return n;
  }

  /** Test helper. */
  inflightCount(runId?: string): number {
    if (runId) return this.inflight.get(runId)?.size ?? 0;
    let n = 0;
    for (const s of this.inflight.values()) n += s.size;
    return n;
  }
}
