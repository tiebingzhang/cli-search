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
const TIMEOUT_MS = 30000;

if (!fs.existsSync(SOCK_DIR)) fs.mkdirSync(SOCK_DIR, { recursive: true });
if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH);
fs.writeFileSync(PID_PATH, String(process.pid));

function cleanup() {
  if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH);
  if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  process.exit(0);
}
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

let extSocket = null;
const pending = new Map();
const waitingForExt = [];
let nextId = 1;

const wss = new WebSocket.Server({ host: '127.0.0.1', port: WS_PORT });

wss.on('connection', (ws) => {
  extSocket = ws;
  ws.on('close', () => {
    if (extSocket === ws) extSocket = null;
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
    dispatch(req, conn);
  }
});

function handle(req, conn) {
  if (!extSocket || extSocket.readyState !== WebSocket.OPEN) {
    const entry = { req, conn };
    waitingForExt.push(entry);
    const timer = setTimeout(() => {
      const idx = waitingForExt.indexOf(entry);
      if (idx !== -1) {
        waitingForExt.splice(idx, 1);
        conn.end(JSON.stringify({ error: 'timed out waiting for extension to connect' }) + '\n');
      }
    }, TIMEOUT_MS);
    conn.once('close', () => clearTimeout(timer));
    return;
  }
  dispatch(req, conn);
}

function dispatch(req, conn) {
  const id = nextId++;
  const timer = setTimeout(() => {
    pending.delete(id);
    conn.end(JSON.stringify({ error: 'timed out waiting for browser' }) + '\n');
  }, TIMEOUT_MS);
  pending.set(id, (msg) => {
    clearTimeout(timer);
    const { id: _drop, ...rest } = msg;
    conn.end(JSON.stringify(rest) + '\n');
  });
  extSocket.send(JSON.stringify({ ...req, id }));
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

server.listen(SOCK_PATH);
