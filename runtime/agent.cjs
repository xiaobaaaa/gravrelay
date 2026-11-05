"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);
const compatibility = require("./compatibility.json");
const original = process.env.AGY_SSH_APP || "/Applications/Antigravity.app";
const python = process.env.AGY_SSH_PYTHON || "/usr/bin/python3";
const binary = original + "/Contents/MacOS/Antigravity";
const languageServer = original + "/Contents/Resources/bin/language_server";
const library = path.join(os.homedir(), "Library/Application Support");
const legacy = path.join(library, "Antigravity SSH Preview");
const moduleData = path.join(library, "Antigravity SSH Settings");
const projectFile = path.join(moduleData, "projects.json");
const hostsFile = path.join(moduleData, "hosts.json");
const socketDirectory = path.join(os.homedir(), ".ssh/agy-settings");
const connector = path.join(__dirname, "connect.py");
const devtoolsFile = path.join(library, "Antigravity/DevToolsActivePort");
const panelPath = path.join(__dirname, "panel.js");
const world = "AntigravitySSHSettings-" + randomUUID();
const alias = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const binding = "__agyConnectionsBridge";
const masters = new Map();
const opening = new Map();
const workspaces = new Map();
const selectedProjects = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class UserFacingError extends Error {}
let hostsCache, savedProjects, savedHosts, stop = false;

function jsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return undefined; }
}

function persist(file, value) {
  fs.mkdirSync(moduleData, { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID();
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try { fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function validPath(value) {
  return typeof value === "string" && value.length <= 4096 && value.startsWith("/")
    && !/[\u0000-\u001f]/.test(value);
}

function oldProjectId(host, directory) {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespace).update("ssh://" + host + directory).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  return bytes.toString("hex").replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5");
}

function projects() {
  if (!savedProjects) {
    const old = jsonFile(projectFile) ?? jsonFile(path.join(legacy, "connections.json"));
    savedProjects = (Array.isArray(old?.projects) ? old.projects : []).flatMap(project => {
      if (typeof project?.host !== "string" || !alias.test(project.host)) return [];
      const folders = Array.isArray(project.folders) ? project.folders.filter(validPath) : [project.path].filter(validPath);
      if (!folders.length) return [];
      return [{
        id: typeof project.id === "string" && uuid.test(project.id) ? project.id : oldProjectId(project.host, folders[0]),
        name: typeof project.name === "string" && project.name ? project.name : path.posix.basename(folders[0]) || "/",
        host: project.host, folders,
      }];
    });
  }
  return savedProjects;
}

function configuredHosts() {
  if (!savedHosts) {
    const old = jsonFile(hostsFile);
    savedHosts = Array.isArray(old?.hosts)
      ? old.hosts.filter(item => typeof item?.host === "string" && alias.test(item.host))
        .map(item => ({ host: item.host, enabled: item.enabled === true }))
      : [...new Set(projects().map(project => project.host))].map(host => ({ host, enabled: true }));
  }
  return savedHosts;
}

async function availableAliases() {
  if (!hostsCache || Date.now() > hostsCache.expires) {
    const { stdout } = await run(python, [connector, "--hosts"], { timeout: 8000 });
    const items = JSON.parse(stdout).filter(host => typeof host === "string" && alias.test(host));
    hostsCache = { items: [...new Set(items)], expires: Date.now() + 30000 };
  }
  return hostsCache.items;
}

function socketFor(host) {
  fs.mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(socketDirectory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new UserFacingError("The SSH control socket directory permissions are unsafe.");
  }
  const file = path.join(socketDirectory, createHash("sha256").update(host).digest("hex").slice(0, 16));
  if (Buffer.byteLength(file) >= 100) throw new UserFacingError("The SSH control socket path is too long.");
  return file;
}

const ssh = "/usr/bin/ssh";
const sshOptions = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
  "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no",
  "-o", "ClearAllForwardings=yes"];

async function checkMaster(host) {
  try {
    await run(ssh, ["-S", socketFor(host), "-O", "check", host], { timeout: 2000 });
    return true;
  } catch { return false; }
}

function markDisconnected(state) {
  if (state.status === "failed") return;
  state.status = "failed";
  state.failures++;
  state.retryAt = Date.now() + Math.min(30000, 3000 * 2 ** Math.min(state.failures - 1, 4));
}

async function connectHost(host) {
  const previous = masters.get(host);
  if (stop || !configuredHosts().some(record => record.host === host && record.enabled) ||
      previous && (previous.status !== "failed" || previous.retryAt > Date.now())) return;
  const state = { status: "connecting", child: null, failures: previous?.failures ?? 0, retryAt: 0 };
  masters.set(host, state);
  try {
    if (!(await checkMaster(host))) {
      if (masters.get(host) !== state || stop) return;
      state.child = spawn(ssh, [...sshOptions, "-M", "-N", "-S", socketFor(host),
        "-o", "ControlPersist=no", host], { stdio: "ignore" });
      state.child.once("error", () => {
        if (masters.get(host) === state) markDisconnected(state);
      });
      state.child.once("exit", () => {
        if (masters.get(host) === state) markDisconnected(state);
      });
      for (let count = 0; count < 24 && state.status === "connecting"; count++) {
        if (masters.get(host) !== state || stop) return;
        if (await checkMaster(host)) {
          state.status = "connected";
          state.failures = 0;
          return;
        }
        await pause(350);
      }
      if (state.child.exitCode === null) state.child.kill();
      markDisconnected(state);
    } else if (masters.get(host) === state && !stop) {
      state.status = "connected";
      state.failures = 0;
    }
  } catch {
    if (masters.get(host) === state) markDisconnected(state);
  }
}

async function disconnectHost(host) {
  const state = masters.get(host);
  masters.delete(host);
  if (state?.child && state.child.exitCode === null) state.child.kill();
  try { await run(ssh, ["-S", socketFor(host), "-O", "exit", host], { timeout: 1800 }); }
  catch {}
}

let checkingConnections = false;

async function maintainConnections() {
  if (stop || checkingConnections) return;
  checkingConnections = true;
  try {
    await Promise.all(configuredHosts().filter(record => record.enabled).map(async ({ host }) => {
      const state = masters.get(host);
      if (state?.status === "connected" && !(await checkMaster(host)) && masters.get(host) === state) {
        markDisconnected(state);
      }
      void connectHost(host);
      if (masters.get(host)?.status === "connected") void warmWorkspace(host);
    }));
  } finally {
    checkingConnections = false;
  }
}

async function browse(host, directory) {
  if (!validPath(directory) && directory !== "~") throw new UserFacingError("Enter an absolute remote folder path.");
  if (masters.get(host)?.status !== "connected" || !(await checkMaster(host))) {
    throw new UserFacingError("Connect to this host in Settings → Connections first.");
  }
  const script = "import json,os,sys;p=os.path.realpath(os.path.expanduser(sys.argv[1]));" +
    "children=sorted(e.name for e in os.scandir(p) if e.is_dir() and not e.name.startswith('.') and '\\n' not in e.name);" +
    "print(json.dumps({'path':p,'children':children[:400]}))";
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  try {
    const { stdout } = await run(ssh, [...sshOptions, "-T", "-S", socketFor(host),
      "-o", "ControlMaster=no", "-o", "ProxyCommand=/usr/bin/false", host,
      "python3 -c " + quote(script) + " " + quote(directory)], { timeout: 12000, maxBuffer: 512 * 1024 });
    const result = JSON.parse(stdout);
    if (!validPath(result.path) || !Array.isArray(result.children)) throw new Error("bad directory");
    return result;
  } catch { throw new UserFacingError("Could not read the remote folder. Check the SSH connection and folder permissions."); }
}

async function processRows(format = "pid=,ppid=,comm=") {
  const { stdout } = await run("/bin/ps", ["-ww", "-axo", format], { timeout: 3000, maxBuffer: 3 * 1024 * 1024 });
  return stdout.split("\n").flatMap(line => {
    const row = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), command: row[3] }] : [];
  });
}

function running(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function previewWindow(host) {
  const rows = await processRows("pid=,ppid=,command=");
  const previewBinary = path.join(legacy, `Antigravity ${compatibility.appVersion} SSH Window.app/Contents/MacOS/Antigravity`);
  const profile = "--user-data-dir=" + path.join(legacy, host);
  return rows.find(row => row.command.startsWith(previewBinary + " ")
    && (row.command.includes(profile + " ") || row.command.endsWith(profile)));
}

async function verifiedWorkspacePort(host) {
  const folder = path.join(legacy, host);
  const session = jsonFile(path.join(folder, "session.json"));
  const processes = await processRows();
  const forwardPorts = pid => loopbackPorts(processes.filter(p => p.ppid === pid && p.command === ssh).map(p => p.pid));
  if (Number.isInteger(session?.port) && running(session.supervisorPID) &&
      (await forwardPorts(session.supervisorPID)).includes(session.port)) return session.port;

  // Sessions started by the previous connector carry their port in the preview page.
  const preview = await previewWindow(host);
  if (!preview) return null;
  let port;
  try {
    port = Number(fs.readFileSync(path.join(folder, "DevToolsActivePort"), "utf8").split("\n")[0]);
  } catch { return null; }
  if (!(await loopbackPorts([preview.pid])).includes(port)) return null;
  const forwards = await forwardPorts(preview.ppid);
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list", {
    redirect: "error", signal: AbortSignal.timeout(1800),
  })).json();
  for (const target of targets) {
    if (target.type !== "page") continue;
    const url = new URL(target.url);
    if (url.protocol === "https:" && url.hostname === "localhost" && !url.username && !url.password &&
        forwards.includes(Number(url.port))) return Number(url.port);
  }
  return null;
}

async function workspacePort(project) {
  const host = project.host;
  let port = await verifiedWorkspacePort(host);
  if (port) return port;
  let startup = opening.get(host);
  if (!startup) {
    startup = (async () => {
      const child = spawn(python, [connector, "--headless", "--host", host, "--directory",
        project.folders[0], "--project-spec", JSON.stringify(project)], { detached: true, stdio: "ignore" });
      let exited = false;
      child.once("error", () => { exited = true; });
      child.once("exit", () => { exited = true; });
      child.unref();
      for (let attempt = 0; attempt < 100 && !exited; attempt++) {
        await pause(600);
        const port = await verifiedWorkspacePort(host);
        if (port) return port;
      }
      throw new UserFacingError("The SSH workspace could not start. Check the connection and try again.");
    })().finally(() => opening.delete(host));
    opening.set(host, startup);
  }
  return startup;
}

function destinationFor(project, port) {
  const address = new URL("https://localhost:" + port + "/");
  address.searchParams.set("project", project.id);
  return { address: address.href, host: project.host, project: project.id };
}

function workspaceState(host) {
  let state = workspaces.get(host);
  if (!state) {
    state = { pending: false, retryAt: 0, checkedAt: 0, port: null, conversations: null, destination: null };
    workspaces.set(host, state);
  }
  return state;
}

async function warmWorkspace(host) {
  const saved = projects().filter(project => project.host === host);
  if (!saved.length) return;
  const state = workspaceState(host);
  if (state.pending || state.retryAt > Date.now() || Date.now() - state.checkedAt < 6000) return;
  state.pending = true;
  try {
    const project = saved.find(item => item.id === selectedProjects.get(host)) ?? saved[0];
    const port = await workspacePort(project);
    const result = await run(python, [path.join(__dirname, "switch-project.py"),
      String(port), JSON.stringify({ projects: saved })], { timeout: 18000, maxBuffer: 2 * 1024 * 1024 });
    state.conversations = JSON.parse(result.stdout);
    state.port = port;
    state.destination = destinationFor(project, port);
    state.checkedAt = Date.now();
  } catch {
    state.port = null;
    state.destination = null;
    state.retryAt = Date.now() + 10000;
  } finally {
    state.pending = false;
  }
}

async function openCreatedProject(project) {
  const host = project.host;
  if (masters.get(host)?.status !== "connected" || !(await checkMaster(host))) {
    throw new UserFacingError("SSH is reconnecting. The project will load automatically.");
  }
  const port = await workspacePort(project);
  try {
    await run(python, [path.join(__dirname, "switch-project.py"),
      String(port), JSON.stringify(project)], { timeout: 15000, maxBuffer: 64 * 1024 });
  } catch {
    throw new UserFacingError("The SSH workspace could not open this project. Check the connection and folder.");
  }
  selectedProjects.set(host, project.id);
  const state = workspaceState(host);
  state.port = port;
  state.destination = destinationFor(project, port);
  state.checkedAt = 0;
  state.conversations = { ...state.conversations, [project.id]: state.conversations?.[project.id] ?? [] };
  void warmWorkspace(host);
  return { workspace: state.destination };
}

async function dispatch(message) {
  const { action, host, path: directory } = message;
  const records = configuredHosts();
  if (action === "snapshot") {
    const list = records.map(item => ({
      host: item.host, enabled: item.enabled,
      status: item.enabled ? masters.get(item.host)?.status ?? "connecting" : "disconnected",
    }));
    const connected = new Set(list.filter(item => item.status === "connected").map(item => item.host));
    const saved = projects().map(project => {
      const state = workspaces.get(project.host);
      const conversations = state?.conversations?.[project.id];
      return {
        ...project,
        conversations: Array.isArray(conversations) ? conversations : null,
        workspace: connected.has(project.host) && state?.port && Array.isArray(conversations)
          ? destinationFor(project, state.port) : null,
      };
    });
    return { hosts: list, projects: saved, workspaces: list.flatMap(({ host }) => {
      const state = workspaces.get(host);
      return connected.has(host) && state?.destination ? [state.destination] : [];
    }) };
  }
  if (action === "aliases") {
    return (await availableAliases()).filter(name => !records.some(item => item.host === name));
  }
  if (action === "addHost") {
    if (typeof host !== "string" || !alias.test(host) || !(await availableAliases()).includes(host)) {
      throw new UserFacingError("Select a host from the SSH configuration.");
    }
    if (!records.some(item => item.host === host)) {
      savedHosts = [...records, { host, enabled: true }];
      persist(hostsFile, { hosts: savedHosts });
      void connectHost(host);
    }
    return {};
  }
  const record = records.find(item => item.host === host);
  if (!record) throw new UserFacingError("Select a configured SSH host.");
  if (action === "toggle") {
    record.enabled = message.enabled === true;
    persist(hostsFile, { hosts: records });
    if (record.enabled) {
      const state = masters.get(host);
      if (state?.status === "failed") state.retryAt = 0;
      void connectHost(host);
    } else {
      workspaces.delete(host);
      await disconnectHost(host);
    }
    return {};
  }
  if (action === "browse") return browse(host, directory);
  if (action === "create") {
    const name = typeof message.name === "string" ? message.name.trim() : "";
    const folders = message.folders;
    if (!name || name.length > 120 || !Array.isArray(folders) || !folders.length || folders.length !== 1
        || !folders.every(validPath)) throw new UserFacingError("Select one remote folder.");
    const verified = [];
    for (const folder of new Set(folders)) verified.push((await browse(host, folder)).path);
    const unique = [...new Set(verified)];
    const prior = projects().find(item => item.host === host && item.folders.length === 1
      && item.folders[0] === unique[0]);
    const project = prior ?? { id: randomUUID(), host, name, folders: unique };
    if (!prior) {
      savedProjects = [...projects(), project];
      persist(projectFile, { projects: savedProjects });
    }
    try { return await openCreatedProject(project); }
    catch (error) {
      return { message: "Project saved. " + (error instanceof UserFacingError ? error.message : "The SSH workspace is unavailable.") };
    }
  }
  throw new UserFacingError("This SSH operation is not supported.");
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.pending = new Map();
    this.events = new Map();
    this.nextId = 0;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("debugger unavailable")), 3000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("debugger unavailable")); }, { once: true });
    });
    this.ws.addEventListener("message", event => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.id) {
        const call = this.pending.get(packet.id);
        if (!call) return;
        clearTimeout(call.timer);
        this.pending.delete(packet.id);
        if (packet.error) call.reject(new Error("debugger request failed"));
        else call.resolve(packet.result);
      } else this.events.get(packet.method)?.(packet.params);
    });
    this.ws.addEventListener("close", () => {
      for (const { timer, reject } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("debugger closed"));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error("debugger closed"));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("debugger request timed out"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function loopbackPorts(pids) {
  if (!pids.length) return [];
  try {
    const { stdout } = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", pids.join(","),
      "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 3500 });
    return [...stdout.matchAll(/^n(?:127\.0\.0\.1|\[::1\]):(\d+)$/gm)].map(match => Number(match[1]));
  } catch { return []; }
}

function localPage(url, allowed) {
  try {
    const uri = new URL(url);
    return ["https:", "http:"].includes(uri.protocol) && uri.hostname === "127.0.0.1"
      && allowed.includes(Number(uri.port)) && !uri.username && !uri.password;
  } catch { return false; }
}

async function workspaceHost(url) {
  let candidate;
  try { candidate = new URL(url); } catch { return ""; }
  if (candidate.protocol !== "https:" || candidate.hostname !== "localhost" || candidate.username || candidate.password) return "";
  for (const [host, state] of workspaces) {
    if (state.destination && new URL(state.destination.address).origin === candidate.origin) return host;
  }
  const hosts = [...new Set(projects().map(project => project.host))];
  const ports = await Promise.all(hosts.map(host => verifiedWorkspacePort(host).catch(() => null)));
  return hosts[ports.indexOf(Number(candidate.port))] || "";
}

async function styleWorkspaceFrame(url, parentOrigins) {
  const client = new CDP(url);
  try {
    await client.ready;
    const result = await client.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
      if (!document.head) return false;
      if (globalThis.__agyEmbeddedSidebarHandled) return true;
      const style = document.createElement("style");
      style.id = "agy-embedded-workspace-style";
      style.textContent = '[data-testid="sidebar-split"] > :has([role="navigation"]), ' +
        '[data-testid="sidebar-split"] > :has([role="navigation"]) + :not(:last-child) { display:none!important }';
      document.head.append(style);
      globalThis.__agyEmbeddedSidebarHandled = true;
      const parents = new Set(${JSON.stringify(parentOrigins)});
      const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
      window.addEventListener("message", event => {
        if (event.source !== window.parent || !parents.has(event.origin)) return;
        const data = event.data;
        if (data?.type !== "agy-ssh-select" || !uuid.test(data.project) ||
            data.conversation && !uuid.test(data.conversation)) return;
        const destination = new URL(data.conversation ? "/c/" + data.conversation : "/", location.origin);
        destination.searchParams.set("project", data.project);
        if (destination.href === location.href) return;
        history.pushState(history.state, "", destination.href);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      });
      const announce = () => {
        if (!document.querySelector('[data-testid="sidebar-split"]') &&
            !(location.pathname.startsWith("/onboarding") && document.querySelector("button"))) return false;
        for (const origin of parents) window.parent.postMessage({type:"agy-ssh-ready"}, origin);
        return true;
      };
      if (!announce()) {
        const observer = new MutationObserver(() => { if (announce()) observer.disconnect(); });
        observer.observe(document.documentElement, {childList:true,subtree:true});
      }
      document.addEventListener("click", event => {
        if (!event.isTrusted || !style.isConnected || !event.target.closest?.('[aria-label="Toggle Sidebar"]')) return;
        const expanded = document.querySelector('[data-testid="sidebar-split"] [role="navigation"]');
        style.remove();
        if (expanded?.getClientRects().length) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
      return true;
    })()` });
    return result.result.value === true;
  } finally { client.close(); }
}

async function attach(url, allowedPorts) {
  const client = new CDP(url);
  let context, generation = 0, requests = 0;

  async function mount(frame) {
    const expected = ++generation;
    context = undefined;
    if (frame.parentId) return;
    const local = localPage(frame.url, await allowedPorts(frame.url));
    const host = local ? "" : await workspaceHost(frame.url);
    if (!local && !host) return;
    const { executionContextId } = await client.send("Page.createIsolatedWorld", {
      frameId: frame.id, worldName: world, grantUniveralAccess: false,
    });
    if (generation !== expected) return;
    await client.send("Runtime.addBinding", { name: binding, executionContextId });
    if (generation !== expected) return;
    context = executionContextId;
    const source = fs.readFileSync(panelPath, "utf8");
    const evaluation = await client.send("Runtime.evaluate", {
      expression: "globalThis.__agyConnectionsRemoteHost = " + JSON.stringify(host) + ";\n" + source,
      contextId: context,
    });
    if (evaluation.exceptionDetails) throw new Error("cannot mount settings");
  }

  try {
    await client.ready;
    client.events.set("Runtime.bindingCalled", packet => {
      if (packet.name !== binding || packet.executionContextId !== context ||
          packet.payload.length > 9000 || requests > 7) return;
      let message;
      try { message = JSON.parse(packet.payload); } catch { return; }
      if (!Number.isSafeInteger(message?.id) || typeof message.action !== "string") return;
      requests++;
      const originContext = context;
      Promise.resolve(dispatch(message)).then(
        data => ({ ok: true, data }),
        error => ({ ok: false, error: error instanceof UserFacingError
          ? error.message : "The SSH operation failed. Check the connection and try again." }),
      ).then(result => {
        if (context !== originContext) return;
        return client.send("Runtime.evaluate", {
          contextId: originContext,
          expression: "globalThis.__agyConnectionsReply(" + message.id + "," + JSON.stringify(result) + ")",
        });
      }).catch(() => {}).finally(() => { requests--; });
    });
    client.events.set("Page.frameNavigated", ({ frame }) => {
      if (!frame.parentId) mount(frame).catch(() => {});
    });
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    const { frameTree } = await client.send("Page.getFrameTree");
    await mount(frameTree.frame);
    return {
      client,
      async remove() {
        if (context) {
          await client.send("Runtime.evaluate", {
            contextId: context, expression: "globalThis.__agyConnectionsRemove?.()",
          }).catch(() => {});
        }
        client.close();
      },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function main() {
  const parent = (await processRows()).find(row => row.command === binary);
  if (!parent) return;
  const version = (await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw",
    path.join(original, "Contents/Info.plist")], { timeout: 2500 })).stdout.trim();
  if (version !== compatibility.appVersion) return;
  await run("/usr/bin/codesign", ["--verify", "--strict", "-R",
    `=anchor apple generic and identifier "${compatibility.bundleId}" and certificate leaf[subject.OU] = "${compatibility.teamId}"`, original], { timeout: 10000 });

  let devtoolsPort;
  for (let count = 0; count < 6 && running(parent.pid) && !stop; count++) {
    try {
      const candidate = Number(fs.readFileSync(devtoolsFile, "utf8").split("\n")[0]);
      if ((await loopbackPorts([parent.pid])).includes(candidate)) {
        devtoolsPort = candidate;
        break;
      }
    } catch {}
    await pause(900);
  }
  if (!devtoolsPort) return;

  let rendererPorts = [];
  async function allowedPorts(url) {
    if (!localPage(url, rendererPorts)) {
      const children = (await processRows()).filter(row => row.ppid === parent.pid && row.command === languageServer);
      rendererPorts = await loopbackPorts(children.map(row => row.pid));
    }
    return rendererPorts;
  }

  const attached = new Map();
  const styledFrames = new Map();
  void maintainConnections();
  const connectionTimer = setInterval(() => maintainConnections().catch(() => {}), 2500);
  try {
    while (running(parent.pid) && !stop) {
      try {
        const endpoint = "http://127.0.0.1:" + devtoolsPort + "/json/list";
        const response = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(1800) });
        const targets = await response.json();
        const parentOrigins = [];
        for (const page of targets) {
          if (page.type !== "page") continue;
          if (localPage(page.url, await allowedPorts(page.url)) || await workspaceHost(page.url)) {
            parentOrigins.push(new URL(page.url).origin);
          }
        }
        for (const target of targets) {
          if (!["page", "iframe"].includes(target.type) || !target.webSocketDebuggerUrl) continue;
          const ws = new URL(target.webSocketDebuggerUrl);
          if (ws.protocol !== "ws:" || ws.hostname !== "127.0.0.1" ||
              Number(ws.port) !== devtoolsPort || ws.pathname !== "/devtools/page/" + target.id) continue;
          if (target.type === "iframe") {
            if (parentOrigins.length && styledFrames.get(target.id) !== target.url && await workspaceHost(target.url) &&
                await styleWorkspaceFrame(ws.href, parentOrigins).catch(() => false)) styledFrames.set(target.id, target.url);
            continue;
          }
          const existing = attached.get(target.id);
          if (existing?.client.ws.readyState === WebSocket.OPEN) continue;
          if (!localPage(target.url, await allowedPorts(target.url)) && !(await workspaceHost(target.url))) continue;
          try { attached.set(target.id, await attach(ws.href, allowedPorts)); } catch {}
        }
        for (const id of styledFrames.keys()) if (!targets.some(target => target.id === id)) styledFrames.delete(id);
        for (const [id, entry] of attached) {
          if (!targets.some(target => target.id === id)) {
            await entry.remove();
            attached.delete(id);
          }
        }
      } catch {}
      await pause(1700);
    }
  } finally {
    clearInterval(connectionTimer);
    await Promise.allSettled([...attached.values()].map(entry => entry.remove()));
    await Promise.allSettled([...masters.keys()].map(disconnectHost));
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { stop = true; });
main().catch(() => {
  console.error("Antigravity SSH Bridge could not start. Run the installer with the doctor command.");
  process.exitCode = 1;
});
