// The best finished run of the flow section, kept as its recorded result (setup, event log, marks, splits, digest) so the
// next ride can race it as the phantom. A plain ES module with no DOM beyond localStorage, which is optional: when it is
// missing or refused the best run lasts until the page closes. A record is tied to an engine label (the release it was
// recorded on) and is ignored on any other, since a replay is exact only on the engine that recorded it.

const KEY = "phantomflow.flow.best";

export class BestRun {
  /** @param {string} engineLabel The engine release the page runs (a record from another is ignored). */
  constructor(engineLabel) {
    this.label = engineLabel;
    this.record = null;
    try {
      const text = globalThis.localStorage?.getItem(KEY);
      const stored = text ? JSON.parse(text) : null;
      if (stored && stored.engine === engineLabel && Number.isFinite(stored.result?.time) && Array.isArray(stored.result?.events)) {
        this.record = stored.result;
      }
    } catch { /* storage is a convenience: carry on without it */ }
  }

  /** The best run so far (a section result), or null. */
  get() {
    return this.record;
  }

  /** Keeps `result` when it beats the best (or there is none). Returns true when it did. */
  offer(result) {
    if (!result || !Number.isFinite(result.time)) return false;
    if (this.record && !(result.time < this.record.time)) return false;
    this.record = result;
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify({ engine: this.label, result }));
    } catch { /* see above */ }
    return true;
  }

  clear() {
    this.record = null;
    try {
      globalThis.localStorage?.removeItem(KEY);
    } catch { /* see above */ }
  }
}
