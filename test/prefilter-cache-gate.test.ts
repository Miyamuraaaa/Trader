import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({peek:vi.fn(),rpc:vi.fn()}));
vi.mock('../src/execution/execution-preflight-cache.js',()=>({peekExecutionPreflight:mocks.peek,getCachedExecutionMintAnalysis:vi.fn(),getCachedExecutionAta:vi.fn(),preloadExecutionPreflight:vi.fn()}));
vi.mock('../src/scanner-rpc-limiter.js',()=>({runScannerRpc:mocks.rpc,scannerRpcLimiter:{}}));
import { CONFIG,MINTS } from '../src/config.js';
import { TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID } from '../src/execution/account-preflight.js';
import { classifyIntermediate } from '../src/execution/scanner-executable-prefilter.js';
const originalWallet=CONFIG.botWalletAddress;
afterEach(()=>{CONFIG.botWalletAddress=originalWallet;vi.restoreAllMocks();vi.clearAllMocks();});
it('uses valid cached policy/ATA without entering a cooling RPC governor',async()=>{
  CONFIG.botWalletAddress=MINTS.SOL;
  mocks.peek.mockReturnValue(Promise.resolve([{mint:MINTS.SOL,status:'SUPPORTED',programId:TOKEN_PROGRAM_ID.toBase58(),extensions:[],reasons:[]},{exists:true,creationRentLamports:0}]));
  mocks.rpc.mockRejectedValue(new Error('RPC cooldown'));
  expect(await classifyIntermediate(MINTS.SOL,'RPC_P0_EXECUTION_CRITICAL')).toMatchObject({status:'SUPPORTED'});
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('cache miss still enters authoritative scanner RPC admission and fails closed',async()=>{
  CONFIG.botWalletAddress=MINTS.SOL;mocks.peek.mockReturnValue(undefined);mocks.rpc.mockRejectedValue(new Error('RPC cooldown'));
  await expect(classifyIntermediate(MINTS.SOL,'RPC_P0_EXECUTION_CRITICAL')).rejects.toThrow('RPC cooldown');
  expect(mocks.rpc.mock.calls[0]?.[2]).toBe('RPC_P0_EXECUTION_CRITICAL');
});
it('cached Token-2022 remains discovery-only',async()=>{
  CONFIG.botWalletAddress=MINTS.SOL;
  mocks.peek.mockReturnValue(Promise.resolve([{programId:TOKEN_2022_PROGRAM_ID.toBase58()},{exists:true,creationRentLamports:0}]));
  expect(await classifyIntermediate(MINTS.SOL)).toMatchObject({status:'TOKEN_2022'});expect(mocks.rpc).not.toHaveBeenCalled();
});
