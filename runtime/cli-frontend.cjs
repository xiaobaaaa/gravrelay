function installCLIFrontend() {
  if (window === window.top) return;
  const key = '__gravrelay_ssh';
  const host = new URL(location.href).searchParams.get(key);
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(host) || globalThis.__gravRelayCLIFrontend) return;
  globalThis.__gravRelayCLIFrontend = { host, requests: 0, ready: false };
  // Each SSH frontend shares local assets with the Mac, but owns its UI state.
  const areas = new Map();
  for (const name of ['localStorage', 'sessionStorage']) {
    const storage = window[name];
    if (!storage) continue;
    const prefix = 'gravrelay:' + host + ':';
    const keys = () => Array.from({ length: storage.length }, (_, i) => storage.key(i))
      .filter(key => typeof key === 'string' && key.startsWith(prefix)).map(key => key.slice(prefix.length));
    const methods = {
      getItem: key => storage.getItem(prefix + String(key)),
      setItem: (key, value) => storage.setItem(prefix + String(key), String(value)),
      removeItem: key => storage.removeItem(prefix + String(key)),
      clear: () => { for (const key of keys()) storage.removeItem(prefix + key); },
      key: index => keys()[index] ?? null,
    };
    const scoped = new Proxy(storage, {
      get(target, key) {
        if (key === 'length') return keys().length;
        if (Object.hasOwn(methods, key)) return methods[key];
        if (typeof key === 'symbol') return Reflect.get(target, key, target);
        return methods.getItem(key) ?? undefined;
      },
      set(target, key, value) { methods.setItem(key, value); return true; },
      deleteProperty(target, key) { methods.removeItem(key); return true; },
      ownKeys: keys,
      getOwnPropertyDescriptor(target, key) {
        const value = methods.getItem(key);
        return value === null ? undefined : { value, configurable: true, enumerable: true, writable: true };
      },
    });
    Object.defineProperty(window, name, { configurable: true, get: () => scoped });
    areas.set(storage, { prefix, scoped });
  }
  if (areas.size) {
    const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
    const listeners = new WeakMap();
    function wrapper(listener, options) {
      if (!listener || !['function', 'object'].includes(typeof listener)) return listener;
      const capture = typeof options === 'boolean' ? options : options?.capture === true;
      let captures = listeners.get(listener);
      if (!captures) { captures = new Map(); listeners.set(listener, captures); }
      if (!captures.has(capture)) captures.set(capture, event => {
        const area = areas.get(event.storageArea);
        if (!area || typeof event.key !== 'string' || !event.key.startsWith(area.prefix)) return;
        const scoped = new Proxy(event, { get(target, key) {
          if (key === 'key') return target.key.slice(area.prefix.length);
          if (key === 'storageArea') return area.scoped;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        if (typeof listener === 'function') listener.call(window, scoped);
        else listener.handleEvent?.(scoped);
      });
      return captures.get(capture);
    }
    window.addEventListener = (type, listener, options) => add(type, type === 'storage' ? wrapper(listener, options) : listener, options);
    window.removeEventListener = (type, listener, options) => remove(type, type === 'storage' ? wrapper(listener, options) : listener, options);
  }
  const parentOrigin = location.origin;
  let resolve, reject;
  const settings = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timeout = setTimeout(() => { clearInterval(retry); window.removeEventListener('message', receive); reject(new Error('The remote CLI connection is not ready.')); }, 45000);
  settings.catch(() => {});
  function receive(event) {
    const value = event.data;
    if (event.source !== window.parent || event.origin !== parentOrigin || value?.type !== 'agy-ssh-cli-bootstrap' || value.host !== host) return;
    let url;
    try { url = new URL(value.rpcOrigin); } catch { return; }
    if (url.protocol !== 'https:' || url.hostname !== 'localhost' || url.username || url.password ||
        url.pathname !== '/' || !/^\d+$/.test(url.port) || Number(url.port) < 1024 ||
        typeof value.csrf !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.csrf)) return;
    clearTimeout(timeout);
    clearInterval(retry);
    window.removeEventListener('message', receive);
    globalThis.__gravRelayCLIFrontend.ready = true;
    resolve({ origin: url.origin, csrf: value.csrf });
  }
  window.addEventListener('message', receive);
  const announce = () => window.parent.postMessage({ type: 'agy-ssh-cli-bootstrap-request', host }, parentOrigin);
  const retry = setInterval(announce, 150);
  announce();
  const fetch = window.fetch.bind(window);
  const jsonUnaryMethods = new Set(['JetboxWriteState', 'UpdateConversationAnnotations', 'UpdateProject']);
  function grpcFrame(flags, bytes) {
    const frame = new Uint8Array(bytes.length + 5);
    frame[0] = flags;
    new DataView(frame.buffer).setUint32(1, bytes.length);
    frame.set(bytes, 5);
    return frame;
  }
  async function jsonUnary(config, url, request, headers, body) {
    const bytes = new Uint8Array(body);
    if (bytes.length < 5 || bytes[0] !== 0 ||
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1) !== bytes.length - 5)
      throw new Error('Unsupported unary RPC framing.');
    const payload = bytes.slice(5);
    headers.set('Content-Type', 'application/json');
    headers.set('Connect-Protocol-Version', '1');
    headers.delete('X-Grpc-Web');
    const response = await fetch(config.origin + url.pathname + url.search, {
      method: request.method, headers, body: payload, signal: request.signal,
      credentials: 'omit', mode: 'cors', redirect: 'error',
    });
    const text = await response.text();
    const codes = { canceled: 1, unknown: 2, invalid_argument: 3, deadline_exceeded: 4,
      not_found: 5, already_exists: 6, permission_denied: 7, resource_exhausted: 8,
      failed_precondition: 9, aborted: 10, out_of_range: 11, unimplemented: 12,
      internal: 13, unavailable: 14, data_loss: 15, unauthenticated: 16 };
    let status = 0, message = '', data = text || '{}';
    if (!response.ok) {
      let error;
      try { error = JSON.parse(text); } catch { error = {}; }
      status = codes[error.code] ?? (response.status === 401 ? 16 : response.status === 403 ? 7 : 2);
      message = error.message || 'The remote RPC failed.';
    } else {
      JSON.parse(data);
    }
    const encoder = new TextEncoder();
    const trailers = grpcFrame(128, encoder.encode('grpc-status: ' + status + '\r\n' +
      (message ? 'grpc-message: ' + encodeURIComponent(message) + '\r\n' : '')));
    const result = status ? trailers : (() => {
      const frame = grpcFrame(0, encoder.encode(data));
      const value = new Uint8Array(frame.length + trailers.length);
      value.set(frame); value.set(trailers, frame.length); return value;
    })();
    return new Response(result, { status: 200, headers: { 'Content-Type': 'application/grpc-web+json' } });
  }
  window.fetch = async function(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/exa.')) return fetch(input, init);
    const config = await settings;
    const request = new Request(input instanceof Request ? input : url.href, init);
    const headers = new Headers(request.headers);
    headers.set('X-Codeium-Csrf-Token', config.csrf);
    headers.delete('Authorization');
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    globalThis.__gravRelayCLIFrontend.requests++;
    if (jsonUnaryMethods.has(url.pathname.split('/').pop()) &&
        headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/grpc-web+json')
      return jsonUnary(config, url, request, headers, body);
    return fetch(config.origin + url.pathname + url.search, {
      method: request.method, headers, body, signal: request.signal,
      credentials: 'omit', mode: 'cors', redirect: 'error',
    });
  };
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method].bind(history);
    history[method] = (state, unused, address) => {
      if (address != null) {
        const next = new URL(address, location.href);
        if (next.origin === location.origin) { next.searchParams.set(key, host); address = next.href; }
      }
      return original(state, unused, address);
    };
  }
}
module.exports = installCLIFrontend;
