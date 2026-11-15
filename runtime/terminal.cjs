function installNativeTerminal() {
  if (window === window.top) return;
  const host = new URL(location.href).searchParams.get('__gravrelay_ssh');
  if (!host || globalThis.__gravRelayCLIFrontend?.host !== host) return;
  if (globalThis.__gravRelayNativeTerminal?.version === 2) return;
  globalThis.__gravRelayNativeTerminal?.remove?.();
  const changed = new Map(), checks = new Map();
  let queued = false, disposed = false, retry, registry;
  const state = { version: 2, host, status: 'waiting', ready: false };
  const methods = ['useTerminalTheme', 'useTerminalCopyPaste', 'useAutoResize', 'loadTerminal'];
  const rpcMethods = ['listTerminals', 'createTerminal', 'closeTerminal', 'sendTerminalInput', 'streamTerminalOutput'];
  function capabilities(value) { return value && methods.every(name => typeof value[name] === 'function'); }
  function nativeFeature(features) {
    // Reuse this frame's own native React hooks and bundled xterm.
    const definitions = [features.config?.terminalFeature, features.skin?.terminalFeature,
      ...(features.variantFeatures || []).map(value => value?.terminalFeature)];
    for (const definition of definitions) {
      const rules = definition?.applyAll;
      const rule = Array.isArray(rules) ? rules.find(value =>
        value.runtimeGating?.customFlag === 'enable-jetbox-terminal-v2' &&
        capabilities(value.feature?.terminalCapabilities)) : undefined;
      if (rule) return rule.feature;
    }
  }
  function providers() {
    const root = document.querySelector('[data-testid="sidebar-split"]');
    const key = Object.keys(root ?? {}).find(key => key.startsWith('__reactFiber'));
    let features, services;
    for (let fiber = root?.[key], depth = 0; fiber && depth < 400; fiber = fiber.return, depth++) {
      const value = fiber.memoizedProps?.value;
      if (typeof value?.get === 'function' && typeof value.getCache?.set === 'function' &&
          Array.isArray(value.featureNames) && value.featureNames.includes('terminalFeature')) features = value;
      if (value && rpcMethods.every(name => typeof value[name] === 'function')) services = value;
    }
    return { features, services };
  }
  function patch(features) {
    const native = nativeFeature(features);
    if (!native) return false;
    const current = features.get('terminalFeature'), previous = changed.get(features);
    if (previous && current === previous.replacement) return true;
    if (capabilities(current?.terminalCapabilities)) return true;
    const replacement = { ...(current || {}), ...native };
    changed.set(features, { replacement, original: current });
    features.getCache.set('terminalFeature', replacement);
    return true;
  }
  function schedule() { if (!queued && !disposed) { queued = true; queueMicrotask(apply); } }
  async function apply() {
    queued = false;
    if (disposed) return;
    const { features, services } = providers();
    const shared = globalThis.__gravRelayNativeFeatures;
    if (!features || !services || !shared?.ready) return;
    if (registry === shared && state.ready) { state.status = 'ready'; return; }
    if (!nativeFeature(features)) { state.status = 'unsupported'; return; }
    if (checks.get(features)?.services === services) return;
    const check = { services }; checks.set(features, check); state.status = 'checking';
    try {
      // Capability discovery must not create/close a PTY or launch a shell.
      const response = await services.listTerminals({}, { timeoutMs: 10000 });
      if (!Array.isArray(response?.terminals)) throw new Error('Invalid terminal capability response.');
      if (disposed || checks.get(features) !== check) return;
      if (!shared.ready || globalThis.__gravRelayNativeFeatures !== shared) {
        checks.delete(features); state.status = 'waiting'; return;
      }
      if (!shared.register('terminal', patch)) { checks.delete(features); state.status = 'waiting'; return; }
      registry = shared; state.ready = true; state.status = 'ready'; delete state.error;
    } catch (error) {
      if (disposed || checks.get(features) !== check) return;
      state.status = 'unavailable'; state.error = error?.message || 'Remote terminal service unavailable.';
      clearTimeout(retry);
      retry = setTimeout(() => { checks.delete(features); schedule(); }, 10000);
    }
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  state.remove = () => {
    disposed = true; observer.disconnect(); clearTimeout(retry);
    registry?.unregister('terminal');
    for (const [features, value] of changed) {
      if (features.getCache.get('terminalFeature') === value.replacement)
        features.getCache.set('terminalFeature', value.original);
    }
    changed.clear(); checks.clear();
    // The remote CLI owns existing PTYs; removing a UI must preserve them.
    delete globalThis.__gravRelayNativeTerminal;
  };
  globalThis.__gravRelayNativeTerminal = state;
  apply();
}
module.exports = installNativeTerminal;
