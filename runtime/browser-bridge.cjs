'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const HOST = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const KEY = /^builtin-browser:[A-Za-z0-9_.:-]{1,240}$/;
const ALLOWED_OPERATIONS = new Set(['acquire', 'show', 'hide', 'frame', 'navigate', 'control', 'sendMouse', 'sendKey', 'insertText', 'setViewportSize', 'capturePage', 'dispose']);

function browserURL(value) {
  if (value === 'about:blank') return value;
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid browser URL.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP and HTTPS browser addresses are supported.');
  return url.href;
}
function endpointURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port) || Number(url.port) < 1024 || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('The browser connection must use its verified local SSH entrance.');
  return url;
}
function viewport(value) {
  return {width: Math.max(320, Math.min(1920, Math.round(Number(value?.width) || 1024))), height: Math.max(200, Math.min(1400, Math.round(Number(value?.height) || 768)))};
}

class BrowserCDP {
  constructor(url) {
    this.pending = new Map(); this.listeners = new Map(); this.sequence = 0; this.closed = false;
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      const timeout=setTimeout(()=>{this.closed=true;try{this.socket.close();}catch{}reject(new Error('The remote browser connection timed out.'));},10000);
      this.socket.addEventListener('open', ()=>{clearTimeout(timeout);resolve();}, {once:true});
      this.socket.addEventListener('error', () => {clearTimeout(timeout);this.closed=true;try{this.socket.close();}catch{}reject(new Error('The remote browser could not be reached.'));}, {once:true});
      this.socket.addEventListener('close',()=>{clearTimeout(timeout);reject(new Error('The remote browser connection closed.'));},{once:true});
    });
    this.socket.addEventListener('message', event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id) {
        const item = this.pending.get(message.id); if (!item) return;
        this.pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error.message || 'Remote browser command failed.')) : item.resolve(message.result || {});
      } else for (const callback of this.listeners.get(message.method) || []) callback(message.params || {});
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('The remote browser connection closed.')); }
      this.pending.clear();
    });
  }
  on(method, callback) { const listeners = this.listeners.get(method) || new Set(); listeners.add(callback); this.listeners.set(method,listeners); return () => listeners.delete(callback); }
  async send(method, params = {}, timeout = 12000) {
    await this.ready; if (this.closed) throw new Error('The remote browser connection closed.');
    const id = ++this.sequence;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The remote browser request timed out.')); }, timeout);
      this.pending.set(id,{resolve,reject,timer}); this.socket.send(JSON.stringify({id,method,params}));
    });
  }
  close() { this.socket.close(); }
}

function createBrowserBridge({ensureEndpoint, CDP = BrowserCDP, fetch: fetcher = globalThis.fetch, stateFile} = {}) {
  if (typeof ensureEndpoint !== 'function') throw new TypeError('A verified SSH browser endpoint factory is required.');
  const entries = new Map(), opening = new Map(), saved = new Map(); let nextWebContentsId = 1000000000;
  const idFor = (host,key) => host + '\n' + key;
  function checkedStateFile() {
    if(!stateFile)return;
    if(!path.isAbsolute(stateFile))throw new Error('The browser state path must be absolute.');
    const parent=path.dirname(stateFile);fs.mkdirSync(parent,{recursive:true,mode:0o700});
    const directory=fs.lstatSync(parent);
    if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid()||(directory.mode&0o077))throw new Error('The browser state directory must be private and user-owned.');
    if(fs.existsSync(stateFile)||(()=>{try{fs.lstatSync(stateFile);return true;}catch{return false;}})()){
      const info=fs.lstatSync(stateFile);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)||info.nlink!==1)throw new Error('Unsafe browser state file.');
    }
  }
  function persist() {
    if(!stateFile)return;checkedStateFile();
    const temporary=stateFile+'.'+randomUUID();
    try {fs.writeFileSync(temporary,JSON.stringify({schema:1,tabs:[...saved.values()]}),{flag:'wx',mode:0o600});fs.renameSync(temporary,stateFile);}
    finally {try{fs.unlinkSync(temporary);}catch{}}
  }
  let stateLoaded=false;
  function loadState(){
    if(stateLoaded)return;
    if(stateFile){
    checkedStateFile();
    if(fs.existsSync(stateFile)){
      if(fs.statSync(stateFile).size>128*1024)throw new Error('The browser state file is too large.');
      let state;try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{throw new Error('The saved SSH browser tab list could not be read.');}
      if(state.schema!==1||!Array.isArray(state.tabs)||state.tabs.length>128)throw new Error('Invalid browser state file.');
      for(const record of state.tabs){
        if(!HOST.test(record.host||'')||!KEY.test(record.tabKey||'')||!/^[A-Za-z0-9_-]{1,160}$/.test(record.targetId||'')||!/^[A-Za-z0-9_-]{8,160}$/.test(record.browserUUID||'')||!Number.isInteger(record.webContentsId)||record.webContentsId<1000000001||record.webContentsId>2147483647)throw new Error('Invalid saved browser tab identity.');
        const id=idFor(record.host,record.tabKey);if(saved.has(id))throw new Error('Duplicate saved browser tab identity.');
        saved.set(id,{host:record.host,tabKey:record.tabKey,targetId:record.targetId,browserUUID:record.browserUUID,webContentsId:record.webContentsId});nextWebContentsId=Math.max(nextWebContentsId,record.webContentsId);
      }
    }
  }
    stateLoaded=true;
  }
  async function browserIdentity(endpoint){
    const version=await json(endpoint,'/json/version'),url=new URL(version.webSocketDebuggerUrl||'');
    const match=url.pathname.match(/^\/devtools\/browser\/([A-Za-z0-9_-]{8,160})$/);if(!match)throw new Error('Invalid remote browser identity.');return match[1];
  }
  function identityError(message,code){const error=new Error(message);error.code=code;return error;}
  const snapshot = entry => ({webContentsId:entry.webContentsId,url:entry.url,title:entry.title,isLoading:entry.loading,canGoBack:entry.canGoBack,canGoForward:entry.canGoForward,zOrder:0,isAgentStepActive:false});
  async function json(endpoint, path, options) {
    const response = await fetcher(new URL(path,endpoint),{...options,redirect:'error',signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error('The remote browser endpoint rejected the request.');
    return response.json();
  }
  async function connect(entry) {
    const endpoint = endpointURL(await ensureEndpoint(entry.host));
    if(await browserIdentity(endpoint)!==entry.browserUUID)throw identityError('The remote browser has restarted. Reopen this browser tab.','BROWSER_RESTARTED');
    // Only reconnect a target ID created by this bridge, never choose an arbitrary existing tab.
    const targets = await json(endpoint, '/json/list');
    const target = targets.find(target => target.id === entry.targetId && target.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw identityError('This remote browser tab has closed. Open a new browser tab.','TARGET_CLOSED');
    const remote = new URL(target.webSocketDebuggerUrl);
    if (!/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(remote.pathname)) throw new Error('Invalid remote browser tab endpoint.');
    const ws = new URL(endpoint); ws.protocol = 'ws:'; ws.pathname = remote.pathname;
    const cdp = new CDP(ws.href); await cdp.ready; entry.cdp = cdp; entry.casting = false; entry.endpoint = endpoint;
    cdp.on('Page.frameNavigated', ({frame}) => { if (!frame?.parentId && frame?.url) { entry.mainFrameId=frame.id;entry.url=frame.url;entry.loading=true;entry.dirty=true;entry.frame=null;entry.events.push({type:'did-navigate',url:entry.url}); } });
    cdp.on('Page.frameStartedLoading', () => { entry.loading = true; entry.events.push({type:'did-start-loading'}); });
    cdp.on('Page.loadEventFired', () => { entry.loading=false;entry.dirty=true;entry.frame=null;entry.events.push({type:'did-stop-loading'}); });
    cdp.on('Page.screencastFrame', frame => {
      if (typeof frame.data === 'string' && frame.data.length <= 4*1024*1024) { entry.frame = frame.data; entry.frameSequence++; entry.frameMetadata=frame.metadata||{};entry.lastFrameAt=Date.now();if(!entry.loading)entry.dirty=false; }
      cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId}).catch(()=>{});
    });
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride',{...entry.viewport,deviceScaleFactor:1,mobile:false});
    if (entry.visible) await start(entry);
    return cdp;
  }
  async function client(entry) {
    if (entry.cdp && !entry.cdp.closed) return entry.cdp;
    if (!entry.connecting) entry.connecting=connect(entry).finally(()=>{entry.connecting=null;});
    return entry.connecting;
  }
  async function start(entry) {
    const cdp = entry.cdp; if (!cdp || cdp.closed || entry.casting) return;
    await cdp.send('Page.startScreencast',{format:'jpeg',quality:70,maxWidth:1600,maxHeight:1200,everyNthFrame:1}); entry.casting = true;
  }
  async function state(entry) {
    const cdp = await client(entry), history = await cdp.send('Page.getNavigationHistory');
    const current = history.entries?.[history.currentIndex];
    if (current) { entry.url = current.url; entry.title = current.title || ''; }
    entry.canGoBack = history.currentIndex > 0; entry.canGoForward = history.currentIndex < (history.entries?.length || 0)-1;
    return snapshot(entry);
  }
  async function acquire(host,request) {
    const id = idFor(host,request.tabKey);
    if(entries.has(id)) {
      const entry=entries.get(id);
      try {await client(entry);return state(entry);}
      catch(error){if(!['BROWSER_RESTARTED','TARGET_CLOSED'].includes(error.code))throw error;entry.cdp?.close();entries.delete(id);saved.delete(id);persist();}
    }
    if (opening.has(id)) return opening.get(id);
    if(!saved.has(id)&&saved.size>=128)throw new Error('Close an existing SSH browser tab before opening another.');
    const promise = (async()=>{
      const initialUrl = browserURL(request.initialUrl || 'about:blank'), endpoint = endpointURL(await ensureEndpoint(host));
      const browserUUID=await browserIdentity(endpoint),record=saved.get(id);
      let target;
      if(record?.browserUUID===browserUUID){
        const targets=await json(endpoint,'/json/list');target=targets.find(value=>value.id===record.targetId&&value.type==='page');
      }
      const restored=!!target;
      if(!target)target=await json(endpoint,'/json/new?about:blank',{method:'PUT'});
      if (typeof target.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(target.id)) throw new Error('Invalid remote browser tab identity.');
      const entry={host,tabKey:request.tabKey,targetId:target.id,browserUUID,webContentsId:restored?record.webContentsId:++nextWebContentsId,url:'about:blank',title:'',loading:false,canGoBack:false,canGoForward:false,visible:false,casting:false,viewport:viewport(),frameSequence:0,frame:null,events:[],nonce:randomUUID()};
      saved.set(id,{host,tabKey:entry.tabKey,targetId:entry.targetId,browserUUID,webContentsId:entry.webContentsId});persist();
      entries.set(id,entry); const cdp=await connect(entry); if (!restored&&initialUrl!=='about:blank') { entry.loading=true; await cdp.send('Page.navigate',{url:initialUrl}); }
      return state(entry);
    })().finally(()=>opening.delete(id)); opening.set(id,promise); return promise;
  }
  async function handle(host,request) {
    if (!HOST.test(host) || !request || !KEY.test(request.tabKey || '') || !ALLOWED_OPERATIONS.has(request.operation)) throw new Error('Invalid SSH browser request.');
    loadState();
    if (request.operation === 'acquire') return acquire(host,request);
    const entry = entries.get(idFor(host,request.tabKey)); if (!entry) throw new Error('The remote browser tab is not open.');
    const cdp = await client(entry);
    switch(request.operation) {
      case 'show': {
        entry.visible=true; const size=viewport(request.boundsCss);
        if (size.width!==entry.viewport.width || size.height!==entry.viewport.height) { entry.viewport=size; await cdp.send('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:false}); }
        await start(entry); return state(entry);
      }
      case 'hide': entry.visible=false; if(entry.casting){await cdp.send('Page.stopScreencast');entry.casting=false;} return true;
      case 'frame': {
        const value=await state(entry),events=entry.events.splice(0,128);if(entry.events.length>256)entry.events=[];
        if(entry.visible&&!entry.casting)await start(entry);
        if(entry.visible&&(entry.dirty||!entry.frame||Date.now()-(entry.lastFrameAt||0)>2000)){const image=await cdp.send('Page.captureScreenshot',{format:'jpeg',quality:70,fromSurface:true,captureBeyondViewport:false});entry.frame=image.data;entry.frameSequence++;entry.lastFrameAt=Date.now();entry.dirty=false;}
        const changed=entry.frameSequence>(Number(request.afterSequence)||0);
        return {state:value,events,sequence:entry.frameSequence,image:changed||!request.afterSequence?entry.frame:undefined,viewport:entry.viewport};
      }
      case 'navigate': entry.loading=true;entry.dirty=true;entry.frame=null;await cdp.send('Page.navigate',{url:browserURL(request.url)});return state(entry);
      case 'control': {
        const action=request.command;
        if(action==='back'||action==='forward') { const h=await cdp.send('Page.getNavigationHistory');const target=h.entries?.[h.currentIndex+(action==='back'?-1:1)]; if(target)await cdp.send('Page.navigateToHistoryEntry',{entryId:target.id}); }
        else if(action==='reload')await cdp.send('Page.reload');
        else if(action==='stop')await cdp.send('Page.stopLoading');
        else if(action==='selectAll'){await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});}
        else if(action==='mute'||action==='unmute'){
          await cdp.send('Runtime.evaluate',{expression:"document.querySelectorAll('video,audio').forEach(element=>{element.muted="+(action==='mute'?'true':'false')+"})",returnByValue:true});
        }
        else if(action==='copy'||action==='cut') {
          const selected=await cdp.send('Runtime.evaluate',{expression: "(()=>{const e=document.activeElement;if(e instanceof HTMLInputElement&&e.type==='password')return '';if(e&&typeof e.value==='string'&&typeof e.selectionStart==='number')return e.value.slice(e.selectionStart,e.selectionEnd);return String(window.getSelection()||'')})()",returnByValue:true});
          const clipboardText=selected.result?.value;
          if(typeof clipboardText!=='string'||clipboardText.length>1024*1024)throw new Error('The remote browser selection could not be copied.');
          if(action==='cut'){await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'x',code:'KeyX',windowsVirtualKeyCode:88,modifiers:2});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'x',code:'KeyX',windowsVirtualKeyCode:88,modifiers:2});}
          return {...await state(entry),clipboardText};
        }
        else throw new Error('This browser control is not supported over SSH.');
        return state(entry);
      }
      case 'sendMouse': {
        const p=request.params||{},types=new Set(['mousePressed','mouseReleased','mouseMoved','mouseWheel']);if(!types.has(p.type))throw new Error('Invalid mouse input.');
        const input={type:p.type,x:Math.max(0,Math.min(entry.viewport.width,Number(p.x)||0)),y:Math.max(0,Math.min(entry.viewport.height,Number(p.y)||0)),modifiers:(Number(p.modifiers)||0)&15};
        if(['left','right','middle','none'].includes(p.button))input.button=p.button;
        if(p.type==='mousePressed'||p.type==='mouseReleased')input.clickCount=Math.max(1,Math.min(3,Number(p.clickCount)||1));
        if(p.type==='mouseWheel'){input.deltaX=Math.max(-5000,Math.min(5000,Number(p.deltaX)||0));input.deltaY=Math.max(-5000,Math.min(5000,Number(p.deltaY)||0));}
        await cdp.send('Input.dispatchMouseEvent',input); return true;
      }
      case 'sendKey': {
        const p=request.params||{};if(!['keyDown','rawKeyDown','keyUp','char'].includes(p.type))throw new Error('Invalid keyboard input.');
        const input={type:p.type,modifiers:(Number(p.modifiers)||0)&15};for(const field of ['key','code','text','unmodifiedText'])if(typeof p[field]==='string'&&p[field].length<=128)input[field]=p[field];
        for(const field of ['windowsVirtualKeyCode','nativeVirtualKeyCode'])if(Number.isInteger(p[field])&&p[field]>=0&&p[field]<=65535)input[field]=p[field];
        await cdp.send('Input.dispatchKeyEvent',input);return true;
      }
      case 'insertText': if(typeof request.text!=='string'||request.text.length>65536)throw new Error('Invalid browser text input.');await cdp.send('Input.insertText',{text:request.text});return true;
      case 'setViewportSize': {const size=viewport(request.size);entry.viewport=size;await cdp.send('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:false});return true;}
      case 'capturePage': return (await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false})).data;
      case 'dispose': {
        // /json/close is restricted to this bridge-owned target, even if other Chrome tabs share the profile.
        try { await fetcher(new URL('/json/close/'+entry.targetId,entry.endpoint),{redirect:'error',signal:AbortSignal.timeout(8000)}); }
        finally { entry.cdp?.close();entries.delete(idFor(host,request.tabKey));saved.delete(idFor(host,request.tabKey));persist(); }
        return true;
      }
    }
  }
  return {handle, async disposeHost(host) {for(const entry of [...entries.values()])if(entry.host===host)await handle(host,{operation:'dispose',tabKey:entry.tabKey}).catch(()=>{});}, close(){for(const entry of entries.values())entry.cdp?.close();entries.clear();}, ownedTabCount:()=>entries.size};
}
module.exports={createBrowserBridge,BrowserCDP,browserURL,endpointURL,viewport,ALLOWED_OPERATIONS};
