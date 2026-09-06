import { performance } from 'node:perf_hooks';
import { CONFIG, DECIMALS, MINTS } from './config.js';
import { approveTransaction, signApprovedExecution } from './execution/approved-transaction.js';
import { buildJupiterRaptorCycle, buildRaptorJupiterCycle } from './execution/aggregator-cycle-builder.js';
import {
  createExecutionConnection, executionRpcEndpointLabel,
} from './execution/execution-connection.js';
import { preloadExecutionPreflight } from './execution/execution-preflight-cache.js';
import {
  buildJupiterOrcaCycle, buildOrcaJupiterCycle, buildOrcaRaptorCycle, buildRaptorOrcaCycle,
} from './execution/mixed-cycle-builder.js';
import { ExecutionNetworkProfiler } from './execution/network-profiler.js';
import { preloadExecutionPlanFee } from './execution/execution-fee-cache.js';
import { loadDedicatedSigner } from './execution/signer.js';
import {
  fetchExecutionBlockhash, fetchExecutionBlockHeight, simulateAtomicTransaction,
} from './execution/simulator.js';
import { assertBlockhashFresh } from './execution/handoff-validator.js';
import { inspectAtomicTransaction } from './execution/transaction-inspector.js';
import { discoverOrcaPools, setOrcaExecutionSnapshotProvider } from './orca.js';
import { toAtomic } from './math.js';
import { ExecutionAccountStream } from './execution/execution-account-stream.js';
import { OrcaLiveStateCache } from './execution/orca-live-state.js';
import { sampleExecutionPriorityFee } from './execution/priority-fee-oracle.js';

const builders = {
  'raptor-jupiter': buildRaptorJupiterCycle,
  'jupiter-raptor': buildJupiterRaptorCycle,
  'jupiter-orca': buildJupiterOrcaCycle,
  'orca-jupiter': buildOrcaJupiterCycle,
  'raptor-orca': buildRaptorOrcaCycle,
  'orca-raptor': buildOrcaRaptorCycle,
} as const;
type RouteName = keyof typeof builders;

interface Sample {
  route: RouteName;
  buildMs: number;
  simulationMs: number;
  totalMs: number;
  quoteAgeMs: number;
  passed: boolean;
  reason?: string;
}

function argument(name: string): string | undefined {
  return process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 0) return 0;
  return ordered[Math.max(0, Math.ceil(percentileValue * ordered.length) - 1)]!;
}

function summarize(label: string, values: number[]): string {
  return `${label}: p50=${percentile(values, 0.5).toFixed(1)}ms p90=${percentile(values, 0.9).toFixed(1)}ms worst=${Math.max(...values).toFixed(1)}ms`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('EXECUTION LATENCY BENCHMARK — LIVE MAINNET DATA / NO BROADCAST');
  console.log('NOT AN ARBITRAGE OPPORTUNITY');
  const signer = await loadDedicatedSigner('dry-run');
  if (!signer) throw new Error('Dedicated signer is unavailable');
  const connection = createExecutionConnection();
  const accountStream = new ExecutionAccountStream(connection);
  const orcaLiveState = new OrcaLiveStateCache(connection, accountStream);
  await accountStream.start();
  setOrcaExecutionSnapshotProvider(orcaLiveState);
  const runs = Math.max(1, Math.min(20, Number(argument('runs') ?? 5)));
  const routeNames = (argument('routes') ?? 'raptor-jupiter,jupiter-orca,raptor-orca')
    .split(',').map((item) => item.trim()).filter((item): item is RouteName => item in builders);
  if (routeNames.length === 0) throw new Error('No valid benchmark routes were selected');
  const inputAmount = BigInt(toAtomic(CONFIG.executionValidationAmountUsdc, DECIMALS.USDC));
  const intervalMs = Math.max(0, Number(argument('interval-ms') ?? 1100));

  const warmupProfiler = new ExecutionNetworkProfiler();
  const poolResult = await Promise.resolve(warmupProfiler.measure(
    'http.orca.poolDiscovery.USDC-WSOL', 'http', () => discoverOrcaPools(MINTS.USDC, MINTS.SOL),
  )).then((value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }));
  const preflightResult = await Promise.resolve(preloadExecutionPreflight(
    connection, signer.keypair.publicKey, [MINTS.USDC, MINTS.SOL], warmupProfiler,
  )).then((value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }));
  const feeResult = await Promise.resolve(sampleExecutionPriorityFee(connection, [], warmupProfiler))
    .then((value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }));
  if (preflightResult.status === 'rejected') {
    console.log(`Static preflight warmup failed safely: ${String(preflightResult.reason)}`);
  }
  if (poolResult.status === 'rejected') throw poolResult.reason;
  if (feeResult.status === 'rejected') {
    console.log(`Priority-fee warmup failed safely: ${String(feeResult.reason)}`);
  }
  const orcaPools = poolResult.value;
  const orcaWarmups: PromiseSettledResult<void>[] = [];
  for (const direction of [MINTS.USDC, MINTS.SOL]) {
    orcaWarmups.push(await orcaLiveState.watch(orcaPools.slice(0, 1), direction, warmupProfiler)
      .then(() => ({ status: 'fulfilled' as const, value: undefined }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })));
  }
  for (const result of orcaWarmups) {
    if (result.status === 'rejected') console.log(`Orca template warmup failed safely: ${String(result.reason)}`);
  }
  for (const route of routeNames) {
    try {
      const plan = await builders[route]({
        connection, wallet: signer.keypair.publicKey, inputAmount,
        slippageBps: CONFIG.slippageBps, intermediateMint: MINTS.SOL,
        computeUnitLimit: 500_000, profiler: warmupProfiler,
        orcaPoolHints: route.includes('orca') ? orcaPools.slice(0, 1).map((pool) => pool.address) : undefined,
      });
      await preloadExecutionPlanFee(connection, plan, warmupProfiler);
    } catch (error) {
      console.log(`Route template warmup ${route} failed safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`Execution RPC: ${executionRpcEndpointLabel()}`);
  console.log(`Static warmup requests: ${JSON.stringify(warmupProfiler.timings)}`);

  const samples: Sample[] = [];
  for (const route of routeNames) {
    const builder = builders[route];
    for (let run = 1; run <= runs; run++) {
      const profiler = new ExecutionNetworkProfiler();
      const started = performance.now();
      try {
        // Start the independent blockhash RPC alongside route construction, but
        // always settle it so a builder failure cannot leave an unhandled RPC
        // rejection in this no-broadcast benchmark process.
        const blockhashPromise = fetchExecutionBlockhash(connection, profiler).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const plan = await builder({
          connection, wallet: signer.keypair.publicKey, inputAmount,
          slippageBps: CONFIG.slippageBps, intermediateMint: MINTS.SOL,
          computeUnitLimit: 500_000, profiler,
          orcaPoolHints: route.includes('orca') ? orcaPools.slice(0, 1).map((pool) => pool.address) : undefined,
        });
        const buildMs = Number((performance.now() - started).toFixed(1));
        const inspection = inspectAtomicTransaction(plan);
        if (!inspection.passed) throw new Error(`Inspection failed: ${inspection.reasons.join('; ')}`);
        const preparedResult = await blockhashPromise;
        if (!preparedResult.ok) throw preparedResult.error;
        const prepared = preparedResult.value;
        const simulationStarted = performance.now();
        const blockHeightPromise = fetchExecutionBlockHeight(connection, profiler).then(
          (value) => ({ value } as const), (error: unknown) => ({ error } as const),
        );
        const simulation = await simulateAtomicTransaction(connection, plan, signer, {
          quoteReceivedAt: plan.quoteReceivedAt, maxAgeMs: CONFIG.maxExecutionQuoteAgeMs,
        }, profiler, prepared);
        const simulationMs = Number((performance.now() - simulationStarted).toFixed(1));
        if (!simulation.passed) throw new Error(`Simulation failed: ${JSON.stringify(simulation.error)}`);
        const blockHeightResult = await blockHeightPromise;
        if ('error' in blockHeightResult) throw blockHeightResult.error;
        await assertBlockhashFresh(connection, simulation, profiler, blockHeightResult.value);
        const approved = approveTransaction('validated-opportunity', plan, simulation.transaction);
        signApprovedExecution(approved, signer);
        const totalMs = Number((performance.now() - started).toFixed(1));
        const quoteAgeMs = simulation.timing.simulationResponseAt - plan.quoteReceivedAt;
        samples.push({ route, buildMs, simulationMs, totalMs, quoteAgeMs, passed: true });
        console.log(JSON.stringify({ route, run, buildMs, simulationMs, totalMs, quoteAgeMs,
          unitsConsumed: simulation.unitsConsumed, requests: profiler.timings }));
      } catch (error) {
        const totalMs = Number((performance.now() - started).toFixed(1));
        const reason = error instanceof Error ? error.message : String(error);
        samples.push({ route, buildMs: totalMs, simulationMs: 0, totalMs, quoteAgeMs: 0, passed: false, reason });
        console.log(JSON.stringify({ route, run, passed: false, totalMs, reason, requests: profiler.timings }));
      }
      if (run < runs) await delay(intervalMs);
    }
  }

  console.log('\nLATENCY SUMMARY');
  for (const route of routeNames) {
    const passed = samples.filter((sample) => sample.route === route && sample.passed);
    console.log(`${route}: ${passed.length}/${runs} passed`);
    if (passed.length > 0) {
      console.log(`  ${summarize('quote/build', passed.map((sample) => sample.buildMs))}`);
      console.log(`  ${summarize('simulation', passed.map((sample) => sample.simulationMs))}`);
      console.log(`  ${summarize('candidate->local-sign-ready', passed.map((sample) => sample.totalMs))}`);
      console.log(`  ${summarize('fresh-quote age at simulation', passed.map((sample) => sample.quoteAgeMs))}`);
    }
    const failures = samples.filter((sample) => sample.route === route && !sample.passed);
    for (const failure of failures) console.log(`  FAIL: ${failure.reason}`);
  }
  console.log('BROADCAST: DISABLED');
  console.log('REAL FUNDS MOVED: NO');
  setOrcaExecutionSnapshotProvider(undefined);
  await orcaLiveState.stop();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
