import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { address } from '@solana/kit';
import { createNoopSigner } from '@solana/signers';
import { TOKEN_PROGRAM_ID } from '../src/execution/account-preflight.js';
import {
  DEFAULT_WHIRLPOOL_DEPLOYMENT,
  getTwoHopSwapV2Instruction,
} from '@orca-so/whirlpools-client';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { kitInstructionToWeb3 } from '../src/execution/instruction-adapter.js';
import { calculateConfirmedCycleAccounting, confirmAndAccountForCycle } from '../src/execution/confirmation-accounting.js';
import { PersistentExecutionLock } from '../src/execution/execution-lock.js';
import { PersistentExecutionJournal, assertExecutionTransition } from '../src/execution/execution-journal.js';
import { validateFinalEconomics } from '../src/execution/final-validation.js';
import { assertLiveSubmissionAllowed, type LiveSubmissionGuardConfig } from '../src/execution/live-guard.js';
import { calculateRealizedCycleResult } from '../src/execution/realized-accounting.js';
import { captureAndValidateLiveBalances } from '../src/execution/live-balance-preflight.js';
import { PersistentRiskManager } from '../src/execution/risk-manager.js';
import { loadDedicatedSigner } from '../src/execution/signer.js';
import { assertIntermediateTokenExecutionPolicy, classifyToken2022Extensions } from '../src/execution/token-analysis.js';
import { inspectAtomicTransaction } from '../src/execution/transaction-inspector.js';
import {
  approveSignedExecutionForSubmission,
  approveTransaction,
  signApprovedExecution,
  type ApprovedSignedExecution,
} from '../src/execution/approved-transaction.js';
import { AmbiguousSubmissionError, OneShotBroadcaster, type SubmissionTransport } from '../src/execution/broadcaster.js';
import { handoffIdentity, parseOrcaAtomicHandoff } from '../src/execution/handoff-dto.js';
import {
  aggregatorHandoffIdentity,
  parseAggregatorAtomicHandoff,
} from '../src/execution/aggregator-handoff-dto.js';
import { assertBlockhashFresh, assertFinalHandoffPolicy, assertHandoffScope, calculateExecutorEconomics } from '../src/execution/handoff-validator.js';
import {
  crossPoolMayClear,
  orcaEvaluationToHandoff,
  orderedDistinctOrcaPoolPairs,
  quoteExactOrcaRoundTrip,
  type OrcaCrossPoolEvaluation,
} from '../src/orca-cross-pool.js';
import type { AtomicExecutionPlan } from '../src/execution/types.js';
import { CONFIG, DECIMALS } from '../src/config.js';
import { toAtomic } from '../src/math.js';
import { resolveLiveExecutorEntrypoint } from '../src/live-executor-entrypoint.js';
import { ExecutionNetworkProfiler } from '../src/execution/network-profiler.js';
import { executionFeeEstimate } from '../src/execution/execution-fee-cache.js';
import { preloadExecutionPreflight } from '../src/execution/execution-preflight-cache.js';
import { executionQuoteAgeLimit, assertExecutionQuoteFresh } from '../src/execution/quote-freshness.js';
import { classifyExecutionExpiry, classifyExecutionRejection } from '../src/execution/execution-diagnostics.js';
import {
  assertJitoEndpoint,
  JitoBlockEngineSubmissionTransport,
} from '../src/execution/jito-submission-transport.js';
import { ExecutionAccountStream } from '../src/execution/execution-account-stream.js';

const created: string[] = [];
afterEach(async () => Promise.all(created.splice(0).map((target) => rm(target, { recursive: true, force: true }))));

describe('route-aware execution quote freshness', () => {
  it('keeps non-Raptor routes at 1200ms and grants only Raptor routes up to 1800ms', () => {
    const fast = validPlan();
    fast.quoteReceivedAt = 10_000;
    expect(executionQuoteAgeLimit(fast)).toBe(1200);
    expect(() => assertExecutionQuoteFresh(fast, 'test', 11_201)).toThrow('age=1201ms limit=1200ms');

    const raptor = validPlan();
    raptor.type = 'RAPTOR_JUPITER_CYCLE';
    raptor.quoteReceivedAt = 10_000;
    expect(executionQuoteAgeLimit(raptor)).toBe(1800);
    expect(assertExecutionQuoteFresh(raptor, 'test', 11_800)).toMatchObject({ ageMs: 1800, maxAgeMs: 1800 });
    expect(() => assertExecutionQuoteFresh(raptor, 'test', 11_801)).toThrow('age=1801ms limit=1800ms');
  });
});

describe('execution expiry diagnostics', () => {
  it('attributes stale candidates to the request segment that actually consumed the quote window', () => {
    expect(classifyExecutionExpiry('Execution quote stale at final simulation: age=1201ms', 'SIMULATION_PASS'))
      .toBe('EXPIRED_FINAL_CHECK');
    expect(classifyExecutionExpiry('Raptor execution quote HTTP 504: gateway timeout', 'QUOTED'))
      .toBe('EXPIRED_RAPTOR_QUOTE');
    expect(classifyExecutionExpiry('Raptor instruction build failed after 1200ms: timeout', 'BUILD_START'))
      .toBe('EXPIRED_RAPTOR_INSTRUCTIONS');
    expect(classifyExecutionExpiry('Execution RPC exceeded 750 ms', 'BUILDING'))
      .toBe('EXPIRED_RPC');
    expect(classifyExecutionExpiry('Final transaction quote became stale before simulation', 'INSPECTION_PASS'))
      .toBe('EXPIRED_BUILD');
    expect(classifyExecutionExpiry('Execution quote stale at executor entry', undefined))
      .toBe('EXPIRED_WAITING_FOR_EXECUTOR');
  });

  it('classifies web3 message-capacity errors as transaction size failures', () => {
    expect(classifyExecutionRejection('Transaction exceeds Solana packet/account encoding capacity: encoding overruns Uint8Array'))
      .toBe('TRANSACTION_TOO_LARGE');
  });
});

describe('Jito exact-byte landing adapter', () => {
  it('accepts only official HTTPS block-engine hosts', () => {
    expect(assertJitoEndpoint('https://singapore.mainnet.block-engine.jito.wtf').pathname)
      .toBe('/api/v1/transactions');
    expect(() => assertJitoEndpoint('http://singapore.mainnet.block-engine.jito.wtf'))
      .toThrow('official HTTPS');
    expect(() => assertJitoEndpoint('https://block-engine.jito.wtf.attacker.example'))
      .toThrow('official HTTPS');
  });

  it('submits the exact bytes once through the documented base64 JSON-RPC shape', async () => {
    let captured: RequestInit | undefined;
    const request = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(88) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const transport = new JitoBlockEngineSubmissionTransport(
      'https://tokyo.mainnet.block-engine.jito.wtf', request,
    );
    expect(await transport.submitExactSignedBytes(Uint8Array.from([1, 2, 3])))
      .toBe('x'.repeat(88));
    const body = JSON.parse(String(captured?.body)) as { method: string; params: [string, { encoding: string }] };
    expect(body.method).toBe('sendTransaction');
    expect(body.params).toEqual([Buffer.from([1, 2, 3]).toString('base64'), { encoding: 'base64' }]);
  });

  it('fails closed on a malformed response and has no retry behavior', async () => {
    let calls = 0;
    const request = (async () => {
      calls++;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
    }) as typeof fetch;
    const transport = new JitoBlockEngineSubmissionTransport(
      'https://mainnet.block-engine.jito.wtf', request,
    );
    await expect(transport.submitExactSignedBytes(Uint8Array.from([1]))).rejects.toThrow('signature');
    expect(calls).toBe(1);
  });
});

describe('execution account stream', () => {
  it('deduplicates subscriptions and exposes slot-aged read-only evidence', async () => {
    let slotCallback: ((value: { slot: number }) => void) | undefined;
    let accountCallback: ((account: import('@solana/web3.js').AccountInfo<Buffer>, context: { slot: number }) => void) | undefined;
    let accountSubscriptions = 0;
    const connection = {
      onSlotChange: (callback: typeof slotCallback) => { slotCallback = callback; return 1; },
      onAccountChange: (_address: PublicKey, callback: typeof accountCallback) => {
        accountSubscriptions++;
        accountCallback = callback;
        return 2;
      },
      removeAccountChangeListener: async () => undefined,
      removeSlotChangeListener: async () => undefined,
    } as unknown as import('@solana/web3.js').Connection;
    const stream = new ExecutionAccountStream(connection);
    const watched = key();
    let updates = 0;
    await stream.watch('route-a', [watched], () => { updates++; });
    await stream.watch('route-b', [watched], () => { updates++; });
    expect(accountSubscriptions).toBe(1);
    slotCallback?.({ slot: 99 });
    accountCallback?.({
      data: Buffer.alloc(1), executable: false, lamports: 1, owner: PublicKey.default,
      rentEpoch: 0,
    }, { slot: 100 });
    expect(updates).toBe(2);
    expect(stream.health()).toMatchObject({ subscriptions: 1, cachedAccounts: 1, latestSlot: 100, updates: 1 });
    expect(stream.currentEvidence()).toMatchObject({ slot: 100 });
    await stream.stop();
  });
});

function tempDir(): string {
  const value = path.join(os.tmpdir(), `sol-arb-test-${process.pid}-${Date.now()}-${Math.random()}`);
  created.push(value);
  return value;
}

function key(): string { return Keypair.generate().publicKey.toBase58(); }

function validPlan(wallet = key()): AtomicExecutionPlan {
  const base = key();
  const intermediate = key();
  const poolOne = key();
  const poolTwo = key();
  const accounts = Array.from({ length: 12 }, key);
  const instruction = getTwoHopSwapV2Instruction({
    whirlpoolOne: address(poolOne), whirlpoolTwo: address(poolTwo),
    tokenMintInput: address(base), tokenMintIntermediate: address(intermediate), tokenMintOutput: address(base),
    tokenProgramInput: address(TOKEN_PROGRAM_ID.toBase58()),
    tokenProgramIntermediate: address(TOKEN_PROGRAM_ID.toBase58()),
    tokenProgramOutput: address(TOKEN_PROGRAM_ID.toBase58()),
    tokenOwnerAccountInput: address(accounts[0]!),
    tokenVaultOneInput: address(accounts[1]!), tokenVaultOneIntermediate: address(accounts[2]!),
    tokenVaultTwoIntermediate: address(accounts[3]!), tokenVaultTwoOutput: address(accounts[4]!),
    tokenOwnerAccountOutput: address(accounts[0]!),
    tokenAuthority: createNoopSigner(address(wallet)),
    tickArrayOne0: address(accounts[5]!), tickArrayOne1: address(accounts[6]!), tickArrayOne2: address(accounts[7]!),
    tickArrayTwo0: address(accounts[8]!), tickArrayTwo1: address(accounts[9]!), tickArrayTwo2: address(accounts[10]!),
    oracleOne: address(accounts[11]!), oracleTwo: address(key()),
    memoProgram: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    amount: 100n, otherAmountThreshold: 101n, amountSpecifiedIsInput: true,
    aToBOne: true, aToBTwo: false, sqrtPriceLimitOne: 1n, sqrtPriceLimitTwo: 2n,
    remainingAccountsInfo: null,
  }, { programAddress: DEFAULT_WHIRLPOOL_DEPLOYMENT.programId });
  return {
    id: 'test', type: 'ORCA_TWO_HOP_CYCLE', atomic: true, wallet,
    inputMint: base, intermediateMint: intermediate, outputMint: base,
    inputAmount: 100n, expectedIntermediateAmount: 50n, expectedOutputAmount: 102n,
    minimumOutputAmount: 101n, pools: [poolOne, poolTwo], quoteReceivedAt: Date.now(),
    baseToken: { mint: base, status: 'SUPPORTED', programId: TOKEN_PROGRAM_ID.toBase58(), extensions: [], reasons: [], transferFeeMode: 'NONE' },
    intermediateToken: { mint: intermediate, status: 'SUPPORTED', programId: TOKEN_PROGRAM_ID.toBase58(), extensions: [], reasons: [], transferFeeMode: 'NONE' },
    baseAta: { ata: accounts[0]!, exists: true, balance: 100n, creationRentLamports: 0 },
    intermediateAta: { ata: accounts[1]!, exists: false, balance: 0n, creationRentLamports: 2_039_280 },
    computeUnitLimit: 200_000,
    computeUnitPriceMicroLamports: CONFIG.fallbackPriorityFeeMicroLamports,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.fallbackPriorityFeeMicroLamports }),
      kitInstructionToWeb3(instruction),
    ],
  };
}

describe('isolated executor runtime selection', () => {
  it('uses source beside a tsx parent and compiled JS beside a built parent', () => {
    const source = resolveLiveExecutorEntrypoint('file:///C:/Users/ADMIN/Trader/src/index.ts');
    expect(source).toMatchObject({ runtime: 'typescript/tsx' });
    expect(source.entry.replaceAll('\\', '/')).toMatch(/\/src\/live-execution-process\.ts$/);
    expect(source.args.slice(0, 2)).toEqual(['--import', 'tsx']);

    const compiled = resolveLiveExecutorEntrypoint('file:///C:/Users/ADMIN/Trader/dist/index.js');
    expect(compiled).toMatchObject({ runtime: 'compiled-javascript' });
    expect(compiled.entry.replaceAll('\\', '/')).toMatch(/\/dist\/live-execution-process\.js$/);
    expect(compiled.args).toEqual([compiled.entry]);
  });
});

describe('execution request telemetry', () => {
  it('records successful and failed requests without request payloads', async () => {
    const profiler = new ExecutionNetworkProfiler();
    await expect(profiler.measure('rpc.ok', 'rpc', async () => 7)).resolves.toBe(7);
    await expect(profiler.measure('http.fail', 'http', async () => {
      throw new Error('timed out');
    })).rejects.toThrow('timed out');

    expect(profiler.timings).toHaveLength(2);
    expect(profiler.timings[0]).toMatchObject({ label: 'rpc.ok', kind: 'rpc', ok: true });
    expect(profiler.timings[1]).toMatchObject({ label: 'http.fail', kind: 'http', ok: false, error: 'timed out' });
    expect(JSON.stringify(profiler.timings)).not.toContain('secret');
  });
});

describe('batched execution preflight warmup', () => {
  it('loads mint policy and ATAs in one RPC batch', async () => {
    const wallet = Keypair.generate().publicKey;
    const mints = [key(), key()];
    let batches = 0;
    const parsedMint = (mint: string) => ({
      executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID, rentEpoch: 0,
      data: { program: 'spl-token', parsed: { type: 'mint', info: {
        decimals: 6, mintAuthority: null, freezeAuthority: null,
      } }, space: 82 },
      mint,
    });
    const parsedAta = (mint: string) => ({
      executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID, rentEpoch: 0,
      data: { program: 'spl-token', parsed: { type: 'account', info: {
        mint, owner: wallet.toBase58(), tokenAmount: { amount: '1000000' },
      } }, space: 165 },
    });
    const connection = {
      rpcEndpoint: `mock://${Math.random()}`,
      getMultipleParsedAccounts: async () => {
        batches++;
        return { context: { slot: 1 }, value: [
          parsedMint(mints[0]!), parsedMint(mints[1]!),
          parsedAta(mints[0]!), parsedAta(mints[1]!),
        ] };
      },
      getMinimumBalanceForRentExemption: async () => 2_039_280,
    } as unknown as import('@solana/web3.js').Connection;
    await preloadExecutionPreflight(connection, wallet, mints);
    expect(batches).toBe(1);
  });
});

describe('execution fee hot-path cache', () => {
  it('uses a conservative synchronous floor without an RPC request', () => {
    const plan = validPlan();
    const message = new TransactionMessage({
      payerKey: new PublicKey(plan.wallet),
      recentBlockhash: key(),
      instructions: plan.instructions,
    }).compileToV0Message();
    const priority = Math.ceil(
      plan.computeUnitLimit! * plan.computeUnitPriceMicroLamports! / 1_000_000,
    );
    expect(executionFeeEstimate(message, plan)).toBeGreaterThanOrEqual(10_000 + priority);
  });
});

describe('dedicated signer boundary', () => {
  it('does not require or load a signer in paper mode', async () => {
    expect(await loadDedicatedSigner('paper', undefined)).toBeNull();
  });

  it('rejects a malformed signer file', async () => {
    const dir = tempDir(); await mkdir(dir); const file = path.join(dir, 'bad.json');
    await writeFile(file, '[1,2,3]');
    await expect(loadDedicatedSigner('dry-run', file, key())).rejects.toThrow('64-byte');
  });

  it('rejects signer material anywhere inside the project tree', async () => {
    await expect(loadDedicatedSigner('dry-run', path.join(process.cwd(), 'keys', 'bot.json'), key()))
      .rejects.toThrow('outside the project');
  });

  it('loads a valid external Solana CLI keypair without exposing secret data', async () => {
    const dir = tempDir(); await mkdir(dir); const file = path.join(dir, 'bot.json');
    const generated = Keypair.generate();
    await writeFile(file, JSON.stringify([...generated.secretKey]));
    const loaded = await loadDedicatedSigner('dry-run', file, generated.publicKey.toBase58());
    expect(loaded?.publicKey).toBe(generated.publicKey.toBase58());
    expect(loaded?.sourcePath).toBe(file);
  });
});

describe('aggregator scanner-to-executor boundary', () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const wsol = 'So11111111111111111111111111111111111111112';
  const candidate = () => ({
    schema: 'sol-arb.aggregator-execution-handoff', version: 1,
    opportunityId: 'scanner-observation', detectedAt: Date.now(),
    opportunityType: 'RAPTOR_JUPITER_ATOMIC', providers: ['raptor', 'jupiter'],
    inputMint: usdc, intermediateMint: wsol, outputMint: usdc,
    proposedInputAmount: '50000', scannerPools: [[key()], [key()]],
    scannerObservation: {
      expectedOutputAmount: '50100', minimumOutputAmount: '50050',
      projectedNetAmount: '50', roiBps: '10', quoteTimestamp: Date.now(),
    },
  });

  it('accepts both audited provider orders with matching route types and rejects executable payload injection', () => {
    expect(parseAggregatorAtomicHandoff(candidate()).providers).toEqual(['raptor', 'jupiter']);
    expect(() => parseAggregatorAtomicHandoff({ ...candidate(), providers: ['jupiter', 'raptor'] }))
      .toThrow();
    expect(parseAggregatorAtomicHandoff({
      ...candidate(), opportunityType: 'JUPITER_RAPTOR_ATOMIC', providers: ['jupiter', 'raptor'],
    }).providers).toEqual(['jupiter', 'raptor']);
    expect(() => parseAggregatorAtomicHandoff({
      ...candidate(), opportunityType: 'JUPITER_RAPTOR_ATOMIC', providers: ['raptor', 'jupiter'],
    })).toThrow('does not match provider order');
    expect(() => parseAggregatorAtomicHandoff({ ...candidate(), serializedTransaction: 'attacker-data' }))
      .toThrow();
  });

  it('keeps scanner economics outside candidate identity', () => {
    const original = parseAggregatorAtomicHandoff(candidate());
    const tampered = parseAggregatorAtomicHandoff({
      ...candidate(),
      detectedAt: original.detectedAt,
      scannerPools: original.scannerPools,
      scannerObservation: { ...original.scannerObservation, projectedNetAmount: '-999999', roiBps: '-999999' },
    });
    expect(aggregatorHandoffIdentity(tampered)).toBe(aggregatorHandoffIdentity(original));
  });

  it('uses the valid revalidation -> quoted -> building journal path', () => {
    expect(() => assertExecutionTransition('REVALIDATING', 'QUOTED')).not.toThrow();
    expect(() => assertExecutionTransition('QUOTED', 'BUILDING')).not.toThrow();
    expect(() => assertExecutionTransition('REVALIDATING', 'BUILDING')).toThrow('Illegal execution state');
  });

  it('requires an explicit user-approval transition before a prepared transaction may submit', () => {
    expect(() => assertExecutionTransition('APPROVED_FOR_SUBMISSION', 'APPROVED_BY_USER')).not.toThrow();
    expect(() => assertExecutionTransition('APPROVED_BY_USER', 'REVALIDATING')).not.toThrow();
    expect(() => assertExecutionTransition('APPROVED_BY_USER', 'SUBMITTING')).not.toThrow();
    expect(() => assertExecutionTransition('APPROVED_BY_USER', 'APPROVED_FOR_SUBMISSION')).toThrow('Illegal execution state');
  });
});

describe('live submission guard', () => {
  it('keeps broadcast unavailable before readiness', () => {
    expect(() => assertLiveSubmissionAllowed(false)).toThrow('Broadcast blocked');
  });

  it('requires explicit continuous live approval, bounded session caps, and the readiness gate', () => {
    const ready: LiveSubmissionGuardConfig = {
      executionMode: 'live', liveTradingEnabled: true, liveContinuousEnabled: true, realMoneyReadiness: 'READY',
      liveMaxTransactions: 1, maxConcurrentExecutions: 1, maxTradesPerSession: 1,
    };
    expect(() => assertLiveSubmissionAllowed(true, ready)).not.toThrow();
    expect(() => assertLiveSubmissionAllowed(true, { ...ready, executionMode: 'dry-run' })).toThrow('EXECUTION_MODE');
    expect(() => assertLiveSubmissionAllowed(true, { ...ready, liveTradingEnabled: false })).toThrow('LIVE_TRADING_ENABLED');
    expect(() => assertLiveSubmissionAllowed(true, { ...ready, liveContinuousEnabled: false })).toThrow('LIVE_CONTINUOUS_ENABLED');
    expect(() => assertLiveSubmissionAllowed(true, { ...ready, realMoneyReadiness: 'NOT_READY' })).toThrow('REAL_MONEY_READINESS');
    expect(() => assertLiveSubmissionAllowed(true, { ...ready, liveMaxTransactions: 0 })).toThrow('LIVE_MAX_TRANSACTIONS');
    expect(() => assertLiveSubmissionAllowed(true, {
      ...ready, liveMaxTransactions: 3, maxTradesPerSession: 3,
    })).not.toThrow();
    expect(() => assertLiveSubmissionAllowed(true, {
      ...ready, liveMaxTransactions: 3, maxTradesPerSession: 2,
    })).toThrow('must equal');
    expect(() => assertLiveSubmissionAllowed(false, ready)).toThrow('REAL_MONEY_READINESS is NOT READY');
  });
});

describe('live wallet allocation limits', () => {
  it('rejects an input above the configured percentage of the actual USDC balance', async () => {
    const plan = validPlan();
    plan.inputAmount = 300_000n;
    const connection = {
      getBalance: async () => 12_000_000,
      getTokenAccountBalance: async () => ({ value: { amount: '500000' } }),
    } as unknown as import('@solana/web3.js').Connection;
    await expect(captureAndValidateLiveBalances(connection, plan)).rejects.toThrow('MAX_TRADE_PERCENT');
  });
});

const liveGuard: LiveSubmissionGuardConfig = {
  executionMode: 'live', liveTradingEnabled: true, liveContinuousEnabled: true, realMoneyReadiness: 'READY',
  liveMaxTransactions: 1, maxConcurrentExecutions: 1, maxTradesPerSession: 1,
};

function approvedForSubmission(executionId: string, localOnly = false): ApprovedSignedExecution {
  const signer = Keypair.generate();
  const plan = validPlan(signer.publicKey.toBase58());
  plan.quoteReceivedAt = Date.now();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey, recentBlockhash: key(), instructions: plan.instructions,
  }).compileToV0Message());
  const signed = signApprovedExecution(
    approveTransaction('validated-opportunity', plan, transaction),
    { keypair: signer, publicKey: signer.publicKey.toBase58(), sourcePath: 'test-only' },
  );
  const timing = {
    blockhashRetrievalMs: 1, serializationMs: 1, simulationRpcMs: 1,
    blockhashRetrievedAt: Date.now(), simulationRequestAt: Date.now(), simulationResponseAt: Date.now(),
  };
  const common = {
    passed: true, error: null, logs: [], unitsConsumed: 1, transactionBytes: transaction.serialize().length,
    estimatedBaseFeeLamports: 5000, transactionVersion: 'v0' as const,
    staticAccountCount: transaction.message.staticAccountKeys.length, lookupTableCount: 0,
    lookupTableAccountCount: 0, lookupTableAddresses: [], requiredSignatures: 1,
    blockhash: transaction.message.recentBlockhash, lastValidBlockHeight: 999, loadedAccountsDataSize: 1,
    returnData: null, transaction, timing,
  };
  return approveSignedExecutionForSubmission(
    executionId,
    signed,
    { ...common, sigVerify: false },
    localOnly ? undefined : { ...common, sigVerify: true, lastValidBlockHeight: undefined },
  );
}

async function seedApprovedJournal(journal: PersistentExecutionJournal, approved: ApprovedSignedExecution): Promise<void> {
  await journal.begin(approved.executionId);
  await journal.transition(approved.executionId, 'VALIDATING');
  await journal.transition(approved.executionId, 'SIMULATING');
  await journal.transition(approved.executionId, 'APPROVED', { messageHash: approved.messageHash });
  await journal.transition(approved.executionId, 'SIGNING');
  await journal.transition(approved.executionId, 'SIGNED');
  await journal.transition(approved.executionId, 'SIGNED_SIMULATION');
  await journal.transition(approved.executionId, 'APPROVED_FOR_SUBMISSION', { messageHash: approved.messageHash });
}

describe('one-shot broadcaster', () => {
  it('accepts the live single-simulation boundary only with a verified local signature', () => {
    const approved = approvedForSubmission('local-only', true);
    expect(approved.signatureVerification).toBe('LOCAL_ED25519');
    expect(approved.signedSimulation).toBeUndefined();
  });
  function setupTransport(signature: () => string, fail?: Error) {
    const calls: Uint8Array[] = [];
    const transport: SubmissionTransport = {
      submitExactSignedBytes: async (bytes) => {
        calls.push(Uint8Array.from(bytes));
        if (fail) throw fail;
        return signature();
      },
    };
    return { transport, calls };
  }

  async function setup(id: string) {
    const dir = tempDir(); await mkdir(dir);
    const journalPath = path.join(dir, 'journal.json');
    const approved = approvedForSubmission(id);
    const journal = new PersistentExecutionJournal(journalPath);
    await seedApprovedJournal(journal, approved);
    const risk = new PersistentRiskManager(
      { maxTrades: 1, maxConsecutiveFailures: 1, maxSessionLossAtomic: 1_000_000n },
      path.join(dir, 'risk.json'),
    );
    await risk.load();
    return { approved, journal, journalPath, risk };
  }

  it('submits only exact approved bytes and persists SUBMITTED', async () => {
    const state = await setup('approved-send');
    const mock = setupTransport(() => state.approved.transactionSignature);
    const broadcaster = new OneShotBroadcaster(mock.transport, state.journal, state.risk, {
      readinessReady: true, guardConfig: liveGuard,
      now: () => state.approved.plan.quoteReceivedAt,
    });
    await expect(broadcaster.submit(state.approved)).resolves.toBe(state.approved.transactionSignature);
    expect(Buffer.from(mock.calls[0] ?? []).equals(Buffer.from(state.approved.transaction.serialize()))).toBe(true);
    expect(state.journal.get(state.approved.executionId)).toMatchObject({
      state: 'SUBMITTED', signature: state.approved.transactionSignature,
      serializedTransactionHash: state.approved.serializedTransactionHash,
    });
  });

  it('allows submission only after the prepared record has explicit user approval', async () => {
    const state = await setup('manual-approved-send');
    await state.journal.transition(state.approved.executionId, 'APPROVED_BY_USER', {
      messageHash: state.approved.messageHash,
    });
    const mock = setupTransport(() => state.approved.transactionSignature);
    const broadcaster = new OneShotBroadcaster(mock.transport, state.journal, state.risk, {
      readinessReady: true, guardConfig: liveGuard,
      now: () => state.approved.plan.quoteReceivedAt,
    });
    await expect(broadcaster.submit(state.approved)).resolves.toBe(state.approved.transactionSignature);
    expect(mock.calls).toHaveLength(1);
  });

  it('rejects an unapproved object and modified signed bytes', async () => {
    const state = await setup('tamper');
    const mock = setupTransport(() => state.approved.transactionSignature);
    const broadcaster = new OneShotBroadcaster(mock.transport, state.journal, state.risk, {
      readinessReady: true, guardConfig: liveGuard,
      now: () => state.approved.plan.quoteReceivedAt,
    });
    await expect(broadcaster.submit({} as ApprovedSignedExecution)).rejects.toThrow('not an in-process');
    state.approved.transaction.message.recentBlockhash = key();
    await expect(broadcaster.submit(state.approved)).rejects.toThrow(/fingerprint|changed/);
    expect(mock.calls).toHaveLength(0);
  });

  it('never retries an ambiguous result and blocks a second attempt', async () => {
    const state = await setup('ambiguous');
    const mock = setupTransport(() => state.approved.transactionSignature, new Error('socket closed'));
    const broadcaster = new OneShotBroadcaster(mock.transport, state.journal, state.risk, {
      readinessReady: true, guardConfig: liveGuard,
      now: () => state.approved.plan.quoteReceivedAt,
    });
    await expect(broadcaster.submit(state.approved)).rejects.toBeInstanceOf(AmbiguousSubmissionError);
    await expect(broadcaster.submit(state.approved)).rejects.toThrow('already attempted');
    expect(mock.calls).toHaveLength(1);
    expect(state.journal.get(state.approved.executionId)).toMatchObject({
      state: 'SUBMITTING', signature: state.approved.transactionSignature,
    });
    const restarted = new PersistentExecutionJournal(state.journalPath);
    await restarted.load();
    expect(restarted.unresolved()).toMatchObject([{
      id: state.approved.executionId,
      state: 'SUBMITTING',
      signature: state.approved.transactionSignature,
    }]);
  });

  it('enforces every live guard before transport invocation', async () => {
    const state = await setup('guards');
    const mock = setupTransport(() => state.approved.transactionSignature);
    const broadcaster = new OneShotBroadcaster(mock.transport, state.journal, state.risk, {
      readinessReady: true, guardConfig: { ...liveGuard, liveTradingEnabled: false },
    });
    await expect(broadcaster.submit(state.approved)).rejects.toThrow('LIVE_TRADING_ENABLED');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('approved message signing boundary', () => {
  it('signs only an already re-inspected compiled message and preserves its hash', () => {
    const signer = Keypair.generate();
    const plan = validPlan(signer.publicKey.toBase58());
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: key(),
      instructions: plan.instructions,
    }).compileToV0Message());
    const approved = approveTransaction('developer-validation', plan, transaction);
    const signed = signApprovedExecution(approved, {
      keypair: signer, publicKey: signer.publicKey.toBase58(), sourcePath: 'test-only',
    });
    expect(signed.signedMessageHash).toBe(approved.messageHash);
    expect(signed.serializedSize).toBeGreaterThan(0);
  });

  it('fails closed when an approved message changes before signing', () => {
    const signer = Keypair.generate(); const plan = validPlan(signer.publicKey.toBase58());
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: key(), instructions: plan.instructions }).compileToV0Message());
    const approved = approveTransaction('developer-validation', plan, transaction);
    transaction.message.recentBlockhash = key();
    expect(() => signApprovedExecution(approved, { keypair: signer, publicKey: signer.publicKey.toBase58(), sourcePath: 'test-only' })).toThrow('changed before signing');
  });
});

function handoff(overrides: Record<string, unknown> = {}) {
  const pools = [key(), key()] as const;
  return {
    schema: 'sol-arb.execution-handoff', version: 1, opportunityId: 'scanner-event', detectedAt: Date.now() - 99_999,
    opportunityType: 'ORCA_TWO_HOP_ATOMIC', venue: 'orca',
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    intermediateMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', pools,
    proposedInputAmount: '50000',
    scannerObservation: { expectedOutputAmount: '999999999', minimumOutputAmount: '999999999', projectedNetAmount: '999999999', roiBps: '999999999', quoteTimestamp: Date.now() - 99_999, stateSlots: ['1'] },
    discovery: { source: 'scanner', metadata: { arbitrary: 'diagnostic-only' } },
    ...overrides,
  };
}

describe('untrusted scanner handoff boundary', () => {
  it('rejects malformed DTOs and arbitrary transaction data', () => {
    expect(() => parseOrcaAtomicHandoff({ ...handoff(), instructions: ['evil'] })).toThrow();
    expect(() => parseOrcaAtomicHandoff({ ...handoff(), pools: [key(), key(), key()] })).toThrow();
    expect(() => parseOrcaAtomicHandoff({ ...handoff(), proposedInputAmount: '-1' })).toThrow();
  });

  it('does not give scanner quote/profit tampering authority or use stale discovery age as quote freshness', () => {
    const raw = handoff();
    const original = parseOrcaAtomicHandoff(raw);
    const tampered = parseOrcaAtomicHandoff({ ...raw, scannerObservation: { expectedOutputAmount: '1', minimumOutputAmount: '1', projectedNetAmount: '-999999', roiBps: '-999999', quoteTimestamp: 1, stateSlots: [] } });
    expect(handoffIdentity(tampered)).toBe(handoffIdentity(original));
    expect(assertHandoffScope(tampered)).toBe(50_000n);
  });

  it('accepts an address-identified dynamic intermediate but rejects a non-USDC base and oversized input', () => {
    expect(assertHandoffScope(parseOrcaAtomicHandoff(handoff({ intermediateMint: key() })))).toBe(50_000n);
    const wrongBase = key();
    expect(() => assertHandoffScope(parseOrcaAtomicHandoff(handoff({
      inputMint: wrongBase, outputMint: wrongBase,
    })))).toThrow('USDC -> intermediate -> USDC');
    const overCap = (BigInt(toAtomic(CONFIG.firstLiveMaxInputUsdc, DECIMALS.USDC)) + 1n).toString();
    expect(() => assertHandoffScope(parseOrcaAtomicHandoff(handoff({ proposedInputAmount: overCap }))))
      .toThrow('FIRST_LIVE');
  });

  it('uses executor-only fee-inclusive conservative economics for approval', () => {
    const plan = validPlan();
    plan.intermediateAta = { ...plan.intermediateAta, exists: true, creationRentLamports: 0 };
    plan.intermediateMint = 'So11111111111111111111111111111111111111112';
    plan.inputAmount = 50_000n; plan.expectedIntermediateAmount = 1_000_000n;
    plan.expectedOutputAmount = 151_000n; plan.minimumOutputAmount = 151_000n; plan.quoteReceivedAt = Date.now(); plan.computeUnitLimit = 72_760;
    const simulation = { estimatedBaseFeeLamports: 6_456, lastValidBlockHeight: 100, ...{} } as SimulationResult;
    const economics = calculateExecutorEconomics(plan, simulation);
    expect(economics.conservativeNetAtomic).toBeGreaterThan(0n);
    plan.minimumOutputAmount = 50_000n;
    const erased = calculateExecutorEconomics(plan, simulation);
    expect(() => assertFinalHandoffPolicy(plan, simulation, erased)).toThrow('Final economics');
  });

  it('prices network fees conservatively for a non-WSOL dynamic intermediate', () => {
    const plan = validPlan();
    plan.intermediateAta = { ...plan.intermediateAta, exists: true, creationRentLamports: 0 };
    plan.intermediateMint = key();
    plan.inputAmount = 50_000n; plan.expectedIntermediateAmount = 10_000n;
    plan.expectedOutputAmount = 60_000n; plan.minimumOutputAmount = 59_000n;
    plan.computeUnitLimit = 72_760;
    const economics = calculateExecutorEconomics(plan, {
      estimatedBaseFeeLamports: 6_000,
    } as SimulationResult);
    expect(economics.networkCostUsdcAtomic).toBe(1_500n);
    expect(economics.conservativeNetAtomic).toBe(7_500n);
  });

  it('charges missing ATA rent against conservative execution economics', () => {
    const plan = validPlan();
    plan.intermediateMint = 'So11111111111111111111111111111111111111112';
    plan.inputAmount = 50_000n; plan.expectedIntermediateAmount = 1_000_000n;
    plan.expectedOutputAmount = 151_000n; plan.minimumOutputAmount = 151_000n;
    const economics = calculateExecutorEconomics(plan, { estimatedBaseFeeLamports: 5_000 } as SimulationResult);
    expect(economics.ataRentLamports).toBe(2_039_280n);
    expect(economics.conservativeNetAtomic).toBeLessThan(0n);
  });

  it('does not charge transient WSOL ATA rent when the approved cycle closes it atomically', () => {
    const plan = validPlan();
    plan.intermediateMint = 'So11111111111111111111111111111111111111112';
    plan.inputAmount = 50_000n; plan.expectedIntermediateAmount = 1_000_000n;
    plan.expectedOutputAmount = 151_000n; plan.minimumOutputAmount = 151_000n;
    plan.aggregatorEvidence = {
      providers: ['raptor', 'jupiter'], routeProgramIds: [], sourceInstructionHashes: [],
      closesIntermediateAta: true,
      legs: [{
        provider: 'raptor', programId: 'RaptorD5ojtsqDDtJeRsunPLg6GvLYNnwKJWxYE4m87',
        inputMint: plan.inputMint, outputMint: plan.intermediateMint, inputAmount: plan.inputAmount,
        expectedOutputAmount: plan.expectedIntermediateAmount, minimumOutputAmount: plan.expectedIntermediateAmount,
        pool: plan.pools[0],
      }, {
        provider: 'jupiter', programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        inputMint: plan.intermediateMint, outputMint: plan.outputMint, inputAmount: plan.expectedIntermediateAmount,
        expectedOutputAmount: plan.expectedOutputAmount, minimumOutputAmount: plan.minimumOutputAmount,
        pool: plan.pools[1],
      }],
    };
    const economics = calculateExecutorEconomics(plan, { estimatedBaseFeeLamports: 5_000 } as SimulationResult);
    expect(economics.ataRentLamports).toBe(0n);
  });

  it('rejects stale executor quotes and expired approved blockhashes', async () => {
    const plan = validPlan(); plan.intermediateMint = 'So11111111111111111111111111111111111111112';
    plan.inputAmount = 50_000n; plan.expectedIntermediateAmount = 1_000_000n; plan.expectedOutputAmount = 151_000n; plan.minimumOutputAmount = 151_000n;
    plan.computeUnitLimit = 72_760; plan.quoteReceivedAt = Date.now() - 2_000;
    const simulation = { estimatedBaseFeeLamports: 6_456, lastValidBlockHeight: 101, timing: { blockhashRetrievedAt: Date.now() - 20_000 } } as SimulationResult;
    expect(() => assertFinalHandoffPolicy(plan, simulation, calculateExecutorEconomics(plan, simulation))).toThrow('Final economics');
    await expect(assertBlockhashFresh({ getBlockHeight: async () => 100 } as unknown as import('@solana/web3.js').Connection, simulation)).rejects.toThrow('age exceeded');
  });

  it('keeps scanner provider implementations and vulnerable token libraries out of executor imports', async () => {
    const files = [
      'src/execution/handoff-validator.ts', 'src/execution/orca-two-hop-builder.ts',
      'src/execution/aggregator-handoff-validator.ts', 'src/execution/aggregator-cycle-builder.ts',
      'src/execution/mixed-cycle-builder.ts', 'src/execution/orca-swap-builder.ts',
      'src/execution/transaction-inspector.ts', 'src/execution/token-analysis.ts',
      'src/execution/signer.ts', 'src/execution/simulator.ts', 'src/execution/approved-transaction.ts',
      'src/execution/broadcaster.ts', 'src/execution/live-balance-preflight.ts',
      'src/execution/confirmation-accounting.ts', 'src/live-execution-worker.ts',
      'src/live-execution-process.ts',
    ];
    const source = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const joined = source.join('\n');
    expect(joined).not.toMatch(/from\s+['"](?:\.\.\/)+(?:meteora|raptor|raydium|jupiter)(?:\.js)?['"]/i);
    expect(joined).not.toMatch(/@solana\/spl-token|bigint-buffer/i);
    expect(joined).not.toMatch(/(?:generic-cycle|raydium-swap|meteora-swap)-builder/i);
  });
});

describe('Orca same-DEX cross-pool eligibility', () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const wsol = 'So11111111111111111111111111111111111111112';
  const pool = (address: string) => ({ venue: 'orca' as const, address, tokenMintA: usdc, tokenMintB: wsol, poolType: 'whirlpool', feeRate: 0 });
  const snapshot = (sqrtPrice: bigint) => ({ whirlpool: { sqrtPrice, tokenMintA: usdc, tokenMintB: wsol }, responseTimestamp: Date.now() } as unknown as import('../src/orca.js').OrcaPoolSnapshot);

  it('rejects same-pool representations but allows distinct Orca liquidity when state prefilter supports it', () => {
    const first = pool(key()); const second = pool(key());
    // USDC->WSOL uses p and WSOL->USDC uses 1/p. Differing pools can form a positive spot product.
    expect(crossPoolMayClear(first, snapshot(1n << 65n), second, snapshot(1n << 63n), usdc, wsol)).toBe(true);
    expect(crossPoolMayClear(first, snapshot(1n << 65n), first, snapshot(1n << 63n), usdc, wsol)).toBe(false);
  });

  it('keeps intermediate direction exact and does not treat a pool alias as independent liquidity', () => {
    const first = pool(key()); const alias = { ...first };
    expect(crossPoolMayClear(first, snapshot(1n << 65n), alias, snapshot(1n << 63n), usdc, wsol)).toBe(false);
    expect(crossPoolMayClear(first, snapshot(1n << 65n), pool(key()), snapshot(1n << 63n), usdc, usdc)).toBe(false);
  });

  it('rejects a state spread that cannot clear both configured pool fees', () => {
    const first = { ...pool(key()), feeRate: 0.01 };
    const second = { ...pool(key()), feeRate: 0.01 };
    expect(crossPoolMayClear(first, snapshot(1n << 64n), second, snapshot(1n << 64n), usdc, wsol)).toBe(false);
  });

  it('generates both orderings for distinct pools and never emits self-pairs or aliases', () => {
    const first = pool(key()); const second = pool(key()); const alias = { ...first };
    const pairs = orderedDistinctOrcaPoolPairs([first, second, alias]);
    expect(pairs.map(([a, b]) => `${a.address}->${b.address}`)).toEqual([
      `${first.address}->${second.address}`,
      `${second.address}->${first.address}`,
    ]);
    expect(pairs.every(([a, b]) => a.address !== b.address)).toBe(true);
  });

  it('propagates the exact raw first-hop output into the reverse pool quote', () => {
    const first = pool(key()); const second = pool(key());
    const amounts: string[] = [];
    const quote = ((_: unknown, params: { amountAtomic: string }) => {
      amounts.push(params.amountAtomic);
      return amounts.length === 1
        ? { outAmount: '123456789', otherAmountThreshold: '123000000', feeAmount: '1' }
        : { outAmount: '50001', otherAmountThreshold: '50000', feeAmount: '1' };
    }) as typeof import('../src/orca.js').quoteOrcaPoolFromSnapshot;
    quoteExactOrcaRoundTrip(first, snapshot(1n << 64n), second, snapshot(1n << 64n), wsol, 50_000n, quote);
    expect(amounts).toEqual(['50000', '123456789']);
  });

  it('preserves a dynamic intermediate mint and exact raw amount in the strict handoff DTO', () => {
    const intermediateMint = key();
    const value: OrcaCrossPoolEvaluation = {
      classification: 'SAME_DEX_CROSS_POOL', executionArchitecture: 'ORCA_TWO_HOP_ATOMIC',
      firstPool: key(), secondPool: key(), intermediateMint,
      inputAmount: 20_000n, expectedOutputAmount: 20_100n, minimumOutputAmount: 20_050n,
      firstHopFeeAmount: 1n, secondHopFeeAmount: 1n,
      projectedNetAmount: 75n, conservativeNetAmount: 25n,
      roiBps: 50n, conservativeRoiBps: 12n, rawRoundTripSpreadBps: 50n,
      detectedAt: Date.now(), executionEligible: true,
    };
    const dto = orcaEvaluationToHandoff(value, ['123']);
    expect(dto.intermediateMint).toBe(intermediateMint);
    expect(dto.proposedInputAmount).toBe('20000');
    expect(dto.pools).toEqual([value.firstPool, value.secondPool]);
  });
});

describe('transaction instruction inspection', () => {
  it('accepts only the expected decoded atomic Orca cycle', () => {
    expect(inspectAtomicTransaction(validPlan())).toMatchObject({ passed: true });
  });

  it('blocks an unexpected executable program', () => {
    const plan = validPlan();
    plan.instructions.push(SystemProgram.transfer({ fromPubkey: new Keypair().publicKey, toPubkey: new Keypair().publicKey, lamports: 1 }));
    expect(inspectAtomicTransaction(plan).reasons.join(' ')).toContain('Unexpected top-level program');
  });

  it('blocks a wrong mint and unexpected output account', () => {
    const plan = validPlan();
    plan.outputMint = key();
    expect(inspectAtomicTransaction(plan).passed).toBe(false);
  });

  it('blocks a compute price that differs from conservative execution economics', () => {
    const plan = validPlan();
    plan.computeUnitPriceMicroLamports = CONFIG.fallbackPriorityFeeMicroLamports + 1;
    expect(inspectAtomicTransaction(plan).reasons.join(' ')).toContain('price differs');
  });
});

describe('final execution economics', () => {
  it('blocks stale and unprofitable revalidation results', () => {
    const plan = validPlan();
    plan.quoteReceivedAt = Date.now() - 10_000;
    plan.expectedOutputAmount = 99n;
    const result = validateFinalEconomics(plan, {
      now: Date.now(), maxQuoteAgeMs: 500, estimatedCostsAtomic: 1n,
      minimumNetProfitAtomic: 0n, minimumProfitBps: 1n,
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('Stale');
    expect(result.reasons.join(' ')).toContain('below threshold');
  });
});

describe('Token-2022 execution policy', () => {
  it('fails closed for Token-2022 until a compatible maintained client is reviewed', () => {
    expect(classifyToken2022Extensions(['metadataPointer']).status).toBe('UNSUPPORTED');
  });

  it('blocks transfer-fee and transfer-hook extensions until modeled end-to-end', () => {
    const result = classifyToken2022Extensions(['transferFeeConfig', 'transferHook']);
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.transferFeeMode).toBe('BLOCKED_UNMODELED');
  });

  it('permits a classic dynamic mint only when both mint and freeze authorities are revoked', () => {
    const mint = key();
    const safe = {
      mint, status: 'SUPPORTED' as const, programId: TOKEN_PROGRAM_ID.toBase58(), decimals: 6,
      extensions: [], reasons: [], transferFeeMode: 'NONE' as const,
      mintAuthority: null, freezeAuthority: null,
    };
    expect(() => assertIntermediateTokenExecutionPolicy(safe, true)).not.toThrow();
    expect(() => assertIntermediateTokenExecutionPolicy({ ...safe, mintAuthority: key() }, true)).toThrow('authority');
    expect(() => assertIntermediateTokenExecutionPolicy({ ...safe, freezeAuthority: undefined }, true)).toThrow('authority');
    expect(() => assertIntermediateTokenExecutionPolicy(safe, false)).toThrow('disabled');
  });
});

describe('persistent execution controls', () => {
  it('finalizes interrupted pre-submission states but preserves submission-possible states', async () => {
    const states = [
      ['DETECTED'],
      ['DETECTED', 'HANDOFF_RECEIVED'],
      ['DETECTED', 'HANDOFF_RECEIVED', 'REVALIDATING'],
      ['DETECTED', 'HANDOFF_RECEIVED', 'REVALIDATING', 'QUOTED', 'BUILDING', 'INSPECTING', 'SIMULATING', 'APPROVED', 'SIGNING', 'SIGNED'],
    ] as const;
    for (const [index, sequence] of states.entries()) {
      const file = path.join(tempDir(), 'journal.json');
      await mkdir(path.dirname(file), { recursive: true });
      const first = new PersistentExecutionJournal(file);
      await first.load();
      await first.begin(`pre-${index}`);
      for (const state of sequence.slice(1)) await first.transition(`pre-${index}`, state);
      const restarted = new PersistentExecutionJournal(file);
      await restarted.load();
      const recovery = await restarted.recoverInterruptedPreSubmission();
      expect(recovery.requiresReconciliation).toHaveLength(0);
      expect(restarted.get(`pre-${index}`)?.state).toBe('REJECTED');
    }

    const file = path.join(tempDir(), 'journal.json');
    await mkdir(path.dirname(file), { recursive: true });
    const submitted = new PersistentExecutionJournal(file);
    await submitted.load();
    await submitted.begin('possibly-sent');
    await submitted.transition('possibly-sent', 'HANDOFF_RECEIVED');
    await submitted.transition('possibly-sent', 'REVALIDATING');
    await submitted.transition('possibly-sent', 'QUOTED');
    await submitted.transition('possibly-sent', 'BUILDING');
    await submitted.transition('possibly-sent', 'INSPECTING');
    await submitted.transition('possibly-sent', 'SIMULATING');
    await submitted.transition('possibly-sent', 'APPROVED');
    await submitted.transition('possibly-sent', 'SIGNING');
    await submitted.transition('possibly-sent', 'SIGNED');
    await submitted.transition('possibly-sent', 'SUBMITTING', {
      signature: key(), wallet: key(), baseMint: key(), intermediateMint: key(),
    });
    const restarted = new PersistentExecutionJournal(file);
    await restarted.load();
    const recovery = await restarted.recoverInterruptedPreSubmission();
    expect(recovery.finalizedPreSubmission).toHaveLength(0);
    expect(recovery.requiresReconciliation.map((record) => record.state)).toEqual(['SUBMITTING']);
  });

  it.each(['SUBMITTED', 'CONFIRMING'] as const)(
    'preserves %s records for deterministic signature reconciliation',
    async (targetState) => {
      const file = path.join(tempDir(), 'journal.json');
      await mkdir(path.dirname(file), { recursive: true });
      const journal = new PersistentExecutionJournal(file);
      await journal.load();
      await journal.begin(`possibly-sent-${targetState}`);
      for (const state of [
        'HANDOFF_RECEIVED', 'REVALIDATING', 'QUOTED', 'BUILDING', 'INSPECTING',
        'SIMULATING', 'APPROVED', 'SIGNING', 'SIGNED', 'SUBMITTING', 'SUBMITTED',
      ] as const) {
        await journal.transition(`possibly-sent-${targetState}`, state, state === 'SUBMITTING'
          ? { signature: key(), wallet: key(), baseMint: key(), intermediateMint: key() }
          : {});
        if (state === targetState) break;
      }
      if (targetState === 'CONFIRMING') {
        await journal.transition(`possibly-sent-${targetState}`, 'CONFIRMING');
      }
      const restarted = new PersistentExecutionJournal(file);
      await restarted.load();
      const recovery = await restarted.recoverInterruptedPreSubmission();
      expect(recovery.finalizedPreSubmission).toHaveLength(0);
      expect(recovery.requiresReconciliation).toMatchObject([{ state: targetState }]);
    },
  );

  it('recovers only a lock whose owning process is dead', async () => {
    const file = path.join(tempDir(), 'execution.lock');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `2147483647:${Date.now()}:dead-owner`);
    const dead = new PersistentExecutionLock(file);
    expect(await dead.recoverDeadOwner()).toBe(true);
    await writeFile(file, `${process.pid}:${Date.now()}:live-owner`);
    expect(await dead.recoverDeadOwner()).toBe(false);
  });

  it('enforces a single execution lock', async () => {
    const dir = tempDir(); await mkdir(dir); const lock = new PersistentExecutionLock(path.join(dir, 'lock'));
    const release = await lock.acquire('a');
    await expect(lock.acquire('b')).rejects.toThrow('already held');
    await release();
  });

  it('blocks duplicates, consecutive failures, and session loss', async () => {
    const dir = tempDir(); await mkdir(dir); const state = path.join(dir, 'risk.json');
    const risk = new PersistentRiskManager({ maxTrades: 3, maxConsecutiveFailures: 2, maxSessionLossAtomic: 10n }, state);
    await risk.load();
    await risk.recordSuccess('done', -11n);
    expect(() => risk.assertCanExecute('done')).toThrow('Duplicate');
    expect(() => risk.assertCanExecute('new')).toThrow('MAX_SESSION_LOSS');
    const failures = new PersistentRiskManager({ maxTrades: 3, maxConsecutiveFailures: 2, maxSessionLossAtomic: 100n }, path.join(dir, 'fail.json'));
    await failures.recordFailure(); await failures.recordFailure();
    expect(() => failures.assertCanExecute('new')).toThrow('MAX_CONSECUTIVE_FAILURES');
  });

  it('persists the one-shot submission cap before a future send attempt', async () => {
    const dir = tempDir(); await mkdir(dir);
    const risk = new PersistentRiskManager({ maxTrades: 1, maxConsecutiveFailures: 2, maxSessionLossAtomic: 100n }, path.join(dir, 'one-shot.json'));
    await risk.recordSubmissionAttempt('attempted');
    expect(() => risk.assertCanExecute('another')).toThrow('MAX_TRADES_PER_SESSION');
  });

  it('persists a fail-closed state machine and exposes unresolved submissions for restart reconciliation', async () => {
    const dir = tempDir(); await mkdir(dir); const journal = new PersistentExecutionJournal(path.join(dir, 'journal.json'));
    await journal.begin('one');
    await journal.transition('one', 'VALIDATING');
    await journal.transition('one', 'SIMULATING');
    await journal.transition('one', 'APPROVED', { messageHash: 'abc' });
    await journal.transition('one', 'SIGNING');
    await journal.transition('one', 'SIGNED');
    await journal.transition('one', 'SUBMITTING'); // Persisted before a future RPC send.
    const restarted = new PersistentExecutionJournal(path.join(dir, 'journal.json'));
    await restarted.load();
    expect(restarted.unresolved()).toMatchObject([{ id: 'one', state: 'SUBMITTING' }]);
    expect(() => assertExecutionTransition('SUBMITTING', 'SIGNED')).toThrow('Illegal execution state');
  });
});

describe('confirmed-balance accounting', () => {
  it('keeps projected data out of realized P&L and reports intermediate dust', () => {
    const result = calculateRealizedCycleResult(
      { capturedAt: 1, baseAmount: 1_000_000n, intermediateAmount: 0n, solLamports: 10_000n },
      { capturedAt: 2, baseAmount: 1_001_500n, intermediateAmount: 7n, solLamports: 4_500n },
    );
    expect(result.realizedBaseDelta).toBe(1_500n);
    expect(result.solFeeDeltaLamports).toBe(5_500n);
    expect(result.intermediateDustDelta).toBe(7n);
    expect(result.hasUnexpectedIntermediateDust).toBe(true);
  });

  it('extracts fee, realized base P&L, and intermediate dust from confirmed transaction balances', () => {
    const wallet = key();
    const base = key();
    const intermediate = key();
    const result = calculateConfirmedCycleAccounting('known-historical-or-fixture-signature', wallet, base, intermediate, {
      feeLamports: 5_000n,
      accountKeys: [wallet],
      preBalances: [100_000n],
      postBalances: [95_000n],
      preTokenBalances: [
        { accountIndex: 1, mint: base, owner: wallet, amount: 1_000_000n },
        { accountIndex: 2, mint: intermediate, owner: wallet, amount: 0n },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: base, owner: wallet, amount: 1_002_500n },
        { accountIndex: 2, mint: intermediate, owner: wallet, amount: 3n },
      ],
    });
    expect(result.actualFeeLamports).toBe(5_000n);
    expect(result.realizedBasePnlAtomic).toBe(2_500n);
    expect(result.intermediateDustAtomic).toBe(3n);
    expect(result.hasUnexpectedIntermediateDust).toBe(true);
  });

  it('confirms a signature, persists on-chain accounting, and never performs submission', async () => {
    const dir = tempDir(); await mkdir(dir); const journal = new PersistentExecutionJournal(path.join(dir, 'confirm.json'));
    const wallet = key(); const base = key(); const intermediate = key();
    await journal.begin('confirmation');
    await journal.transition('confirmation', 'VALIDATING');
    await journal.transition('confirmation', 'SIMULATING');
    await journal.transition('confirmation', 'APPROVED');
    await journal.transition('confirmation', 'SIGNING');
    await journal.transition('confirmation', 'SIGNED');
    await journal.transition('confirmation', 'SUBMITTING');
    await journal.transition('confirmation', 'SUBMITTED', { signature: 'fixture-signature' });
    const connection = {
      getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }),
      getTransaction: async () => ({
        meta: {
          fee: 5000,
          preBalances: [100_000], postBalances: [94_000],
          preTokenBalances: [{ accountIndex: 1, mint: base, owner: wallet, uiTokenAmount: { amount: '1000' } }, { accountIndex: 2, mint: intermediate, owner: wallet, uiTokenAmount: { amount: '0' } }],
          postTokenBalances: [{ accountIndex: 1, mint: base, owner: wallet, uiTokenAmount: { amount: '1025' } }, { accountIndex: 2, mint: intermediate, owner: wallet, uiTokenAmount: { amount: '3' } }],
        },
        transaction: { message: { staticAccountKeys: [new PublicKey(wallet)] } },
      }),
    } as unknown as import('@solana/web3.js').Connection;
    const accounting = await confirmAndAccountForCycle(connection, {
      signature: 'fixture-signature', wallet, baseMint: base, intermediateMint: intermediate,
      journal, executionId: 'confirmation', timeoutMs: 100, pollIntervalMs: 1,
    });
    expect(accounting.realizedBasePnlAtomic).toBe(25n);
    expect(journal.get('confirmation')).toMatchObject({ state: 'CONFIRMED', accounting: { actualFeeLamports: '5000', usdcDelta: '25', intermediateDust: '3' } });
  });
});
