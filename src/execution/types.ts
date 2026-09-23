import type {
  AddressLookupTableAccount,
  Keypair,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import type { TokenAccountPreflight } from './account-preflight.js';
import type { TokenProgramAnalysis } from './token-analysis.js';
import type { ExecutionNetworkTiming } from './network-profiler.js';

export type ExecutionRouteType =
  | 'ORCA_TWO_HOP_CYCLE'
  | 'RAPTOR_JUPITER_CYCLE'
  | 'JUPITER_RAPTOR_CYCLE'
  | 'JUPITER_ORCA_CYCLE'
  | 'ORCA_JUPITER_CYCLE'
  | 'RAPTOR_ORCA_CYCLE'
  | 'ORCA_RAPTOR_CYCLE'
  | 'JUPITER_RAYDIUM_CYCLE'
  | 'RAYDIUM_JUPITER_CYCLE'
  | 'JUPITER_METEORA_CYCLE'
  | 'METEORA_JUPITER_CYCLE'
  | 'RAPTOR_RAYDIUM_CYCLE'
  | 'RAYDIUM_RAPTOR_CYCLE'
  | 'RAPTOR_METEORA_CYCLE'
  | 'METEORA_RAPTOR_CYCLE'
  | 'ORCA_RAYDIUM_CYCLE'
  | 'RAYDIUM_ORCA_CYCLE'
  | 'ORCA_METEORA_CYCLE'
  | 'METEORA_ORCA_CYCLE'
  | 'RAYDIUM_METEORA_CYCLE'
  | 'METEORA_RAYDIUM_CYCLE';

export type AggregatorExecutionProvider = 'raptor' | 'jupiter' | 'orca' | 'raydium' | 'meteora';

export interface ValidatedExecutionLegEvidence {
  downstreamProgramId?: string;
  provider: AggregatorExecutionProvider;
  programId: string;
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  expectedOutputAmount: bigint;
  minimumOutputAmount: bigint;
  pool: string;
}

export interface AggregatorCycleEvidence {
  providers: [AggregatorExecutionProvider, AggregatorExecutionProvider];
  /** Executable CPI programs named by the independently fetched route plans. */
  routeProgramIds: string[];
  /** SHA-256 fingerprints of the API instruction payloads before compilation. */
  sourceInstructionHashes: string[];
  closesIntermediateAta: boolean;
  /** Executor-built leg facts; scanner data is never copied here. */
  legs: [ValidatedExecutionLegEvidence, ValidatedExecutionLegEvidence];
}

export interface AtomicExecutionPlan {
  id: string;
  type: ExecutionRouteType;
  atomic: true;
  wallet: string;
  inputMint: string;
  intermediateMint: string;
  outputMint: string;
  inputAmount: bigint;
  expectedIntermediateAmount: bigint;
  expectedOutputAmount: bigint;
  minimumOutputAmount: bigint;
  pools: [string, string];
  quoteReceivedAt: number;
  /** Present for execution validation; contains no signer material. */
  executionTiming?: {
    routeDiscoveryMs: number;
    poolAccountFetchMs: number;
    freshPoolStateFetchMs: number;
    quoteGenerationMs: number;
    transactionConstructionMs: number;
    oldestPoolStateAt: number;
    newestPoolStateAt: number;
    oldestPoolStateSlot?: number;
    newestPoolStateSlot?: number;
    quoteGeneratedAt: number;
    transactionConstructionStartedAt: number;
    quoteAgeAtTransactionConstructionMs: number;
    /** Shared mutable request trace; simulator entries append to this same array. */
    networkRequests?: ExecutionNetworkTiming[];
  };
  baseToken: TokenProgramAnalysis;
  intermediateToken: TokenProgramAnalysis;
  baseAta: TokenAccountPreflight;
  intermediateAta: TokenAccountPreflight;
  computeUnitLimit?: number;
  /** Exact price encoded in the inspected ComputeBudget instruction. */
  computeUnitPriceMicroLamports?: number;
  instructions: TransactionInstruction[];
  /** Resolved and RPC-verified ALTs used to compile this exact transaction. */
  lookupTableAccounts?: AddressLookupTableAccount[];
  aggregatorEvidence?: AggregatorCycleEvidence;
  raydiumEvidence?: import('./raptor-raydium-cycle-builder.js').RaydiumCycleEvidence;
}

export interface SignerContext {
  keypair: Keypair;
  publicKey: string;
  sourcePath: string;
}

export interface InspectionResult {
  passed: boolean;
  reasons: string[];
  programIds: string[];
  instructionCount: number;
}

export interface SimulationResult {
  passed: boolean;
  error: unknown;
  logs: string[];
  unitsConsumed?: number;
  transactionBytes: number;
  estimatedBaseFeeLamports: number;
  transactionVersion: 'v0';
  staticAccountCount: number;
  lookupTableCount: number;
  lookupTableAccountCount: number;
  lookupTableAddresses: string[];
  requiredSignatures: number;
  blockhash: string;
  lastValidBlockHeight?: number;
  sigVerify: boolean;
  loadedAccountsDataSize?: number;
  returnData: unknown;
  transaction: VersionedTransaction;
  timing: {
    blockhashRetrievalMs: number;
    serializationMs: number;
    simulationRpcMs: number;
    blockhashRetrievedAt: number;
    simulationRequestAt: number;
    simulationResponseAt: number;
  };
}
