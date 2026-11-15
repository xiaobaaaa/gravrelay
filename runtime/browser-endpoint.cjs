"use strict";

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const alias = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const browserId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function reservePort(preferred = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({host:'127.0.0.1', port:preferred, exclusive:true}, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function ownsForward(child, port) {
  if (!Number.isInteger(child?.pid) || child.pid < 1 || child.exitCode !== null) return false;
  const executable = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  try {
    const {stdout} = await run(executable, ['-nP', '-a', '-p', String(child.pid), '-iTCP:' + port,
      '-sTCP:LISTEN', '-Fpn'], {timeout:2500,maxBuffer:16*1024});
    const lines = stdout.trim().split('\n');
    return lines.includes('p' + child.pid) && lines.some(line => line === 'n127.0.0.1:' + port);
  } catch { return false; }
}

function versionAt(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({host:'127.0.0.1',port,path:'/json/version',agent:false,
      headers:{Connection:'close'}}, response => {
      const chunks = []; let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 65536) request.destroy(new Error('Invalid browser endpoint response.'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        if (response.statusCode !== 200) return reject(new Error('The SSH browser endpoint is not ready.'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid browser endpoint response.')); }
      });
    });
    request.setTimeout(1800, () => request.destroy(new Error('The SSH browser endpoint timed out.')));
    request.once('error', reject);
  });
}

function localIdentity(value, port) {
  if (!value || !/^(HeadlessChrome|Chrome|Chromium)\//.test(value.Browser || '')) return null;
  let url;
  try { url = new URL(value.webSocketDebuggerUrl); } catch { return null; }
  const match = url.pathname.match(/^\/devtools\/browser\/([0-9a-f-]{36})$/i);
  return url.protocol === 'ws:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash && Number(url.port) === port &&
    match && browserId.test(match[1]) ? match[1] : null;
}

function createBrowserEndpoints({runRemote, openForward, ownsForward:verifyOwner = ownsForward,
                                 reconnectDelay = count => Math.min(1000 * 2 ** Math.min(count, 5), 30000), readyTimeout = 15000} = {}) {
  if (typeof runRemote !== 'function' || typeof openForward !== 'function')
    throw new TypeError('Browser endpoint callbacks are required.');
  const states = new Map();
  let closed = false;
  const alive = child => child && child.exitCode === null && !child.killed;
  function stopChild(child) { if (alive(child)) child.kill(); }
  function retry(state) {
    if (closed || state.timer || !state.active) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      ensure(state.host).catch(() => { state.failures++; retry(state); });
    }, reconnectDelay(state.failures));
    state.timer.unref?.();
  }
  function watch(state, child) {
    const disconnected = () => {
      if (state.child !== child) return;
      state.child = null;
      retry(state);
    };
    child.once('exit', disconnected);
    child.once('error', disconnected);
  }
  async function healthy(state, expected) {
    if (!alive(state.child) || !(await verifyOwner(state.child, state.port))) return false;
    try { return localIdentity(await versionAt(state.port), state.port) === expected; }
    catch { return false; }
  }
  async function connect(state) {
    if (state.identity && await healthy(state, state.identity)) return 'http://127.0.0.1:' + state.port + '/';
    const old = state.child;
    state.child = null;
    if (alive(old)) {
      const ended = new Promise(resolve => { old.once('exit', resolve); old.once('error', resolve); setTimeout(resolve, 2500).unref?.(); });
      stopChild(old); await ended;
    }
    if (closed) throw new Error('The SSH browser connection was closed.');
    const source = fs.readFileSync(path.join(__dirname, 'browser_remote.py'), 'utf8');
    const raw = await runRemote(state.host, source);
    const remote = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
    if (remote?.ok !== true) throw new Error(remote?.message || 'Could not prepare the SSH browser.');
    if (!Number.isInteger(remote.remotePort) || remote.remotePort < 1024 || remote.remotePort > 65535 ||
        !browserId.test(remote.browserId || '')) throw new Error('The SSH host returned an invalid browser identity.');
    if (closed) throw new Error('The SSH browser connection was closed.');
    state.port = await reservePort(state.port || 0);
    if (closed) throw new Error('The SSH browser connection was closed.');
    const child = await openForward(state.host, remote.remotePort, state.port);
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function')
      throw new Error('Could not start the owned SSH browser forward.');
    if (closed) { stopChild(child); throw new Error('The SSH browser connection was closed.'); }
    state.child = child;
    watch(state, child);
    try {
      const deadline = Date.now() + readyTimeout;
      while (Date.now() < deadline && !closed && state.child === child && alive(child)) {
        if (await verifyOwner(child, state.port)) {
          const value = await versionAt(state.port).catch(() => null);
          const identity = localIdentity(value, state.port);
          if (identity) {
            if (identity !== remote.browserId) throw new Error('The local browser port belongs to a different browser.');
            state.identity = identity; state.failures = 0;
            return 'http://127.0.0.1:' + state.port + '/';
          }
        }
        await pause(120);
      }
      throw new Error('The owned SSH browser forward did not become ready.');
    } catch (error) {
      if (state.child === child) state.child = null;
      stopChild(child);
      throw error;
    }
  }
  function ensure(host) {
    if (closed) return Promise.reject(new Error('The SSH browser connection was closed.'));
    if (typeof host !== 'string' || !alias.test(host)) return Promise.reject(new Error('Invalid SSH browser host.'));
    let state = states.get(host);
    if (!state) { state={host,active:true,port:0,child:null,pending:null,timer:null,failures:0,identity:null}; states.set(host,state); }
    clearTimeout(state.timer); state.timer = null;
    if (state.pending) return state.pending;
    state.pending = connect(state).finally(() => { state.pending = null; });
    return state.pending;
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const state of states.values()) {
      state.active = false; clearTimeout(state.timer);
      const child = state.child; state.child = null; stopChild(child);
    }
    states.clear();
  }
  return {ensure,close};
}
module.exports = {createBrowserEndpoints, localIdentity};
