const {spawn}=require('node:child_process');
const readline=require('node:readline');
class QuotaConnection {
 constructor(executable,timeoutMs,onUpdate=()=>{}) {
  this.pending=new Map(); this.nextId=1; this.closed=false; this.timeoutMs=timeoutMs;
  this.child=spawn(executable,['app-server','--listen','stdio://'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  this.lines=readline.createInterface({input:this.child.stdout});
  this.child.stderr.on('data',()=>{});
  this.child.stdin.on('error',e=>this.close(e));
  this.child.on('error',e=>this.close(e));
  this.child.on('exit',()=>this.close(new Error('Codex quota connection closed')));
  this.lines.on('line',line=>{
   let msg;try{msg=JSON.parse(line)}catch{return}
   if(msg.id!==undefined){
    const pending=this.pending.get(Number(msg.id));if(!pending)return;
    this.pending.delete(Number(msg.id));clearTimeout(pending.timer);
    if(msg.error)pending.reject(new Error(msg.error.message||'Quota request failed'));else pending.resolve(msg.result);
   } else if(msg.method==='account/rateLimits/updated')onUpdate(msg.params);
  });
  this.ready=this.request('initialize',{clientInfo:{name:'local-codex-usage',version:'1.3.0'},capabilities:{experimentalApi:true}}).then(()=>{
   if(!this.closed)this.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  });
 }
 request(method,params){
  if(this.closed)return Promise.reject(new Error('Quota connection is closed'));
  const id=this.nextId++;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Timeout: ${method}`));this.close();},this.timeoutMs);
   this.pending.set(id,{resolve,reject,timer});
   this.child.stdin.write(JSON.stringify({id,method,...(params===undefined?{}:{params})})+'\n');
  });
 }
 async read(){await this.ready;return this.request('account/rateLimits/read');}
 close(error=new Error('Quota connection disposed')){
  if(this.closed)return;this.closed=true;
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error)}this.pending.clear();
  this.lines.close();if(!this.child.killed)this.child.kill();
 }
}
module.exports={QuotaConnection};
