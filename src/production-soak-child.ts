// This bootstrap suppresses arbitrary library/error payloads before loading signer code.
export {};
console.log = console.warn = console.error = () => {};
if (!process.send || process.env.TRADER_PRODUCTION_SOAK !== '1' || process.env.LIVE_TRADING_ENABLED !== 'false') throw new Error('Invalid no-broadcast child startup');
if(process.argv.includes('--opportunity-quality-comparison')){
  const {comparisonBarrier,installComparisonFetchBarrier}=await import('./comparison-drain.js');
  comparisonBarrier.configure(true);installComparisonFetchBarrier();
  process.on('message',(message:unknown)=>{
    if(!message||typeof message!=='object'||(message as {type?:string}).type!=='COMPARISON_STOP')return;
    comparisonBarrier.stop();
    process.send?.({type:'COMPARISON_STOPPED',pending:comparisonBarrier.snapshot()});
    void comparisonBarrier.idle().then(()=>process.send?.({type:'COMPARISON_DRAINED',pending:comparisonBarrier.snapshot()}));
  });
}
await import('./live-execution-process.js');
