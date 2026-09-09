import type { RoundTripResult } from './routes.js';
import { CONFIG,DECIMALS } from './config.js';
import { fromAtomic } from './math.js';
import { quoteMatchesExecutableProviderPolicy } from './execution/executable-route-policy.js';
const percentile=(a:number[])=>{a=[...a].sort((a,b)=>a-b);return {count:a.length,p50:a[Math.ceil(a.length*.5)-1]??null,p90:a[Math.ceil(a.length*.9)-1]??null,p99:a[Math.ceil(a.length*.99)-1]??null,max:a.at(-1)??null};};
class Coverage {
  private sizes=new Map<string,{planned:number;completed:number;compatible:number;fresh:number;ages:number[];skews:number[];expected:number[];worst:number[];nearest:Array<{expected:number;worst:number;age:number;skew:number}>}>();
  private group(size:string){let row=this.sizes.get(size);if(!row){if(this.sizes.size>=64)throw new Error('COVERAGE_SIZE_BOUND');row={planned:0,completed:0,compatible:0,fresh:0,ages:[],skews:[],expected:[],worst:[],nearest:[]};this.sizes.set(size,row);}return row;}
  plan(size:string,count:number){this.group(size).planned+=count;}
  record(route:RoundTripResult,classicKnown:boolean){if(![route.buyQuote.provider,route.sellQuote.provider].every(p=>p==='jupiter'||p==='raptor'))return;
    const size=fromAtomic(route.buyQuote.inAmount,DECIMALS.USDC).toString(),row=this.group(size);row.completed++;
    const age=Date.now()-Math.min(route.buyQuote.responseTimestamp,route.sellQuote.responseTimestamp),skew=route.quoteSkewMs,expected=route.profit.estimatedNetProfitUsdc.toNumber(),worst=route.profit.worstCaseNetProfitUsdc.toNumber();
    const compatible=classicKnown&&Number(size)<=CONFIG.firstLiveMaxInputUsdc&&quoteMatchesExecutableProviderPolicy(route.buyQuote)&&quoteMatchesExecutableProviderPolicy(route.sellQuote)&&route.buyQuote.outputMint===route.sellQuote.inputMint;
    if(compatible)row.compatible++;if(compatible&&age>=0&&age<=CONFIG.raptorExecutionQuoteAgeMs&&skew<=CONFIG.maxQuoteAgeMs)row.fresh++;
    for(const [key,value] of [['ages',age],['skews',skew],['expected',expected],['worst',worst]] as const){row[key].push(value);row[key]=row[key].slice(-2048);}
    row.nearest.push({expected,worst,age,skew});row.nearest.sort((a,b)=>b.worst-a.worst);row.nearest=row.nearest.slice(0,10);
  }
  snapshot(){return Object.fromEntries([...this.sizes].map(([size,row])=>[size,{planned:row.planned,completed:row.completed,compatible:row.compatible,fresh:row.fresh,completionRatio:row.planned?row.completed/row.planned:0,ageMs:percentile(row.ages),skewMs:percentile(row.skews),expectedNet:percentile(row.expected),worstNet:percentile(row.worst),nearest:row.nearest}]));}
}
export const executableCoverage=new Coverage();
