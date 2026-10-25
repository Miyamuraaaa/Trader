// Temporary paper-only reproduction. Never persist arbitrary application output.
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const output=path.resolve('data',`quote-collision-probe-${Date.now()}.json`);
const minutes=Number(process.argv.find(x=>x.startsWith('--minutes='))?.split('=')[1]??3);
if(!Number.isFinite(minutes)||minutes<1||minutes>20)throw new Error('INVALID_PROBE_DURATION');
const startedAt=Date.now();const collisions=[];const counts={uniqueConstraint:0,scanFailures:0,scannerStarted:0,persistenceFailures:0};
const child=spawn('cmd.exe',['/d','/s','/c','npm.cmd run dev'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,EXECUTION_MODE:'paper',LIVE_TRADING_ENABLED:'false',LIVE_CONTINUOUS_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
let pending='';
function consume(chunk){pending+=chunk.toString();let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line.includes('UNIQUE constraint failed: quotes.id'))counts.uniqueConstraint++;if(/Scan iteration failed|scanner lane failed/.test(line))counts.scanFailures++;if(/scanner started|Scanner started|Scan cycle|Scanner execution-scope totals/i.test(line))counts.scannerStarted++;if(/QUOTE_PERSISTENCE_FAILED|SCANNER_HISTORY_\w+_FAILED/.test(line))counts.persistenceFailures++;const index=line.indexOf('QUOTE_ID_COLLISION ');if(index>=0){try{collisions.push(JSON.parse(line.slice(index+19)));}catch{}}}if(pending.length>65536)pending='';}
child.stdout.on('data',consume);child.stderr.on('data',consume);
setTimeout(()=>{try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}},minutes*60000);
const progress=setInterval(()=>console.log(JSON.stringify({elapsedMs:Date.now()-startedAt,counts})),60000);progress.unref();
child.on('exit',(code)=>{const result={mode:'paper',startedAt,endedAt:Date.now(),exitCode:code,counts,collisions};fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,counts,collisionCount:collisions.length,first8:collisions.slice(0,8)}));});
