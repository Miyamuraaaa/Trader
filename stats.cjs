const Database = require('better-sqlite3');
const db = new Database('data/terminal.db');
const trades = db.prepare('SELECT CAST(realized_pnl_usdc AS REAL) as pnl FROM paper_trades WHERE status = \'COMPLETED\'').all();

let totalWins = 0;
let totalLosses = 0;
let sumWins = 0;
let sumLosses = 0;
let maxDrawdown = 0;
let peak = 10000;
let currentBalance = 10000;

for (const t of trades) {
    const pnl = t.pnl;
    if (pnl > 0) {
        totalWins++;
        sumWins += pnl;
    } else {
        totalLosses++;
        sumLosses += pnl;
    }
    currentBalance += pnl;
    if (currentBalance > peak) peak = currentBalance;
    const drawdown = peak - currentBalance;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
}

const totalTrades = totalWins + totalLosses;
const winRate = totalTrades > 0 ? (totalWins / totalTrades) : 0;
const lossRate = 1 - winRate;
const avgWin = totalWins > 0 ? sumWins / totalWins : 0;
const avgLoss = totalLosses > 0 ? Math.abs(sumLosses) / totalLosses : 0;
const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
const profitFactor = Math.abs(sumLosses) > 0 ? sumWins / Math.abs(sumLosses) : 'Infinity';
const netProfit = sumWins + sumLosses;
const returnPct = (netProfit / 10000) * 100;

console.log(JSON.stringify({
    totalTrades,
    totalWins,
    totalLosses,
    winRate: (winRate * 100).toFixed(1) + '%',
    avgWin: avgWin.toFixed(4),
    avgLoss: avgLoss.toFixed(4),
    expectancy: expectancy.toFixed(4),
    profitFactor: profitFactor === 'Infinity' ? profitFactor : profitFactor.toFixed(4),
    netProfit: netProfit.toFixed(4),
    totalGrossProfit: sumWins.toFixed(4),
    totalGrossLoss: Math.abs(sumLosses).toFixed(4),
    maxDrawdown: maxDrawdown.toFixed(4),
    returnPct: returnPct.toFixed(4) + '%'
}, null, 2));
