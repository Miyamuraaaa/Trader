import { CONFIG } from './config.js';
import { db } from './db.js';
import { scanOnce } from './scanner.js';

if (CONFIG.mode !== 'PAPER') {
  throw new Error('Safety boundary: scan:once only supports MODE=PAPER');
}
if (!CONFIG.enableJupiter && !CONFIG.enableRaptor && !CONFIG.enableRaydium
  && !CONFIG.enableOrca && !CONFIG.enableMeteora) {
  throw new Error('At least one quote provider must be enabled');
}

try {
  await scanOnce();
} finally {
  db.close();
}
