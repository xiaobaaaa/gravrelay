const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../runtime/agent.cjs'),'utf8');
const first=source.indexOf('const cliChecks = new Map();'),last=source.indexOf('\nasync function maintainConnections()',first);
function fixture(){
 const calls=[];let finish;
 const context=vm.createContext({path,python:'python3',__dirname:'/fixture',configuredHosts:()=>[{host:'devbox',enabled:true}],
  UserFacingError:class extends Error{},run:(_,args)=>{calls.push(args);return new Promise(resolve=>{finish=resolve})}});
 const invoke=vm.runInContext(source.slice(first,last)+'\ninspectCLI',context);
 return {invoke,calls,finish:value=>finish({stdout:JSON.stringify({ok:true,status:value})})};
}
test('read-only CLI checks can coalesce but never impersonate a pending update or restart',async()=>{
 const x=fixture(),a=x.invoke('devbox'),b=x.invoke('devbox');
 await assert.rejects(x.invoke('devbox','update'),/already running/);
 await assert.rejects(x.invoke('devbox','restart'),/already running/);
 assert.equal(x.calls.length,1);x.finish({state:'available'});
 assert.equal((await a).state,'available');assert.equal((await b).state,'available');
 const update=x.invoke('devbox','update');assert.equal(x.calls.length,2);
 await assert.rejects(x.invoke('devbox','restart'),/already running/);
 x.finish({state:'restart_required'});assert.equal((await update).state,'restart_required');
});
test('disabled or unknown SSH hosts cannot trigger a CLI operation',async()=>{
 const x=fixture();await assert.rejects(x.invoke('other','update'),/Connect the SSH host/);assert.equal(x.calls.length,0);
});
