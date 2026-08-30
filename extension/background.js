const WS_PORT = 47285;

let socket = null;

// tabId -> { [frameLetter]: frameId }, populated by the most recent snapshot
const frameMapsByTab = new Map();
const FRAME_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Named keys for the trusted (chrome.debugger / CDP) key path.
const CDP_KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

function parseChordCdp(chord) {
  const parts = chord.split('+');
  const keyPart = parts.pop();
  let modifiers = 0;
  for (const p of parts) {
    const m = p.toLowerCase();
    if (m === 'ctrl' || m === 'control') modifiers |= 2;
    else if (m === 'shift') modifiers |= 8;
    else if (m === 'alt' || m === 'option') modifiers |= 1;
    else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'win') modifiers |= 4;
  }
  const lower = keyPart.toLowerCase();
  let info;
  if (CDP_KEYS[lower]) {
    info = { ...CDP_KEYS[lower] };
  } else if (keyPart.length === 1) {
    const shift = (modifiers & 8) !== 0;
    const isAlpha = /[a-z]/i.test(keyPart);
    const key = isAlpha ? (shift ? keyPart.toUpperCase() : keyPart.toLowerCase()) : keyPart;
    const code = isAlpha ? 'Key' + keyPart.toUpperCase() : /[0-9]/.test(keyPart) ? 'Digit' + keyPart : '';
    info = { key, code, keyCode: keyPart.toUpperCase().charCodeAt(0), text: key };
  } else {
    info = { key: keyPart, code: '', keyCode: 0 };
  }
  // Ctrl/Meta shortcuts should not insert text.
  if (modifiers & 2 || modifiers & 4) delete info.text;
  return { modifiers, ...info };
}

async function sendTrustedKeys(tabId, chords) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    for (const chord of chords) {
      const info = parseChordCdp(chord);
      const common = {
        modifiers: info.modifiers,
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.keyCode,
        nativeVirtualKeyCode: info.keyCode,
      };
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: info.text ? 'keyDown' : 'rawKeyDown',
        ...common,
        ...(info.text ? { text: info.text, unmodifiedText: info.text } : {}),
      });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    }
  } finally {
    await chrome.debugger.detach(target);
  }
  return { ok: true, count: chords.length };
}

async function getReuseTabId() {
  const { reuseTabId } = await chrome.storage.session.get('reuseTabId');
  return typeof reuseTabId === 'number' ? reuseTabId : null;
}

async function setReuseTabId(tabId) {
  const prev = await getReuseTabId();
  if (prev !== null && prev !== tabId) {
    try {
      await chrome.tabs.ungroup(prev);
    } catch (e) {}
  }
  await chrome.storage.session.set({ reuseTabId: tabId });
  if (typeof tabId === 'number') {
    try {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { color: 'blue', title: 'CLI' });
    } catch (e) {}
  }
}

async function refreshAttachedGroup() {
  const tabId = await getReuseTabId();
  if (typeof tabId !== 'number') return;
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { color: 'blue', title: 'CLI' });
  } catch (e) {}
}

function setConnected(isConnected) {
  chrome.action.setBadgeText({ text: isConnected ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: isConnected ? '#22c55e' : '#ef4444' });
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  socket = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  setConnected(false);

  socket.onopen = () => {
    setConnected(true);
  };

  socket.onclose = () => {
    socket = null;
    setConnected(false);
    setTimeout(connect, 2000);
  };

  socket.onerror = () => {};

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    const { id } = msg;
    try {
      const result = await handleRequest(msg);
      socket.send(JSON.stringify({ id, ...result }));
    } catch (err) {
      socket.send(JSON.stringify({ id, error: String((err && err.message) || err) }));
    }
  };
}

connect();
refreshAttachedGroup();

chrome.alarms.create('reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => connect());

function buildUrl(action, query, url) {
  if (action === 'google') return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  if (action === 'ddg') return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  if (action === 'visit') return url;
  throw new Error(`unknown action: ${action}`);
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getOrCreateTab(targetUrl) {
  const reuseTabId = await getReuseTabId();
  if (reuseTabId !== null) {
    try {
      await chrome.tabs.get(reuseTabId);
      const loaded = waitForTabLoad(reuseTabId);
      await chrome.tabs.update(reuseTabId, { url: targetUrl, active: true });
      await loaded;
      return reuseTabId;
    } catch (e) {
      // fall through and create a new tab
    }
  }
  const tab = await chrome.tabs.create({ url: targetUrl });
  await setReuseTabId(tab.id);
  await waitForTabLoad(tab.id);
  return tab.id;
}

async function getCurrentTabId() {
  const reuseTabId = await getReuseTabId();
  if (reuseTabId === null) {
    throw new Error('no active tab - run google/ddg/visit first');
  }
  try {
    await chrome.tabs.get(reuseTabId);
  } catch (e) {
    await setReuseTabId(null);
    throw new Error('no active tab - run google/ddg/visit first');
  }
  return reuseTabId;
}

// --- injected page functions (must be self-contained; run in the page's isolated world) ---

function pageLabelElements(framePrefix) {
  const old = document.getElementById('__cli_overlay_root__');
  if (old) old.remove();
  window.__cliLabels = {};

  const root = document.createElement('div');
  root.id = '__cli_overlay_root__';
  root.style.position = 'absolute';
  root.style.top = '0';
  root.style.left = '0';
  root.style.width = '0';
  root.style.height = '0';
  root.style.zIndex = '2147483647';
  root.style.pointerEvents = 'none';
  document.documentElement.appendChild(root);

  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function idFor(i) {
    return (framePrefix || '') + CHARS[Math.floor(i / 36) % 36] + CHARS[i % 36];
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Collect all interactive elements, including those inside Shadow DOM
  function collectElements(root) {
    const seen = new Set();
    const elements = [];
    function add(el) {
      if (!seen.has(el)) {
        seen.add(el);
        elements.push(el);
      }
    }
    const selector = 'a, button, input, textarea, select, [role], [onclick], [contenteditable], [tabindex]';
    root.querySelectorAll(selector).forEach(add);
    // Catch framework-rendered components (React/Vue click handlers with no semantic markup)
    root.querySelectorAll('div, span, li, slot').forEach(add);
    // Recurse into shadow roots
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) {
        collectElements(el.shadowRoot).forEach(add);
      }
    });
    return elements;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'textarea', 'select'].includes(tag)) return true;
    const role = el.getAttribute('role');
    if (role && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch'].includes(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.isContentEditable) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && parseInt(tabindex, 10) >= 0) return true;
    // Catch framework-rendered components (React/Vue click handlers with no semantic markup)
    if (tag === 'div' || tag === 'span' || tag === 'li' || tag === 'slot') {
      if (getComputedStyle(el).cursor === 'pointer') return true;
    }
    return false;
  }

  const candidates = collectElements(document).filter((el) => isInteractive(el) && isVisible(el));

  const elements = [];
  let i = 0;
  for (const el of candidates) {
    if (i >= 1296) break;
    const id = idFor(i);
    window.__cliLabels[id] = el;
    el.dataset.cliId = id;

    const rect = el.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const left = rect.left + window.scrollX;

    const box = document.createElement('div');
    box.style.position = 'absolute';
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.border = '1px solid #ff3366';
    box.style.boxSizing = 'border-box';
    box.style.pointerEvents = 'none';
    root.appendChild(box);

    const badge = document.createElement('div');
    badge.textContent = id;
    badge.style.position = 'absolute';
    badge.style.top = `${top}px`;
    badge.style.left = `${left}px`;
    badge.style.transform = 'translateY(-100%)';
    badge.style.background = '#ff3366';
    badge.style.color = '#fff';
    badge.style.font = 'bold 10px monospace';
    badge.style.padding = '1px 3px';
    badge.style.lineHeight = '1';
    badge.style.pointerEvents = 'none';
    root.appendChild(badge);

    const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    const tag = el.tagName.toLowerCase();
    const entry = { id, tag, text };
    if (tag === 'a') entry.href = el.href;
    if (tag === 'input') entry.type = el.type;
    elements.push(entry);
    i++;
  }
  return elements;
}

function pageContextText() {
  const markers = [];
  document.querySelectorAll('[data-cli-id]').forEach((el) => {
    const id = el.getAttribute('data-cli-id');
    const tag = el.tagName.toLowerCase();
    let info = id;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const label = (el.getAttribute('aria-label') || el.placeholder || el.name || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 60);
      info = `${id}:${el.type || tag}${label ? ' ' + label : ''}`;
    }
    const m = document.createElement('span');
    m.className = '__cli_marker__';
    m.textContent = ` ⟦${info}⟧ `;
    el.parentNode.insertBefore(m, el);
    markers.push(m);
  });
  const text = document.body.innerText;
  markers.forEach((m) => m.remove());
  return text;
}

function pageClearLabels() {
  const root = document.getElementById('__cli_overlay_root__');
  if (root) root.remove();
  document.querySelectorAll('[data-cli-id]').forEach((el) => {
    delete el.dataset.cliId;
  });
  window.__cliLabels = {};
  return { ok: true };
}

function pageSendKeys(chords) {
  const NAMED = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  };
  function resolve(part) {
    const lower = part.toLowerCase();
    if (NAMED[lower]) return { ...NAMED[lower] };
    if (part.length === 1) {
      const code = /[a-z]/i.test(part) ? 'Key' + part.toUpperCase() : /[0-9]/.test(part) ? 'Digit' + part : '';
      return { key: part, code, keyCode: part.toUpperCase().charCodeAt(0) };
    }
    return { key: part, code: '', keyCode: 0 };
  }
  for (const chord of chords) {
    const parts = chord.split('+');
    const keyPart = parts.pop();
    const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    for (const p of parts) {
      const m = p.toLowerCase();
      if (m === 'ctrl' || m === 'control') mods.ctrlKey = true;
      else if (m === 'shift') mods.shiftKey = true;
      else if (m === 'alt' || m === 'option') mods.altKey = true;
      else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'win') mods.metaKey = true;
    }
    const info = resolve(keyPart);
    if (mods.shiftKey && info.key.length === 1) info.key = info.key.toUpperCase();
    const target = document.activeElement || document.body;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...mods,
      key: info.key,
      code: info.code,
      keyCode: info.keyCode,
      which: info.keyCode,
    };
    target.dispatchEvent(new KeyboardEvent('keydown', base));
    if (info.key.length === 1 && !mods.ctrlKey && !mods.metaKey) {
      target.dispatchEvent(new KeyboardEvent('keypress', base));
    }
    target.dispatchEvent(new KeyboardEvent('keyup', base));
  }
  return { ok: true, count: chords.length };
}

function pageClickLabel(id) {
  const el = window.__cliLabels && window.__cliLabels[id];
  if (!el) return { ok: false, error: `unknown element id: ${id}` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', base));
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', base));
  el.dispatchEvent(new MouseEvent('click', base));
  return { ok: true };
}

function pageTypeLabel(id, text) {
  const el = window.__cliLabels && window.__cliLabels[id];
  if (!el) return { ok: false, error: `unknown element id: ${id}` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (el.isContentEditable) {
    el.textContent = '';
    document.execCommand('insertText', false, text);
  } else if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, '');
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    return { ok: false, error: `element ${id} (<${tag}>) is not a text input` };
  }
  return { ok: true };
}

async function pageReadDropdown(id, framePrefix) {
  const labels = window.__cliLabels || (window.__cliLabels = {});
  const el = labels[id];
  if (!el) return { ok: false, error: `unknown element id: ${id}` };

  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function makeId(i) {
    return (framePrefix || '') + CHARS[Math.floor(i / 36) % 36] + CHARS[i % 36];
  }
  let next = 0;
  function assign(node) {
    while (labels[makeId(next)] && labels[makeId(next)] !== node) next++;
    const nid = makeId(next);
    labels[nid] = node;
    next++;
    return nid;
  }

  if (el.tagName.toLowerCase() === 'select') {
    const options = Array.from(el.options).map((o, idx) => ({
      index: idx,
      value: o.value,
      text: (o.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      selected: o.selected,
    }));
    return { ok: true, kind: 'select', options };
  }

  // Resolve the option container for an ARIA / overflow / virtualized dropdown.
  function isVisible(node) {
    const s = getComputedStyle(node);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  const optionSelector =
    '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], li, option';
  let container = null;
  const role = el.getAttribute('role');
  if ((role === 'listbox' || role === 'menu') || el.querySelector(optionSelector)) {
    container = el;
  }
  if (!container) {
    const owns = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (owns) container = document.getElementById(owns);
  }
  if (!container) {
    const found = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).filter(isVisible);
    container = found[found.length - 1] || el;
  }

  // Pick the scrollable element (container or a descendant that overflows).
  let scrollEl = null;
  if (container.scrollHeight > container.clientHeight + 1) {
    scrollEl = container;
  } else {
    scrollEl =
      Array.from(container.querySelectorAll('*')).find((n) => n.scrollHeight > n.clientHeight + 1) || null;
  }

  const seenKeys = new Set();
  const options = [];
  function harvest() {
    container.querySelectorAll(optionSelector).forEach((node) => {
      if (!isVisible(node)) return;
      const text = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      const key = node.getAttribute('data-value') || node.id || text;
      if (!text || seenKeys.has(key)) return;
      seenKeys.add(key);
      options.push({
        id: assign(node),
        text,
        selected: node.getAttribute('aria-selected') === 'true' || node.getAttribute('aria-checked') === 'true',
      });
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (scrollEl) {
    scrollEl.scrollTop = 0;
    await sleep(60);
    harvest();
    let last = -1;
    let guard = 0;
    while (scrollEl.scrollTop !== last && guard < 300) {
      last = scrollEl.scrollTop;
      scrollEl.scrollTop += scrollEl.clientHeight;
      await sleep(60);
      harvest();
      guard++;
      if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight) break;
    }
  } else {
    harvest();
  }

  return { ok: true, kind: 'listbox', options };
}

function pageSelectOption(id, value) {
  const el = window.__cliLabels && window.__cliLabels[id];
  if (!el) return { ok: false, error: `unknown element id: ${id}` };
  if (el.tagName.toLowerCase() !== 'select') {
    return { ok: false, error: `element ${id} (<${el.tagName.toLowerCase()}>) is not a <select>` };
  }
  const opts = Array.from(el.options);
  let target = opts.find((o) => o.value === value);
  if (!target && /^\d+$/.test(value)) target = opts[parseInt(value, 10)];
  if (!target) target = opts.find((o) => (o.textContent || '').trim() === value);
  if (!target) return { ok: false, error: `no option matching "${value}"` };
  el.value = target.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: target.value, text: (target.textContent || '').trim() };
}

// --- request dispatch ---

function resolveFrameId(tabId, elementId) {
  const frameMap = frameMapsByTab.get(tabId);
  if (!frameMap) throw new Error('no snapshot taken yet - run snapshot first');
  const prefix = Object.prototype.hasOwnProperty.call(frameMap, '') ? '' : elementId[0];
  const frameId = frameMap[prefix];
  if (frameId === undefined) throw new Error(`unknown element id: ${elementId}`);
  return frameId;
}

async function handleRequest(msg) {
  const { action, query, url, waitMs, links, context, elementId, text, value, chords, trusted } = msg;

  if (action === 'google' || action === 'ddg' || action === 'visit') {
    const targetUrl = buildUrl(action, query, url);
    const tabId = await getOrCreateTab(targetUrl);
    await new Promise((r) => setTimeout(r, typeof waitMs === 'number' ? waitMs : 1000));
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: links
        ? () =>
            Array.from(document.querySelectorAll('a[href]'))
              .filter((a) => a.offsetParent !== null || a === document.body)
              .map((a) => `${a.innerText.trim().replace(/\s+/g, ' ')} - ${a.href}`)
              .filter((line) => line.length > 3)
              .join('\n')
        : () => document.body.innerText,
    });
    return { text: frames.map((f) => f.result).filter(Boolean).join('\n') };
  }

  if (action === 'attach') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('no active tab in the focused window');
    await setReuseTabId(tab.id);
    return { tabId: tab.id, url: tab.url, title: tab.title };
  }

  if (action === 'snapshot') {
    const tabId = await getCurrentTabId();
    // Discover every frame in the tab (SPAs often render main content in a same-origin iframe).
    const discovery = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => true });
    const frameMap = {};
    const elements = [];
    const perFrame = await Promise.all(
      discovery.map((frame, i) => {
        const prefix = discovery.length > 1 ? FRAME_CHARS[i % FRAME_CHARS.length] : '';
        frameMap[prefix] = frame.frameId;
        return chrome.scripting.executeScript({
          target: { tabId, frameIds: [frame.frameId] },
          func: pageLabelElements,
          args: [prefix],
        });
      })
    );
    for (const [{ result }] of perFrame) {
      elements.push(...result);
    }
    frameMapsByTab.set(tabId, frameMap);
    if (context) {
      const textFrames = await Promise.all(
        discovery.map((frame) =>
          chrome.scripting.executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            func: pageContextText,
          })
        )
      );
      const contextText = textFrames.map(([{ result }]) => result).filter(Boolean).join('\n');
      return { elements, text: contextText };
    }
    return { elements };
  }

  if (action === 'click') {
    const tabId = await getCurrentTabId();
    const frameId = resolveFrameId(tabId, elementId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: pageClickLabel,
      args: [elementId],
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true };
  }

  if (action === 'type') {
    const tabId = await getCurrentTabId();
    const frameId = resolveFrameId(tabId, elementId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: pageTypeLabel,
      args: [elementId, text],
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true };
  }

  if (action === 'key') {
    const tabId = await getCurrentTabId();
    const frameId = elementId ? resolveFrameId(tabId, elementId) : 0;
    if (elementId) {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (id) => {
          const el = window.__cliLabels && window.__cliLabels[id];
          if (el) el.focus();
        },
        args: [elementId],
      });
    }
    if (trusted) {
      return await sendTrustedKeys(tabId, chords);
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: pageSendKeys,
      args: [chords],
    });
    return { ok: true, count: result.count };
  }

  if (action === 'clearlabels') {
    const tabId = await getCurrentTabId();
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageClearLabels });
    frameMapsByTab.delete(tabId);
    return { ok: true };
  }

  if (action === 'readdropdown') {
    const tabId = await getCurrentTabId();
    const frameId = resolveFrameId(tabId, elementId);
    const frameMap = frameMapsByTab.get(tabId);
    const prefix = Object.prototype.hasOwnProperty.call(frameMap, '') ? '' : elementId[0];
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: pageReadDropdown,
      args: [elementId, prefix],
    });
    if (!result.ok) throw new Error(result.error);
    return { kind: result.kind, options: result.options };
  }

  if (action === 'selectoption') {
    const tabId = await getCurrentTabId();
    const frameId = resolveFrameId(tabId, elementId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: pageSelectOption,
      args: [elementId, value],
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true, value: result.value, text: result.text };
  }

  if (action === 'screenshot') {
    const tabId = await getCurrentTabId();
    const { windowId } = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return { png: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }

  throw new Error(`unknown action: ${action}`);
}
