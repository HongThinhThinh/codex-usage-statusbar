const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {watchAuth}=require('../auth-monitor.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-auth-test-'));const file=path.join(root,'auth.json');
 const write=id=>fs.writeFileSync(file,JSON.stringify({tokens:{account_id:id,access_token:'fake-'+id}}));
 write('A');let changes=0;const monitor=watchAuth(file,()=>changes++,10000);
 try{
  monitor.check();assert.equal(changes,0);
  fs.writeFileSync(file+'.tmp',JSON.stringify({tokens:{account_id:'B',access_token:'fake-B'}}));fs.renameSync(file+'.tmp',file);monitor.check();assert.equal(changes,1);
  fs.unlinkSync(file);monitor.check();assert.equal(changes,2);
  write('C');monitor.check();assert.equal(changes,3);
 }finally{monitor.dispose();fs.rmSync(root,{recursive:true,force:true})}
 const connections=[];let resolveOld;
 const response=used=>({rateLimits:{primary:{usedPercent:used,windowDurationMins:300,resetsAt:1791753398}}});
 class MockConnection{
  constructor(_,__,onUpdate){this.onUpdate=onUpdate;this.closed=false;connections.push(this)}
  read(){if(connections.indexOf(this)===0)return new Promise(resolve=>resolveOld=resolve);return Promise.resolve(response(12))}
  close(){this.closed=true}
 }
 class ThemeColor{constructor(id){this.id=id}}
 class MarkdownString{appendMarkdown(){}}
 const sandbox={exports:{},require:id=>id==='vscode'?{ThemeColor,MarkdownString,workspace:{getConfiguration:()=>({get:(_,fallback)=>fallback})}}:id==='./quota-rpc.cjs'?{QuotaConnection:MockConnection}:require(id.startsWith('.')?path.join(__dirname,'..',id):id),process,console,setTimeout,clearTimeout,setInterval,clearInterval};
 vm.createContext(sandbox);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'..','extension.js'),'utf8')+`\nstatusItem={}; detailItems=Array.from({length:4},()=>({hide(){this.visible=false},show(){this.visible=true}})); output={appendLine(){}}; globalThis.test={refresh,handleAuthChange,deactivate,get:()=>({lastSnapshot,statusItem,detailItems})};`,sandbox);
 const api=sandbox.test;const pending=api.refresh(false);
 while(!resolveOld)await tick();
 api.handleAuthChange();assert.equal(connections[0].closed,true);assert.equal(api.get().lastSnapshot,undefined);assert.ok(api.get().detailItems.every(item=>!item.visible));
 connections[0].onUpdate(response(95));assert.equal(api.get().lastSnapshot,undefined,'Old connection notification was displayed');
 resolveOld(response(83));await pending;
 for(let i=0;i<20&&api.get().lastSnapshot?.windows[0]?.usedPercent!==12;i++)await tick();
 assert.equal(api.get().lastSnapshot.windows[0].usedPercent,12,'Old response overwrote new account quota');
 assert.equal(connections.length,2);api.deactivate();
 console.log('Passed: atomic account replacement, logout/login, old connection closed, stale response and notification rejected, new-account quota displayed.');
})().catch(e=>{console.error(e.message);process.exitCode=1});
