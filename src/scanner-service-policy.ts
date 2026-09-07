/** Weighted service slots, shared within each provider's existing RPS/concurrency budget. */
export class ScannerFairService {
  private cursor = 0;
  private readonly slots = ['EXEC_PREFILTER_HIGH', 'EXEC_PREFILTER_HIGH', 'DISCOVERY_HIGH', 'DISCOVERY_LOW'] as const;
  take<T>(queue: T[], priority: (item: T) => string | undefined): T | undefined {
    const tier = (value: string | undefined) => value === 'EXEC_PREFILTER_HIGH' ? value : value === 'HIGH' || value === 'DISCOVERY_HIGH' ? 'DISCOVERY_HIGH' : 'DISCOVERY_LOW';
    for (let checked = 0; checked < this.slots.length; checked++) {
      const slot = this.slots[this.cursor++ % this.slots.length];
      const index = queue.findIndex((item) => tier(priority(item)) === slot);
      if (index >= 0) return queue.splice(index, 1)[0];
    }
    return undefined;
  }
}

/** Three eligible turns then one observation turn, with independent round-robin cursors. */
export class LiveSizeCadence {
  private turn = 0; private eligibleCursor = 0; private observationCursor = 0;
  next(sizes: readonly number[], cap: number): number | undefined {
    const eligible = sizes.filter((n) => n <= cap), observations = sizes.filter((n) => n > cap);
    const observe = !eligible.length || (!!observations.length && this.turn++ % 4 === 3);
    return observe ? observations[this.observationCursor++ % observations.length] : eligible[this.eligibleCursor++ % eligible.length];
  }
}
