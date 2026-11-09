const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const install = require('../runtime/cli-frontend.cjs');
function fixture(top = false, storage = null, host = "devbox") {
  const calls = [], listeners = new Set(), navigations = [];
  const location = new URL('https://127.0.0.1:4000/?__gravrelay_ssh='+host);
  const parent = { postMessage() {} };
  const window = {
    top: top ? null : parent, parent,
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return new Response('{}'); },
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  };
  if (storage) window.localStorage = storage;
  if (top) window.top = window;
  const history = {
    pushState: (...args) => navigations.push(args),
    replaceState: (...args) => navigations.push(args),
  };
  const context = vm.createContext({window,location,history,URL,Request,Headers,setInterval,clearInterval,setTimeout,clearTimeout,Promise,Error});
  vm.runInContext('(' + install.toString() + ')()', context);
  const valid = {type:'agy-ssh-cli-bootstrap',host,rpcOrigin:'https://localhost:5000',csrf:'x'.repeat(43)};
  function bootstrap(data = valid, origin = location.origin, source = parent) {
    for (const fn of [...listeners]) fn({ data, origin, source });
  }
  return { window,calls,bootstrap,valid,navigations,history,location,emitStorage:event=>{for(const fn of [...listeners])fn(event)} };
}

test('RPC waits for remote configuration and never sends local credentials', async () => {
  const x = fixture();
  const pending = x.window.fetch('/exa.language_server_pb.LanguageServerService/GetUserStatus', {
    method:'POST',body:'{}',headers:{Authorization:'local-test-credential','X-Codeium-Csrf-Token':'local-test-csrf'},
  });
  await new Promise(r => setImmediate(r));
  assert.equal(x.calls.length,0);
  x.bootstrap();
  await pending;
  assert.equal(x.calls[0].url,'https://localhost:5000/exa.language_server_pb.LanguageServerService/GetUserStatus');
  assert.equal(x.calls[0].init.headers.get('Authorization'),null);
  assert.equal(x.calls[0].init.headers.get('X-Codeium-Csrf-Token'),x.valid.csrf);
  assert.equal(x.calls[0].init.credentials,'omit');
});

test('rejects another frame, origin or host before accepting the intended connection', async () => {
  const x=fixture();
  const pending=x.window.fetch('/exa.test/Read',{method:'POST',body:'{}'});
  x.bootstrap(x.valid,'https://example.com');
  x.bootstrap(x.valid,x.location.origin,{});
  x.bootstrap({...x.valid,host:'other-host'});
  x.bootstrap({...x.valid,rpcOrigin:'https://example.com'});
  await new Promise(r=>setImmediate(r));
  assert.equal(x.calls.length,0);
  x.bootstrap();await pending;
  assert.equal(x.calls.length,1);
  assert.equal(new URL(x.calls[0].url).origin,'https://localhost:5000');
});

test('keeps local assets and external services on their intended origin', async () => {
  const x=fixture();x.bootstrap();
  await x.window.fetch('/assets/app.js');
  await x.window.fetch('https://example.com/exa.service/Method');
  assert.equal(x.calls[0].url,'/assets/app.js');
  assert.equal(x.calls[1].url,'https://example.com/exa.service/Method');
});

test('preserves the SSH identity through native project and conversation navigation', () => {
  const x=fixture();x.bootstrap();
  x.history.pushState({},'', '/c/thread?project=project-id');
  const url=new URL(x.navigations[0][2]);
  assert.equal(url.pathname,'/c/thread');
  assert.equal(url.searchParams.get('project'),'project-id');
  assert.equal(url.searchParams.get('__gravrelay_ssh'),'devbox');
});

test('leaves the native top-level app client unchanged', async () => {
  const x=fixture(true);
  await x.window.fetch('/exa.test/Read');
  assert.equal(x.calls[0].url,'/exa.test/Read');
  assert.equal(x.window.__gravRelayCLIFrontend,undefined);
});


function sharedStorage() {
  const values=new Map();
  return {
    get length(){return values.size},
    key:index=>[...values.keys()][index]??null,
    getItem:key=>values.get(String(key))??null,
    setItem:(key,value)=>values.set(String(key),String(value)),
    removeItem:key=>values.delete(String(key)),
    clear:()=>values.clear(),
  };
}
test('isolates SSH project selection and clear from the Mac and other SSH frontends',()=>{
  const backing=sharedStorage();backing.setItem('selectedProject','Mac project');
  const a=fixture(false,backing,'host-a'),b=fixture(false,backing,'host-b');a.bootstrap();b.bootstrap();
  a.window.localStorage.setItem('selectedProject','A project');
  b.window.localStorage.setItem('selectedProject','B project');
  assert.equal(backing.getItem('selectedProject'),'Mac project');
  assert.equal(a.window.localStorage.getItem('selectedProject'),'A project');
  assert.equal(b.window.localStorage.getItem('selectedProject'),'B project');
  assert.equal(a.window.localStorage.length,1);
  assert.deepEqual(Object.keys(a.window.localStorage),['selectedProject']);
  a.window.localStorage.clear();
  assert.equal(backing.getItem('selectedProject'),'Mac project');
  assert.equal(b.window.localStorage.getItem('selectedProject'),'B project');
});
test('delivers only the matching SSH namespace in storage events',()=>{
  const backing=sharedStorage(),x=fixture(false,backing,'host-a');x.bootstrap();
  const seen=[];x.window.addEventListener('storage',event=>seen.push({key:event.key,own:event.storageArea===x.window.localStorage}));
  x.emitStorage({storageArea:backing,key:'selectedProject'});
  x.emitStorage({storageArea:backing,key:'gravrelay:host-b:selectedProject'});
  x.emitStorage({storageArea:backing,key:'gravrelay:host-a:selectedProject'});
  assert.equal(seen.length,1);assert.deepEqual(seen[0],{key:'selectedProject',own:true});
});
