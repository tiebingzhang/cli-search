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
  type --focused <text>     type text into the currently focused input (no ID)
                            add --force for non-standard/custom editable fields
  type --label <label> <text> type into the field whose label matches (e.g. Subject)
  fields                    list only the editable fields and dropdowns on the tab, with labels
  key <keys...> [--in <ID>] send keystrokes to the page (e.g. Enter, Ctrl+k, g i)
                            add --trusted for real key events (moves focus on Tab)
  clearlabels               remove the snapshot labels/overlay from the current tab
  closetabs                 close every tab the tool has opened (the CLI tab group)
  readdropdown <ID>         list every option of an open dropdown/select, scrolling if needed
  readdropdown --label <label> open the dropdown whose label matches and list its options
  selectoption <ID> <value> choose an option on a native <select> by value, index, or text
  selectoption --label <label> <value> choose an option on the <select> whose label matches
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

  if (action === 'fields') {
    const res = await sendRequest({ action: 'fields' });
    for (const f of res.fields) {
      console.log(`${f.type.padEnd(10)} ${f.label || '(no label)'}`);
    }
    return;
  }

  if (action === 'type') {
    const li = rest.indexOf('--label');
    if (li !== -1) {
      const label = rest[li + 1];
      const text = rest.slice(li + 2).join(' ');
      if (!label || !text) {
        console.error('usage: search-cli type --label <label> <text>');
        process.exit(1);
      }
      const res = await sendRequest({ action: 'type', label, text });
      console.log(`typed into "${res.matched}"`);
      return;
    }
    const focused = rest.includes('--focused') || rest.includes('--force');
    if (focused) {
      const force = rest.includes('--force');
      const text = rest.filter((t) => t !== '--focused' && t !== '--force').join(' ');
      if (!text) {
        console.error('usage: search-cli type --focused <text>  (add --force for non-standard fields)');
        process.exit(1);
      }
      await sendRequest({ action: 'type', text, force });
      console.log('typed into focused element');
      return;
    }
    const [elementId, ...textParts] = rest;
    const text = textParts.join(' ');
    if (!elementId || !text) {
      console.error('usage: search-cli type <ID> <text>  (or: type --focused <text>)');
      process.exit(1);
    }
    await sendRequest({ action: 'type', elementId, text });
    console.log(`typed into ${elementId}`);
    return;
  }

  if (action === 'key') {
    const chords = [];
    let elementId;
    let trusted = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--in') {
        elementId = rest[++i];
      } else if (rest[i] === '--trusted') {
        trusted = true;
      } else {
        chords.push(rest[i]);
      }
    }
    if (!chords.length) {
      console.error('usage: search-cli key <keys...> [--in <ID>] [--trusted]   e.g. key Enter, key Ctrl+k, key Tab --trusted');
      process.exit(1);
    }
    const res = await sendRequest({ action: 'key', chords, elementId, trusted });
    console.log(`sent ${res.count} key event(s)`);
    return;
  }

  if (action === 'clearlabels') {
    await sendRequest({ action: 'clearlabels' });
    console.log('cleared snapshot labels');
    return;
  }

  if (action === 'closetabs') {
    const res = await sendRequest({ action: 'closetabs' });
    console.log(`closed ${res.closed} tab(s)`);
    return;
  }

  if (action === 'readdropdown') {
    const li = rest.indexOf('--label');
    if (li !== -1) {
      const label = rest.slice(li + 1).join(' ');
      if (!label) {
        console.error('usage: search-cli readdropdown --label <label>');
        process.exit(1);
      }
      const res = await sendRequest({ action: 'readdropdown', label });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return;
    }
    const [elementId] = rest;
    if (!elementId) {
      console.error('usage: search-cli readdropdown <ID>  (or: readdropdown --label <label>)');
      process.exit(1);
    }
    const res = await sendRequest({ action: 'readdropdown', elementId });
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (action === 'selectoption') {
    const li = rest.indexOf('--label');
    if (li !== -1) {
      const label = rest[li + 1];
      const value = rest.slice(li + 2).join(' ');
      if (!label || !value) {
        console.error('usage: search-cli selectoption --label <label> <value>');
        process.exit(1);
      }
      const res = await sendRequest({ action: 'selectoption', label, value });
      console.log(`selected "${res.text}" (${res.value}) on "${res.matched}"`);
      return;
    }
    const [elementId, ...valueParts] = rest;
    const value = valueParts.join(' ');
    if (!elementId || !value) {
      console.error('usage: search-cli selectoption <ID> <value>  (or: selectoption --label <label> <value>)');
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
      'usage: search-cli <start|stop|status|google|ddg|visit|attach|snapshot|fields|click|type|key|clearlabels|closetabs|readdropdown|selectoption|screenshot> [args] [--wait=ms] [--links]'
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
