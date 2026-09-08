/** Weighted service slots, shared within each provider's existing RPS/concurrency budget. */
export class ScannerFairService {
  private prefilterRun = 0;
  private cursor = 0;
  private readonly slots = ['EXEC_PREFILTER_HIGH', 'EXEC_PREFILTER_HIGH', 'DISCOVERY_HIGH', 'DISCOVERY_LOW'] as const;
  take<T>(queue: T[], priority: (item: T) => string | undefined, deadline?: (item: T) => number): T | undefined {
    const tier = (value: string | undefined) => value === 'EXEC_PREFILTER_HIGH' ? value : value === 'HIGH' || value === 'DISCOVERY_HIGH' ? 'DISCOVERY_HIGH' : 'DISCOVERY_LOW';
    const choose = (kind: string) => queue.reduce((best, item, index) => tier(priority(item)) === kind && (best < 0 || (deadline?.(item) ?? 0) < (deadline?.(queue[best]!) ?? 0)) ? index : best, -1);
    const remove = (index: number) => { const item = queue.splice(index, 1)[0]!; this.prefilterRun = tier(priority(item)) === 'EXEC_PREFILTER_HIGH' ? this.prefilterRun + 1 : 0; return item; };
    if (deadline && this.prefilterRun < 2) { const urgent = choose('EXEC_PREFILTER_HIGH'); if (urgent >= 0) return remove(urgent); }
    const discoveryWaiting = queue.some((item) => tier(priority(item)) !== 'EXEC_PREFILTER_HIGH');
    for (let checked = 0; checked < this.slots.length; checked++) {
      const slot = this.slots[this.cursor++ % this.slots.length]!;
      if (deadline && slot === 'EXEC_PREFILTER_HIGH' && this.prefilterRun >= 2 && discoveryWaiting) continue;
      const index = choose(slot);
      if (index >= 0) return remove(index);
    }
    return undefined;
  }
}

/** Three eligible turns then one observation turn, with independent round-robin cursors. */
export class LiveSizeCadence {
  private turn = 0; private eligibleCursor = 0; private observationCursor = 0;
  next(sizes: readonly number[], cap: number, utility?: (size: number) => number): number | undefined {
    const eligible = sizes.filter((n) => n <= cap), observations = sizes.filter((n) => n > cap);
    const observe = !eligible.length || (!!observations.length && this.turn++ % 4 === 3);
    const group = observe ? observations : eligible;
    const cursor = observe ? this.observationCursor++ : this.eligibleCursor++;
    // Half the slots remain unconditional round-robin exploration. Utility is bounded/advisory.
    if (utility && cursor % 2 === 1 && group.length) {
      const best = group.reduce((best, size) => utility(size) > utility(best) ? size : best);
      if (utility(best) > 0) return best;
    }
    return group[(utility ? Math.floor(cursor / 2) : cursor) % group.length];
  }
}
