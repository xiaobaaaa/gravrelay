function installSidebarScrolling() {
  if (window !== window.top || globalThis.__gravRelaySidebarScrolling) return;
  let binding, queued = false, disposed = false, scanFrame;

  function attach(row, heading, host, scroller) {
    if (getComputedStyle(row).position !== 'sticky') return null;
    const changes = new Map();
    let frame, stopped = false;
    function write(element, name, value, priority = '') {
      let entries = changes.get(element);
      if (!entries) { entries = new Map(); changes.set(element, entries); }
      if (!entries.has(name)) entries.set(name, {
        original: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name),
      });
      if (element.style.getPropertyValue(name) !== value || element.style.getPropertyPriority(name) !== priority)
        element.style.setProperty(name, value, priority);
      entries.get(name).written = element.style.getPropertyValue(name);
      entries.get(name).writtenPriority = element.style.getPropertyPriority(name);
    }
    function update() {
      frame = undefined;
      if (stopped || !row.isConnected || !host.isConnected) return;
      // Keep the native virtual item in normal flow. Its measured height still
      // includes SSH rows, so native local rows and the thumb share one range.
      write(row, 'position', 'relative', 'important');
      write(heading, 'position', 'relative');
      write(heading, 'z-index', '11');
      write(heading, 'background-color', 'var(--sidebar, Canvas)');
      // The native virtualizer retains the active section header. Pin only the
      // heading, rather than pinning its entire (potentially very tall) item.
      const offset = scroller.clientHeight > 0
        ? Math.max(0, scroller.getBoundingClientRect().top + scroller.clientTop - row.getBoundingClientRect().top)
        : 0;
      write(heading, 'transform', 'translateY(' + offset + 'px)');
    }
    function schedule() {
      if (!stopped && frame === undefined) frame = requestAnimationFrame(update);
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(row); resize.observe(scroller);
    const styles = new MutationObserver(schedule);
    styles.observe(row, {attributes:true, attributeFilter:['style']});
    scroller.addEventListener('scroll', schedule, {passive:true});
    update();
    return {
      row, heading, host, scroller,
      remove() {
        if (stopped) return;
        stopped = true;
        if (frame !== undefined) cancelAnimationFrame(frame);
        resize.disconnect(); styles.disconnect();
        scroller.removeEventListener('scroll', schedule);
        for (const [element, entries] of changes) for (const [name, value] of entries) {
          if (element.style.getPropertyValue(name) !== value.written ||
              element.style.getPropertyPriority(name) !== value.writtenPriority) continue;
          if (value.original) element.style.setProperty(name, value.original, value.priority);
          else element.style.removeProperty(name);
        }
        changes.clear();
      },
    };
  }
  function scan() {
    queued = false; scanFrame = undefined;
    if (disposed) return;
    const heading = document.querySelector('[data-testid="sidebar-add-project-button"]')?.closest('[data-testid="section-header"]');
    const row = heading?.parentElement;
    const host = row?.querySelector('[data-agy-ssh-projects]');
    const scroller = row?.closest('[data-testid="conversation-list-sidebar"]');
    const valid = row?.matches('[data-index]') && host?.isConnected && !host.hidden && scroller;
    if (valid && binding?.row === row && binding.heading === heading && binding.host === host) return;
    binding?.remove(); binding = undefined;
    if (valid) binding = attach(row, heading, host, scroller);
  }
  const observer = new MutationObserver(() => {
    if (!queued && !disposed) { queued = true; scanFrame = requestAnimationFrame(scan); }
  });
  observer.observe(document.documentElement, {childList:true, subtree:true, attributes:true,
    attributeFilter:['hidden','data-collapsed']});
  globalThis.__gravRelaySidebarScrolling = {
    version: 1,
    get attached() { return !!binding; },
    remove() {
      disposed = true; observer.disconnect();
      if (scanFrame !== undefined) cancelAnimationFrame(scanFrame);
      binding?.remove(); binding = undefined;
      delete globalThis.__gravRelaySidebarScrolling;
    },
  };
  scan();
}
module.exports = installSidebarScrolling;
