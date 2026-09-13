import { spawn, type ChildProcess } from 'node:child_process';
import { CONFIG } from './config.js';
import { log } from './logger.js';
import { checkRpc, verifyCanonicalTokenMints } from './solana.js';
import { notifyMarketChange, scanLoop, stopScanner, subscribeLiveExecutionHandoffs } from './scanner.js';
import { startServer } from './server.js';
import { db } from './db.js';
import { RaptorQuoteStream } from './raptor-stream.js';
import { getScanCycles } from './token-universe.js';
import { toAtomic } from './math.js';
import { DECIMALS } from './config.js';
import {
  refreshDynamicTokenUniverse,
  getDynamicTokens,
  startDynamicTokenDiscovery,
  stopDynamicTokenDiscovery,
} from './dynamic-token-universe.js';
import { getExecutionReadiness } from './execution-readiness.js';
import { setRecoveryReadiness,type RecoveryReadiness } from './execution/runtime-readiness.js';
import { resolveLiveExecutorEntrypoint } from './live-executor-entrypoint.js';
import { acquireScannerRuntimeLock, type ScannerRuntimeLock } from './scanner-runtime-lock.js';
import { LiveApprovalBridge } from './live-approval-bridge.js';
import {
  directMarketStreamHealth,
  setDirectMarketChangeListener,
  stopDirectMarketStream,
} from './direct-market-stream.js';

// The external WSL key file can take ~14 seconds to traverse on a cold Windows
// filesystem mount. This timeout is startup-only and never extends quote age.
const LIVE_EXECUTOR_STARTUP_TIMEOUT_MS = 60_000;

async function startIsolatedLiveExecutor(): Promise<ChildProcess> {
  const resolved = resolveLiveExecutorEntrypoint(import.meta.url);
  log.info('Starting isolated live executor', {
    runtime: resolved.runtime,
    entry: resolved.entry,
  });
  const child = spawn(process.execPath, resolved.args, {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  child.on('message',(message:unknown)=>{
    const value=message as {type?:string;state?:string};
    if(value?.type==='LIVE_EXECUTOR_HEALTH'&&['READY_FOR_SIGNER','READY_FOR_NEW_SUBMISSIONS','RECONCILIATION_ONLY','LEGACY_UNRESOLVED_BLOCKED','NOT_READY','NO_BROADCAST'].includes(value.state??''))setRecoveryReadiness(value.state as RecoveryReadiness);
  });
  child.on('exit',()=>setRecoveryReadiness('NOT_READY'));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // A timed-out child is not allowed to linger with access to the signer.
      child.kill('SIGTERM');
      reject(new Error(
        `Isolated live executor startup timed out after ${LIVE_EXECUTOR_STARTUP_TIMEOUT_MS}ms`,
      ));
    }, LIVE_EXECUTOR_STARTUP_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('message', onMessage);
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Isolated live executor exited during startup (code=${String(code)}, signal=${String(signal)})`));
    };
    const onMessage = (message: unknown): void => {
      if (typeof message === 'object' && message !== null
        && ((message as { type?: string }).type === 'LIVE_EXECUTOR_READY'
          || (message as {type?:string}).type==='LIVE_EXECUTOR_HEALTH')) {
        cleanup();
        resolve();
      }
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
  return child;
}

async function main(): Promise<void> {
  // This must happen before the server, scanner, or isolated executor starts.
  // It prevents duplicate `tsx watch` sessions from racing on the execution
  // journal and turning valid handoffs into stale/rejected records.
  const runtimeLock = await acquireScannerRuntimeLock();
  log.info('Scanner runtime lock acquired', { path: runtimeLock.path, pid: process.pid });
  await startMain(runtimeLock);
}

async function startMain(runtimeLock: ScannerRuntimeLock): Promise<void> {
  log.info('sol-arb-scanner starting', {
    executionMode: CONFIG.executionMode,
    rpcUrl: CONFIG.rpcUrl,
    jupiterBaseUrl: CONFIG.jupiterBaseUrl,
    raptorBaseUrl: CONFIG.raptorBaseUrl,
    enabledProviders: [
      CONFIG.enableJupiter ? 'jupiter' : null,
      CONFIG.enableRaptor ? 'raptor' : null,
      CONFIG.enableRaydium ? 'raydium' : null,
      CONFIG.enableOrca ? 'orca' : null,
      CONFIG.enableMeteora ? 'meteora' : null,
    ].filter(Boolean).join(','),
    tradeSizesUsdc: CONFIG.tradeSizesUsdc.join(','),
    tradeSizesPerScan: CONFIG.tradeSizesPerScan,
    scanTokens: CONFIG.scanTokens.join(','),
    slippageBps: CONFIG.slippageBps,
    minNetProfitUsdc: CONFIG.minNetProfitUsdc,
    scanIntervalMs: CONFIG.scanIntervalMs,
    scanMode: CONFIG.buyDexes.length || CONFIG.sellDexes.length ? 'cross-dex' : 'unrestricted',
  });

  if (!CONFIG.enableJupiter && !CONFIG.enableRaptor && !CONFIG.enableRaydium
    && !CONFIG.enableOrca && !CONFIG.enableMeteora) {
    throw new Error('At least one quote provider must be enabled');
  }
  if (CONFIG.executionMode === 'live' && (!CONFIG.liveTradingEnabled || !CONFIG.liveContinuousEnabled)) {
    throw new Error('LIVE mode is locked: EXECUTION_MODE=live, LIVE_TRADING_ENABLED=true, and LIVE_CONTINUOUS_ENABLED=true are all required');
  }
  if (CONFIG.executionMode === 'live' && CONFIG.liveExecutionPollMs >= CONFIG.maxExecutionQuoteAgeMs) {
    throw new Error('LIVE_EXECUTION_POLL_MS must be lower than MAX_EXECUTION_QUOTE_AGE_MS');
  }

  console.log(CONFIG.executionMode === 'paper'
    ? '\nPAPER MODE — NO REAL TRANSACTIONS'
    : CONFIG.executionMode === 'dry-run'
      ? '\nDRY RUN READINESS — execution:validate can construct and simulate, but cannot broadcast'
      : '\nLIVE EXECUTION MODE — REAL FUNDS AT RISK');

  const readiness = getExecutionReadiness();
  console.log(`REAL-MONEY READINESS: ${readiness.verdict}`);
  console.log(`Submission path exposed: ${readiness.liveSubmissionExposed ? 'YES' : 'NO'}\n`);

  console.log('\n======================================================');
  console.log('Quote providers (GET quote data only)');
  console.log('  Jupiter: ' + (CONFIG.enableJupiter ? 'ENABLED' : 'DISABLED'));
  if (CONFIG.enableJupiter) {
    console.log('    Endpoint: ' + new URL(CONFIG.jupiterBaseUrl).hostname);
    console.log('    Authentication: ' + (CONFIG.jupiterApiKey ? 'API key' : 'keyless'));
    console.log('    Configured plan: ' + CONFIG.jupiterPlan.toUpperCase());
    console.log('    Limiter: ACTIVE');
  }
  console.log('  Raptor: ' + (CONFIG.enableRaptor ? 'ENABLED' : 'DISABLED'));
  if (CONFIG.enableRaptor) {
    console.log('    Endpoint: ' + new URL(CONFIG.raptorBaseUrl).hostname);
    console.log('    Authentication: none (current hosted public beta)');
    console.log('    Limiter: ACTIVE');
  }
  console.log('  Raydium: ' + (CONFIG.enableRaydium ? 'ENABLED (compute GET only)' : 'DISABLED'));
  console.log('  Orca: ' + (CONFIG.enableOrca ? 'ENABLED (direct Whirlpool quote math)' : 'DISABLED'));
  console.log('  Meteora: ' + (CONFIG.enableMeteora ? 'ENABLED (DLMM swapQuote only)' : 'DISABLED'));
  console.log('======================================================\n');
  console.log(CONFIG.executionMode === 'live'
    ? 'LIVE MARKET DATA / CONTINUOUS EXECUTION ENABLED'
    : 'LIVE MARKET DATA / READ-ONLY');
  console.log('A LIVE QUOTED OPPORTUNITY IS NOT GUARANTEED EXECUTABLE PROFIT.\n');

  // Startup must not wait on public RPC or optional discovery feeds. Those
  // calls can be slow/rate-limited and previously left `npm run dev` stuck
  // after the banner, before the dashboard or scanner even started. Execution
  // still performs its own fresh, strict validation for every candidate.
  const liveApproval = new LiveApprovalBridge();
  const server = startServer(3000, liveApproval);
  log.info('Dashboard server started; scanner startup is not waiting on background preparation');

  void (async () => {
    try {
      const slot = await checkRpc();
      log.info('Background RPC health check passed', { slot: slot.toString() });
      await verifyCanonicalTokenMints();
      log.info('Background canonical mint verification passed', {
        tokens: CONFIG.scanTokens.join(','),
      });
    } catch (err) {
      log.warn('Background RPC health check failed; scanner/executor continue with their own request checks', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // Dynamic discovery is a scheduler input, never an execution prerequisite.
  // Core scanning begins immediately and the universe expands as this finishes.
  void refreshDynamicTokenUniverse();
  startDynamicTokenDiscovery();
  setDirectMarketChangeListener(notifyMarketChange);
  const directStateHealthTimer = setInterval(() => {
    log.info('Scanner direct market-state stream health', directMarketStreamHealth());
  }, CONFIG.providerHealthIntervalMs);
  directStateHealthTimer.unref();

  // Begin quote discovery before signer initialization. The executor consumes
  // only fresh persisted handoffs after it is ready; no transaction can be
  // approved or submitted until the isolated signer process says READY.
  scanLoop().catch(e => {
    log.fatal('Fatal scanner error', { error: e instanceof Error ? e.message : String(e) });
    shutdown('FATAL_ERROR');
  });

  let liveExecutor: ChildProcess | null = null;
  let unsubscribeLiveHandoffs: (() => void) | undefined;
  let livePrewarmTimer: NodeJS.Timeout | undefined;
  if (CONFIG.executionMode === 'live') {
    // Scanner availability is independent from the optional signer process.
    // A slow external key file must never terminate dashboard/market discovery.
    void startIsolatedLiveExecutor().then((child) => {
      liveExecutor = child;
      child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'EXECUTION_FUNNEL_EVENT' || !('event' in message)) return;
        const parsed = FunnelTelemetry.safeParse(message.event);
        if (parsed.success) executionFunnel.record(parsed.data);
      });
      liveApproval.attach(child);
      const publishExecutionPrewarm = (): void => {
        if (!child.connected) return;
        const mints = getDynamicTokens()
          .filter((token) => token.executionPrecheck === 'PASS')
          .map((token) => token.mint);
        child.send({ type: 'LIVE_EXECUTOR_PREWARM', mints });
      };
      publishExecutionPrewarm();
      livePrewarmTimer = setInterval(publishExecutionPrewarm, 60_000);
      livePrewarmTimer.unref();
      unsubscribeLiveHandoffs = subscribeLiveExecutionHandoffs((candidate) => {
        if (!child.connected) return;
        // This is an identification-only DTO. The child still reparses and
        // independently validates it before any execution preparation.
        child.send({ type: 'LIVE_EXECUTOR_HANDOFF', candidate }, (error) => {
          if (error) log.debug('Fast executor IPC handoff failed; durable inbox will be polled', { reason: error.message });
        });
      });
      child.once('exit', (code, signal) => {
        if (livePrewarmTimer) clearInterval(livePrewarmTimer);
        livePrewarmTimer = undefined;
        unsubscribeLiveHandoffs?.();
        unsubscribeLiveHandoffs = undefined;
        log.error('Isolated live executor stopped; scanning remains active but submission is disabled', {
          code: code ?? undefined,
          signal: signal ?? undefined,
        });
      });
    }).catch((error: unknown) => {
      log.error('Isolated live executor did not become ready; scanning continues and no live submission is possible', {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }
  let raptorStream: RaptorQuoteStream | null = null;
  if (CONFIG.enableRaptor && CONFIG.enableRaptorStream) {
    const cycles = getScanCycles();
    const subscriptions = CONFIG.tradeSizesUsdc
      .flatMap((amountUsdc) => cycles.map((cycle) => ({
        inputMint: cycle.inputMint,
        outputMint: cycle.intermediateMint,
        amountAtomic: toAtomic(amountUsdc, DECIMALS.USDC),
        slippageBps: CONFIG.slippageBps,
      })))
      .slice(0, CONFIG.raptorStreamMaxSubscriptions);
    if (subscriptions.length > 0) {
      raptorStream = new RaptorQuoteStream(subscriptions, ({ quote }) => {
        notifyMarketChange(quote.inputMint, quote.outputMint);
      });
      raptorStream.start();
    }
  }

  const shutdown = (sig: string) => {
    log.info('received ' + sig + ', shutting down gracefully');
    
    // Stop scanner (§37)
    stopScanner();
    raptorStream?.stop();
    stopDynamicTokenDiscovery();
    clearInterval(directStateHealthTimer);
    if (livePrewarmTimer) clearInterval(livePrewarmTimer);
    void stopDirectMarketStream();
    liveExecutor?.kill('SIGTERM');
    
    // Stop server
    server.close();
    
    // Close db gracefully
    log.info('closing database connections');
    try {
      db.close();
    } catch (e) {
      log.error('Error closing database', { error: e instanceof Error ? e.message : String(e) });
    }
    
    void runtimeLock.release().catch((error: unknown) => {
      log.error('Failed to release scanner runtime lock', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => process.exit(0));
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

}

main().catch((err) => {
  log.fatal('fatal', { reason: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
import { executionFunnel, FunnelTelemetry } from './execution/execution-funnel.js';
