import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { ScanQuotePersistence } from '../src/quote-persistence.js';
import type { QuoteRow } from '../src/db.js';
import { normalizeRaptorQuote } from '../src/raptor.js';
vi.hoisted(() => { vi.stubEnv('EXECUTION_MODE','paper');vi.stubEnv('LIVE_TRADING_ENABLED','false'); });
vi.mock('dotenv/config', () => ({}));

describe('quote evidence has one persistence owner per scan',()=>{
  it.each([true,false])('shares ownership across buffered/direct paths (buffer first=%s)',bufferFirst=>{
    const db=new Database(':memory:');
    db.exec('CREATE TABLE quotes(id TEXT PRIMARY KEY, scan_id TEXT, leg TEXT)');
    const write=(r:QuoteRow)=>{db.prepare('INSERT INTO quotes VALUES(?,?,?)').run(r.id,r.scanId,r.leg);};
    const queued:QuoteRow[]=[];const failed=vi.fn();
    const owner=new ScanQuotePersistence('scan',write,r=>{queued.push(r);return true;},failed);
    const quote={id:'same-quote',scanId:'scan',leg:'BUY_JUPITER'} as QuoteRow;
    try {
      expect(owner.persist(quote,bufferFirst)).toBe(true);
      expect(owner.persist({...quote,leg:'EXEC_BUY_JUPITER'},!bufferFirst)).toBe(false);
      queued.forEach(write);
      expect(db.prepare('SELECT COUNT(*) AS n FROM quotes').get()).toEqual({n:1});
      expect(failed).not.toHaveBeenCalled();
    }finally{db.close();}
  });
  it('reports write/enqueue failure without claiming success or retrying',()=>{
    for(const buffered of [true,false]){
      const failed=vi.fn(),write=vi.fn(()=>{throw new Error('fixture storage failure');});
      const enqueue=vi.fn(()=>false),owner=new ScanQuotePersistence('scan',write,enqueue,failed);
      const row={id:'q',scanId:'scan',leg:'BUY'} as QuoteRow;
      expect(()=>owner.persist(row,buffered)).toThrow();
      expect(failed).toHaveBeenCalledWith(row,'QUOTE_PERSISTENCE_FAILED');
      expect(owner.persist(row,buffered)).toBe(false);
      expect(buffered?enqueue:write).toHaveBeenCalledTimes(1);
    }
  });
  it('independently constructed concurrent equal-state quotes have distinct UUIDs',async()=>{
    const raw={inputMint:'input',outputMint:'output',amountIn:'100',amountOut:'110',minAmountOut:'109',priceImpact:0,slippageBps:10,contextSlot:123,routePlan:[{pool:'same-pool',dex:'Raydium CLMM'}]};
    const [a,b]=await Promise.all([Promise.resolve().then(()=>normalizeRaptorQuote(raw,100,101)),Promise.resolve().then(()=>normalizeRaptorQuote(raw,100,101))]);
    expect(a.id).not.toBe(b.id);expect(a.poolIds).toEqual(b.poolIds);expect(a.inAmount).toBe(b.inAmount);
  });
});
