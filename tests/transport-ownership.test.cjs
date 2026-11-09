const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const text=fs.readFileSync(path.join(__dirname,'../runtime/agent.cjs'),'utf8');
const a=text.indexOf('function ownsTransportProcess('),b=text.indexOf('\nasync function stopLocalTransport',a);
const moduleData='/Users/test/Library/Application Support/Antigravity SSH Settings';
const owns=vm.runInNewContext('('+text.slice(a,b)+')',{path,moduleData});
const session={host:'devbox',supervisorPID:4242};
const command='/usr/bin/python3 '+moduleData+'/releases/0.2.0-test/transport.py --host devbox --app-pid 123';
test('disconnects only the isolated local transport group for the requested SSH host',()=>{
 assert.equal(owns('devbox',session,'4242 '+command),true);
 assert.equal(owns('devbox',session,'4243 '+command),false);
 assert.equal(owns('devbox',session,'4242 /usr/bin/python3 /other/project/task.py'),false);
 assert.equal(owns('devbox',session,'4242 '+command.replace('--host devbox','--host devbox-extra')),false);
 assert.equal(owns('other-host',session,'4242 '+command),false);
});
