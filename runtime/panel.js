(() => {
  if (globalThis.__agyConnectionsInstalled || window !== window.top) return;
  globalThis.__agyConnectionsInstalled = true;

  const pending = new Map();
  const remoteHost = globalThis.__agyConnectionsRemoteHost || "";
  let sequence = 0, snapshot, disposed = false, refreshPending = false;
  let settings, sidebar;
  let scheduled = false;

  const node = (tag, text = "", className = "") => {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  function button(label, action, css = "") {
    const el = node("button", label, css);
    el.type = "button";
    el.addEventListener("click", event => {
      if (event.isTrusted) action(el);
    });
    return el;
  }

  function request(action, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The SSH request timed out."));
      }, action === "open" || action === "create" ? 90000 : 45000);
      pending.set(id, { resolve, reject, timer });
      globalThis.__agyConnectionsBridge(JSON.stringify({ id, action, ...args }));
    });
  }
  globalThis.__agyConnectionsReply = (id, result) => {
    const item = pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(id);
    if (result.ok) item.resolve(result.data);
    else item.reject(new Error(result.error));
  };

  const styles = `
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .content { padding: 24px 28px; max-width: 780px; margin: auto; }
    h2 { margin: 0 0 7px; font-size: 20px; font-weight: 560; }
    p, .muted { font-size: 12px; opacity: .7; }
    p { margin: 0; }
    .stack { display: flex; flex-direction: column; gap: 10px; }
    .row { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .spread { justify-content: space-between; }
    .grow { flex: 1; min-width: 0; }
    .block { margin: 18px 0; }
    .card { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 10px; padding: 0 12px; }
    .host { padding: 12px 0; }
    .host + .host { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
    .host-name { display: block; font-size: 14px; font-weight: 530; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #86868c; margin-right: 5px; }
    .dot.connected { background: #36b96a; }
    .dot.connecting { background: #d6a648; }
    .dot.failed { background: #e16767; }
    .switch { padding: 0; width: 32px; height: 18px; flex-shrink: 0; border: 0; border-radius: 12px;
      background: color-mix(in srgb, currentColor 25%, transparent); position: relative; }
    .switch::after { position: absolute; content: ""; border-radius: 50%; width: 13px; height: 13px;
      background: white; left: 2.5px; top: 2.5px; }
    .switch[aria-checked="true"] { background: #347bea; }
    .switch[aria-checked="true"]::after { left: 16.5px; }
    button, input, select { color: inherit; font: inherit; background: transparent; border-radius: 7px;
      border: 1px solid color-mix(in srgb, currentColor 19%, transparent); padding: 6px 10px; }
    select option { color: CanvasText; background: Canvas; }
    button { cursor: pointer; white-space: nowrap; }
    button:hover:not(:disabled):not(.switch) { background: color-mix(in srgb, currentColor 9%, transparent); }
    button:disabled { opacity: .42; cursor: default; }
    .status { min-height: 18px; font-size: 12px; opacity: .8; }
    .link { border: none; padding-inline: 0; text-align: left; }
    dialog { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 14px;
      padding: 20px; width: min(560px, calc(100vw - 40px)); max-height: 88vh; color: inherit;
      background: var(--background, Canvas); box-shadow: 0 18px 70px #0007; overflow: auto; }
    dialog::backdrop { background: #0007; }
    label { font-size: 13px; font-weight: 520; }
    .sources { padding: 12px; }
    .folder-list { max-height: 155px; overflow: auto; }
    .folder-list button { display: block; text-align: left; width: 100%; border: 0; }
    .paths { font-size: 12px; overflow-wrap: anywhere; }
    .paths .row { margin: 4px 0; }
    .ssh-project { margin: 2px 0; }
    .ssh-project-header { display:flex;align-items:center;gap:4px;min-height:30px;padding:0 7px; }
    .ssh-project-header button, .ssh-conversation, .ssh-show-more { border:0;background:transparent;text-align:left; }
    .ssh-project-toggle { padding:2px 1px;color:inherit;opacity:.75; }
    .ssh-project-name { min-width:0;flex:1;padding:4px 3px;overflow:hidden;text-overflow:ellipsis; }
    .ssh-project-name, .ssh-conversation { font-size:13px; }
    .project-folder-icon { width:17px;height:17px;display:block; }
    .host-globe { width:12px;height:12px;color:var(--host-color);flex:none; }
    .location { display:flex;align-items:center;gap:5px;flex:none;font-size:11px;opacity:.65; }
    .location .dot { width:6px;height:6px;margin:0; }
    .ssh-conversations { padding:0 7px 2px 28px; }
    .ssh-conversation { display:flex;align-items:center;justify-content:space-between;gap:5px;width:100%;padding:5px 4px; }
    .ssh-conversation-title { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    .ssh-empty { font-size:12px;opacity:.55;padding:5px 4px; }
    .ssh-show-more { display:block; }
    button[aria-current="true"] { background:color-mix(in srgb,currentColor 10%,transparent); }
  `;

  function surface() {
    const host = node("div");
    const root = host.attachShadow({ mode: "closed" });
    root.append(node("style", styles));
    return { host, root };
  }

  async function refresh() {
    if (refreshPending || disposed) return;
    refreshPending = true;
    try {
      const data = await request("snapshot");
      if (!snapshot || JSON.stringify(data) !== JSON.stringify(snapshot)) {
        snapshot = data;
        render();
      }
    } finally { refreshPending = false; }
  }

  async function act(status, work, control) {
    if (control) control.disabled = true;
    try {
      await work();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      if (control) control.disabled = false;
    }
  }

  const stateLabel = { connected: "Connected", connecting: "Connecting…", disconnected: "Disconnected", failed: "Reconnecting…" };

  function settingsView() {
    const { host, root } = surface();
    host.style.cssText = "flex:1; min-width:0; height:100%; overflow:auto; color:inherit; font:inherit";
    host.hidden = true;
    host.setAttribute("aria-label", "SSH Connections");
    const content = node("div", "", "content");
    const top = node("div", "", "row spread block");
    const records = node("div", "", "card");
    const status = node("div", "", "status");
    status.setAttribute("role", "status");
    const addRow = node("div", "", "row block");
    addRow.hidden = true;
    const select = node("select");
    select.setAttribute("aria-label", "SSH host");
    const add = button("Add", control => act(status, async () => {
      const aliases = await request("aliases");
      select.replaceChildren();
      for (const name of aliases) {
        const option = node("option", name);
        option.value = name;
        select.append(option);
      }
      addRow.hidden = !aliases.length;
      status.textContent = aliases.length ? "" : "All configured SSH hosts have been added.";
    }, control));
    addRow.append(select, button("Connect", control => act(status, async () => {
      if (!select.value) return;
      await request("addHost", { host: select.value });
      addRow.hidden = true;
      await refresh();
    }, control)), button("Cancel", () => { addRow.hidden = true; }));
    top.append(node("strong", "SSH connections from this Mac"), add);
    content.append(node("h2", "Connections"), node("p", "Connect to or disconnect from SSH hosts."), top, addRow, records, status);
    root.append(content);

    return {
      host,
      draw() {
        records.replaceChildren();
        for (const record of snapshot?.hosts || []) {
          const row = node("div", "", "row host");
          const toggle = button("", control => act(status, async () => {
            status.textContent = "";
            await request("toggle", { host: record.host, enabled: !record.enabled });
            await refresh();
          }, control), "switch");
          toggle.setAttribute("role", "switch");
          toggle.setAttribute("aria-label", "Connect " + record.host);
          toggle.setAttribute("aria-checked", String(record.enabled));
          const detail = node("div", "", "grow");
          const state = node("div", "", "muted");
          state.append(node("span", "", "dot " + record.status), document.createTextNode(stateLabel[record.status]));
          detail.append(node("span", record.host, "host-name"), state);
          row.append(toggle, detail);
          if (record.status === "failed") {
            row.append(button("Retry", control => act(status, async () => {
              await request("toggle", { host: record.host, enabled: true });
              await refresh();
            }, control)));
          }
          records.append(row);
        }
      },
    };
  }

  function mountSettings() {
    const dialog = document.querySelector('.settings-modal-container[role="dialog"][aria-label="Settings"]');
    const general = dialog?.querySelector('[data-testid="settings-nav-item-General"]');
    const layout = general?.closest(".relative.flex.w-full.h-full.outline-none");
    const native = layout?.children[1];
    const row = general?.parentElement;
    if (!dialog || !native || !row) return;
    if (settings?.dialog === dialog && settings.entry.isConnected) return;
    settings?.remove();

    const view = settingsView();
    const entry = node("div", "", row.className);
    let previousDisplay = "", selectedNative;
    const nav = button("Connections", () => {
      if (!view.host.hidden) return;
      selectedNative = dialog.querySelector('[data-testid^="settings-nav-item-"].bg-sidebar-secondary');
      selectedNative?.classList.remove("bg-sidebar-secondary");
      previousDisplay = native.style.display;
      native.style.display = "none";
      nav.classList.add("bg-sidebar-secondary");
      nav.setAttribute("aria-current", "page");
      view.host.hidden = false;
      view.draw();
      refresh().catch(() => {});
    });
    nav.className = general.className.replace(/\bbg-sidebar-secondary\b/g, "").trim();
    nav.replaceChildren(node("span", "Connections", "text-sm transition-colors select-none truncate flex-1"));
    entry.append(nav);
    row.after(entry);
    layout.append(view.host);

    const restore = () => {
      if (view.host.hidden) return;
      view.host.hidden = true;
      native.style.display = previousDisplay;
      selectedNative?.classList.add("bg-sidebar-secondary");
      nav.classList.remove("bg-sidebar-secondary");
      nav.removeAttribute("aria-current");
    };
    const onNativeNav = event => {
      if (event.target.closest?.('[data-testid^="settings-nav-item-"]')) restore();
    };
    dialog.addEventListener("click", onNativeNav, true);
    settings = {
      dialog, entry, view,
      remove() {
        restore();
        entry.remove();
        view.host.remove();
        dialog.removeEventListener("click", onNativeNav, true);
      },
    };
  }

  const plusSelector = '[data-testid="sidebar-add-project-button"]';

  function mountSidebar() {
    const plus = document.querySelector(plusSelector);
    const heading = plus?.closest('[data-testid="section-header"]');
    const row = heading?.parentElement;
    if (sidebar?.heading === heading && sidebar?.host.isConnected) {
      sidebar.updateVisibility();
      return;
    }
    sidebar?.remove();
    sidebar = undefined;
    if (!row?.matches('[data-index]')) return;

    const { host, root } = surface();
    const rows = node("div");
    root.append(rows);
    host.setAttribute("data-agy-ssh-projects", "");

    // The native virtualizer measures this row, including its SSH projects.
    heading.after(host);
    sidebar = {
      heading, host, rows,
      updateVisibility() {
        host.hidden = heading.getAttribute("data-collapsed") === "true" ||
          !snapshot?.projects?.some(project => project.host !== remoteHost);
      },
      remove() { host.remove(); },
    };
    drawSidebar();
  }

  const collapsedProjects = new Set();
  const expandedConversationLists = new Set();
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

  function sourceIcon(host, folder = false) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", folder ? "project-folder-icon" : "host-globe");
    const hash = [...host].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
    svg.style.setProperty("--host-color", "hsl(" + (hash % 360) + " 65% 65%)");
    const outline = document.createElementNS(ns, "path");
    outline.setAttribute("fill", "none");
    outline.setAttribute("stroke", "currentColor");
    outline.setAttribute("stroke-width", folder ? "1.6" : "1.5");
    outline.setAttribute("stroke-linecap", "round");
    outline.setAttribute("stroke-linejoin", "round");
    outline.setAttribute("d", folder
      ? "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
      : "M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0m0 0h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9z");
    svg.append(outline);
    return svg;
  }

  function formatActivity(timestamp) {
    const date = Date.parse(timestamp);
    if (!Number.isFinite(date)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - date) / 1000));
    if (seconds < 60) return "now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
    return Math.floor(seconds / 86400) + "d";
  }

  function drawSidebar() {
    if (!sidebar) return;
    sidebar.updateVisibility();
    const rows = document.createDocumentFragment();
    for (const project of snapshot?.projects || []) {
      if (project.host === remoteHost) continue;
      const state = snapshot.hosts.find(item => item.host === project.host)?.status;
      const collapsed = collapsedProjects.has(project.id);
      const group = node("div", "", "ssh-project");
      const header = node("div", "", "ssh-project-header");
      const toggle = button("", () => {
        if (collapsedProjects.has(project.id)) collapsedProjects.delete(project.id);
        else collapsedProjects.add(project.id);
        drawSidebar();
      }, "ssh-project-toggle");
      toggle.append(sourceIcon(project.host, true));
      toggle.setAttribute("aria-label", (collapsed ? "Expand " : "Collapse ") + project.name);
      toggle.setAttribute("aria-expanded", String(!collapsed));
      const select = button(project.name, () => selectSaved(project), "ssh-project-name");
      select.title = project.folders.join("\n");
      select.setAttribute("aria-label", "Open SSH project " + project.name + " · " + project.host);
      if (selection?.project === project.id && !selection.conversation) select.setAttribute("aria-current", "true");

      const location = node("span", "", "location");
      location.title = project.host + " · " + (stateLabel[state] || "Disconnected");
      location.append(node("span", project.host), node("span", "", "dot " + (state || "")));
      header.append(toggle, select, location);
      group.append(header);

      if (!collapsed) {
        const conversations = project.conversations;
        const list = node("div", "", "ssh-conversations");
        if (!Array.isArray(conversations) || !conversations.length) {
          list.append(node("div", Array.isArray(conversations) ? "No conversations yet"
            : state === "connected" ? "Loading conversations…" : stateLabel[state] || "Disconnected", "ssh-empty"));
        } else {
          const shown = expandedConversationLists.has(project.id) ? conversations : conversations.slice(0, 5);
          for (const conversation of shown) {
            const entry = button("", () => selectSaved(project, conversation.id), "ssh-conversation");
            const source = node("span", "", "location");
            source.title = project.host;
            source.append(sourceIcon(project.host), node("span", formatActivity(conversation.updated)));
            entry.append(node("span", conversation.title, "ssh-conversation-title"), source);
            entry.title = conversation.title + " · " + project.host;
            if (selection?.project === project.id && selection.conversation === conversation.id) {
              entry.setAttribute("aria-current", "true");
            }
            list.append(entry);
          }
          if (shown.length < conversations.length) {
            list.append(button("Show more", () => {
              expandedConversationLists.add(project.id);
              drawSidebar();
            }, "ssh-empty ssh-show-more"));
          }
        }
        group.append(list);
      }
      rows.append(group);
    }
    sidebar.rows.replaceChildren(rows);
  }

  const workspaceFrames = new Map();
  const positionedPanes = new Map();
  let displayedWorkspace = null;
  let selection = null;

  function workspaceFrame(destination) {
    const url = new URL(destination.address);
    if (url.protocol !== "https:" || url.hostname !== "localhost" ||
        url.origin === location.origin || url.username || url.password || url.pathname !== "/") return null;
    const split = document.querySelector('[data-testid="sidebar-split"]');
    const content = split?.lastElementChild;
    if (!content || content.contains(document.querySelector('[data-testid="conversation-list-sidebar"]'))) return null;
    let frame = workspaceFrames.get(destination.host);
    if (frame?.content !== content) {
      frame?.element.remove();
      const element = node("iframe");
      element.title = destination.host + " SSH workspace";
      element.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-downloads");
      element.setAttribute("data-agy-workspace-frame", destination.host);
      element.setAttribute("aria-hidden", "true");
      element.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden;pointer-events:none;z-index:2;background:var(--background)";
      if (getComputedStyle(content).position === "static") {
        positionedPanes.set(content, content.style.position);
        content.style.position = "relative";
      }
      content.append(element);
      frame = { element, content, origin: "", route: "", ready: false };
      workspaceFrames.set(destination.host, frame);
    }
    if (frame.origin !== url.origin) {
      frame.origin = url.origin;
      frame.route = destination.project + ":";
      frame.ready = false;
      frame.element.src = url.href;
    }
    return frame;
  }

  function hideWorkspace() {
    if (!displayedWorkspace) return;
    const frame = displayedWorkspace;
    frame.element.style.visibility = "hidden";
    frame.element.style.pointerEvents = "none";
    frame.element.setAttribute("aria-hidden", "true");
    for (const [element, inert] of frame.inert ?? []) element.inert = inert;
    frame.inert = null;
    displayedWorkspace = null;
  }

  function revealWorkspace(frame) {
    if (displayedWorkspace === frame) return;
    hideWorkspace();
    frame.element.style.visibility = "visible";
    frame.element.style.pointerEvents = "auto";
    frame.element.removeAttribute("aria-hidden");
    frame.inert = new Map();
    for (const child of frame.content.children) {
      if (child.matches("[data-agy-workspace-frame]")) continue;
      frame.inert.set(child, child.inert);
      child.inert = true;
    }
    displayedWorkspace = frame;
  }

  function applySelection(destination, force = false) {
    if (!selection) return;
    const project = snapshot?.projects.find(item => item.id === selection.project);
    const target = destination ?? project?.workspace;
    if (!target || !uuid.test(target.project) || selection.conversation && !uuid.test(selection.conversation)) return;
    const url = new URL(target.address);
    if (url.origin === location.origin) {
      hideWorkspace();
      if (selection.conversation) url.pathname = "/c/" + selection.conversation;
      if (location.href !== url.href) {
        history.pushState(history.state, "", url.href);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      }
      return;
    }
    const frame = workspaceFrame(target);
    if (!frame?.ready) return;
    const route = target.project + ":" + (selection.conversation || "");
    if (force || frame.route !== route) {
      frame.route = route;
      frame.element.contentWindow.postMessage({
        type: "agy-ssh-select", project: target.project, conversation: selection.conversation,
      }, frame.origin);
    }
    revealWorkspace(frame);
  }

  function selectSaved(project, conversation = null) {
    selection = { project: project.id, conversation };
    drawSidebar();
    applySelection(project.workspace, true);
  }

  function showWorkspace(result) {
    if (!result.workspace) return;
    selection = { project: result.workspace.project, conversation: null };
    drawSidebar();
    applySelection(result.workspace, true);
  }

  function receiveWorkspaceReady(event) {
    if (event.data?.type !== "agy-ssh-ready") return;
    for (const frame of workspaceFrames.values()) {
      if (event.origin === frame.origin && event.source === frame.element.contentWindow) {
        frame.ready = true;
        applySelection();
        return;
      }
    }
  }

  function warmFrames() {
    for (const destination of snapshot?.workspaces || []) {
      workspaceFrame(destination);
    }
    applySelection();
  }

  function openNativeProject(event) {
    if (!selection || event.target.closest?.("[data-agy-ssh-projects], [data-agy-ssh-menu]")) return;
    const control = event.target.closest?.('button, a, [data-sidebar-row-id], [data-sidebar-section-drop-id]');
    if (!control) return;
    if (control.matches(plusSelector)) return;
    if (control.closest('[data-sidebar-row-id], [data-sidebar-section-drop-id]') ||
        ["New Conversation", "Automations", "Customizations"].includes(control.textContent.trim())) {
      selection = null;
      hideWorkspace();
      drawSidebar();
    }
  }

  let projectMenu;
  function mountProjectMenu() {
    const plus = document.querySelector(plusSelector);
    const id = plus?.getAttribute("aria-controls");
    const native = id && document.getElementById(id);
    if (!native || plus.getAttribute("aria-expanded") !== "true") {
      projectMenu?.extension.remove();
      projectMenu = null;
      return;
    }
    if (projectMenu?.native === native) return;
    const exemplar = native.querySelector("button.agy-overlay-item");
    if (!exemplar) return;

    const extension = node("div");
    extension.setAttribute("data-agy-ssh-menu", "");
    native.append(extension);
    const status = node("div", "", "px-2 text-xs text-muted-foreground");
    status.setAttribute("role", "status");
    const actions = node("div");
    extension.append(actions, status);
    const item = (label, callback) => button(label, callback, exemplar.className);
    const menu = { native, extension, browsing: false };
    projectMenu = menu;

    const close = () => native.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", code: "Escape", bubbles: true, cancelable: true,
    }));

    async function browseFolder(host, directory) {
      menu.browsing = true;
      actions.replaceChildren(item("Back", () => { menu.browsing = false; draw(); }));
      status.textContent = "Loading folders…";
      try {
        const listing = await request("browse", { host, path: directory });
        if (projectMenu !== menu || !menu.browsing) return;
        status.textContent = "";
        const path = node("input", "", "w-full px-2 py-1 text-sm rounded-md border border-border bg-background");
        path.value = listing.path;
        path.setAttribute("aria-label", "Remote folder");
        path.addEventListener("keydown", event => {
          if (event.key === "Enter" && event.isTrusted) {
            event.preventDefault();
            event.stopPropagation();
            void browseFolder(host, path.value.trim());
          }
        });
        const directories = node("div");
        directories.style.cssText = "max-height:150px;overflow:auto";
        if (listing.path !== "/") {
          directories.append(item("Parent Folder", () => browseFolder(host, listing.path.split("/").slice(0, -1).join("/") || "/")));
        }
        for (const name of listing.children) {
          directories.append(item(name, () => browseFolder(host, listing.path.replace(/\/$/, "") + "/" + name)));
        }
        const open = item("Open This Folder", control => act(status, async () => {
          status.textContent = "Opening SSH project…";
          const result = await request("create", {
            host, name: listing.path.split("/").filter(Boolean).at(-1) || host, folders: [listing.path],
          });
          await refresh();
          if (!result.workspace) { status.textContent = result.message; return; }
          showWorkspace(result);
          close();
        }, control));
        actions.append(path, directories, open);
      } catch (error) { status.textContent = error.message; }
    }

    function draw() {
      if (menu.browsing || !extension.isConnected) return;
      actions.replaceChildren();
      for (const record of snapshot?.hosts || []) {
        if (record.status === "connected") {
          actions.append(item("Open Folder on " + record.host + "…", () => browseFolder(record.host, "~")));
        }
      }
      status.textContent = "";
    }
    menu.draw = draw;
    draw();
    refresh().catch(() => {});
  }

  document.addEventListener("click", openNativeProject, true);
  window.addEventListener("message", receiveWorkspaceReady);

  function render() {
    settings?.view.draw();
    drawSidebar();
    projectMenu?.draw();
    warmFrames();
  }
  function mount() {
    if (disposed) return;
    scheduled = false;
    mountSettings();
    mountSidebar();
    mountProjectMenu();
    warmFrames();
  }
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    const native = document.querySelector('.settings-modal-container[role="dialog"][aria-label="Settings"]');
    const heading = document.querySelector(plusSelector)?.closest('[data-testid="section-header"]');
    const plus = document.querySelector(plusSelector);
    const menuId = plus?.getAttribute("aria-controls");
    const menu = plus?.getAttribute("aria-expanded") === "true" && menuId ? document.getElementById(menuId) : null;
    if ((native === settings?.dialog || !native) && heading === sidebar?.heading && sidebar?.host.isConnected &&
        menu === (projectMenu?.native ?? null)) {
      sidebar.updateVisibility();
      return;
    }
    scheduled = true;
    requestAnimationFrame(mount);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-collapsed", "aria-expanded"] });
  const tick = setInterval(() => refresh().catch(() => {}), 2600);
  globalThis.__agyConnectionsRemove = () => {
    disposed = true;
    clearInterval(tick);
    observer.disconnect();
    settings?.remove();
    sidebar?.remove();
    projectMenu?.extension.remove();
    hideWorkspace();
    for (const frame of workspaceFrames.values()) frame.element.remove();
    for (const [content, position] of positionedPanes) {
      if (content.style.position === "relative") content.style.position = position;
    }
    document.removeEventListener("click", openNativeProject, true);
    window.removeEventListener("message", receiveWorkspaceReady);
  };
  mount();
  refresh().catch(() => {});
})();
