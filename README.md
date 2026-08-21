# JSHarvest

A Manifest V3 Chrome extension that detects, deduplicates, classifies and exports **every JavaScript resource loaded by the page you are visiting**.

Collection is passive: JSHarvest only observes what your own browser already loads. It never issues extra requests to the target server — except in the opt-in **Deep Scan** mode, which is off by default and clearly marked in the UI.

No framework, no dependencies, no bundler. Plain ES modules. Runs on **Chrome 120+** and **Firefox 140+** (Android 142+) from one shared codebase.

---

## Install

The two browsers disagree on exactly one thing — the `background` key — so the repo carries two manifests and a copy-only build script (`node build.mjs`) that emits `dist/chrome/` and `dist/firefox/`.

### Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `jsharvest/` directory (or `dist/chrome/` after a build — both work)
4. Pin the extension, open any website, click the JSHarvest icon

### Firefox

1. `node build.mjs`
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** → select `dist/firefox/manifest.json`
4. **Required:** open `about:addons` → JSHarvest → **Permissions** → enable *Access your data for all websites*. In Firefox MV3 host permissions are optional and must be granted by you; without this, `webRequest` never fires and the list stays empty.
5. Open any website and click the JSHarvest icon

Temporary add-ons are removed when Firefox restarts; repeat steps 2–3 (the permission grant is remembered per install).

---

## Usage

The popup has four **views**, switched by the tabs under the header:

| View | Shows |
|---|---|
| **Scripts** | Every collected JS resource, deduplicated and classified (the default) |
| **Findings** | Secrets and endpoints mined from first-party JS during Deep Scan |
| **Sources** | Original source file tree recovered from source maps during Deep Scan |
| **Diff** | Added / removed / changed scripts vs. the last snapshot |

| Element | What it does |
|---|---|
| Top bar | Host + counters (`42 scripts · 12 first-party · 30 third-party`) + total transfer size + ⚙ options |
| Toolbar badge | The extension icon shows the live script count for each tab |
| Search box | Live filter (150 ms debounce), scoped to the active view |
| Chips (Scripts view) | `All` / `First-party` / `Third-party` / `Bundles` / `Sourcemap` / `Risk`, plus a `blob/data` toggle |
| Row click | Opens a **detail panel** with full metadata + Copy / Open |
| `Copy` | Copies the currently filtered list as text |
| `Export ▾` | Downloads the active view in a view-appropriate format (see below) |
| `Snapshot` | Saves a lightweight snapshot of the current capture for Diff |
| `Deep Scan` | Opt-in deep analysis of first-party bundles (see below) |
| `Clear` | Empties the collection for the active tab |

Row badges: `3P` third-party · `bundle` bundler output · `map` source map · `worker` Worker/ServiceWorker · `no-SRI` third-party script without `integrity` · `mixed` http on https · `inferred` unverified · vendor name · HTTP status.

### Keyboard

| Key | Action |
|---|---|
| `/` | Focus the search box |
| `Esc` | Close detail / export menu, else clear search + filter |
| `Ctrl/Cmd + C` | Copy the filtered list (unless text is selected) |

### Export formats

**Scripts:** TXT (one URL/line) · JSON (full metadata) · CSV · Markdown (grouped) · **Wordlist** (unique path segments for ffuf/gobuster) · **curl** (status-probe script) · **HAR** (devtools archive).
**Findings:** Markdown report · CSV · JSON.
**Sources:** Tree (file hierarchy) · TXT (one path/line) · JSON.

File name: `jsharvest_<host>_<YYYYMMDD-HHmm>.<ext>`

### DevTools panel

A wider, sortable, full-height table lives under a **JSHarvest** tab in DevTools — better suited to large lists. Click a column header to sort; the same Deep Scan / Export / Clear actions are available.

### Options

The ⚙ button (or the extension's options page) exposes Deep Scan aggressiveness (verify / recursive / depth / source recovery / mining), the toolbar badge, the default `blob/data` visibility and export format, and history retention.

### Deep Scan (opt-in)

Deep Scan downloads first-party JS files and statically analyses them (no `eval`) to surface things the passive layers never see:

- **Hidden chunks** — Webpack chunk maps (`__webpack_require__.u` + `publicPath`, incl. the Next.js `({…}[e]||e)` shape), Vite `__vite__mapDeps` arrays, dynamic `import("…")` (Vite/Rollup/native ESM), `new URL("…", import.meta.url)` workers, SystemJS `register` deps, and absolute/relative path literals.
- **Verification** — discovered chunk URLs are checked with `HEAD`; a `200` promotes them from `inferred` to `confirmed`.
- **Recursion** — discovered first-party chunks are scanned too (depth configurable, default 1).
- **Source recovery** — `.map` files are fetched and parsed; the original `sources[]` become the **Sources** view / tree export (with a marker when `sourcesContent` is embedded).
- **Secret & endpoint mining** — fetched first-party JS is scanned for API keys, tokens, private keys, JWTs, internal hosts, S3 buckets and API paths. Secret values are **masked** in the UI. Results populate the **Findings** view.

Limits: 80 files, 4 concurrent requests, 10 s timeout, 4 MB read/file, 400 HEAD verifications, 40 source maps. Progress + Cancel are shown throughout. Everything Deep Scan adds is marked `inferred` until verified.

> Deep Scan sends extra requests to the target server, and mining/source recovery can surface sensitive data. Only use it on sites you are authorized to test.

### AI analysis (bring your own key)

An optional **AI** tab runs a deep, professional analysis of the collected surface using **your own** API key.

**Setup is one field: paste an API key.** The provider is detected from the key format and the model is chosen automatically:

| Key starts with | Provider |
|---|---|
| `sk-ant-…` | Anthropic (Claude) |
| `sk-…` / `sk-proj-…` | OpenAI |
| `AIza…` | Google Gemini |
| `gsk_…` | Groq |
| `sk-or-v1-…` | OpenRouter |

If a model id has been retired, JSHarvest falls back through a candidate list automatically and remembers the one that worked — no model field to maintain.

One-click analyses: **Attack surface** · **Triage findings** · **3rd-party risk** · **Tech fingerprint** · **Next steps**, plus a question box. Answers stream in, render as formatted Markdown, and you can **ask follow-ups** — the conversation keeps its context without re-sending the inventory.

How the data is handled:

- The request is made **from the extension page** (not a content script), so the key is never exposed to pages, and `<all_urls>` host permission bypasses CORS.
- The API key lives in `storage.local` under a **separate key** — it is not part of the settings object, never synced, and only read by `lib/ai.js`.
- Only a **compact inventory** is sent: totals, risk signals, third-party hosts with sizes and SRI status, the largest first-party bundles, technology traces, worker scripts, failed responses, mined findings and source-map stats. **Raw secret values are never stored and therefore never sent** — findings already carry masked values. With *Redact context* on (default), file paths and raw endpoint values are withheld too.
- The model is told to separate observation from inference, to re-judge the miner's confidence itself, and never to invent URLs or versions. Answers are rendered through a **DOM-only Markdown renderer** — no `innerHTML`, so model output can never inject markup.
- "Test connection" in Options validates the key and reports the provider and model it resolved.

> The AI layer sends page-derived data to a third-party provider using your key (and bills your account). Only enable it for pages you are authorized to assess.

---

## Architecture

```
manifest.json              Chrome MV3 manifest (background.service_worker)
manifest.firefox.json      Firefox MV3 manifest (background.scripts + gecko settings)
build.mjs                  copy-only build -> dist/chrome, dist/firefox
background/
  service-worker.js        webRequest listeners, epoch tab lifecycle, badge, router
content/
  collector.js             DOM collector (script/preload/importmap/SRI, all frames)
  page-hook.js             MAIN-world hook: Worker/SharedWorker/serviceWorker.register
lib/
  browser-api.js           `browser` ?? `chrome` shim — keeps every call awaitable
  store.js                 storage.session abstraction; epoch model; findings/origins
  classify.js              normalization, dedupe key, party/vendor/bundle/SRI flags
  deepscan.js              opt-in static analysis: chunks, verify, recursion, mine, maps
  sourcemap.js             .map parser -> original source paths
  mine.js                  secret + endpoint regex miner (masks secrets)
  diff.js                  capture-to-capture diff (added/removed/changed)
  history.js               per-origin snapshots in storage.local (for Diff)
  settings.js              user options in storage.local
  ai.js                    AI layer — provider auto-detected from the API key
  markdown.js              safe Markdown -> DOM renderer (no innerHTML)
  export.js                TXT/JSON/CSV/MD + wordlist/curl/HAR + findings/sources
  messaging.js             one-way broadcast helper (popup may be closed)
popup/                     main UI (4 views, virtualized list, detail panel)
panel/                     DevTools panel (devtools bootstrap + sortable table)
options/                   options page
styles/tokens.css          shared design tokens (options + panel)
test/run.mjs               dependency-free unit tests (node test/run.mjs)
```

**Cross-browser rule.** Every module imports `api` from `lib/browser-api.js` instead of touching `chrome.*` directly: Firefox's `chrome.*` alias is callback-based, so `await chrome.storage.session.get(…)` would silently resolve to `undefined` there. `browser` (Firefox, promise-based) is preferred, `chrome` (Chrome MV3, also promise-based) is the fallback. The content script is a classic script and cannot import, so it applies the same rule locally.

**Two collection layers, one store.**

1. *Network layer* (`background`): `webRequest.onCompleted` / `onErrorOccurred` for `script`, `xmlhttprequest` and `other` request types. Non-script types count as JS when the URL ends in `.js` / `.mjs` / `.cjs` or the response `Content-Type` is JavaScript (captured via `onHeadersReceived`). Records `url`, `tabId`, `frameId`, `statusCode`, `fromCache`, `timeStamp`, `type`, `initiator`.
2. *DOM layer* (`content/collector.js`): `script[src]` (with `integrity`/mixed-content flags), `link[rel=preload][as=script]`, `link[rel=modulepreload]`, `<script type="importmap">` targets, `performance.getEntriesByType('resource')`, JS path references inside inline scripts, `sourceMappingURL` comments, and a `MutationObserver` + `PerformanceObserver` for later additions.
3. *Worker layer* (`content/page-hook.js`, injected into the page's MAIN world): wraps `Worker` / `SharedWorker` / `navigator.serviceWorker.register` and reports their script URLs via `postMessage`. It only observes — the native constructor always runs unchanged.

Both layers send raw hits to the store, which deduplicates on `origin + pathname` and merges the `sources` array, so one file found by three layers is one row with `["network","dom","performance"]`.

**MV3 service worker survival.** The worker can be suspended at any moment, so the in-memory `Map` is only a cache. Every write goes to `storage.session` under `tab:<id>`, batched with a 300 ms debounce and a 1000 ms hard ceiling; the worker rehydrates from storage whenever it wakes up, and flushes on `runtime.onSuspend`.

**Tab lifecycle — navigation epochs.** Each entry is tagged with a navigation *epoch*. `onBeforeNavigate` (main frame) bumps the epoch but keeps the list; `onCommitted` commits the epoch and purges only entries from the *previous* page. A script that races the commit already carries the new epoch, so it survives — this fixes the old "reset dropped an early script" race. SPA route changes go through `onHistoryStateUpdated` (URL refresh only, list preserved). `tabs.onRemoved` deletes the tab's data.

**Persistence split.** Live capture lives in `storage.session` (cleared when the browser closes). User settings and per-origin Diff snapshots live in `storage.local` (survive restarts).

---

## Manual test scenarios

1. **Static, script-heavy site** (e.g. a news site) — open, then the popup: dozens of rows, third-party analytics/ad vendors labelled, counters match the list.
2. **SPA route change** (React/Vue/Next.js app) — navigate between routes without a reload: new chunks are appended, the list is *not* reset, and the host in the top bar follows the new URL.
3. **Full page reload** — press F5: the list resets and refills. Covered by `webNavigation.onCommitted` on the main frame.
4. **Page with iframes** — scripts loaded inside frames appear too (`all_frames: true` in the content script, and `frameId` recorded on the network side).
5. **After service worker sleep** (most important) — open a site, wait until `chrome://serviceworker-internals` shows the worker stopped (or click *Stop* in `chrome://extensions` → *service worker*), then open the popup: the data is still there, rehydrated from `chrome.storage.session`.
6. **Two tabs side by side** — collect on two different sites and switch between them: each popup shows only its own tab's data (`tab:<id>` keyed storage, popup always queries the active tab id).

The pure logic (classification/SRI flags, the epoch model, source-map parsing, secret/endpoint mining, diff, all export formats, and the Deep Scan extractors against CRA / Next.js / Vite / SystemJS bundle shapes) is verified by `test/run.mjs`; the seven scenarios above exercise the browser-bound parts.

---

## Development

No dependencies are needed to build or test — everything is plain ES modules and Node's built-ins.

```bash
node test/run.mjs     # unit tests (or: npm test)
node build.mjs        # emit dist/chrome and dist/firefox (or: npm run build)
npm run lint:firefox  # web-ext lint on dist/firefox (needs `npm i`)
```

CI (`.github/workflows/ci.yml`) runs the tests, builds both targets, syntax-checks every module, and lints the Firefox package on each push/PR.

---

## Known limits

- **`blob:` and `data:` scripts are opaque.** They are recorded and grouped separately (hidden until you enable the `blob/data` chip), but their content and origin cannot be attributed reliably.
- **The MAIN-world worker hook is best-effort.** A strict page CSP can occasionally block the injected hook; workers created before the content script runs at `document_idle` may also be missed. Network + DOM layers still catch most worker scripts.
- **Deep Scan results are inferences until verified.** Chunk URLs rebuilt from bundler templates are marked `inferred`; `HEAD` verification (when enabled) promotes the real ones to `confirmed`, but heavily obfuscated or non-standard bundlers may yield nothing.
- **Mining is heuristic.** High-signal patterns (AWS/Google/Slack/Stripe/… keys) are reliable; the generic `key=…` pattern is low-confidence and can produce false positives. Secret values are masked in the UI, but exports of the Findings/Sources views may still contain sensitive data — handle them accordingly.
- **The AI layer is bring-your-own-key and third-party.** It bills your provider account and sends page-derived data to that provider. Model ids drift, so JSHarvest falls back through a candidate list and caches whichever one answers. The extension works fully without it.
- **Firefox needs the host permission granted by hand**, and temporary add-ons disappear on restart. Signing the package (`web-ext sign` or AMO) removes both frictions but is out of scope here.
