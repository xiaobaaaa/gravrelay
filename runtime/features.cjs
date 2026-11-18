function installNativeFeatures(options = {}) {
  if (window === window.top) return;
  const host = new URL(location.href).searchParams.get('__gravrelay_ssh');
  if (!host || globalThis.__gravRelayCLIFrontend?.host !== host) return;
  const symbols = { '2.32.1': 'bna', '2.32.2': 'bna' };
  const symbol = symbols[options.appVersion];
  if (!symbol || options.factorySymbol !== symbol) return;
  if (globalThis.__gravRelayNativeFeatures?.version === 1) return;
  const descriptor = Object.getOwnPropertyDescriptor(window, symbol);
  const original = descriptor?.value;
  if (!descriptor?.writable || typeof original !== 'function') return;
  const source = Function.prototype.toString.call(original);
  if (!source.includes('this.getCache') || !source.includes('baselineRuntimeEnvironment') ||
      !source.includes('runtimeEnvironment')) return;
  const patches = new Map();
  let proxy, frame, disposed = false;
  function manager(value) {
    return typeof value?.get === 'function' && typeof value.getCache?.get === 'function' &&
      typeof value.getCache?.set === 'function' && Array.isArray(value.featureNames) &&
      value.runtimeEnvironment && typeof value.runtimeEnvironment === 'object';
  }
  function ancestors() {
    const root = document.querySelector('[data-testid="sidebar-split"]');
    const key = Object.keys(root ?? {}).find(key => key.startsWith('__reactFiber'));
    const result = [];
    for (let fiber = root?.[key], depth = 0; fiber && depth < 400; fiber = fiber.return, depth++) result.push(fiber);
    return result;
  }
  function revision() {
    const found = [];
    for (const fiber of ancestors()) {
      if (typeof fiber.type !== 'function') continue;
      const text = Function.prototype.toString.call(fiber.type);
      if (!text.includes('new ' + symbol) || !text.includes('baselineRuntimeEnvironment')) continue;
      const candidates = [];
      for (let hook = fiber.memoizedState, depth = 0; hook && depth < 300; hook = hook.next, depth++) {
        if (typeof hook.memoizedState === 'number' && Number.isFinite(hook.memoizedState) &&
            typeof hook.queue?.dispatch === 'function') candidates.push(hook.queue.dispatch);
      }
      if (candidates.length !== 1) return null;
      found.push(candidates[0]);
    }
    return found.length === 1 ? found[0] : null;
  }
  function owned() { return window[symbol] === original || proxy && window[symbol] === proxy; }
  function apply(value) {
    if (!manager(value)) return;
    for (const [name, patch] of [...patches]) {
      try { patch(value); delete api.errors[name]; }
      catch (error) { api.errors[name] = error?.message || 'Native feature adapter failed.'; }
    }
  }
  function wrap() {
    if (proxy && window[symbol] === proxy) return true;
    if (window[symbol] !== original) return false;
    proxy = new Proxy(original, {
      construct(target, args, newTarget) {
        const value = Reflect.construct(target, args, newTarget);
        if (!disposed) apply(value);
        return value;
      },
    });
    window[symbol] = proxy;
    return window[symbol] === proxy;
  }
  function unwrap() { if (proxy && window[symbol] === proxy) window[symbol] = original; }
  function refresh() {
    if (disposed || !owned() || !revision()) return false;
    if (frame !== undefined) return true;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (disposed || !owned()) return;
      const dispatch = revision();
      if (dispatch) dispatch(value => typeof value === 'number' && Number.isFinite(value) ? value + 1 : value);
    });
    return true;
  }
  const api = {
    version: 1, host, appVersion: options.appVersion, factorySymbol: symbol, errors: {},
    get ready() { return !disposed && !!owned() && !!revision(); },
    register(name, patch) {
      if (!api.ready || typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ||
          typeof patch !== 'function' || !wrap()) return false;
      if (patches.get(name) === patch) return true;
      patches.set(name, patch);
      for (const fiber of ancestors()) apply(fiber.memoizedProps?.value);
      refresh(); return true;
    },
    unregister(name) {
      if (!patches.delete(name)) return false;
      delete api.errors[name];
      if (!patches.size) unwrap();
      refresh(); return true;
    },
    refresh,
    remove() {
      if (disposed) return;
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined; patches.clear(); unwrap();
      delete globalThis.__gravRelayNativeFeatures;
    },
  };
  globalThis.__gravRelayNativeFeatures = api;
}
module.exports = installNativeFeatures;
