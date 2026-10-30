# TODO

Design notes and backlog for `search-cli`. Ordered roughly by value-per-effort.

## Guiding principle: teach through output, not through memory

The primary user of this tool is an LLM agent, and an agent only "knows" a flag exists
after it has already been burned by the default behavior. So never rely on the agent
remembering to add a flag. Encode knowledge in three channels:

1. **The default is correct** — the right thing happens with no flags at all.
2. **The output header states what happened and what to do** — e.g.
   `# WARNING: page still mutating after 5s — re-run with --wait=8000 or snapshot --context`.
3. **Errors carry the next command** — the existing `no active tab - run google/ddg/visit
   first` is the pattern to copy everywhere.

`--help` and the `~/.pi/agent/AGENTS.md` blurb are weak channels; agents skim them.
Assume the only reliable documentation is what the tool prints on stdout/stderr.

---

## 1. Replace fixed `--wait` with an automatic settle probe  (high / small)

Current flow (`extension/background.js` `waitForTabLoad` + `getOrCreateTab`, ~line 171):
resolves on `chrome.tabs.onUpdated` `status === 'complete'`, then sleeps a fixed
`waitMs` (default 1000, wired in `cli/bin/search-cli.js` ~line 330). `complete` means the
load event fired, which on an SPA means "shell painted, data not arrived." Result:
`visit` on a React app returns an empty or half-rendered page, silently.

Do instead:

- Poll a cheap DOM fingerprint in-page until quiet (no debugger, no MutationObserver
  timing headaches):

  ```js
  async function pageSettle(quietMs, deadlineMs) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const start = performance.now();
    let last = '', stableSince = performance.now();
    while (performance.now() - start < deadlineMs) {
      const nodes = document.getElementsByTagName('*').length;
      const len = document.body ? document.body.innerHTML.length : 0;
      const cur = nodes + ':' + len;
      if (cur !== last) { last = cur; stableSince = performance.now(); }
      else if (performance.now() - stableSince >= quietMs) {
        return { settled: true, nodes, ms: performance.now() - start };
      }
      await sleep(120);
    }
    return { settled: false, nodes: document.getElementsByTagName('*').length, ms: performance.now() - start };
  }
  ```

- Gate order: `document.readyState === 'complete'` → settle probe (quiet 500ms,
  deadline ~5s) → read.
- Emit a header line from `visit`/`google`/`ddg`:
  `# settled in 1.8s (312 nodes)` or the mutating-warning above.
- Higher-fidelity alternative: `chrome.debugger` + `Network.enable` for true network-idle.
  Strictly better, but it shows the "Chrome is being debugged" infobar, so keep it opt-in
  (`--idle=network`).

## 2. Post-action settle on mutating commands  (high / small)

`click`, `type`, `key`, `selectoption` almost always trigger navigation or async re-render.
Today the next command reads a mid-flight page. Have each run the settle probe afterward and
report `# page changed: 47 -> 61 nodes, settled in 1.2s`. Then the agent never has to reason
about timing at all, which deletes most of the need for a `--wait-for` flag.

## 3. Stale snapshot IDs misclick instead of failing  (high / small)

`pageLabelElements` assigns IDs with `idFor(i)` — a plain index into the collected element
list (`extension/background.js` ~line 235). Any DOM insertion/removal shifts every later ID,
so `click AB` hits the wrong element silently. This is the most dangerous current bug: the
agent gets no signal and keeps going.

- At snapshot time, store a fingerprint per ID: tag + trimmed text + rounded rect + name/id
  attribute.
- At action time, re-resolve the element and compare fingerprints. On mismatch:
  `element AB is stale (snapshot had 47 elements, now 31; DOM changed). Run snapshot again.`
- Keep the map in `frameMapsByTab` (already exists for frame IDs) so it survives the
  service-worker restart between commands.

## 4. Add observability: `eval`, `console`, `net`  (high / medium)

Biggest capability gap versus Chrome DevTools MCP. Today the tool can read and touch a page
but cannot answer "why did this fail?" — no console logs, no network requests, no JS
execution.

Cheap to add because `sendTrustedKeys` (~line 61) already does
`chrome.debugger.attach(target, '1.3')`:

- `search-cli eval "<expr>"` → `Runtime.evaluate` with `awaitPromise`, `returnByValue`.
- `search-cli console [--clear]` → `Log.enable` + `Runtime.enable`, buffer entries per tab.
- `search-cli net [--filter=fetch|xhr|doc] [--since]` → `Network.enable`, buffer method/url/
  status/timing; makes "did the API call 401?" a one-liner.
- Buffer in the service worker keyed by tabId; cap the ring (e.g. 200 entries) and truncate
  bodies, since agent context is the real constraint.

## 5. Guardrails for a tool that acts as the user  (high / medium)

`manifest.json` asks for `tabs, tabGroups, scripting, storage, debugger` +
`host_permissions: <all_urls>` on the user's **real, logged-in profile**. The agent can send
email, delete records, submit payments, and there is no gate.

- `~/.chrome-cli-search/allowlist` of host patterns; refuse `click`/`type`/`key`/`submit`
  on non-allowlisted hosts with a clear error naming the host.
- `--dry-run`: resolve the target, print what *would* be clicked/typed (label, text,
  surrounding context), take no action.
- Treat a `submit` button / Enter-in-form as destructive: require an explicit `--commit`.
- `search-cli closetabs` and `attach` are already good hygiene; extend the tab-group idea to
  mark CLI-opened tabs visually so the human sees what the agent owns.

## 6. Token budget for page text  (medium / small)

Per-element strings are truncated (60–120 chars) but full page text is unbounded, so one
large page eats the context window.

- `visit --max-chars=N` (default ~8000) with an explicit
  `[truncated: 41233 chars total, showing first 8000 — narrow with --links or --selector]`.
- Main-content extraction (Readability-style: drop `nav/header/footer/aside`, collapse
  repeated whitespace) before returning text.
- `snapshot --limit=N` and dedupe identical repeated rows ("23 more like `AB12`") — huge
  token savings on table-heavy pages.

## 7. Missing verbs  (medium)

- `upload <ID> <path...>` — `DOM.setFileInputFiles` via the debugger session; `type` cannot
  fill a file input.
- `scroll <dir> [--amount]` / `--full` page screenshot; today `screenshot` captures only the
  viewport, so below-the-fold content is invisible to the agent.
- `pdf <path>` via `Page.printToPDF`.
- `cookies [--domain]` / `storage get|set` via `chrome.cookies` / `chrome.storage` — useful
  for "am I actually logged in as the right account?"
- `tabs` / `tab <n>` / `newtab <url>` for multiple simultaneous targets. Today there is one
  reused tab plus `attach`, which serializes everything and makes parallel work impossible.
- `wait --selector <css>` / `--text "…" / --url-contains` as the explicit escape hatch, once
  items 1–2 make the automatic path good enough. Give it a useful timeout error listing the
  visible `h1`/`h2` text so the agent learns why it never matched.

## 8. Security follow-ups

Done (this change): the daemon now pins the WebSocket handshake to the extension's
`chrome-extension://<id>` Origin (`verifyClient` in `cli/lib/daemon.js`), refuses handshakes
with a non-extension Origin (including a missing one), takes `extension-id` on first connect
(TOFU), and keeps a ring of refusals surfaced by `search-cli status`. `~/.chrome-cli-search`
is `0700` with `0600` on pid/socket/pin files. This closes CSWSH: a web page the user visits
can no longer open `ws://127.0.0.1:47285` and drive the logged-in browser. `search-cli unpin`
re-pins after reinstalling the extension.

Also done in the same pass: the daemon refuses to start a second instance instead of unlinking
the live socket (it pings the socket first, and clears a stale pid/socket left by a killed
instance); in-flight requests now fail immediately when the extension socket closes instead of
hanging to the 30s timeout; `search-cli status` reports pid, extension-connected, pinned id,
and recent refusals; the daemon tracks **all** live extension sockets in a Set and sends on the
newest OPEN one (Chrome lets the previous service worker's socket linger, so tracking only the
last connection made `status` report "connected: no" while requests still worked).

Still open:

- **A local process can forge the Origin header.** It is a plain TCP client, so the pin is
  only a browser-enforced check. Accepted for now because anything running as this user can
  already read Chrome's cookie DB; revisit if that assumption changes.
- **Shared secret.** Harder: the extension cannot read files, so a token in
  `~/.chrome-cli-search` cannot reach it directly. Options: have the CLI open a
  `chrome-extension://<id>/relay.html#token=…` page to hand over a secret, or have the
  extension mint a nonce and the CLI echo it via the daemon's `hello`. Then verify both
  Origin and secret per connection.
- **Another installed extension could claim the pin** if it connects while unpinned
  (e.g. right after `unpin`, before the real extension reconnects). Mitigation: re-pin
  command that takes the expected id, or a short pin-grace window.
- **Stable extension id.** Add a `"key"` to `manifest.json` so the unpacked id survives being
  moved to a different directory instead of changing and forcing a re-pin.
- **`eval` widens the blast radius** badly once item 4 lands. Gate it behind the allowlist and
  make it refuse to run on non-allowlisted origins by default.
- **Daemon stderr is discarded.** The CLI spawns the daemon with `stdio: 'ignore'`, so the
  pinning/refusal logs above are invisible unless you run `node cli/lib/daemon.js` by hand.
  Redirect to `~/.chrome-cli-search/daemon.log` (0600) and add `search-cli logs [--tail=N]`.
- **Reconnect latency.** After a daemon restart the extension dials back on its 2s retry while
  the service worker is alive, or on the 1-minute `chrome.alarms` tick once Chrome has suspended
  it, so `search-cli status` can report `extension connected: no` for up to a minute and the
  first command queues (it succeeds, slowly). Options: the minimum 0.5-minute alarm, and/or let
  the CLI wake the extension by opening `chrome-extension://<pinned id>/wakeup.html` in a tab it
  immediately closes.
- **Replies are accepted from any pinned socket** — `pending.get(msg.id)` in `cli/lib/daemon.js`
  ignores which `ws` delivered the message. Safe while every socket belongs to the same pinned
  extension, but once the shared-secret work lands, bind each pending id to the socket it was
  sent on and drop replies from anywhere else.

## 9. Packaging / reach

- Chrome-only, manual "Load unpacked" + Developer mode. Fine personally, disqualifying for CI
  or for handing to someone else.
- Consider: zip the extension for the Chrome Web Store (unpacked install is blocked in
  some enterprises), a `search-cli install-extension` helper that opens
  `chrome://extensions` and copies the path to the clipboard, and a README note about the
  debugger infobar once `--idle=network` or `eval` lands.
- Add tests: the settle probe, label resolution ordering (`aria-label` → `aria-labelledby` →
  `<label>` → placeholder → name → title), and ID staleness detection are all pure logic and
  worth unit coverage. Origin pinning deserves a handshake test (no Origin / https Origin /
  wrong extension id / matching id).

## 10. Known rough edges found while reading the code

- `handleRequest` dispatch uses `req.action` with no unknown-action guard visible at the
  top level; an unknown action can leave a CLI request hanging until the 30s daemon timeout.
  Reply `{error: 'unknown action: X'}` immediately, and list valid actions in the message so
  a hallucinated command self-corrects.
