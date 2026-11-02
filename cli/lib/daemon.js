#!/usr/bin/env node
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const WS_PORT = 47285;
const SOCK_DIR = path.join(os.homedir(), '.chrome-cli-search');
const SOCK_PATH = path.join(SOCK_DIR, 'daemon.sock');
const PID_PATH = path.join(SOCK_DIR, 'daemon.pid');
const PIN_PATH = path.join(SOCK_DIR, 'extension-id');
const TIMEOUT_MS = 30000;

// --- security ---
// The daemon is reachable by anything that can open a TCP port, and a WebSocket
// handshake from a web page always carries an Origin header. Pinning the handshake
// to the extension's own chrome-extension:// origin means no page the user visits can
// open ws://127.0.0.1:47285 and drive their logged-in browser (CSWSH). The first
// extension to connect is pinned (TOFU); `search-cli unpin` re-pins after a reinstall.
// Residual: a local non-browser client can forge an Origin header. See TODO.md.
const EXT_ORIGIN_PREFIX = 'chrome-extension://';

function mkdirPrivate() {
  if (!fs.existsSync(SOCK_DIR)) fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(SOCK_DIR, 0o700); } catch (e) { /* best effort */ }
}

function readPinnedId() {
  try { return fs.readFileSync(PIN_PATH, 'utf8').trim() || null; } catch (e) { return null; }
}

function writePinnedId(id) {
  fs.writeFileSync(PIN_PATH, id, { mode: 0o600 });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function removeIfExists(p) {
  try { fs.unlinkSync(p); } catch (e) { /* best effort */ }
}

// A second daemon instance would unlink the live socket and overwrite the pid file,
// orphaning the running daemon and silently breaking the CLI. Probe before touching either.
function socketResponds(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCK_PATH)) return resolve(false);
    const conn = net.createConnection(SOCK_PATH);
    const done = (v) => {
      clearTimeout(timer);
      conn.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    conn.once('connect', () => conn.write(JSON.stringify({ action: 'ping' }) + '\n'));
    conn.once('data', () => done(true));
    conn.once('error', () => done(false));
  });
}

mkdirPrivate();

function cleanup() {
  removeIfExists(SOCK_PATH);
  removeIfExists(PID_PATH);
  process.exit(0);
}
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

let wss = null;
// Chrome can hold more than one socket from this extension at once (the previous
// service worker's socket lingers after a restart), so track all of them and send on
// the newest one that is actually OPEN. Replies are accepted from any pinned socket.
const extSockets = new Set();
const pending = new Map();
const waitingForExt = [];
let nextId = 1;
const rejected = [];

function currentExt() {
  const list = [...extSockets];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].readyState === WebSocket.OPEN) return list[i];
  }
  return null;
}

function noteRefusal(reason) {
  rejected.push(`${new Date().toISOString()} ${reason}`);
  if (rejected.length > 20) rejected.shift();
  console.error(`search-cli daemon: refused WebSocket handshake (${reason})`);
}

function failPending(message) {
  for (const [, cb] of pending) cb({ error: message });
  pending.clear();
  const drained = waitingForExt.slice();
  waitingForExt.length = 0;
  for (const { conn } of drained) conn.end(JSON.stringify({ error: message }) + '\n');
}

function status() {
  return {
    pid: process.pid,
    pinnedExtensionId: readPinnedId(),
    extensionConnected: !!currentExt(),
    refusedHandshakes: rejected,
  };
}

function isLocalAction(action) {
  return action === 'status' || action === 'ping';
}

function localResponse(req) {
  if (req.action === 'ping') return { ok: true, pid: process.pid };
  return { ok: true, ...status() };
}

function extensionHint() {
  const base = 'timed out waiting for extension to connect';
  if (!rejected.length) return `${base} - load the extension/ directory in chrome://extensions (Developer mode)`;
  return `${base} - last handshake refused: ${rejected[rejected.length - 1]}`;
}

function verifyClient(info, done) {
  const origin = (info.req.headers || {}).origin;
  if (typeof origin !== 'string' || !origin.startsWith(EXT_ORIGIN_PREFIX)) {
    noteRefusal(`origin ${JSON.stringify(origin === undefined ? null : origin)} is not an extension origin`);
    return done(false, 403, 'forbidden');
  }
  const id = origin.slice(EXT_ORIGIN_PREFIX.length);
  const pinned = readPinnedId();
  if (pinned === null) {
    writePinnedId(id);
    console.error(`search-cli daemon: pinned extension id ${id}`);
    return done(true);
  }
  if (pinned === id) return done(true);
  noteRefusal(`origin ${origin} does not match pinned id ${pinned}; run 'search-cli unpin' to re-pin`);
  return done(false, 403, 'forbidden');
}

function createWss() {
  wss = new WebSocket.Server({ host: '127.0.0.1', port: WS_PORT, verifyClient });

  wss.on('error', (err) => {
    console.error(`search-cli daemon: cannot listen on 127.0.0.1:${WS_PORT} (${err.message})`);
    process.exit(1);
  });

  wss.on('connection', (ws) => {
    extSockets.add(ws);
    ws.on('close', () => {
      extSockets.delete(ws);
      if (extSockets.size === 0) {
        failPending('extension disconnected before answering (reload it; run `search-cli status`, or `search-cli unpin` if its id changed)');
      }
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return;
      }
      const cb = pending.get(msg.id);
      if (cb) {
        pending.delete(msg.id);
        cb(msg);
      }
    });

    while (waitingForExt.length) {
      const { req, conn } = waitingForExt.shift();
      if (isLocalAction(req.action)) conn.end(JSON.stringify(localResponse(req)) + '\n');
      else dispatch(req, conn);
    }
  });
}

function handle(req, conn) {
  if (isLocalAction(req.action)) {
    return conn.end(JSON.stringify(localResponse(req)) + '\n');
  }
  if (!currentExt()) {
    const entry = { req, conn };
    waitingForExt.push(entry);
    const timer = setTimeout(() => {
      const idx = waitingForExt.indexOf(entry);
      if (idx !== -1) {
        waitingForExt.splice(idx, 1);
        conn.end(JSON.stringify({ error: extensionHint() }) + '\n');
      }
    }, TIMEOUT_MS);
    conn.once('close', () => clearTimeout(timer));
    return;
  }
  dispatch(req, conn);
}

function dispatch(req, conn) {
  const ws = currentExt();
  if (!ws) {
    return conn.end(JSON.stringify({ error: extensionHint() }) + '\n');
  }
  const id = nextId++;
  const timeoutMs = typeof req.maxWaitMs === 'number' ? Math.max(TIMEOUT_MS, req.maxWaitMs + 10000) : TIMEOUT_MS;
  const timer = setTimeout(() => {
    pending.delete(id);
    conn.end(JSON.stringify({ error: 'timed out waiting for browser' }) + '\n');
  }, timeoutMs);

  pending.set(id, (msg) => {
    clearTimeout(timer);
    const { id: _drop, ...rest } = msg;
    conn.end(JSON.stringify(rest) + '\n');
  });
  ws.send(JSON.stringify({ ...req, id }));
}

const server = net.createServer((conn) => {
  let buf = '';
  conn.on('data', (chunk) => {
    buf += chunk;
    const idx = buf.indexOf('\n');
    if (idx === -1) return;
    const line = buf.slice(0, idx);
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      conn.end(JSON.stringify({ error: 'bad request' }) + '\n');
      return;
    }
    handle(req, conn);
  });
});

server.on('error', (err) => {
  console.error(`search-cli daemon: unix socket error (${err.message})`);
  process.exit(1);
});

async function start() {
  if (fs.existsSync(PID_PATH)) {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8'), 10);
    if (Number.isFinite(pid) && pid > 0 && pidAlive(pid) && (await socketResponds())) {
      console.error(`search-cli daemon: already running (pid ${pid}); refusing to start a second instance`);
      process.exit(1);
    }
    console.error('search-cli daemon: clearing stale pid/socket left by a dead instance');
    removeIfExists(PID_PATH);
  }
  if (fs.existsSync(SOCK_PATH)) {
    if (await socketResponds()) {
      console.error('search-cli daemon: another daemon answers on the socket; refusing to start');
      process.exit(1);
    }
    removeIfExists(SOCK_PATH);
  }
  fs.writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
  createWss();
  server.listen(SOCK_PATH, () => {
    try { fs.chmodSync(SOCK_PATH, 0o600); } catch (e) { /* best effort */ }
  });
}

start().catch((err) => {
  console.error('search-cli daemon: ' + err.message);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('search-cli daemon: ' + err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('search-cli daemon: ' + (err && err.message ? err.message : err));
});
