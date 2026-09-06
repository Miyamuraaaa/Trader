import crypto from 'node:crypto';
import { CONFIG, DECIMALS, MINTS } from './config.js';
import { toAtomic } from './math.js';
import {
  discoverOrcaPools,
  getFreshOrcaPoolSnapshots,
  quoteOrcaPoolFromSnapshot,
  type OrcaPoolSnapshot,
} from './orca.js';
import type { PoolMetadata } from './pool-registry.js';
import type { OrcaAtomicHandoff } from './execution/handoff-dto.js';

export interface OrcaCrossPoolStats {
  poolsTracked: number;
  eligibleUsdcWsolPools: number;
  eligibleUsdcDynamicPools: number;
  intermediatesTracked: number;
  intermediateMints: string[];
  orderedCombinations: number;
  prefilterEvaluations: number;
  prefilterEvaluationsPerMinute: number;
  evaluated: number;
  candidates: number;
  discoveryOnly: number;
  skippedQuotes: number;
  poolStateFailures: number;
  poolStateFailureReasons: string[];
  totalEvaluated: number;
  evaluationsPerMinute: number;
  scanSizesUsdc: number[];
  handoffs: number;
  executorRejections: number;
  expiredCandidates: number;
  approvedDryRuns: number;
  lastScanStartedAt?: number;
  lastScanCompletedAt?: number;
}

export interface OrcaCrossPoolEvaluation {
  classification: 'SAME_DEX_CROSS_POOL';
  executionArchitecture: 'ORCA_TWO_HOP_ATOMIC' | 'DISCOVERY_ONLY';
  firstPool: string;
  secondPool: string;
  intermediateMint: string;
  inputAmount: bigint;
  expectedOutputAmount: bigint;
  minimumOutputAmount: bigint;
  firstHopFeeAmount: bigint;
  secondHopFeeAmount: bigint;
  projectedNetAmount: bigint;
  conservativeNetAmount: bigint;
  roiBps: bigint;
  conservativeRoiBps: bigint;
  rawRoundTripSpreadBps: bigint;
  detectedAt: number;
  executionEligible: boolean;
  dto?: OrcaAtomicHandoff;
}

export const orcaCrossPoolStats: OrcaCrossPoolStats = {
  poolsTracked: 0, eligibleUsdcWsolPools: 0, eligibleUsdcDynamicPools: 0,
  intermediatesTracked: 0, intermediateMints: [], orderedCombinations: 0,
  prefilterEvaluations: 0, prefilterEvaluationsPerMinute: 0,
  evaluated: 0, candidates: 0, discoveryOnly: 0, skippedQuotes: 0, poolStateFailures: 0,
  poolStateFailureReasons: [],
  totalEvaluated: 0, evaluationsPerMinute: 0, scanSizesUsdc: [],
  handoffs: 0, executorRejections: 0, expiredCandidates: 0, approvedDryRuns: 0,
};

/** The handoff process records outcome telemetry; it never changes eligibility. */
export function recordOrcaHandoffOutcome(outcome: 'handoff' | 'rejected' | 'expired' | 'approved'): void {
  if (outcome === 'handoff') orcaCrossPoolStats.handoffs++;
  if (outcome === 'rejected') orcaCrossPoolStats.executorRejections++;
  if (outcome === 'expired') orcaCrossPoolStats.expiredCandidates++;
  if (outcome === 'approved') orcaCrossPoolStats.approvedDryRuns++;
}

function withPoolStateTimeout<T>(promise: Promise<T>, poolAddress: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Orca pool-state timeout for ${poolAddress}`)),
      CONFIG.orcaPoolStateTimeoutMs,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function feeBps(pool: PoolMetadata): number {
  if (pool.feeRate === undefined || !Number.isFinite(pool.feeRate) || pool.feeRate < 0) return 0;
  // Orca API feeRate is a fractional rate. Preserve a defensive fallback for
  // already-bps-like values rather than understating the prefilter.
  return pool.feeRate <= 1 ? Math.ceil(pool.feeRate * 10_000) : Math.ceil(pool.feeRate);
}

function directedSpot(snapshot: OrcaPoolSnapshot, inputMint: string): { numerator: bigint; denominator: bigint } {
  const square = BigInt(snapshot.whirlpool.sqrtPrice) ** 2n;
  const q128 = 1n << 128n;
  return String(snapshot.whirlpool.tokenMintA) === inputMint
    ? { numerator: square, denominator: q128 }
    : { numerator: q128, denominator: square };
}

/** Cheap state-only screen; exact quotes below remain authoritative. */
export function crossPoolMayClear(
  first: PoolMetadata,
  firstSnapshot: OrcaPoolSnapshot,
  second: PoolMetadata,
  secondSnapshot: OrcaPoolSnapshot,
  inputMint: string,
  intermediateMint: string,
): boolean {
  if (first.address === second.address) return false;
  const firstSpot = directedSpot(firstSnapshot, inputMint);
  const secondSpot = directedSpot(secondSnapshot, intermediateMint);
  const numerator = firstSpot.numerator * secondSpot.numerator;
  const denominator = firstSpot.denominator * secondSpot.denominator;
  const requiredBps = Math.max(CONFIG.orcaCrossPoolPrefilterBps, CONFIG.minProfitBps + feeBps(first) + feeBps(second));
  return numerator * 10_000n > denominator * BigInt(10_000 + requiredBps);
}

export function orderedDistinctOrcaPoolPairs(
  pools: PoolMetadata[],
): Array<readonly [PoolMetadata, PoolMetadata]> {
  const unique = [...new Map(pools.map((pool) => [pool.address, pool])).values()];
  return unique.flatMap((first) => unique
    .filter((second) => second.address !== first.address)
    .map((second) => [first, second] as const));
}

/**
 * Exact two-leg propagation, kept as a small independently testable boundary.
 * The second leg can only consume the raw output returned by the first leg.
 */
export function quoteExactOrcaRoundTrip(
  first: PoolMetadata,
  firstSnapshot: OrcaPoolSnapshot,
  second: PoolMetadata,
  secondSnapshot: OrcaPoolSnapshot,
  intermediateMint: string,
  inputAmount: bigint,
  quote: typeof quoteOrcaPoolFromSnapshot = quoteOrcaPoolFromSnapshot,
) {
  const firstQuote = quote(first, {
    inputMint: MINTS.USDC,
    outputMint: intermediateMint,
    amountAtomic: inputAmount.toString(),
    slippageBps: CONFIG.slippageBps,
  }, firstSnapshot);
  const secondQuote = quote(second, {
    inputMint: intermediateMint,
    outputMint: MINTS.USDC,
    amountAtomic: firstQuote.outAmount,
    slippageBps: CONFIG.slippageBps,
  }, secondSnapshot);
  return { firstQuote, secondQuote };
}

function candidateId(first: string, second: string, amount: bigint, detectedAt: number): string {
  return crypto.createHash('sha256').update(`orca-cross-pool:${first}:${second}:${amount}:${detectedAt}`).digest('hex');
}

export function orcaEvaluationToHandoff(value: OrcaCrossPoolEvaluation, slots: string[]): OrcaAtomicHandoff {
  return {
    schema: 'sol-arb.execution-handoff', version: 1,
    opportunityId: candidateId(value.firstPool, value.secondPool, value.inputAmount, value.detectedAt),
    detectedAt: value.detectedAt,
    opportunityType: 'ORCA_TWO_HOP_ATOMIC', venue: 'orca',
    inputMint: MINTS.USDC, intermediateMint: value.intermediateMint, outputMint: MINTS.USDC,
    pools: [value.firstPool, value.secondPool], proposedInputAmount: value.inputAmount.toString(),
    scannerObservation: {
      expectedOutputAmount: value.expectedOutputAmount.toString(), minimumOutputAmount: value.minimumOutputAmount.toString(),
      projectedNetAmount: value.projectedNetAmount.toString(), roiBps: value.roiBps.toString(),
      quoteTimestamp: value.detectedAt, stateSlots: slots,
    },
    discovery: { source: 'orca-cross-pool-scanner', metadata: { strategy: 'SAME_DEX_CROSS_POOL' } },
  };
}

/**
 * Evaluates only independent Whirlpool pairs. Same provider never implies same
 * liquidity here: pair identity is the actual Whirlpool address, not "orca".
 */
export async function scanOrcaCrossPoolCycles(options: {
  networkCostUsdcAtomic: bigint;
  currentSlot?: bigint;
  intermediates?: string[];
  executionIntermediates?: string[];
}): Promise<OrcaCrossPoolEvaluation[]> {
  const started = Date.now();
  orcaCrossPoolStats.lastScanStartedAt = started;
  // These are the current scan's coverage figures. Cumulative work remains
  // available in totalEvaluated, avoiding misleading ever-growing pool counts.
  orcaCrossPoolStats.poolsTracked = 0;
  orcaCrossPoolStats.eligibleUsdcWsolPools = 0;
  orcaCrossPoolStats.eligibleUsdcDynamicPools = 0;
  orcaCrossPoolStats.intermediatesTracked = 0;
  orcaCrossPoolStats.intermediateMints = [];
  orcaCrossPoolStats.orderedCombinations = 0;
  orcaCrossPoolStats.prefilterEvaluations = 0;
  orcaCrossPoolStats.evaluated = 0;
  orcaCrossPoolStats.candidates = 0;
  orcaCrossPoolStats.discoveryOnly = 0;
  orcaCrossPoolStats.skippedQuotes = 0;
  orcaCrossPoolStats.poolStateFailures = 0;
  orcaCrossPoolStats.poolStateFailureReasons = [];
  orcaCrossPoolStats.scanSizesUsdc = [...CONFIG.orcaCrossPoolAmountsUsdc];
  const intermediates = options.intermediates ?? [MINTS.SOL, MINTS.USDT];
  const executable = new Set(options.executionIntermediates ?? [MINTS.SOL]);
  orcaCrossPoolStats.intermediateMints = [...new Set(intermediates)];
  orcaCrossPoolStats.intermediatesTracked = orcaCrossPoolStats.intermediateMints.length;
  const all: OrcaCrossPoolEvaluation[] = [];
  for (const intermediateMint of intermediates) {
    const pools = await discoverOrcaPools(MINTS.USDC, intermediateMint);
    orcaCrossPoolStats.poolsTracked += pools.length;
    let available: Array<{ pool: PoolMetadata; snapshot: OrcaPoolSnapshot }> = [];
    if (pools.length > 0) {
      try {
        // Fetch all Whirlpool, tick-array and oracle accounts in bounded
        // batches. The previous per-pool Promise.all created a burst of
        // several RPC requests for every pool and was routinely throttled by
        // the public mainnet endpoint.
        const snapshots = await withPoolStateTimeout(
          getFreshOrcaPoolSnapshots(pools),
          `${pools.length} batched pools for ${intermediateMint}`,
        );
        available = snapshots.map((snapshot, index) => ({ pool: pools[index]!, snapshot }));
      } catch (error) {
        orcaCrossPoolStats.poolStateFailures += pools.length;
        const reason = error instanceof Error ? error.message : String(error);
        orcaCrossPoolStats.poolStateFailureReasons.push(
          `${intermediateMint}: ${reason.slice(0, 240)}`,
        );
      }
    }
    const viableEntries = available.filter(({ snapshot }) => BigInt(snapshot.whirlpool.liquidity) > 0n);
    const viable = viableEntries.map(({ pool }) => pool);
    if (intermediateMint === MINTS.SOL) orcaCrossPoolStats.eligibleUsdcWsolPools += viable.length;
    else if (executable.has(intermediateMint)) orcaCrossPoolStats.eligibleUsdcDynamicPools += viable.length;
    const byAddress = new Map(viableEntries.map(({ pool, snapshot }) => [pool.address, snapshot]));
    const pairs = orderedDistinctOrcaPoolPairs(viable);
    orcaCrossPoolStats.orderedCombinations += pairs.length;
    for (const [first, second] of pairs) {
      const firstSnapshot = byAddress.get(first.address)!;
      const secondSnapshot = byAddress.get(second.address)!;
      orcaCrossPoolStats.prefilterEvaluations++;
      if (!crossPoolMayClear(first, firstSnapshot, second, secondSnapshot, MINTS.USDC, intermediateMint)) continue;
      for (const amountUsdc of CONFIG.orcaCrossPoolAmountsUsdc) {
        const inputAmount = BigInt(toAtomic(amountUsdc, DECIMALS.USDC));
        let firstQuote;
        let secondQuote;
        try {
          ({ firstQuote, secondQuote } = quoteExactOrcaRoundTrip(
            first, firstSnapshot, second, secondSnapshot,
            intermediateMint, inputAmount,
          ));
        } catch {
          // One shallow/invalid Whirlpool must not stop the remaining ordered
          // pool combinations or any other provider's scan.
          orcaCrossPoolStats.skippedQuotes++;
          continue;
        }
        const expected = BigInt(secondQuote.outAmount);
        const minimum = BigInt(secondQuote.otherAmountThreshold);
        const projected = expected - inputAmount - options.networkCostUsdcAtomic;
        const conservative = minimum - inputAmount - options.networkCostUsdcAtomic;
        const roiBps = projected * 10_000n / inputAmount;
        const conservativeRoiBps = conservative * 10_000n / inputAmount;
        const rawRoundTripSpreadBps = (expected - inputAmount) * 10_000n / inputAmount;
        const detectedAt = Math.min(firstSnapshot.responseTimestamp, secondSnapshot.responseTimestamp);
        const executionEligible = executable.has(intermediateMint)
          && inputAmount <= BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC))
          && projected >= BigInt(toAtomic(CONFIG.minNetProfitUsdc, DECIMALS.USDC))
          && conservative >= BigInt(toAtomic(CONFIG.minNetProfitUsdc, DECIMALS.USDC))
          && roiBps >= BigInt(CONFIG.minProfitBps)
          && conservativeRoiBps >= BigInt(CONFIG.minProfitBps);
        const evaluation: OrcaCrossPoolEvaluation = {
          classification: 'SAME_DEX_CROSS_POOL',
          executionArchitecture: executable.has(intermediateMint) ? 'ORCA_TWO_HOP_ATOMIC' : 'DISCOVERY_ONLY',
          firstPool: first.address, secondPool: second.address, intermediateMint, inputAmount,
          expectedOutputAmount: expected, minimumOutputAmount: minimum,
          firstHopFeeAmount: BigInt(firstQuote.feeAmount ?? '0'), secondHopFeeAmount: BigInt(secondQuote.feeAmount ?? '0'),
          projectedNetAmount: projected, conservativeNetAmount: conservative,
          roiBps, conservativeRoiBps, rawRoundTripSpreadBps,
          detectedAt, executionEligible,
        };
        if (executionEligible) {
          evaluation.dto = orcaEvaluationToHandoff(
            evaluation,
            options.currentSlot === undefined ? [] : [options.currentSlot.toString()],
          );
          orcaCrossPoolStats.candidates++;
        } else if (!executable.has(intermediateMint)) {
          orcaCrossPoolStats.discoveryOnly++;
        }
        all.push(evaluation);
        orcaCrossPoolStats.evaluated++;
        orcaCrossPoolStats.totalEvaluated++;
      }
    }
  }
  orcaCrossPoolStats.lastScanCompletedAt = Date.now();
  const elapsedMs = Math.max(1, orcaCrossPoolStats.lastScanCompletedAt - started);
  orcaCrossPoolStats.evaluationsPerMinute = Math.round(orcaCrossPoolStats.evaluated * 60_000 / elapsedMs);
  orcaCrossPoolStats.prefilterEvaluationsPerMinute = Math.round(
    orcaCrossPoolStats.prefilterEvaluations * 60_000 / elapsedMs,
  );
  return all;
}
