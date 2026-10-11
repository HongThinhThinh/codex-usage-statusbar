const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {QuotaConnection}=require('../quota-rpc.cjs');
const {watchUsage,parseUsageEvents}=require('../usage-events.cjs');
// Point CODEX_EXECUTABLE at a real Codex binary; defaults to `codex` on PATH.
const executable=process.env.CODEX_EXECUTABLE||'codex';
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-usage-watch-'));
 const connection=new QuotaConnection(executable,20000);
 let watcher;
 try{
  const first=await connection.read();const pid=connection.child.pid;
  const second=await connection.read();
  assert.equal(pid,connection.child.pid);assert.ok(first.rateLimits&&second.rateLimits);
  const event={timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'token_count',rate_limits:{limit_id:'codex',primary:{used_percent:37,window_minutes:300,resets_at:1791753398}}}};
  const parsed=parseUsageEvents(JSON.stringify(event));assert.equal(parsed[0].raw.rateLimits.primary.usedPercent,37);
  const start=Date.now();
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Live watcher did not emit')),2500);
   watcher=watchUsage(root,update=>{clearTimeout(timer);assert.equal(update.raw.rateLimits.primary.usedPercent,37);resolve();});
   fs.writeFileSync(path.join(root,'live.jsonl'),JSON.stringify(event)+'\n');
  });
  console.log(`Session event appeared in ${Date.now()-start}ms. Two quota reads reused the same app-server process. Checks passed.`);
 }finally{watcher?.dispose();connection.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1});
