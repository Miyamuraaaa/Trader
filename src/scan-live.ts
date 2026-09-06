import { CONFIG } from './config.js';
import { db } from './db.js';
import { scanOnce } from './scanner.js';
import { getScanCycles } from './token-universe.js';
import { getDynamicTokens, refreshDynamicTokenUniverse } from './dynamic-token-universe.js';

if (CONFIG.mode !== 'PAPER') {
  throw new Error('Safety boundary: scan:live only supports MODE=PAPER');
}

console.log('\n========================================');
console.log('SOLANA ARBITRAGE SCANNER');
console.log('LIVE MARKET DATA / READ-ONLY');
console.log('NO TRANSACTION BUILDING OR EXECUTION');
console.log('========================================\n');

try {
  await refreshDynamicTokenUniverse();
  const dynamic = getDynamicTokens();
  if (dynamic.length > 0) {
    console.log(`Dynamic tokens discovered: ${dynamic.length}`);
    for (const token of dynamic) {
      console.log(`${token.tier.padEnd(9)} ${token.symbol.padEnd(12)} ${token.mint} score=${token.discoveryScore.toFixed(2)} liquidity=$${token.liquidityUsdc.toFixed(0)} volume24h=$${token.volume24hUsdc.toFixed(0)} executionPrecheck=${token.executionPrecheck}`);
    }
  }
  // Live integration validation covers both canonical cycles plus the two
  // highest-ranked dynamic cycles. The long-running scanner rotates through
  // the full universe without bursting every free-tier API at once.
  const allCycles = getScanCycles();
  const cycles = [
    ...allCycles.filter((cycle) => cycle.tier === 'CORE'),
    ...allCycles.filter((cycle) => cycle.tier !== 'CORE').slice(0, 2),
  ];
  if (cycles.length === 0) throw new Error('No trusted scan cycles configured');
  for (const cycle of cycles) {
    console.log(`\nLIVE CYCLE: ${cycle.path.join(' -> ')}`);
    await scanOnce(cycle);
  }
} finally {
  db.close();
}
