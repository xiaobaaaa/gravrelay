function installRemoteFiles() {
  if (window === window.top) return;
  const host = new URL(location.href).searchParams.get('__gravrelay_ssh');
  if (!host || globalThis.__gravRelayCLIFrontend?.host !== host ||
      globalThis.__gravRelayRemoteFiles) return;
  let disposed = false, timer;
  const featuresChanged = new Map(), bars = new Map(), pending = new Set();
  const style = document.createElement('style');
  style.textContent = '[data-gravrelay-file-shell]{position:relative;display:flex!important;flex-direction:column;min-height:0}' +
    '[data-gravrelay-file-shell]>:not([data-gravrelay-file-toolbar]){min-height:0;flex:1}' +
    '[data-gravrelay-file-toolbar]{display:flex;align-items:center;gap:8px;flex:none;min-height:32px;padding:0 10px;border-bottom:1px solid var(--border);background:var(--background);color:var(--secondary-foreground);font-size:12px}' +
    '[data-gravrelay-file-toolbar] button{display:inline-flex;align-items:center;gap:4px;border-radius:6px;padding:3px 7px;color:var(--foreground);white-space:nowrap}' +
    '[data-gravrelay-file-toolbar] button:hover{background:var(--secondary)}' +
    '[data-gravrelay-file-toolbar] button:disabled{opacity:.55;cursor:wait}' +
    '[data-gravrelay-file-status]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:auto}' +
    '[data-gravrelay-file-status][data-error]{color:var(--error)}' +
    '[data-gravrelay-pdf-host]{position:relative;overflow:hidden;display:block!important}' +
    '[data-gravrelay-pdf-host]>:not([data-gravrelay-pdf]){display:none!important}' +
    '[data-gravrelay-pdf]{position:absolute;inset:0;display:flex;flex-direction:column;text-align:left;color:var(--foreground);background:var(--background)}' +
    '[data-gravrelay-pdf-controls]{display:flex;justify-content:center;align-items:center;gap:8px;flex:none;padding:5px;border-bottom:1px solid var(--border);font-size:12px}' +
    '[data-gravrelay-pdf-controls] button{border-radius:5px;padding:3px 7px;background:var(--secondary)}' +
    '[data-gravrelay-pdf-body]{flex:1;min-height:0;overflow:auto;padding:12px;text-align:center}' +
    '[data-gravrelay-pdf-body] canvas{display:block;margin:0 auto;max-width:100%;height:auto;background:white}';
  document.head.append(style);

  function fiber(element) {
    const key = Object.keys(element ?? {}).find(key => key.startsWith('__reactFiber'));
    return element?.[key];
  }
  function providers(doc) {
    let features, reader;
    for (let f = fiber(doc.querySelector('[data-testid="sidebar-split"]')), n = 0;
         f && n < 400; f = f.return, n++) {
      const value = f.memoizedProps?.value;
      if (typeof value?.get === 'function' && typeof value.getCache?.set === 'function' &&
          Array.isArray(value.featureNames)) features = value;
      if (typeof value?.readFile === 'function') reader = value;
    }
    return { features, reader };
  }
  function parentDownload() {
    const download = providers(window.parent.document).features?.get('download');
    if (typeof download?.downloadBlob !== 'function')
      throw new Error('The app download service is not ready. Try again.');
    return download;
  }
  const download = {
    async downloadBlob(blob, name) {
      await parentDownload().downloadBlob(blob, name);
    },
    async downloadText(text, name) {
      await parentDownload().downloadBlob(new Blob([text], {type:'text/plain;charset=utf-8'}), name);
    },
  };
  function patch(features) {
    if (!features || featuresChanged.has(features)) return;
    const previous = { download: features.get('download') };
    featuresChanged.set(features, previous);
    // The CLI skin posts host-download messages to a Google Remote Control host.
    // Our parent is the local app, so use that app's own download service.
    features.getCache.set('download', download);
  }
  function firstElement(f) {
    if (f.stateNode?.nodeType === 1) return f.stateNode;
    for (let child = f.child; child; child = child.sibling) {
      const element = firstElement(child);
      if (element) return element;
    }
  }
  function filePanes() {
    const found = new Map(), root = fiber(document.querySelector('[data-testid="sidebar-split"]'));
    const stack = root ? [root] : [];
    while (stack.length) {
      const current = stack.pop(), props = current.memoizedProps;
      if (typeof props?.fileUri === 'string' && typeof props?.tabId === 'string' &&
          props.tabId.startsWith('file__')) {
        const element = firstElement(current);
        if (element?.isConnected && !element.hasAttribute('data-gravrelay-file-toolbar')) {
          let conversation;
          for (let f = current, n = 0; f && n < 70; f = f.return, n++) {
            const p = f.memoizedProps;
            const candidate = p?.cascadeId ?? p?.conversationId ??
              (p?.treeId?.kind === 'cascadeId' ? p.treeId.cascadeId : undefined);
            if (typeof candidate === 'string' && /^[0-9a-f-]{36}$/i.test(candidate)) {
              conversation = candidate; break;
            }
          }
          conversation ??= location.pathname.match(/^\/c\/([0-9a-f-]{36})$/i)?.[1];
          found.set(element, {uri:props.fileUri, conversation});
        }
      }
      for (let child = current.child; child; child = child.sibling) stack.push(child);
    }
    return found;
  }
  function supportedUri(uri) {
    try { const url = new URL(uri); decodeURIComponent(url.pathname); return url.protocol === 'file:' && !url.host && !url.username && !url.password; }
    catch { return false; }
  }
  function filename(uri) {
    const url = new URL(uri), last = decodeURIComponent(url.pathname.split('/').pop() || 'download');
    return last.replace(/[\u0000-\u001f/\\]/g, '_');
  }
  function makeBar(element) {
    const bar = document.createElement('div');
    bar.setAttribute('data-gravrelay-file-toolbar', '');
    const source = document.createElement('span');
    source.textContent = 'SSH · ' + host;
    source.style.cssText = 'display:inline-flex;align-items:center;gap:5px;white-space:nowrap';
    const globe = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({width:'14',height:'14',viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','aria-hidden':'true'})) globe.setAttribute(key,value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z');
    globe.append(path); source.prepend(globe);
    const status = document.createElement('span'); status.setAttribute('data-gravrelay-file-status', '');
    status.setAttribute('role', 'status');
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = 'Download'; button.setAttribute('aria-label', 'Download remote file to this Mac');
    button.addEventListener('click', async () => {
      if (pending.has(bar)) return;
      const record = bars.get(element);
      if (!record || !supportedUri(record.uri)) return;
      const {uri, conversation} = record;
      pending.add(bar); button.disabled = true; status.removeAttribute('data-error'); status.textContent = 'Downloading…';
      try {
        const reader = providers(document).reader;
        if (!reader) throw new Error('The SSH file service is not ready. Try again.');
        const result = await reader.readFile({uri, conversationId:conversation, userInitiated:true});
        if (!result?.content || typeof result.content.byteLength !== 'number')
          throw new Error('The SSH host did not return file contents.');
        await download.downloadBlob(new Blob([result.content], {type:'application/octet-stream'}), filename(uri));
        status.textContent = '';
      } catch (error) {
        status.textContent = error?.message || 'Download failed. Try again.';
        status.setAttribute('data-error', '');
      } finally { pending.delete(bar); button.disabled = false; }
    });
    bar.append(source, status, button);
    element.setAttribute('data-gravrelay-file-shell', '');
    element.prepend(bar);
    return {bar, source, button};
  }
  function previewPDF(placeholder, {uri, conversation}) {
    let cancelled = false, loading, pdf, task, pageNumber = 1, scale = 1, sequence = 0;
    const viewer = document.createElement('div'); viewer.setAttribute('data-gravrelay-pdf', '');
    const controls = document.createElement('div'); controls.setAttribute('data-gravrelay-pdf-controls', '');
    const body = document.createElement('div'); body.setAttribute('data-gravrelay-pdf-body', '');
    body.setAttribute('role', 'region'); body.setAttribute('aria-label', 'Remote PDF preview');
    const label = document.createElement('span'); label.textContent = 'Loading PDF…';
    const buttons = [];
    function button(text, title, action) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
      b.title = title; b.setAttribute('aria-label', title); b.disabled = true;
      b.onclick = action; buttons.push(b); return b;
    }
    const previous = button('‹', 'Previous page', () => { if (pageNumber > 1) { pageNumber--; render(); } });
    const next = button('›', 'Next page', () => { if (pdf && pageNumber < pdf.numPages) { pageNumber++; render(); } });
    const minus = button('−', 'Zoom out', () => { scale = Math.max(.5, scale - .25); render(); });
    const plus = button('+', 'Zoom in', () => { scale = Math.min(3, scale + .25); render(); });
    controls.append(previous, label, next, minus, plus); viewer.append(controls, body);
    const oldOpacity = placeholder.style.opacity;
    placeholder.style.opacity = '1';
    placeholder.setAttribute('data-gravrelay-pdf-host', ''); placeholder.append(viewer);
    function fail(error) {
      if (cancelled) return;
      label.textContent = 'PDF preview unavailable';
      body.textContent = (error?.message || 'Unable to render this PDF.') + ' Use Download to save a copy.';
    }
    async function render() {
      const current = ++sequence;
      task?.cancel();
      buttons.forEach(b => { b.disabled = true; });
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled || current !== sequence) return;
        const natural = page.getViewport({scale:1});
        const width = Math.max(200, body.clientWidth - 24);
        const viewport = page.getViewport({scale: Math.min(Math.min(2, width / natural.width) * scale, 8192 / natural.width, 8192 / natural.height)});
        if (![viewport.width, viewport.height].every(n => Number.isFinite(n) && n > 0))
          throw new Error('Invalid PDF page dimensions.');
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)), 8192 / viewport.width, 8192 / viewport.height);
        const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', 'PDF page ' + pageNumber);
        canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = viewport.width + 'px'; canvas.style.maxWidth = scale > 1 ? 'none' : '100%';
        body.replaceChildren(canvas);
        task = page.render({canvasContext:canvas.getContext('2d'), viewport, intent:'print',
          transform:ratio === 1 ? undefined : [ratio,0,0,ratio,0,0]});
        await task.promise;
        if (cancelled || current !== sequence) return;
        label.textContent = pageNumber + ' / ' + pdf.numPages;
        previous.disabled = pageNumber === 1; next.disabled = pageNumber === pdf.numPages;
        minus.disabled = scale <= .5; plus.disabled = scale >= 3;
      } catch (error) { if (error?.name !== 'RenderingCancelledException') fail(error); }
    }
    (async () => {
      const reader = providers(document).reader;
      if (!reader) throw new Error('The SSH file service is not ready.');
      const result = await reader.readFile({uri, conversationId:conversation, userInitiated:true});
      if (cancelled) return;
      if (!result?.content || result.content.byteLength > 48 * 1024 * 1024)
        throw new Error('This PDF is too large for inline preview.');
      const library = await import(new URL('/workers/pdf.min.mjs', location.origin).href);
      if (cancelled) return;
      library.GlobalWorkerOptions.workerSrc = new URL('/workers/pdf.worker.mjs', location.origin).href;
      loading = library.getDocument({data:result.content.slice(), isEvalSupported:false});
      pdf = await loading.promise;
      if (cancelled) { pdf.destroy(); return; }
      await render();
    })().catch(fail);
    return {dispose() {
      cancelled = true; sequence++; task?.cancel();
      if (pdf) pdf.destroy(); else loading?.destroy();
      viewer.remove(); placeholder.removeAttribute('data-gravrelay-pdf-host'); placeholder.style.opacity = oldOpacity;
    }};
  }
  function apply() {
    timer = null;
    if (disposed) return;
    patch(providers(document).features);
    const panes = filePanes();
    for (const [element, record] of bars) {
      if (!panes.has(element) || !supportedUri(panes.get(element).uri)) {
        record.preview?.dispose(); record.bar.remove(); element.removeAttribute('data-gravrelay-file-shell'); bars.delete(element);
      }
    }
    for (const [element, item] of panes) {
      if (!supportedUri(item.uri)) continue;
      let record = bars.get(element);
      if (!record) { record = makeBar(element); bars.set(element, record); }
      if (record.uri !== item.uri) { record.preview?.dispose(); record.preview = null; }
      Object.assign(record, item);
      const title = host + ':' + decodeURIComponent(new URL(item.uri).pathname);
      if (record.source.title !== title) record.source.title = title;
      const placeholder = element.querySelector('[data-testid="binary-file-no-preview"],[data-testid="artifact-no-preview"]');
      if (placeholder && /\.pdf$/i.test(new URL(item.uri).pathname) && !record.preview)
        record.preview = previewPDF(placeholder, item);
    }
  }
  const observer = new MutationObserver(() => {
    if (!timer && !disposed) timer = setTimeout(apply, 80);
  });
  function nativeFallbackDownload(event) {
    const button = event.target?.closest?.('button');
    if (!button?.closest('[data-testid="binary-file-no-preview"],[data-testid="artifact-no-preview"]')) return;
    for (const [element, record] of bars) if (element.contains(button)) {
      event.preventDefault(); event.stopImmediatePropagation(); record.button.click(); break;
    }
  }
  document.addEventListener?.('click', nativeFallbackDownload, true);
  observer.observe(document.documentElement, {childList:true, subtree:true});
  globalThis.__gravRelayRemoteFiles = {
    version:1,
    remove() {
      disposed = true; clearTimeout(timer); observer.disconnect(); style.remove();
      document.removeEventListener?.('click', nativeFallbackDownload, true);
      for (const [element, record] of bars) {
        record.preview?.dispose(); record.bar.remove(); element.removeAttribute('data-gravrelay-file-shell');
      }
      bars.clear();
      for (const [features, previous] of featuresChanged) {
        if (features.getCache.get('download') === download) features.getCache.set('download', previous.download);
      }
      delete globalThis.__gravRelayRemoteFiles;
    },
  };
  apply();
}
module.exports = installRemoteFiles;
