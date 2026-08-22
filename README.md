# chrome-cli-search

A CLI tool that runs web searches and interacts with Chrome tabs from the terminal.

It works by launching a local daemon that bridges the command line to a Chrome extension, which performs the actual browser operations.

## Features

- **Search**: `search-cli google "query"` and `search-cli ddg "query"` — run searches and get page text
- **Visit**: `search-cli visit "https://example.com"` — fetch page content from any URL
- **Snapshot**: `search-cli snapshot` — label interactive elements on the current tab with IDs
- **Interact**: `search-cli click <ID>` and `search-cli type <ID> "text"` — click elements and type into inputs
- **Screenshot**: `search-cli screenshot` — capture the current tab as PNG

## Installation

### 1. Install the CLI

```bash
cd cli
npm install
```

### 2. Install the Chrome Extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` directory from this repo

### 3. Use It

```bash
# Start the background daemon (auto-started on first use)
./bin/search-cli.js start

# Search Google
./bin/search-cli.js google "pi calculator"

# Search DuckDuckGo with links only
./bin/search-cli.js ddg "node.js docs" --links

# Visit a URL with custom wait time
./bin/search-cli.js visit "https://example.com" --wait=3000

# Interact with the current tab
./bin/search-cli.js snapshot
./bin/search-cli.js click AB
./bin/search-cli.js type CD "hello world"
./bin/search-cli.js screenshot ~/Desktop/page.png
```

## Architecture

```
CLI (search-cli) → Unix socket → Node daemon → WebSocket → Chrome extension → Browser tabs
```

The CLI spawns a background daemon that maintains a WebSocket connection to the Chrome extension. All browser operations (tab creation, page content extraction, element interaction) happen inside the extension.

## Requirements

- Node.js 18+
- Google Chrome (or Chromium-based browser)
