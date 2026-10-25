import type { QuoteRow } from './db.js';

/** One owner per scan, shared by all matrix/continuation and buffer paths.
 * IDs describe quote evidence, not its BUY/SELL/EXEC observation role.
 * Claim before enqueue: a queued write is already owned, even before SQLite sees it.
 */
export class ScanQuotePersistence {
  private readonly claimed = new Set<string>();
  constructor(
    private readonly scanId: string,
    private readonly direct: (row: QuoteRow) => void,
    private readonly buffered: (row: QuoteRow) => boolean,
    private readonly failed: (row: QuoteRow, code: string) => void,
  ) {}
  persist(row: QuoteRow, buffer = false): boolean {
    if (row.scanId !== this.scanId) throw new Error('QUOTE_PERSISTENCE_SCAN_MISMATCH');
    if (this.claimed.has(row.id)) return false;
    this.claimed.add(row.id);
    try {
      if (buffer) {
        if (!this.buffered(row)) throw new Error('QUOTE_HISTORY_ENQUEUE_REJECTED');
      } else this.direct(row);
      return true;
    } catch (error) {
      // No automatic retry or silent success. The scan's existing error path
      // handles the failure; an async worker failure is counted by its owner.
      this.failed(row, 'QUOTE_PERSISTENCE_FAILED');
      throw error;
    }
  }
}
