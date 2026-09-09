import { createHash } from 'node:crypto';
export function parseSoakArguments(args:readonly string[]){
  const minutes=args.find(a=>a.startsWith('--duration-minutes='));const ms=args.find(a=>a.startsWith('--duration-ms='));
  if(minutes&&ms)throw new Error('Specify only one duration');
  const durationMs=minutes?Number(minutes.split('=')[1])*60000:ms?Number(ms.split('=')[1]):5400000;
  if(!Number.isInteger(durationMs)||durationMs<3600000||durationMs>7200000)throw new Error('Production soak duration must be 60..120 minutes');
  return {durationMs,earlyStop:args.includes('--stop-after-constrained-economics')};
}
export function safetyFingerprint(config:object){
  // Values are hashed, never printed. Exclude identity/endpoint/signer/auth material entirely.
  const keys=Object.keys(config).filter(k=>!/url|endpoint|key|secret|wallet|signer|seed|path|authorization|bearer/i.test(k)&&(/^(max|min|firstLive|liveMax|slippage|executionMode|liveTradingEnabled|realMoneyReadiness|allowDynamicTokenExecution)/.test(k)||/rpc|concurrency|rps|safetyInterval|httpTimeout|policy|QuoteAge/i.test(k))).sort();
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(keys.map(k=>[k,(config as Record<string,unknown>)[k]])))).digest('hex');
}
export interface ConstrainedEvidence {candidateId:string;status:string;leg1Completed:boolean;leg2Completed:boolean;reservationRequired:boolean;reservationConsumed:boolean;expectedNet:string;conservativeNet:string;input:string;providers:string[];costs?:unknown;trace?:unknown;legs?:Array<{provider:string;inputMint:string;outputMint:string;input:string;minimumOutput:string;expectedOutput:string;evidenceAt:number;pools:string[]}>}
export class ConstrainedStop {
  private callback:((evidence:ConstrainedEvidence)=>Promise<void>)|undefined;
  private fired=false;
  configure(noBroadcast:boolean,callback:(evidence:ConstrainedEvidence)=>Promise<void>){if(!noBroadcast)throw new Error('EARLY_STOP_REQUIRES_NO_BROADCAST');this.callback=callback;}
  get blocksP0(){return this.callback!==undefined;}
  async consider(evidence:ConstrainedEvidence){
    if(!this.callback||this.fired||!evidence.leg1Completed||!evidence.leg2Completed||(evidence.reservationRequired&&!evidence.reservationConsumed)||!['EXECUTABLE_CANDIDATE','ECONOMICS_DIVERGED'].includes(evidence.status))return false;
    this.fired=true;await this.callback(evidence);return true;
  }
}
export const constrainedStop=new ConstrainedStop();
export function validLongSoak(input:{continuity:boolean;healthySamples:boolean;safetyUnchanged:boolean;checkpointFailures:number;wallClockDriftMaxMs:number;executorReady:boolean;executorExited:boolean;scannerFailed:boolean}){
  return input.continuity&&input.healthySamples&&input.safetyUnchanged&&input.checkpointFailures===0&&input.wallClockDriftMaxMs<=1000&&input.executorReady&&!input.executorExited&&!input.scannerFailed;
}
