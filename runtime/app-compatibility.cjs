function supportedAppVersions(config) {
  const versions = config.supportedAppVersions ?? [config.appVersion];
  if (!Array.isArray(versions) || !versions.length ||
      versions.some(version => typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))) return [];
  return [...new Set(versions)];
}

function isAppVersionSupported(config, version) {
  return supportedAppVersions(config).includes(version);
}

function installCompatibilityNotice(version, supported) {
  const render = () => {
    const id = 'gravrelay-compatibility-notice';
    if (!document.body || globalThis.__gravRelayCompatibilityDismissed === version) return;
    const signature = version + ':' + supported.join(',');
    const previous = document.getElementById(id);
    if (previous?.getAttribute('data-version-signature') === signature) return;
    previous?.remove();
    const box = document.createElement('aside'); box.id = id;
    box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
    box.setAttribute('data-version-signature', signature);
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;max-width:410px;padding:14px;' +
      'z-index:2147483646;border:1px solid var(--border,#666);border-radius:12px;' +
      'background:var(--card,var(--background,#202020));color:var(--foreground,#eee);' +
      'font:13px/1.5 system-ui;box-shadow:0 8px 28px #0004';
    const title = document.createElement('strong'); title.textContent = 'GravRelay update needed';
    const message = document.createElement('p');
    message.textContent = 'Antigravity ' + version + ' is not supported by this GravRelay release. ' +
      'Your saved SSH projects and remote conversations are preserved. Supported versions: ' + supported.join(', ') + '.';
    const link = document.createElement('a'); link.textContent = 'Open GravRelay releases';
    link.href = 'https://github.com/xiaobaaaa/gravrelay/releases/latest';
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.style.textDecoration = 'underline';
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss';
    dismiss.style.cssText = 'margin-left:14px;cursor:pointer';
    dismiss.onclick = () => { globalThis.__gravRelayCompatibilityDismissed = version; box.remove(); };
    box.append(title, message, link, dismiss); document.body.append(box);
  };
  if (document.body) render();
  else document.addEventListener('DOMContentLoaded', render, {once:true});
}

module.exports = {supportedAppVersions, isAppVersionSupported, installCompatibilityNotice};
