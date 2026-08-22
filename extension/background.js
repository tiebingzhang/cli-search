const WS_PORT = 47285;

let socket = null;

async function getReuseTabId() {
  const { reuseTabId } = await chrome.storage.session.get('reuseTabId');
  return typeof reuseTabId === 'number' ? reuseTabId : null;
}

async function setReuseTabId(tabId) {
  await chrome.storage.session.set({ reuseTabId: tabId });
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

function pageLabelElements() {
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
    return CHARS[Math.floor(i / 36) % 36] + CHARS[i % 36];
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
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
    return false;
  }

  const candidates = Array.from(
    document.querySelectorAll('a, button, input, textarea, select, [role], [onclick], [contenteditable], [tabindex]')
  ).filter((el) => isInteractive(el) && isVisible(el));

  const elements = [];
  let i = 0;
  for (const el of candidates) {
    if (i >= 1296) break;
    const id = idFor(i);
    window.__cliLabels[id] = el;

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

function pageClickLabel(id) {
  const el = window.__cliLabels && window.__cliLabels[id];
  if (!el) return { ok: false, error: `unknown element id: ${id}` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
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

// --- request dispatch ---

async function handleRequest(msg) {
  const { action, query, url, waitMs, links, elementId, text } = msg;

  if (action === 'google' || action === 'ddg' || action === 'visit') {
    const targetUrl = buildUrl(action, query, url);
    const tabId = await getOrCreateTab(targetUrl);
    await new Promise((r) => setTimeout(r, typeof waitMs === 'number' ? waitMs : 1000));
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: links
        ? () =>
            Array.from(document.querySelectorAll('a[href]'))
              .filter((a) => a.offsetParent !== null || a === document.body)
              .map((a) => `${a.innerText.trim().replace(/\s+/g, ' ')} - ${a.href}`)
              .filter((line) => line.length > 3)
              .join('\n')
        : () => document.body.innerText,
    });
    return { text: result };
  }

  if (action === 'snapshot') {
    const tabId = await getCurrentTabId();
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: pageLabelElements });
    return { elements: result };
  }

  if (action === 'click') {
    const tabId = await getCurrentTabId();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageClickLabel,
      args: [elementId],
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true };
  }

  if (action === 'type') {
    const tabId = await getCurrentTabId();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageTypeLabel,
      args: [elementId, text],
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true };
  }

  if (action === 'screenshot') {
    const tabId = await getCurrentTabId();
    const { windowId } = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return { png: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }

  throw new Error(`unknown action: ${action}`);
}
