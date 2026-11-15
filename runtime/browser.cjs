function installRemoteBrowser() {
  if (window === window.top) return;
  const host = new URL(location.href).searchParams.get('__gravrelay_ssh');
  if (!host || globalThis.__gravRelayCLIFrontend?.host !== host || globalThis.__gravRelayRemoteBrowser) return;
  const origin = location.origin, pending = new Map(), entries = new Map(), patches = new Map();
  const subscribers = new Map(); let sequence = Date.now(), disposed = false, activeRegistry;
  function request(operation, tabKey, args = {}) {
    if (disposed) return Promise.reject(new Error('The SSH browser view has closed.'));
    return new Promise((resolve,reject) => {
      const id = ++sequence, timer = setTimeout(()=>{pending.delete(id);reject(new Error('The SSH browser request timed out.'));},operation==='acquire'?60000:20000);
      pending.set(id,{resolve,reject,timer});
      window.parent.postMessage({type:'agy-ssh-browser-request',host,id,operation,tabKey,...args},origin);
    });
  }
  function receive(event) {
    const value=event.data;
    if(event.source!==window.parent || event.origin!==origin || value?.type!=='agy-ssh-browser-response' || value.host!==host) return;
    const item=pending.get(value.id);if(!item)return;pending.delete(value.id);clearTimeout(item.timer);
    value.ok ? item.resolve(value.data) : item.reject(new Error(value.error || 'The remote browser request failed.'));
  }
  window.addEventListener('message',receive);
  function subscribe(name,callback){let set=subscribers.get(name);if(!set){set=new Set();subscribers.set(name,set);}set.add(callback);return()=>set.delete(callback);}
  function emit(name,event){for(const callback of subscribers.get(name)||[])try{callback(event);}catch{}}
  function modifiers(event){return(event.altKey?1:0)|(event.ctrlKey?2:0)|(event.metaKey?4:0)|(event.shiftKey?8:0);}
  function surface(entry) {
    if(entry.element)return entry.element;
    const element=document.createElement('div'),canvas=document.createElement('canvas'),input=document.createElement('textarea'),status=document.createElement('div');
    element.dataset.gravrelayBrowserSurface='';element.dataset.tabKey=entry.key;
    element.style.cssText='position:fixed;z-index:3;overflow:hidden;background:var(--background,#161616);display:none';
    canvas.tabIndex=0;canvas.setAttribute('aria-label','Remote browser on '+host);canvas.setAttribute('role','application');
    canvas.style.cssText='display:block;width:100%;height:100%;outline:none;touch-action:none';
    status.setAttribute('role','status');status.style.cssText='position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;background:var(--background,#161616);color:var(--foreground,#ddd);font:13px system-ui';
    input.setAttribute('aria-label','Remote browser keyboard input on '+host);input.tabIndex=-1;input.style.cssText='position:absolute;left:12px;top:12px;width:1px;height:1px;opacity:0;pointer-events:none';
    status.textContent='Connecting to '+host+'…';element.append(canvas,input,status);document.body.append(element);
    entry.element=element;entry.canvas=canvas;entry.status=status;
    const send=(operation,args)=>request(operation,entry.key,args).catch(error=>showError(entry,error));
    function point(event){const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)*(entry.viewport?.width||rect.width)/rect.width,y:(event.clientY-rect.top)*(entry.viewport?.height||rect.height)/rect.height};}
    const button=event=>event.button===2?'right':event.button===1?'middle':'left';
    canvas.addEventListener('pointerdown',event=>{if(!event.isTrusted)return;event.preventDefault();input.focus({preventScroll:true});canvas.setPointerCapture(event.pointerId);send('sendMouse',{params:{type:'mousePressed',...point(event),button:button(event),clickCount:event.detail||1,modifiers:modifiers(event)}});});
    canvas.addEventListener('pointerup',event=>{if(!event.isTrusted)return;event.preventDefault();send('sendMouse',{params:{type:'mouseReleased',...point(event),button:button(event),clickCount:event.detail||1,modifiers:modifiers(event)}});});
    let move;
    canvas.addEventListener('pointermove',event=>{if(!event.isTrusted)return;move={type:'mouseMoved',...point(event),button:event.buttons?button(event):'none',modifiers:modifiers(event)};if(!entry.moveTimer)entry.moveTimer=setTimeout(()=>{entry.moveTimer=null;if(move){send('sendMouse',{params:move});move=null;}},45);});
    canvas.addEventListener('wheel',event=>{if(!event.isTrusted)return;event.preventDefault();send('sendMouse',{params:{type:'mouseWheel',...point(event),deltaX:event.deltaX,deltaY:event.deltaY,modifiers:modifiers(event)}});},{passive:false});
    canvas.addEventListener('contextmenu',event=>event.preventDefault());
    function copySelection(cut=false){return request('control',entry.key,{command:cut?'cut':'copy'}).then(value=>navigator.clipboard.writeText(value.clipboardText||'')).catch(error=>showError(entry,error));}
    input.addEventListener('keydown',event=>{
      if(!event.isTrusted||event.isComposing||event.key==='Process')return;
      const command=(event.metaKey||event.ctrlKey)&&!event.altKey;
      if(event.metaKey&&['q','w',','].includes(event.key.toLowerCase()))return;
      if(command&&event.key.toLowerCase()==='v')return;
      if(command&&['c','x'].includes(event.key.toLowerCase())){event.preventDefault();void copySelection(event.key.toLowerCase()==='x');return;}
      if(event.key.length===1&&!command&&!event.altKey)return;
      event.preventDefault();
      send('sendKey',{params:{type:'rawKeyDown',key:event.key,code:event.code,windowsVirtualKeyCode:event.keyCode,modifiers:(event.metaKey?2:0)|(event.ctrlKey?2:0)|(event.altKey?1:0)|(event.shiftKey?8:0)}});
    });
    input.addEventListener('keyup',event=>{if(!event.isTrusted||event.isComposing||event.key==='Process'||event.key.length===1)return;if(event.metaKey&&['q','w',','].includes(event.key.toLowerCase()))return;event.preventDefault();send('sendKey',{params:{type:'keyUp',key:event.key,code:event.code,windowsVirtualKeyCode:event.keyCode,modifiers:(event.metaKey?2:0)|(event.ctrlKey?2:0)|(event.altKey?1:0)|(event.shiftKey?8:0)}});});
    const insert=()=>{const text=input.value;input.value='';if(text)send('insertText',{text});};
    input.addEventListener('input',event=>{if(event.isTrusted&&!event.isComposing)insert();});
    input.addEventListener('compositionend',event=>{if(event.isTrusted)queueMicrotask(insert);});
    input.addEventListener('paste',event=>{if(!event.isTrusted)return;const text=event.clipboardData?.getData('text/plain');if(text){event.preventDefault();send('insertText',{text});}});
    return element;
  }
  function showError(entry,error){surface(entry);entry.status.textContent=(error?.message||'The remote browser disconnected.')+' Retrying…';entry.status.style.display='flex';}
  function applyBounds(entry,bounds){
    // Native WCV coordinates are clipped for a top-level Electron viewport.
    // This adapter is inside an iframe; its own proxy is the authoritative CSS rectangle.
    const proxy=[...document.querySelectorAll('[data-wcv-tab-key]')].find(element=>element.dataset.wcvTabKey===entry.key);
    const rect=proxy?.getBoundingClientRect();
    if(rect&&rect.width>0&&rect.height>0){
      const left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom);
      bounds={x:left,y:top,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
    }
    if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite))return;
    const element=surface(entry);entry.bounds=bounds;
    Object.assign(element.style,{left:bounds.x+'px',top:bounds.y+'px',width:Math.max(0,bounds.width)+'px',height:Math.max(0,bounds.height)+'px'});
  }
  function update(entry,state,events=[]) {
    const old=entry.state||{};entry.state=state||old;
    for(const event of events)emit('guest',{tabKey:entry.key,...entry.state,...event});
    if(old.title!==entry.state.title)emit('guest',{tabKey:entry.key,type:'page-title-updated',...entry.state});
    if(old.url&&old.url!==entry.state.url&&!events.some(event=>event.type==='did-navigate'))emit('guest',{tabKey:entry.key,type:'did-navigate',...entry.state});
  }
  async function poll(entry) {
    if(disposed||!entry.visible||entry.polling)return;
    entry.polling=true;
    try {
      const value=await request('frame',entry.key,{afterSequence:entry.sequence||0});
      entry.retry=0;entry.viewport=value.viewport;update(entry,value.state,value.events);entry.sequence=value.sequence;
      if(value.image){
        const image=new Image();image.onload=()=>{if(disposed||!entry.visible)return;entry.canvas.width=image.naturalWidth;entry.canvas.height=image.naturalHeight;entry.canvas.getContext('2d')?.drawImage(image,0,0);entry.status.style.display='none';};image.onerror=()=>showError(entry,new Error('The remote browser image could not be decoded.'));image.src='data:image/jpeg;base64,'+value.image;
      } else if(entry.canvas?.width>1)entry.status.style.display='none';
    } catch(error){showError(entry,error);entry.retry=Math.min(8000,(entry.retry||400)*2);}
    finally{entry.polling=false;if(entry.visible&&!disposed)entry.timer=setTimeout(()=>poll(entry),entry.retry||650);}
  }
  const bridge={
    async acquire(value){
      let entry=entries.get(value.tabKey);if(!entry){entry={key:value.tabKey,visible:false};entries.set(value.tabKey,entry);}
      if(!entry.acquiring)entry.acquiring=request('acquire',value.tabKey,{initialUrl:value.initialUrl}).then(state=>{update(entry,state);return state;}).finally(()=>{entry.acquiring=null;});return entry.acquiring;
    },
    async show(key,bounds){
      const entry=entries.get(key);if(!entry)throw new Error('The remote browser tab is not open.');
      entry.visible=true;applyBounds(entry,bounds);entry.element.style.display='block';
      try{if(entry.acquiring)await entry.acquiring;const state=await request('show',key,{boundsCss:entry.bounds||bounds});update(entry,state);clearTimeout(entry.timer);void poll(entry);return state;}
      catch(error){showError(entry,error);clearTimeout(entry.timer);entry.timer=setTimeout(()=>poll(entry),1000);throw error;}
    },
    async hide(key){const entry=entries.get(key);if(entry){entry.visible=false;clearTimeout(entry.timer);if(entry.element)entry.element.style.display='none';}return request('hide',key).catch(()=>true);},
    setBoundsSync(key,bounds){const entry=entries.get(key);if(!entry)return;applyBounds(entry,bounds);clearTimeout(entry.boundsTimer);entry.boundsTimer=setTimeout(()=>{if(entry.visible)Promise.resolve(entry.acquiring).then(()=>request('show',key,{boundsCss:entry.bounds||bounds})).catch(error=>showError(entry,error));},140);},
    async navigate(key,url){const state=await request('navigate',key,{url});const entry=entries.get(key);if(entry)update(entry,state);return state;},
    async control(key,command){if(command==='paste'){const text=await navigator.clipboard.readText();return request('insertText',key,{text});}const state=await request('control',key,{command});if(typeof state.clipboardText==='string')await navigator.clipboard.writeText(state.clipboardText);const entry=entries.get(key);if(entry)update(entry,state);return state;},
    async sendMouse(key,params){
      const type={mouseDown:'mousePressed',mouseUp:'mouseReleased',mouseMove:'mouseMoved',mouseWheel:'mouseWheel'}[params.type]||params.type;
      return request('sendMouse',key,{params:{...params,type}});
    },
    sendKey:(key,params)=>request('sendKey',key,{params}),insertText:(key,text)=>request('insertText',key,{text}),
    setViewportSize:(key,size)=>request('setViewportSize',key,{size}),capturePage:key=>request('capturePage',key),
    async dispose(key){const entry=entries.get(key);if(entry){entry.visible=false;clearTimeout(entry.timer);clearTimeout(entry.boundsTimer);clearTimeout(entry.moveTimer);entry.element?.remove();entries.delete(key);}return request('dispose',key).catch(()=>true);},
    setThemeColor:async()=>true,setPinned:async()=>true,
    setAgentControlling:async(key,active)=>{if(active)throw new Error('Native agent browser automation is not available for this SSH surface.');return{...(entries.get(key)?.state||{}),zOrder:0,isAgentStepActive:false};},
    setOverlayActive:async(key,active)=>{const element=entries.get(key)?.element;if(element)element.style.pointerEvents=active?'none':'';return true;},
    setPortalOverlayOpen:async open=>{for(const entry of entries.values())if(entry.element)entry.element.style.pointerEvents=open?'none':'';return true;},
    setDragOver:async()=>true,elevate:async()=>({zOrder:0,isAgentStepActive:false}),demote:async()=>({zOrder:0,isAgentStepActive:false}),
    onGuestEvent:callback=>subscribe('guest',callback),onZOrderChanged:callback=>subscribe('zorder',callback),onShortcutForwarded:callback=>subscribe('shortcut',callback),onCursorChanged:callback=>subscribe('cursor',callback),
  };
  function provider(){const element=document.querySelector('[data-testid="sidebar-split"]');const key=Object.keys(element||{}).find(key=>key.startsWith('__reactFiber'));for(let fiber=element?.[key],n=0;fiber&&n<400;fiber=fiber.return,n++){const value=fiber.memoizedProps?.value;if(typeof value?.get==='function'&&typeof value.getCache?.set==='function'&&Array.isArray(value.featureNames))return value;}}
  function nativeBrowser(features){
    const spec=features.config?.browserAuxPane;
    for(const value of [spec?.feature,...(spec?.applyAll||[]).map(rule=>rule.feature),...(spec?.applyFirst||[]).map(rule=>rule.feature)])if(value?.engine==='webview'&&typeof value.content==='function')return value;
    return null;
  }
  function patch(features=provider()){
    if(!features||typeof features.get!=='function'||typeof features.getCache?.set!=='function'||patches.has(features))return;
    const pane=nativeBrowser(features);if(!pane)return;
    const values={browserAuxPane:pane,browserSubagentWebviewUx:true,browserSubagentWebview:false,browserElementPicker:{enabled:false},browserSubagentWebviewScript:{enabled:false,webmcpEnabled:false},electronNativeFeature:{wcvBrowser:bridge}};
    const previous={};for(const [name,value]of Object.entries(values)){previous[name]=features.get(name);features.getCache.set(name,value);}patches.set(features,{previous,applied:values});
  }
  function synchronize(){
    const registry=window.__gravRelayNativeFeatures;
    if(registry){
      if(registry.ready!==true)return;
      if(activeRegistry!==registry){activeRegistry?.unregister('browser');activeRegistry=registry;registry.register('browser',patch);}
    }else if(globalThis.__gravRelayBrowserDevelopment===true)patch();
  }
  const timer=setInterval(synchronize,350);synchronize();
  globalThis.__gravRelayRemoteBrowser={host,bridge,patch,dispose(){
    disposed=true;clearInterval(timer);activeRegistry?.unregister('browser');activeRegistry=undefined;window.removeEventListener('message',receive);
    for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('The SSH browser view has closed.'));}pending.clear();
    for(const entry of entries.values()){clearTimeout(entry.timer);clearTimeout(entry.boundsTimer);clearTimeout(entry.moveTimer);entry.element?.remove();}entries.clear();
    for(const [features,{previous,applied}]of patches)for(const [name,value]of Object.entries(previous))if(features.getCache.get(name)===applied[name])features.getCache.set(name,value);patches.clear();delete globalThis.__gravRelayRemoteBrowser;
  }};
}
module.exports=installRemoteBrowser;
