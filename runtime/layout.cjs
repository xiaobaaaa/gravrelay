function installNativeLayout() {
  if (window === window.top) return;
  const host = new URL(location.href).searchParams.get('__gravrelay_ssh');
  if (!host || globalThis.__gravRelayCLIFrontend?.host !== host ||
      globalThis.__gravRelayNativeLayout?.version === 4) return;
  globalThis.__gravRelayNativeLayout?.remove?.();
  const registry = globalThis.__gravRelayNativeFeatures;
  if (!registry || typeof registry.register !== "function") return;
  let disposed = false, queued = false, registered = false, retry;
  const changed = new Map();
  function patch(features) {
    if (typeof features?.get !== 'function' || typeof features.getCache?.set !== 'function' ||
        !Array.isArray(features.featureNames) || changed.has(features)) return;
    const entries = [];
    for (const [name, flag, field] of [["splitView", "enable-split-view", "enabled"],
        ["auxPaneComponent", "enable-aux-pane-redesign", "redesignEnabled"]]) {
      const rule = features.config?.[name]?.applyAll?.find(rule =>
        rule.runtimeGating?.customFlag === flag && rule.feature?.[field] === true);
      if (!rule) continue;
      const previous = features.get(name);
      if (!previous || previous[field] === true) continue;
      const next = {...previous, ...rule.feature};
      features.getCache.set(name, next);
      entries.push({name, previous, next});
    }
    changed.set(features, entries);
  }

  function apply() {
    queued = false;
    if (disposed) return;
    if (!registered) {
      if (!registry.ready) return;
      registered = registry.register("layout", patch) === true;
      if (!registered) return;
      clearInterval(retry);
    }
    const root = document.querySelector('[data-testid="sidebar-split"]');
    const key = Object.keys(root ?? {}).find(key => key.startsWith('__reactFiber'));
    for (let fiber = root?.[key], depth = 0; fiber && depth < 400; fiber = fiber.return, depth++)
      patch(fiber.memoizedProps?.value);
  }
  const observer = new MutationObserver(() => {
    if (!queued && !disposed) { queued = true; queueMicrotask(apply); }
  });
  observer.observe(document.documentElement, {childList:true, subtree:true});
  globalThis.__gravRelayNativeLayout = {
    version: 4,
    remove() {
      disposed = true; observer.disconnect(); clearInterval(retry);
      registry.unregister("layout");
      for (const [features, entries] of changed)
        for (const value of entries)
          if (features.getCache.get(value.name) === value.next)
            features.getCache.set(value.name, value.previous);
      changed.clear(); delete globalThis.__gravRelayNativeLayout;
    },
  };
  retry = setInterval(() => { if (!registered) apply(); }, 350);
  apply();
}
module.exports = installNativeLayout;
