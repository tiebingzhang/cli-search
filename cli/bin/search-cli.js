#!/usr/bin/env node
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SOCK_DIR = path.join(os.homedir(), '.chrome-cli-search');
const SOCK_PATH = path.join(SOCK_DIR, 'daemon.sock');
const PID_PATH = path.join(SOCK_DIR, 'daemon.pid');
const DAEMON_SCRIPT = path.join(__dirname, '..', 'lib', 'daemon.js');

function tryConnect() {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK_PATH);
    conn.once('connect', () => resolve(conn));
    conn.once('error', reject);
  });
}

async function ensureDaemon() {
  try {
    return await tryConnect();
  } catch (e) {
    const child = spawn(process.execPath, [DAEMON_SCRIPT], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        return await tryConnect();
      } catch (e2) {
        // keep retrying
      }
    }
    throw new Error('failed to start daemon');
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

async function startDaemon() {
  if (fs.existsSync(PID_PATH)) {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8'), 10);
    if (isRunning(pid)) {
      console.log(`daemon already running (pid ${pid})`);
      return;
    }
    fs.unlinkSync(PID_PATH);
  }
  const child = spawn(process.execPath, [DAEMON_SCRIPT], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const conn = await tryConnect();
      conn.end();
      console.log(`daemon started (pid ${child.pid})`);
      return;
    } catch (e) {
      // keep waiting
    }
  }
  throw new Error('failed to start daemon');
}

function stopDaemon() {
  if (!fs.existsSync(PID_PATH)) {
    console.log('daemon not running');
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8'), 10);
  if (!isRunning(pid)) {
    fs.unlinkSync(PID_PATH);
    console.log('daemon not running');
    return;
  }
  process.kill(pid, 'SIGTERM');
  console.log(`daemon stopped (pid ${pid})`);
}

async function statusDaemon() {
  if (!fs.existsSync(PID_PATH)) {
    console.log('daemon not running');
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8'), 10);
  if (!isRunning(pid)) {
    console.log('daemon not running (stale pid file)');
    return;
  }
  try {
    const conn = await tryConnect();
    conn.end();
    console.log(`daemon running (pid ${pid})`);
  } catch (e) {
    console.log(`daemon process alive (pid ${pid}) but socket not responding`);
  }
}

function printHelp() {
  console.log(`usage: search-cli <command> [args]

commands:
  start                     start the background daemon
  stop                      stop the background daemon
  status                    show whether the daemon is running
  google <query>            search Google and return page text
  ddg <query>               search DuckDuckGo and return page text
  visit <url>               open a URL and return page text
  attach                    target the browser's current active tab for later commands
  snapshot                  label clickable/input elements on the current tab, print their IDs
  snapshot --context        print the page text with element IDs inlined in context
  click <ID>                click the element with the given snapshot ID
  type <ID> <text>          type text into the input with the given snapshot ID
  readdropdown <ID>         list every option of an open dropdown/select, scrolling if needed
  selectoption <ID> <value> choose an option on a native <select> by value, index, or text
  screenshot [path]         save a PNG of the current tab's visible viewport

options (google/ddg/visit only):
  --wait=ms                 wait this long after load before reading the page (default 1000)
  --links                   return links instead of page text`);
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);

  if (!action || action === '-h' || action === '--help' || action === 'help') {
    printHelp();
    return;
  }

  if (action === 'start') {
    await startDaemon();
    return;
  }
  if (action === 'stop') {
    stopDaemon();
    return;
  }
  if (action === 'status') {
    await statusDaemon();
    return;
  }

  if (action === 'attach') {
    const res = await sendRequest({ action: 'attach' });
    console.log(`attached to tab ${res.tabId}: ${res.title || res.url}`);
    return;
  }

  if (action === 'snapshot') {
    const context = rest.includes('--context');
    const res = await sendRequest({ action: 'snapshot', context });
    if (context) {
      process.stdout.write(res.text + '\n');
    } else {
      process.stdout.write(JSON.stringify(res.elements, null, 2) + '\n');
    }
    return;
  }

  if (action === 'click') {
    const [elementId] = rest;
    if (!elementId) {
      console.error('usage: search-cli click <ID>');
      process.exit(1);
    }
    await sendRequest({ action: 'click', elementId });
    console.log(`clicked ${elementId}`);
    return;
  }

  if (action === 'type') {
    const [elementId, ...textParts] = rest;
    const text = textParts.join(' ');
    if (!elementId || !text) {
      console.error('usage: search-cli type <ID> <text>');
      process.exit(1);
    }
    await sendRequest({ action: 'type', elementId, text });
    console.log(`typed into ${elementId}`);
    return;
  }

  if (action === 'readdropdown') {
    const [elementId] = rest;
    if (!elementId) {
      console.error('usage: search-cli readdropdown <ID>');
      process.exit(1);
    }
    const res = await sendRequest({ action: 'readdropdown', elementId });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (action === 'selectoption') {
    const [elementId, ...valueParts] = rest;
    const value = valueParts.join(' ');
    if (!elementId || !value) {
      console.error('usage: search-cli selectoption <ID> <value>');
      process.exit(1);
    }
    const res = await sendRequest({ action: 'selectoption', elementId, value });
    console.log(`selected "${res.text}" (${res.value}) on ${elementId}`);
    return;
  }

  if (action === 'screenshot') {
    const [outPath] = rest;
    const dest = outPath || path.join(os.tmpdir(), `screenshot-${process.pid}.png`);
    const res = await sendRequest({ action: 'screenshot' });
    fs.writeFileSync(dest, Buffer.from(res.png, 'base64'));
    console.log(dest);
    return;
  }

  if (!['google', 'ddg', 'visit'].includes(action)) {
    console.error(
      'usage: search-cli <start|stop|status|google|ddg|visit|attach|snapshot|click|type|readdropdown|selectoption|screenshot> [args] [--wait=ms] [--links]'
    );
    process.exit(1);
  }

  let waitMs = 1000;
  let links = false;
  const args = [];
  for (const token of rest) {
    const m = /^--wait=(\d+)$/.exec(token);
    if (m) {
      waitMs = parseInt(m[1], 10);
    } else if (token === '--links') {
      links = true;
    } else {
      args.push(token);
    }
  }

  const arg = args.join(' ');
  if (!arg) {
    console.error('missing query/url argument');
    process.exit(1);
  }
  const req = action === 'visit' ? { action, url: arg, waitMs, links } : { action, query: arg, waitMs, links };
  const res = await sendRequest(req);
  process.stdout.write(res.text + '\n');
}

async function sendRequest(req) {
  const conn = await ensureDaemon();
  return new Promise((resolve, reject) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      const res = JSON.parse(line);
      conn.end();
      if (res.error) {
        reject(new Error(res.error));
      } else {
        resolve(res);
      }
    });
    conn.write(JSON.stringify(req) + '\n');
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
