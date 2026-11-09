"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { isIP } = require("node:net");

const run = promisify(execFile);
const compatibility = require("./compatibility.json");
const installCLIFrontend = require("./cli-frontend.cjs");
const installNativePermissions = require("./permissions.cjs");
const installRemoteFiles = require("./files.cjs");
const original = process.env.AGY_SSH_APP || "/Applications/Antigravity.app";
const python = process.env.AGY_SSH_PYTHON || "/usr/bin/python3";
const binary = original + "/Contents/MacOS/Antigravity";
const languageServer = original + "/Contents/Resources/bin/language_server";
const library = path.join(os.homedir(), "Library/Application Support");
const legacy = path.join(library, "Antigravity SSH Preview");
const moduleData = path.join(library, "Antigravity SSH Settings");
const projectFile = path.join(moduleData, "projects.json");
const hostsFile = path.join(moduleData, "hosts.json");
const managedSSH = path.join(moduleData, "ssh-hosts");
const socketDirectory = path.join(os.homedir(), ".ssh/agy-settings");
const connector = path.join(__dirname, "connect.py");
const devtoolsFile = path.join(library, "Antigravity/DevToolsActivePort");
const panelPath = path.join(__dirname, "panel.js");
const catalogFile = path.join(moduleData, "catalog-cache.json");
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
let frontendOrigin = "", appPID = null, catalogTimer;
function cacheCatalog() {
  if (catalogTimer) return;
  catalogTimer = setTimeout(() => {
    catalogTimer = null;
    const hosts = Object.fromEntries([...workspaces].filter(([, state]) => state.conversations).map(([host, state]) => [host, { conversations: state.conversations }]));
    try { persist(catalogFile, { schema: 1, hosts }); }
    catch { console.error("Could not save the SSH conversation cache."); }
  }, 2000);
  catalogTimer.unref();
}

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
        registered: project.registered === true, pendingRegistration: project.pendingRegistration === true,
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

function sshConfigFor(host) {
  const file = path.join(managedSSH, host + ".conf");
  if (!fs.existsSync(file)) return [];
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new UserFacingError("The managed SSH configuration must be a private file.");
  }
  return ["-F", file];
}

async function addManualHost(message) {
  const { host, hostname, username, port } = message;
  if (typeof host !== "string" || !alias.test(host) ||
      typeof hostname !== "string" || hostname.length > 253 ||
      !(isIP(hostname) || /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(hostname)) ||
      typeof username !== "string" || !/^[A-Za-z0-9_.@-]{1,64}$/.test(username) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserFacingError("Enter a valid name, hostname, username and port.");
  }
  if (configuredHosts().some(item => item.host === host) || (await availableAliases()).includes(host)) {
    throw new UserFacingError("This SSH host name is already in use.");
  }
  fs.mkdirSync(managedSSH, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(managedSSH);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
    throw new UserFacingError("The managed SSH configuration directory must be private.");
  }
  const file = path.join(managedSSH, host + ".conf");
  const contents = [
    "Host " + host, "  HostName " + hostname, "  User " + username, "  Port " + port, "",
  ].join("\n");
  fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
  const next = [...configuredHosts(), { host, enabled: true }];
  try {
    persist(hostsFile, { hosts: next });
  } catch (error) {
    fs.unlinkSync(file);
    throw error;
  }
  savedHosts = next;
  void connectHost(host);
  return {};
}

const ssh = "/usr/bin/ssh";
const sshOptions = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
  "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no",
  "-o", "ClearAllForwardings=yes"];

async function checkMaster(host) {
  try {
    await run(ssh, [...sshConfigFor(host), "-S", socketFor(host), "-O", "check", host], { timeout: 2000 });
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
      state.child = spawn(ssh, [...sshConfigFor(host), ...sshOptions, "-M", "-N", "-S", socketFor(host),
        "-o", "ControlPersist=no", host], { stdio: "ignore" });
      state.child.once("error", () => {
        if (masters.get(host) === state) markDisconnected(state);
      });
      state.child.once("exit", () => {
        if (masters.get(host) === state) markDisconnected(state);
      });
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && state.status === "connecting") {
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

function ownsTransportProcess(host, session, output) {
  const match = output.trim().match(/^(\d+)\s+([\s\S]+)$/);
  if (!match || Number(match[1]) !== session.supervisorPID || session.host !== host) return false;
  const command = match[2];
  const script = "/transport.py --host " + host;
  return command.includes(path.join(moduleData, "releases") + path.sep) &&
    (command.endsWith(script) || command.includes(script + " "));
}

async function stopLocalTransport(host) {
  const session = transportState(host);
  if (!session) return;
  const { stdout } = await run("/bin/ps", ["-p", String(session.supervisorPID), "-o", "pgid=,command="],
    { timeout: 2500, maxBuffer: 64 * 1024 }).catch(() => ({ stdout: "" }));
  if (!ownsTransportProcess(host, session, stdout)) return;
  try { process.kill(-session.supervisorPID, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  for (let count = 0; count < 20 && running(session.supervisorPID); count++) await pause(100);
}

async function disconnectHost(host) {
  const state = masters.get(host);
  masters.delete(host);
  if (state?.child && state.child.exitCode === null) state.child.kill();
  try { await run(ssh, [...sshConfigFor(host), "-S", socketFor(host), "-O", "exit", host], { timeout: 1800 }); }
  catch {}
}

let checkingConnections = false;

async function maintainConnections() {
  if (stop || checkingConnections) return;
  checkingConnections = true;
  try {
    await Promise.all(configuredHosts().filter(record => record.enabled).map(async ({ host }) => {
      if (projects().some(project => project.host === host)) {
        void warmWorkspace(host);
        return;
      }
      const state = masters.get(host);
      if (state?.status === "connected" && !(await checkMaster(host)) && masters.get(host) === state) {
        markDisconnected(state);
      }
      void connectHost(host);
    }));
  } finally {
    checkingConnections = false;
  }
}

async function browse(host, directory) {
  if (!validPath(directory) && directory !== "~") throw new UserFacingError("Enter an absolute remote folder path.");
  if (!configuredHosts().some(record => record.host === host && record.enabled)) {
    throw new UserFacingError("Connect to this host in Settings → Connections first.");
  }
  const script = "import json,os,sys;p=os.path.realpath(os.path.expanduser(sys.argv[1]));" +
    "children=sorted(e.name for e in os.scandir(p) if e.is_dir() and not e.name.startswith('.') and '\\n' not in e.name);" +
    "print(json.dumps({'path':p,'children':children[:400]}))";
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  try {
    const multiplex = masters.get(host)?.status === "connected" && await checkMaster(host)
      ? ["-S", socketFor(host), "-o", "ControlMaster=no", "-o", "ProxyCommand=/usr/bin/false"]
      : ["-S", "none", "-o", "ControlMaster=no"];
    const { stdout } = await run(ssh, [...sshConfigFor(host), ...sshOptions, "-T", ...multiplex, host,
      "python3 -c " + quote(script) + " " + quote(directory)], { timeout: 30000, maxBuffer: 512 * 1024 });
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
  const stable = await stableWorkspacePort(host);
  if (stable) return stable;
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

function transportState(host) {
  const session = jsonFile(path.join(legacy, host, "transport.json"));
  if (session?.schema !== 3 || session.backend !== "cli" || !Number.isInteger(session.port) || !running(session.supervisorPID)) return null;
  return session;
}

async function stableWorkspacePort(host) {
  const session = transportState(host);
  if (!session || session.state !== "connected" || typeof session.csrf !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(session.csrf)) return null;
  return (await loopbackPorts([session.supervisorPID])).includes(session.port) ? session.port : null;
}

async function workspacePort(project) {
  const host = project.host;
  const existing = await stableWorkspacePort(host);
  if (existing) return existing;
  let startup = opening.get(host);
  if (!startup) {
    startup = (async () => {
      let exited = false;
      if (!transportState(host)) {
        const child = spawn(python, [path.join(__dirname, "transport.py"), "--host", host, ...(appPID ? ["--app-pid", String(appPID)] : [])],
          { detached: true, stdio: "ignore" });
        child.once("error", () => { exited = true; });
        child.once("exit", () => { exited = true; });
        child.unref();
      }
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const port = await stableWorkspacePort(host);
        if (port) return port;
        if (exited) break;
        await pause(300);
      }
      throw new UserFacingError("The SSH transport could not start. It will retry automatically.");
    })().finally(() => opening.delete(host));
    opening.set(host, startup);
  }
  return startup;
}

function destinationFor(project, port) {
  const session = transportState(project.host);
  if (!frontendOrigin || !session?.csrf) return null;
  const address = new URL("/", frontendOrigin);
  address.searchParams.set("project", project.id);
  address.searchParams.set("__gravrelay_ssh", project.host);
  return { address: address.href, host: project.host, project: project.id,
    backend: "cli", rpcOrigin: "https://localhost:" + port, csrf: session.csrf };
}

function workspaceState(host) {
  let state = workspaces.get(host);
  if (!state) {
    let cached = jsonFile(catalogFile)?.hosts?.[host]?.conversations;
    if (!cached) {
      const previous = jsonFile(path.join(moduleData, "connection-cache.json"))?.projects;
      if (Array.isArray(previous)) cached = Object.fromEntries(previous.filter(item => item.host === host && Array.isArray(item.conversations)).map(item => [item.id, item.conversations]));
    }
    state = { pending: false, retryAt: 0, checkedAt: 0, port: null, conversations: cached ?? null, destination: null };
    workspaces.set(host, state);
  }
  return state;
}

async function warmWorkspace(host) {
  if (!configuredHosts().some(record => record.host === host && record.enabled)) return;
  const saved = projects().filter(project => project.host === host);
  if (!saved.length) return;
  const state = workspaceState(host);
  if (state.pending || state.mutating || state.retryAt > Date.now() || Date.now() - state.checkedAt < 6000) return;
  state.pending = true;
  const project = saved.find(item => item.id === selectedProjects.get(host)) ?? saved[0];
  try {
    const port = await workspacePort(project);
    state.port = port;
    state.destination = destinationFor(project, port);
    state.checkedAt = Date.now();
  } catch {
    const transport = transportState(host);
    state.port = transport?.port ?? null;
    state.destination = transport ? destinationFor(project, transport.port) : null;
    state.retryAt = Date.now() + 10000;
  } finally {
    state.pending = false;
  }
}

async function openCreatedProject(project) {
  const host = project.host;
  if (!configuredHosts().some(record => record.host === host && record.enabled)) {
    throw new UserFacingError("SSH is reconnecting. The project will load automatically.");
  }
  const port = await workspacePort(project);
  try {
    await run(python, [path.join(__dirname, "switch-project.py"),
      String(port), JSON.stringify(project)], { timeout: 45000, maxBuffer: 64 * 1024, env: { ...process.env, GRAVRELAY_BACKEND_SESSION: path.join(legacy, host, "transport.json") } });
  } catch {
    throw new UserFacingError("The SSH workspace could not open this project. Check the connection and folder.");
  }
  project.registered = true;
  project.pendingRegistration = false;
  persist(projectFile, { projects: projects() });
  selectedProjects.set(host, project.id);
  const state = workspaceState(host);
  state.port = port;
  state.destination = destinationFor(project, port);
  state.checkedAt = 0;
  state.conversations = { ...state.conversations, [project.id]: state.conversations?.[project.id] ?? [] };
  void warmWorkspace(host);
  return { workspace: state.destination };
}

const workspaceActions = new Set(["deleteProject", "rename", "pin", "archive", "markUnread", "deleteConversation", "stopConversation"]);

async function manageWorkspace(host, message) {
  const { operation, project: id, conversation, value } = message;
  const project = projects().find(item => item.host === host && item.id === id);
  const state = workspaceState(host);
  if (!workspaceActions.has(operation) || !project ||
      (operation !== "deleteProject" && (typeof conversation !== "string" || !uuid.test(conversation)))) {
    throw new UserFacingError("This SSH action is no longer available.");
  }
  if (state.mutating) throw new UserFacingError("Another SSH operation is in progress. Try again.");
  if (masters.get(host)?.status !== "connected" || !state.port) {
    throw new UserFacingError("The SSH workspace is reconnecting. Try again once connected.");
  }
  state.mutating = true;
  try {
    for (let i = 0; state.pending && i < 120; i++) await pause(100);
    if (state.pending || !state.port) throw new UserFacingError("The SSH workspace is still loading. Try again.");
    if (operation !== "deleteProject" && !state.conversations?.[id]?.some(item => item.id === conversation)) {
      throw new UserFacingError("This conversation is no longer in the project.");
    }
    try {
      await run(python, [path.join(__dirname, "switch-project.py"), String(state.port),
        JSON.stringify({ operation, project: id, conversation, value })], { timeout: 45000, maxBuffer: 64 * 1024, env: { ...process.env, GRAVRELAY_BACKEND_SESSION: path.join(legacy, host, "transport.json") } });
    } catch {
      throw new UserFacingError("The SSH workspace did not confirm this action. Refresh and try again.");
    }
    if (operation === "deleteProject") {
      savedProjects = projects().filter(item => item !== project);
      persist(projectFile, { projects: savedProjects });
      if (selectedProjects.get(host) === id) selectedProjects.delete(host);
      if (state.conversations) delete state.conversations[id];
      if (state.destination?.project === id) state.destination = null;
    } else if (operation !== "stopConversation") {
      const rows = state.conversations[id];
      if (operation === "deleteConversation") state.conversations[id] = rows.filter(item => item.id !== conversation);
      else {
        const row = rows.find(item => item.id === conversation);
        const field = { rename: "title", pin: "pinned", archive: "archived", markUnread: "unread" }[operation];
        row[field] = value;
        rows.sort((a, b) => Number(a.archived) - Number(b.archived) || Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated));
      }
    }
    return {};
  } finally {
    state.mutating = false;
    state.checkedAt = 0;
    void warmWorkspace(host);
  }
}

async function dispatch(message) {
  const { action, host, path: directory } = message;
  const records = configuredHosts();
  if (action === "snapshot") {
    const list = records.map(item => {
      const transport = transportState(item.host);
      const hasProjects = projects().some(project => project.host === item.host);
      const status = hasProjects
        ? transport?.state === "connected" ? "connected" : ["connecting", "prepared"].includes(transport?.state) ? "connecting" : "failed"
        : masters.get(item.host)?.status ?? "connecting";
      return { host: item.host, enabled: item.enabled, status: item.enabled ? status : "disconnected", error: transport?.error ?? null };
    });
    const connected = new Set(list.filter(item => item.status === "connected").map(item => item.host));
    const saved = projects().map(project => {
      const state = workspaces.get(project.host);
      const conversations = state?.conversations?.[project.id];
      return {
        ...project,
        loading: !Object.hasOwn(state?.conversations ?? {}, project.id),
        conversations: Array.isArray(conversations) ? conversations : null,
        canManage: Boolean(connected.has(project.host) && state?.port),
        workspace: connected.has(project.host) && state?.port
          ? destinationFor(project, state.port) : null,
      };
    });
    return { hosts: list, projects: saved, workspaces: list.flatMap(({ host }) => {
      const state = workspaces.get(host);
      return connected.has(host) && state?.destination ? [state.destination] : [];
    }) };
  }
  if (action === "catalog") {
    if (typeof host !== "string" || !records.some(item => item.host === host && item.enabled)) return {};
    const saved = projects().filter(project => project.host === host);
    const known = new Set(saved.map(project => project.id));
    const incoming = message.conversations;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return {};
    const conversations = {};
    for (const project of saved) {
      const rows = Array.isArray(incoming[project.id]) ? incoming[project.id] : [];
      conversations[project.id] = rows.slice(0, 200).filter(row =>
        typeof row?.id === "string" && uuid.test(row.id) && typeof row.title === "string"
      ).map(row => ({
        id: row.id, title: row.title.slice(0, 180),
        updated: typeof row.updated === "string" ? row.updated : "",
        workspace: typeof row.workspace === "string" ? row.workspace.slice(0, 180) : "",
        pinned: row.pinned === true, archived: row.archived === true, unread: row.unread === true,
        running: row.running === true, backgroundRunning: row.backgroundRunning === true,
      }));
    }
    workspaceState(host).conversations = conversations;
    cacheCatalog();
    let changed = false;
    for (const project of saved) {
      const name = message.names?.[project.id];
      if (typeof name === "string" && name.length && name.length <= 120 && name !== project.name) {
        project.name = name;
        changed = true;
      }
    }
    if (Array.isArray(message.projectIds) && message.projectIds.every(id => typeof id === "string" && uuid.test(id))) {
      const existing = new Set(message.projectIds);
      const previous = message.initial ? null : workspaceState(host).catalogProjectIds;
      workspaceState(host).catalogProjectIds = existing;
      savedProjects = projects().filter(project => {
        if (project.host !== host || !known.has(project.id) || existing.has(project.id) ||
            !previous?.has(project.id) || project.pendingRegistration) return true;
        changed = true;
        return false;
      });
    }
    if (changed) persist(projectFile, { projects: projects() });
    return {};
  }
  if (action === "aliases") {
    return (await availableAliases()).filter(name => !records.some(item => item.host === name));
  }
  if (action === "addManualHost") return addManualHost(message);
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
      const workspace = workspaces.get(host);
      if (workspace) { workspace.retryAt = 0; workspace.checkedAt = 0; }
      if (projects().some(project => project.host === host)) void warmWorkspace(host);
      else void connectHost(host);
    } else {
      await stopLocalTransport(host);
      workspaces.delete(host);
      await disconnectHost(host);
    }
    return {};
  }
  if (action === "browse") return browse(host, directory);
  if (action === "manage") return manageWorkspace(host, message);
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
    const project = prior ?? { id: randomUUID(), host, name, folders: unique, pendingRegistration: true };
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
  const host = candidate.searchParams.get("__gravrelay_ssh");
  if (!host || !alias.test(host) || candidate.origin !== frontendOrigin || candidate.username || candidate.password) return "";
  return configuredHosts().some(item => item.host === host && item.enabled) ? host : "";
}

function followWorkspaceTheme(parentOrigins) {
  if (window === window.top || globalThis.__gravRelayThemeInstalled) return;
  globalThis.__gravRelayThemeInstalled = true;
  const parents = new Set(parentOrigins);
  const themeClasses = ["theme-standalone", "dark", "dark-theme", "theme-dark", "theme-light"];
  const themeAttributes = ["data-agy-theme", "data-agy-home-glow", "data-newux-theme", "data-ag-theme-seeded"];
  const propertyName = /^--[a-zA-Z][a-zA-Z0-9-]*$/;
  const styleNames = ["color-scheme", "color", "background-color", "font-family"];
  let theme;

  function validPart(part) {
    return part && Array.isArray(part.classes) && part.classes.every(name => themeClasses.includes(name)) &&
      part.attributes && typeof part.attributes === "object" &&
      Object.entries(part.attributes).every(([name, value]) =>
        themeAttributes.includes(name) && (value === null || typeof value === "string" && value.length < 80)) &&
      part.properties && typeof part.properties === "object" &&
      Object.keys(part.properties).length <= 256 &&
      Object.entries(part.properties).every(([name, value]) =>
        (propertyName.test(name) || styleNames.includes(name)) && typeof value === "string" && value.length <= 2000);
  }

  function applyPart(element, part) {
    for (const name of themeClasses) {
      const enabled = part.classes.includes(name);
      if (element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled);
    }
    for (const name of themeAttributes) {
      const value = part.attributes[name] ?? null;
      if (element.getAttribute(name) === value) continue;
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
    for (const name of [...element.style]) {
      if (propertyName.test(name) && !Object.hasOwn(part.properties, name)) element.style.removeProperty(name);
    }
    for (const [name, value] of Object.entries(part.properties)) {
      if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
    }
  }

  function apply() {
    if (!theme || !document.body) return;
    applyPart(document.documentElement, theme.root);
    applyPart(document.body, theme.body);
  }

  window.addEventListener("message", event => {
    if (event.source !== window.parent || !parents.has(event.origin) ||
        event.data?.type !== "agy-ssh-theme") return;
    const candidate = event.data.theme;
    if (!candidate || !validPart(candidate.root) || !validPart(candidate.body)) return;
    theme = candidate;
    apply();
  });
  const observer = new MutationObserver(apply);
  const options = { attributes: true, attributeFilter: ["class", "style", ...themeAttributes] };
  observer.observe(document.documentElement, options);
  if (document.body) observer.observe(document.body, options);
  for (const origin of parents) window.parent.postMessage({ type: "agy-ssh-theme-ready" }, origin);
}

function installWorkspaceReadiness(parentOrigins) {
  if (window === window.top || globalThis.__gravRelayReadinessInstalled === 2) return;
  globalThis.__gravRelayReadinessInstalled = 2;
  const parents = new Set(parentOrigins);
  let previous;
  function announce(force = false) {
    const workspace = Boolean(document.querySelector('[data-testid="sidebar-split"]'));
    if (!workspace && !(location.pathname.startsWith("/onboarding") && document.querySelector("button"))) return;
    if (!force && previous === workspace) return;
    previous = workspace;
    for (const origin of parents) window.parent.postMessage({
      type: "agy-ssh-ready", actions: globalThis.__gravRelayWorkspaceActions === true, workspace,
    }, origin);
  }
  window.addEventListener("message", event => {
    if (event.source === window.parent && parents.has(event.origin) && event.data?.type === "agy-ssh-probe") announce(true);
  });
  const observer = new MutationObserver(() => announce());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  announce();
}

function followWorkspaceCatalog(parentOrigins) {
  if (window === window.top || globalThis.__gravRelayCatalogInstalled) return;
  globalThis.__gravRelayCatalogInstalled = true;
  const parents = new Set(parentOrigins);
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  let store, registry, scheduled = false, catalogSignature = "";

  function publish(force = false) {
    if (!store) return;
          const summaries = store.getState()?.trajectorySummaries?.summaries;
          if (!summaries) return;
          const conversations = {}, names = {};
          const projects = registry?.projectsStateProvider?.getState();
          const ids = Array.isArray(projects) ? projects.map(item => item.project?.id).filter(id => uuid.test(id)) : undefined;
          for (const [id, summary] of Object.entries(summaries)) {
            if (!summary) continue;
            const metadata = summary.trajectoryMetadata, annotations = summary.annotations ?? {};
            const project = metadata?.projectId;
            if (!uuid.test(id) || !uuid.test(project) || metadata.parentConversationId) continue;
            const rows = conversations[project] ??= [];
            if (rows.length >= 200) continue;
            const seconds = Number(summary.lastModifiedTime?.seconds ?? 0);
            const viewed = Number(annotations.lastUserViewTime?.seconds ?? 0);
            rows.push({
              id, title: String(annotations.title || summary.summary || "Untitled conversation").slice(0, 180),
              updated: seconds ? new Date(seconds * 1000).toISOString() : "",
              workspace: (() => {
                try {
                  const value = metadata.workspaceUris?.[0];
                  return typeof value === "string" ? decodeURIComponent(new URL(value).pathname).split("/").filter(Boolean).at(-1) ?? "" : "";
                } catch { return ""; }
              })(), pinned: annotations.pinned === true, archived: annotations.archived === true,
              unread: annotations.markedAsUnread === true || !summary.notFullyIdle && seconds > viewed,
              running: !summary.killed && ([2, 3, 4].includes(summary.status) || summary.hasRunningSubagents === true),
              backgroundRunning: !summary.killed && !summary.hasRunningSubagents &&
                ![2, 3, 4].includes(summary.status) && summary.notFullyIdle === true,
            });
          }
          for (const [id, rows] of Object.entries(conversations)) {
            rows.sort((a, b) => Number(a.archived) - Number(b.archived) ||
              Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated));
            const project = registry?.getProjectStateProvider(id)?.getState()?.project;
            if (project?.name) names[id] = project.name;
          }
          const data = { type: "agy-ssh-catalog", conversations, names, projectIds: ids, initial: !catalogSignature };
          const signature = JSON.stringify(data);
          if (force || signature !== catalogSignature) {
            catalogSignature = signature;
            for (const origin of parents) window.parent.postMessage(data, origin);
          }

  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; publish(); });
  }

  function findStore() {
    const root = document.querySelector('[data-testid="sidebar-split"]');
    const key = Object.keys(root || {}).find(name => name.startsWith("__reactFiber"));
    for (let fiber = root?.[key], depth = 0; fiber && depth < 400; fiber = fiber.return, depth++) {
      const props = fiber.memoizedProps;
      const core = props?.value?.core;
      if (core && !registry) registry = Object.values(core).find(service =>
        service && typeof service.getProjectStateProvider === "function" && service.projectsStateProvider);
      if (!store) {
        const candidate = [props?.store, props?.value?.store, props?.value].find(value =>
          value?.subscribe && value?.getState?.()?.trajectorySummaries);
        if (candidate) {
          store = candidate;
          store.subscribe(schedule);
        }
      }
    }
    if (!store) return false;
    publish(true);
    return true;
  }

  window.addEventListener("message", event => {
    if (event.source === window.parent && parents.has(event.origin) && event.data?.type === "agy-ssh-catalog-probe") {
      if (!store) findStore();
      else publish(true);
    }
  });
  if (!findStore()) {
    const observer = new MutationObserver(() => { if (findStore()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}

async function styleWorkspaceFrame(url, parentOrigins, contextId) {
  const client = new CDP(url);
  try {
    await client.ready;
    const result = await client.send("Runtime.evaluate", { ...(contextId ? { contextId } : {}), returnByValue: true, expression: `(() => {
      if (window === window.top || !document.head) return false;
      (${installNativePermissions.toString()})();
      (${installRemoteFiles.toString()})();
      (${followWorkspaceTheme.toString()})(${JSON.stringify(parentOrigins)});
      (${installWorkspaceReadiness.toString()})(${JSON.stringify(parentOrigins)});
      (${followWorkspaceCatalog.toString()})(${JSON.stringify(parentOrigins)});
      if (globalThis.__gravRelayWorkspaceActions) return true;
      const style = document.getElementById("agy-embedded-workspace-style") ?? document.createElement("style");
      style.id = "agy-embedded-workspace-style";
      style.textContent = '[data-testid="sidebar-split"] > :has([role="navigation"]), ' +
        '[data-testid="sidebar-split"] > :has([role="navigation"]) + :not(:last-child), ' +
        '[data-testid="sidebar-split"] ~ .absolute.left-0.top-0:has([data-testid="sidebar-toggle"]) { display:none!important }';
      if (!style.isConnected) document.head.append(style);
      globalThis.__agyEmbeddedSidebarHandled = true;
      globalThis.__gravRelayWorkspaceActions = true;
      const parents = new Set(${JSON.stringify(parentOrigins)});
      const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
      const notify = data => {
        for (const origin of parents) window.parent.postMessage(data, origin);
      };
      let store, previousLayout;
      function panes(node) {
        if (node?.type === "pane") return [node];
        return node?.type === "split" && Array.isArray(node.children) ? node.children.flatMap(panes) : [];
      }
      function currentLayout() {
        if (!store) {
          const root = document.querySelector('[data-testid="sidebar-split"]');
          const key = Object.keys(root || {}).find(key => key.startsWith("__reactFiber"));
          for (let fiber = root?.[key], depth = 0; fiber && depth < 400; fiber = fiber.return, depth++) {
            const props = fiber.memoizedProps;
            store = [props?.store, props?.value?.store, props?.value].find(candidate =>
              candidate?.dispatch && candidate?.subscribe && candidate?.getState?.()?.multiConvoLayout);
            if (store) {
              store.subscribe(announceLayout);
              break;
            }
          }
        }
        return store?.getState()?.multiConvoLayout;
      }
      function announceLayout() {
        const root = store?.getState()?.multiConvoLayout?.rootNode;
        if (root === previousLayout) return;
        previousLayout = root;
        notify({ type: "agy-ssh-panes", conversations: panes(root).map(pane => pane.cascadeId) });
      }
      function navigate(destination) {
        if (destination.href === location.href) return;
        history.pushState(history.state, "", destination.href);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      }
      window.addEventListener("message", event => {
        if (event.source !== window.parent || !parents.has(event.origin)) return;
        const data = event.data;
        if (data?.type !== "agy-ssh-select" || !uuid.test(data.project) ||
            data.conversation && !uuid.test(data.conversation)) return;
        // An older integration may still have a handler in this frame.
        event.stopImmediatePropagation();
        const projectPage = new URL("/", location.origin);
        projectPage.searchParams.set("project", data.project);
        const operation = data.operation;
        if (["splitRight", "splitDown", "replacePane", "removePane"].includes(operation) && data.conversation) {
          const apply = () => {
            const layout = currentLayout();
            if (!layout?.focusedPaneId) {
              notify({ type: "agy-ssh-action-error", message: "The conversation layout is still loading. Try again." });
              return;
            }
            const open = panes(layout.rootNode);
            const pane = open.find(item => item.cascadeId === data.conversation);
            if (operation === "replacePane") {
              if (pane) store.dispatch({ type: "multiConvoLayout/resetPane", payload: { paneId: pane.id, cascadeId: "_new" } });
            } else if (operation === "removePane") {
              if (pane && open.length > 1) store.dispatch({ type: "multiConvoLayout/closePane", payload: pane.id });
            } else {
              store.dispatch({ type: "multiConvoLayout/splitPane", payload: {
                targetPaneId: pane?.id ?? layout.focusedPaneId,
                cascadeId: pane ? "_new" : data.conversation,
                direction: operation === "splitRight" ? "horizontal" : "vertical",
              } });
            }
            announceLayout();
          };
          if (new URL(location.href).searchParams.get("project") !== data.project) {
            navigate(projectPage);
            requestAnimationFrame(() => requestAnimationFrame(apply));
          } else apply();
          return;
        }
        if (data.conversation) projectPage.pathname = "/c/" + data.conversation;
        if (operation === "settings") {
          projectPage.searchParams.set("settingsOpen", "true");
          projectPage.searchParams.set("settingsProjectId", data.project);
        }
        navigate(projectPage);
        currentLayout();
        announceLayout();
      }, { capture: true });
      const announce = () => {
        if (!document.querySelector('[data-testid="sidebar-split"]') &&
            !(location.pathname.startsWith("/onboarding") && document.querySelector("button"))) return false;
        notify({ type: "agy-ssh-ready", actions: true });
        currentLayout();
        announceLayout();
        return true;
      };
      if (!announce()) {
        const observer = new MutationObserver(() => { if (announce()) observer.disconnect(); });
        observer.observe(document.documentElement, {childList:true,subtree:true});
      }
      return true;
    })()` });
    return result.result.value === true;
  } finally { client.close(); }
}

async function attach(url, allowedPorts) {
  const client = new CDP(url);
  let context, generation = 0, requests = 0;
  const childContexts = new Map(), frameURLs = new Map(), styledChildren = new Set();
  let rootFrameId;

  async function mount(frame) {
    const expected = ++generation;
    context = undefined;
    frameURLs.set(frame.id, frame.url);
    if (frame.parentId) return;
    const local = localPage(frame.url, await allowedPorts(frame.url));
    if (local) frontendOrigin = new URL(frame.url).origin;
    rootFrameId = frame.id;
    const host = local ? "" : await workspaceHost(frame.url);
    if (!local && !host) return;
    const { executionContextId } = await client.send("Page.createIsolatedWorld", {
      frameId: frame.id, worldName: world, grantUniveralAccess: false,
    });
    if (generation !== expected) return;
    if (generation !== expected) return;
    context = executionContextId;
    const source = fs.readFileSync(panelPath, "utf8");
    const evaluation = await client.send("Runtime.evaluate", {
      expression: "globalThis.__agyConnectionsRemoteHost = " + JSON.stringify(host) + ";\n" + source,
      contextId: context,
    });
    if (evaluation.exceptionDetails) throw new Error("Cannot mount SSH panel: " + (evaluation.exceptionDetails.exception?.description?.split("\\n")[0] ?? evaluation.exceptionDetails.text));
  }

  try {
    await client.ready;
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: "(" + installCLIFrontend.toString() + ")();" });
    client.events.set("Runtime.executionContextCreated", ({ context: child }) => {
      if (child.auxData?.isDefault) childContexts.set(child.id, child);
    });
    client.events.set("Runtime.executionContextDestroyed", ({ executionContextId }) => {
      childContexts.delete(executionContextId); styledChildren.delete(executionContextId);
    });
    client.events.set("Runtime.bindingCalled", packet => {
      if (packet.name !== binding || packet.executionContextId !== context ||
          packet.payload.length > 262144 || requests > 7) return;
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
      frameURLs.set(frame.id, frame.url);
      if (!frame.parentId) mount(frame).catch(() => {});
    });
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Runtime.addBinding", { name: binding, executionContextName: world });
    const { frameTree } = await client.send("Page.getFrameTree");
    const remember = tree => { frameURLs.set(tree.frame.id, tree.frame.url); for (const child of tree.childFrames ?? []) remember(child); };
    remember(frameTree);
    await mount(frameTree.frame);
    return {
      client,
      async refreshFrames() {
        for (const child of childContexts.values()) {
          if (child.auxData.frameId === rootFrameId || styledChildren.has(child.id)) continue;
          const address = frameURLs.get(child.auxData.frameId);
          if (!address || !(await workspaceHost(address))) continue;
          if (await styleWorkspaceFrame(url, [frontendOrigin], child.id).catch(() => false)) styledChildren.add(child.id);
        }
      },
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
  appPID = parent.pid;
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
        await Promise.allSettled([...attached.values()].map(entry => entry.refreshFrames()));
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
    await Promise.allSettled([...masters].filter(([, state]) => state.child).map(([host]) => disconnectHost(host)));
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { stop = true; });
main().catch(() => {
  console.error("GravRelay could not start. Run the installer with the doctor command.");
  process.exitCode = 1;
});
