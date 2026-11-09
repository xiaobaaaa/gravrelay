function installNativePermissions() {
  if (window === window.top) return;
  const host = new URL(location.href).searchParams.get('__gravrelay_ssh');
  if (!host || globalThis.__gravRelayCLIFrontend?.host !== host) return;
  if (globalThis.__gravRelayNativePermissions?.version === 2) return;
  globalThis.__gravRelayNativePermissions?.remove?.();
  const changed = new Map();
  let queued = false, disposed = false;

  function patch(features) {
    if (typeof features?.get !== 'function' || typeof features.getCache?.set !== 'function' ||
        !Array.isArray(features.featureNames) || !features.runtimeEnvironment) return false;
    const input = features.get('inputComponent');
    if (!input || typeof input.showPermissionsSelector !== 'boolean') return false;
    const previous = changed.get(features);
    if (previous && input === previous.input) return true;
    const originalInput = previous && input === previous.input ? previous.originalInput : input;
    const nextInput = { ...input, showPermissionsSelector: true };
    changed.set(features, { input: nextInput, originalInput });
    features.getCache.set('inputComponent', nextInput);
    return true;
  }

  function apply() {
    queued = false;
    if (disposed) return;
    const root = document.querySelector('[data-testid="sidebar-split"]');
    const key = Object.keys(root ?? {}).find(key => key.startsWith('__reactFiber'));
    for (let fiber = root?.[key], depth = 0; fiber && depth < 400; fiber = fiber.return, depth++) {
      if (patch(fiber.memoizedProps?.value)) return;
    }
  }

  const observer = new MutationObserver(() => {
    if (!queued && !disposed) { queued = true; queueMicrotask(apply); }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  globalThis.__gravRelayNativePermissions = {
    version: 2,
    remove() {
      disposed = true;
      observer.disconnect();
      for (const [features, value] of changed) {
        if (features.getCache.get('inputComponent') === value.input)
          features.getCache.set('inputComponent', value.originalInput);
      }
      changed.clear();
      delete globalThis.__gravRelayNativePermissions;
    },
  };
  apply();
}
module.exports = installNativePermissions;

