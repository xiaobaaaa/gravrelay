const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../runtime/panel.js'),'utf8');
const first=source.indexOf('  function applySelection('),last=source.indexOf('\n  function selectSaved(',first);
assert(first>=0&&last>first);
function fixture(backend){
 const projectId='00000000-0000-4000-8000-000000000001',conversationId='00000000-0000-4000-8000-000000000002';
 const origin='https://127.0.0.1:4000',history=[],messages=[],shown=[];
 const workspace={host:'devbox',backend,address:origin+'/?project='+projectId+'&__gravrelay_ssh=devbox',project:projectId};
 const frame={ready:true,workspaceReady:true,actionsReady:true,origin,element:{contentWindow:{postMessage:(data,origin)=>messages.push({data,origin})}}};
 const context=vm.createContext({selection:{project:projectId,conversation:conversationId,operation:null},snapshot:{projects:[{id:projectId,workspace}]},uuid:/^[0-9a-f-]{36}$/i,URL,location:{origin,href:origin+'/'},history:{pushState:(...x)=>history.push(x)},dispatchEvent(){},PopStateEvent:class{},hideWorkspace(){},workspaceFrame:()=>frame,revealWorkspace:x=>shown.push(x)});
 const apply=vm.runInContext('('+source.slice(first,last).trim()+')',context);
 return {apply,history,messages,shown,projectId,conversationId};
}
test('same-origin CLI projects stay in the remote frame and never navigate the Mac client',()=>{
 const x=fixture('cli');x.apply(undefined,true);
 assert.equal(x.history.length,0);
 assert.equal(x.messages.length,1);
 assert.equal(x.messages[0].data.type,'agy-ssh-select');
 assert.equal(x.messages[0].data.conversation,x.conversationId);
 assert.equal(x.shown.length,1);
});
test('keeps the existing standalone native routing behavior',()=>{
 const x=fixture('standalone');x.apply(undefined,true);
 assert.equal(x.history.length,1);
 assert.equal(new URL(x.history[0][2]).pathname,'/c/'+x.conversationId);
 assert.equal(x.messages.length,0);
});

test('cold startup waits for the document instead of permanently marking a partial installation',()=>{
 const callbacks=[],window={};window.top=window;
 const context=vm.createContext({window,document:{head:null,body:null,addEventListener:(type,callback)=>callbacks.push({type,callback})}});
 vm.runInContext(source,context);
 vm.runInContext(source,context);
 assert.equal(context.__agyConnectionsInstalled,undefined);
 assert.equal(context.__agyConnectionsWaiting,true);
 assert.equal(callbacks.length,1);
 assert.equal(callbacks[0].type,'DOMContentLoaded');
});
