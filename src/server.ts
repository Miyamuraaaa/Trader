import express from 'express';
import { executionFunnel } from './execution/execution-funnel.js';
import { scannerDisplayEligibility } from './execution/scanner-display-eligibility.js';
import { scannerRpcLimiter } from './scanner-rpc-limiter.js';
import { directMarketStreamHealth } from './direct-market-stream.js';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import {
  db,
  getPaperTradeStats,
  getRecentScans,
  getRecentOpportunities,
  getRecentTrades,
  getRecentRejections,
  getTradeEvents,
  getOpportunityDetail,
  getQuotesForScan,
  getHealthHistory,
  getRecentObservedSolUsdPrice,
} from './db.js';
import { log } from './logger.js';
import { CONFIG } from './config.js';
import { getExecutionEngine, scannerStats, stopScanner, scanLoop } from './scanner.js';
import { getProviderHealth } from './provider-health.js';
import { rpcMetrics } from './solana.js';
import { getOpportunityLifecycleMetrics } from './opportunity-lifecycle.js';
import { getScanCycles } from './token-universe.js';
import { orcaPoolRegistry } from './orca.js';
import { meteoraPoolRegistry } from './meteora.js';
import { dynamicUniverseStats, getDynamicTokens } from './dynamic-token-universe.js';
import { readBotWallet, withWalletUsdEstimate, type ReadOnlyWalletSnapshot } from './wallet-reader.js';
import { getExecutionReadiness } from './execution-readiness.js';
import { getLiveExecutionDashboard } from './execution/live-dashboard.js';
import type { LiveApprovalBridge } from './live-approval-bridge.js';

function isLocalApprovalRequest(req: express.Request): boolean {
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false;
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

export function startServer(port: number = 3000, liveApproval?: LiveApprovalBridge) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  
  // Serve the static HTML frontend
  app.use(express.static('public'));

  // Wallet state is public/account-only data. Cache it briefly so a browser
  // refresh cannot multiply RPC calls, while keeping the dashboard current.
  const walletCacheTtlMs = 15_000;
  let walletCache: { snapshot: ReadOnlyWalletSnapshot; expiresAt: number } | null = null;
  let walletPending: Promise<ReadOnlyWalletSnapshot> | null = null;
  const getDashboardWallet = async (): Promise<ReadOnlyWalletSnapshot> => {
    if (walletCache && walletCache.expiresAt > Date.now()) return walletCache.snapshot;
    if (!walletPending) {
      walletPending = readBotWallet().then((snapshot) => {
        walletCache = { snapshot, expiresAt: Date.now() + walletCacheTtlMs };
        return snapshot;
      }).finally(() => {
        walletPending = null;
      });
    }
    return walletPending;
  };

  // REST API Endpoints
  app.get('/api/stats', async (req, res) => {
    try {
      if (CONFIG.executionMode !== 'paper') {
        const live = await getLiveExecutionDashboard();
        return res.json({ ...live.stats, executionMode: CONFIG.executionMode });
      }
      const stats = getPaperTradeStats();
      stats.startingBalance = getExecutionEngine().getStartingBalance();
      stats.currentBalance = getExecutionEngine().getBalance();
      res.json(stats);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/scans', (req, res) => {
    try {
      res.json(getRecentScans(100));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/opportunities', (req, res) => {
    try {
      res.json(getRecentOpportunities(100));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/opportunities/:id', (req, res) => {
    try {
      const opp = getOpportunityDetail(req.params.id);
      if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
      res.json(opp);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/trades', async (req, res) => {
    try {
      if (CONFIG.executionMode !== 'paper') {
        return res.json((await getLiveExecutionDashboard()).trades);
      }
      res.json(getRecentTrades(100));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/trades/:id/events', (req, res) => {
    try {
      if (CONFIG.executionMode !== 'paper') return res.json([]);
      res.json(getTradeEvents(req.params.id));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/rejections', (req, res) => {
    try {
      res.json(getRecentRejections(100));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/quotes/:scanId', (req, res) => {
    try {
      res.json(getQuotesForScan(req.params.scanId));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/wallet', async (_req, res) => {
    try {
      if (!CONFIG.botWalletAddress) {
        return res.status(404).json({ error: 'BOT_WALLET_ADDRESS is not configured' });
      }
      const snapshot = await getDashboardWallet();
      // The price comes only from a fresh quote the scanner already stored.
      // No provider/API call is made by this endpoint for valuation.
      res.json(withWalletUsdEstimate(snapshot, getRecentObservedSolUsdPrice()));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/readiness', (_req, res) => {
    res.json(getExecutionReadiness());
  });

  app.get('/api/live-approval', (_req, res) => {
    res.json(liveApproval?.snapshot() ?? null);
  });

  app.post('/api/live-approval/accept', async (req, res) => {
    if (!isLocalApprovalRequest(req)) return res.status(403).json({ error: 'Live approval is accepted only from a local dashboard origin' });
    const { executionId, messageHash, approvalToken } = req.body ?? {};
    if (![executionId, messageHash, approvalToken].every((item) => typeof item === 'string')) {
      return res.status(400).json({ error: 'Malformed approval request' });
    }
    const result = await liveApproval?.accept(executionId, messageHash, approvalToken)
      ?? { ok: false, view: null, error: 'Live executor approval channel is unavailable' };
    return res.status(result.ok ? 200 : 409).json(result);
  });

  app.post('/api/live-approval/reject', async (req, res) => {
    if (!isLocalApprovalRequest(req)) return res.status(403).json({ error: 'Live approval is accepted only from a local dashboard origin' });
    const { executionId, messageHash, approvalToken } = req.body ?? {};
    if (![executionId, messageHash, approvalToken].every((item) => typeof item === 'string')) {
      return res.status(400).json({ error: 'Malformed rejection request' });
    }
    const result = await liveApproval?.reject(executionId, messageHash, approvalToken)
      ?? { ok: false, view: null, error: 'Live executor approval channel is unavailable' };
    return res.status(result.ok ? 200 : 409).json(result);
  });

  app.get('/api/health', (req, res) => {
    try {
      const enabledProviderCount = [
        CONFIG.enableJupiter,
        CONFIG.enableRaptor,
        CONFIG.enableRaydium,
        CONFIG.enableOrca,
        CONFIG.enableMeteora,
      ].filter(Boolean).length;
      const pairsTracked = getScanCycles().length;
      const providerDirectionsPerPair = enabledProviderCount * Math.max(0, enabledProviderCount - 1);
      res.json({
        executionFunnel: executionFunnel.snapshot(),
        scannerRpc: scannerRpcLimiter.snapshot(),
        directMarketStream: directMarketStreamHealth(),
        scanner: getHealthHistory('scanner', 10),
        progress: scannerStats,
        configuration: {
          mode: CONFIG.mode,
          executionMode: CONFIG.executionMode,
          liveTradingEnabled: CONFIG.liveTradingEnabled,
          manualApprovalUiMock: CONFIG.manualApprovalUiMock,
          profitMode: CONFIG.profitMode === 'quote' ? 'expected' : CONFIG.profitMode,
          minNetProfitUsdc: CONFIG.minNetProfitUsdc,
          minProfitBps: CONFIG.minProfitBps,
          firstLiveMaxInputUsdc: CONFIG.firstLiveMaxInputUsdc,
          prefilterSpreadBps: CONFIG.prefilterSpreadBps,
          scanMode: CONFIG.scanMode,
          discoveryMode: CONFIG.discoveryMode,
          raptorQuoteStream: CONFIG.enableRaptorStream,
          tradeSizesUsdc: CONFIG.tradeSizesUsdc,
          tradeSizesPerScan: CONFIG.tradeSizesPerScan,
          paperStartingBalanceUsdc: CONFIG.paperStartingBalanceUsdc,
          enabledProviders: [
            CONFIG.enableJupiter ? 'jupiter' : null,
            CONFIG.enableRaptor ? 'raptor' : null,
            CONFIG.enableRaydium ? 'raydium' : null,
            CONFIG.enableOrca ? 'orca' : null,
            CONFIG.enableMeteora ? 'meteora' : null,
          ].filter((provider): provider is string => provider !== null),
        },
        providers: getProviderHealth(),
        executionReadiness: getExecutionReadiness(),
        rpc: rpcMetrics,
        market: {
          pairsTracked,
          poolsTracked: orcaPoolRegistry.trackedPoolCount() + meteoraPoolRegistry.trackedPoolCount(),
          poolPairsCached: orcaPoolRegistry.trackedPairCount() + meteoraPoolRegistry.trackedPairCount(),
          potentialProviderRoutes: pairsTracked * providerDirectionsPerPair,
          routeSizeCombinations: pairsTracked * providerDirectionsPerPair * CONFIG.tradeSizesUsdc.length,
          dynamicUniverse: {
            ...dynamicUniverseStats,
            tokens: getDynamicTokens(),
            hot: getDynamicTokens().filter((token) => token.tier === 'HOT').length,
            warm: getDynamicTokens().filter((token) => token.tier === 'WARM').length,
            discovery: getDynamicTokens().filter((token) => token.tier === 'DISCOVERY').length,
          },
          opportunityLifecycle: getOpportunityLifecycleMetrics(),
        },
      });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/reset', (req, res) => {
    try {
      if (CONFIG.executionMode !== 'paper') {
        return res.status(409).json({ error: 'Paper account is inactive outside EXECUTION_MODE=paper' });
      }
      
      
      db.transaction(() => {
        db.prepare('DELETE FROM paper_trade_events').run();
        db.prepare('DELETE FROM paper_trades').run();
        db.prepare('DELETE FROM risk_rejections').run();
        db.prepare('DELETE FROM opportunity_observations').run();
        db.prepare('DELETE FROM opportunities').run();
        db.prepare('DELETE FROM routes').run();
        db.prepare('DELETE FROM quotes').run();
        db.prepare('DELETE FROM scans').run();
        db.prepare('DELETE FROM system_health').run();
        db.prepare('DELETE FROM errors').run();
      })();
      
      // Soft reset the engine balance
      getExecutionEngine().reset();
      res.json({ success: true, message: 'Database and paper balance reset successfully.' });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Approval capabilities must never be reachable from the LAN/WAN. The
  // dashboard is intentionally local to the machine running the dedicated bot.
  const server = app.listen(port, '127.0.0.1', () => {
    log.info('Server API listening on http://127.0.0.1:' + port);
  });

  // WebSocket for Live Updates (§18)
  const wss = new WebSocketServer({ server });
  // Approval updates bypass the one-second dashboard metrics refresh. This is
  // a local-only IPC projection, never a transaction or signing payload.
  liveApproval?.subscribe((approval) => {
    const payload = JSON.stringify({ type: 'LIVE_APPROVAL_UPDATE', approval });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  });

  wss.on('connection', async (ws) => {
    log.info('UI connected via WebSocket');
    
    // Dynamically import to avoid circular dependencies if any
    const { jupiterStats, getQueueLength } = await import('./jupiter.js');
    const { raptorStats } = await import('./raptor.js');
    const { scannerStats } = await import('./scanner.js');
    const { CONFIG } = await import('./config.js');

    const pushState = async () => {
      try {
        const paperActive = CONFIG.executionMode === 'paper';
        const live = paperActive ? undefined : await getLiveExecutionDashboard();
        let stats;
        let paperBalance: number | undefined;
        if (paperActive) {
          const paperStats = getPaperTradeStats();
          paperStats.startingBalance = getExecutionEngine().getStartingBalance();
          paperStats.currentBalance = getExecutionEngine().getBalance();
          paperBalance = paperStats.currentBalance;
          stats = paperStats;
        } else {
          stats = live!.stats;
        }

        const payload = {
          executionMode: CONFIG.executionMode,
          stats: {
            ...stats,
            apiStats: {
              ...jupiterStats,
              queuedRequests: getQueueLength(),
              plan: CONFIG.jupiterPlan,
              maxRps: CONFIG.jupiterMaxRps,
              evaluationsPerMin: scannerStats.evaluationsThisMinute,
              scannerRpc: scannerRpcLimiter.snapshot(),
              directMarketStream: directMarketStreamHealth(),
              raptor: raptorStats,
              providers: getProviderHealth(),
              rpc: rpcMetrics,
              scanner: scannerStats,
            }
          },
          balance: paperBalance,
          executionFunnel: executionFunnel.snapshot(),
          firstLiveMaxInputUsdc: CONFIG.firstLiveMaxInputUsdc,
          approval: liveApproval?.snapshot() ?? null,
          manualApprovalMockEnabled: CONFIG.manualApprovalUiMock,
          opportunities: getRecentOpportunities(20).map((value) => {
            const row = value as Record<string, unknown>;
            return { ...row, executionEligibility: scannerDisplayEligibility(row, CONFIG.firstLiveMaxInputUsdc) };
          }),
          trades: paperActive ? getRecentTrades(20) : live!.trades,
        };
        ws.send(JSON.stringify({ type: 'LIVE_UPDATE', payload }));
      } catch (err) {
        log.error('WebSocket push error', { error: err instanceof Error ? err.message : String(err) });
      }
    };

    // Initial state
    void pushState();

    // Broadcast periodically (e.g., every 1s)
    const interval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        void pushState();
      } else {
        clearInterval(interval);
      }
    }, 1000);

    ws.on('close', () => clearInterval(interval));
  });

  return server;
}
