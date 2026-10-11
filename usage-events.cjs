const fs=require('node:fs');
const path=require('node:path');
function parseUsageEvents(text){
 const updates=[];
 for(const line of text.split('\n')){
  let e;try{e=JSON.parse(line)}catch{continue}
  const r=e.payload?.rate_limits;
  if(e.type!=='event_msg'||e.payload?.type!=='token_count'||!r||r.limit_id&&r.limit_id!=='codex')continue;
  const bucket=b=>b?{usedPercent:b.used_percent,windowDurationMins:b.window_minutes,resetsAt:b.resets_at}:null;
  updates.push({at:Date.parse(e.timestamp),raw:{rateLimits:{primary:bucket(r.primary),secondary:bucket(r.secondary),planType:r.plan_type,limitId:r.limit_id,credits:r.credits}}});
 }
 return updates;
}
function watchUsage(root,onUpdate){
 let stopped=false;const timers=new Map();
 const watcher=fs.watch(root,{recursive:true},(_,filename)=>{
  if(!filename||!filename.endsWith('.jsonl'))return;
  const file=path.join(root,filename);clearTimeout(timers.get(file));
  timers.set(file,setTimeout(async()=>{
   timers.delete(file);let handle;
   try{
    handle=await fs.promises.open(file,'r');const {size}=await handle.stat();
    const start=Math.max(0,size-256*1024);const buffer=Buffer.alloc(size-start);
    await handle.read(buffer,0,buffer.length,start);
    let text=buffer.toString('utf8');if(start>0)text=text.slice(text.indexOf('\n')+1);
    for(const update of parseUsageEvents(text))if(!stopped)onUpdate(update);
   }catch{}finally{await handle?.close()}
  },100));
 });
 watcher.on('error',()=>{});
 return {dispose(){stopped=true;watcher.close();for(const timer of timers.values())clearTimeout(timer);timers.clear();}};
}
module.exports={watchUsage,parseUsageEvents};
