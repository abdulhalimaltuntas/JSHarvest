// popup/popup.js
// Aktif sekmenin toplanan JS listesini gosterir, filtreler, analiz eder ve
// disa aktarir. Cerceve yok; DOM API'leri dogrudan. Kullanici verisi yalnizca
// textContent ile yazilir (innerHTML yok).
//
// Gorunumler: scripts (varsayilan), findings (sir/endpoint), sources (source map
// kaynak agaci), diff (snapshot karsilastirmasi).

import { decorate, compareEntries, summarize, kindLabel } from '../lib/classify.js';
import { api } from '../lib/browser-api.js';
import {
  buildExport, buildFindingsExport, buildSourcesExport,
  buildFilename, toTXT, toWordlist
} from '../lib/export.js';
import { getSettings } from '../lib/settings.js';
import { saveSnapshot, getLatestSnapshot } from '../lib/history.js';
import { diffCaptures } from '../lib/diff.js';
import { runAnalysis, getApiKey, detectProvider, PROVIDERS, modelsFor } from '../lib/ai.js';
import { renderMarkdown } from '../lib/markdown.js';

const ROW_HEIGHT = 56;   // popup.css --row-h ile ayni olmali
const OVERSCAN = 6;
const SEARCH_DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 1200;
const SUPPORTED_PAGE_RE = /^(?:https?|file):/i;

const el = {
  host: document.getElementById('host'),
  openOptions: document.getElementById('openOptions'),
  statTotal: document.getElementById('statTotal'),
  statFirst: document.getElementById('statFirst'),
  statThird: document.getElementById('statThird'),
  statSize: document.getElementById('statSize'),
  specFirst: document.getElementById('specFirst'),
  specThird: document.getElementById('specThird'),
  specRisk: document.getElementById('specRisk'),
  spectrum: document.getElementById('spectrum'),
  tabs: document.getElementById('tabs'),
  tabFindings: document.getElementById('tabFindings'),
  tabSources: document.getElementById('tabSources'),
  search: document.getElementById('search'),
  chips: document.getElementById('chips'),
  list: document.getElementById('list'),
  scroller: document.getElementById('scroller'),
  stateLoading: document.getElementById('stateLoading'),
  stateEmpty: document.getElementById('stateEmpty'),
  stateNoMatch: document.getElementById('stateNoMatch'),
  scanbar: document.getElementById('scanbar'),
  scanLabel: document.getElementById('scanLabel'),
  scanFill: document.getElementById('scanFill'),
  scanCancel: document.getElementById('scanCancel'),
  detail: document.getElementById('detail'),
  detailTitle: document.getElementById('detailTitle'),
  detailBody: document.getElementById('detailBody'),
  detailClose: document.getElementById('detailClose'),
  detailCopy: document.getElementById('detailCopy'),
  detailOpen: document.getElementById('detailOpen'),
  copyAll: document.getElementById('copyAll'),
  exportBtn: document.getElementById('exportBtn'),
  exportMenu: document.getElementById('exportMenu'),
  snapshot: document.getElementById('snapshot'),
  deepScan: document.getElementById('deepScan'),
  clear: document.getElementById('clear'),
  toast: document.getElementById('toast'),
  controls: document.querySelector('.controls'),
  aiPanel: document.getElementById('aiPanel'),
  aiHint: document.getElementById('aiHint'),
  aiWork: document.getElementById('aiWork'),
  aiRuns: document.getElementById('aiRuns'),
  aiOut: document.getElementById('aiOut'),
  aiMeta: document.getElementById('aiMeta'),
  aiRun: document.getElementById('aiRun'),
  aiStop: document.getElementById('aiStop'),
  aiQuestion: document.getElementById('aiQuestion'),
  aiCopy: document.getElementById('aiCopy'),
  aiOpenOptions: document.getElementById('aiOpenOptions')
};

const state = {
  tabId: null,
  pageUrl: '',
  supported: true,
  loaded: false,
  updatedAt: -1,
  scanning: false,
  view: 'scripts',
  scripts: [],
  findings: [],
  origins: [],
  prevSnapshot: null,
  filter: 'all',
  query: '',
  showSpecial: false,
  filtered: [],
  detailItem: null,
  settings: null,
  aiRunning: false,
  aiController: null,
  aiText: '',
  aiHistory: [],      // takip sorulari icin konusma gecmisi
  aiModel: ''
};

let searchTimer = null;
let toastTimer = null;
let pollTimer = null;

// ---------------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function send(message) {
  return new Promise((resolve) => {
    try {
      const result = api.runtime.sendMessage(message);
      if (result && typeof result.then === 'function') {
        result.then((r) => resolve(r || { ok: false, error: 'empty' }))
          .catch((e) => resolve({ ok: false, error: String(e && e.message ? e.message : e) }));
      } else {
        resolve({ ok: false, error: 'no response' });
      }
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
}

async function getActiveTab() {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch {
    return null;
  }
}

function makeEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// Veri
// ---------------------------------------------------------------------------

async function load({ silent = false } = {}) {
  if (state.tabId == null) return;
  const response = await send({ type: 'get-tab-data', tabId: state.tabId });
  if (!response.ok) {
    if (!silent) showStates({ empty: true });
    return;
  }
  if (silent && response.updatedAt === state.updatedAt && !response.deepScanRunning) return;

  state.updatedAt = response.updatedAt;
  state.pageUrl = response.pageUrl || state.pageUrl;
  state.scripts = (response.entries || [])
    .map((entry) => decorate(entry, state.pageUrl))
    .sort(compareEntries);
  state.findings = response.findings || [];
  state.origins = response.origins || [];
  state.loaded = true;

  if (response.deepScanRunning && !state.scanning) setScanning(true);
  applyView();
  renderHeader();
  renderTabCounts();
}

async function refreshSnapshot() {
  try {
    state.prevSnapshot = await getLatestSnapshot(state.pageUrl);
  } catch {
    state.prevSnapshot = null;
  }
}

// ---------------------------------------------------------------------------
// Gorunum + filtre
// ---------------------------------------------------------------------------

function currentDiff() {
  const prev = state.prevSnapshot ? state.prevSnapshot.entries : [];
  return diffCaptures(prev, state.scripts);
}

function baseItems() {
  switch (state.view) {
    case 'findings':
      return state.findings;
    case 'sources':
      return state.origins;
    case 'diff': {
      const d = currentDiff();
      return [
        ...d.added.map((e) => ({ ...e, _diff: 'added' })),
        ...d.changed.map((e) => ({ ...e, _diff: 'changed' })),
        ...d.removed.map((e) => ({ ...e, _diff: 'removed' }))
      ];
    }
    case 'scripts':
    default:
      return state.showSpecial
        ? state.scripts
        : state.scripts.filter((e) => e.scheme !== 'blob' && e.scheme !== 'data');
  }
}

function matchesQuery(item, q) {
  if (!q) return true;
  switch (state.view) {
    case 'findings':
      return (`${item.type} ${item.value} ${item.file} ${item.snippet}`).toLowerCase().includes(q);
    case 'sources':
      return String(item.path || '').toLowerCase().includes(q);
    default:
      return String(item.normalizedUrl || '').toLowerCase().includes(q);
  }
}

function passesChip(entry) {
  switch (state.filter) {
    case 'first': return entry.party === 'first';
    case 'third': return entry.party !== 'first';
    case 'bundles': return Boolean(entry.isBundle);
    case 'maps': return Boolean(entry.hasSourceMap) || entry.kind === 'sourcemap';
    case 'risk': return Boolean(entry.noIntegrity) || Boolean(entry.mixedContent);
    default: return true;
  }
}

function updateChrome() {
  const isAi = state.view === 'ai';
  el.controls.style.display = isAi ? 'none' : '';
  el.list.style.display = isAi ? 'none' : '';
  el.aiPanel.hidden = !isAi;
  // Export/Copy/Snapshot AI gorunumunde anlamsiz.
  for (const b of [el.copyAll, el.exportBtn, el.snapshot]) b.style.display = isAi ? 'none' : '';
  if (isAi) showStates({});
}

function applyView() {
  updateChrome();
  if (state.view === 'ai') { setupAiView(); return; }

  const q = state.query.trim().toLowerCase();
  let items = baseItems();
  if (state.view === 'scripts') items = items.filter(passesChip);
  state.filtered = items.filter((item) => matchesQuery(item, q));

  // Chip'ler yalnizca scripts gorunumunde anlamli.
  el.chips.style.display = state.view === 'scripts' ? '' : 'none';
  el.search.placeholder = state.view === 'findings' ? 'Filter findings…'
    : state.view === 'sources' ? 'Filter source paths…'
    : state.view === 'diff' ? 'Filter changes…' : 'Filter…';

  renderList();
  renderStates();
  buildExportMenu();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderHeader() {
  let host = state.pageUrl;
  try { host = new URL(state.pageUrl).host || state.pageUrl; } catch { /* ham */ }
  el.host.textContent = host || '—';
  el.host.title = state.pageUrl || '';

  const visible = state.showSpecial
    ? state.scripts
    : state.scripts.filter((e) => e.scheme !== 'blob' && e.scheme !== 'data');
  const stats = summarize(visible);
  const totalSize = visible.reduce((sum, e) => sum + (e.size || 0), 0);
  el.statTotal.textContent = `${stats.total} script${stats.total === 1 ? '' : 's'}`;
  el.statFirst.textContent = `${stats.first} first-party`;
  el.statThird.textContent = `${stats.third} third-party`;
  // Capraz-kaynak yanitlarda Timing-Allow-Origin yoksa transferSize 0 gelir;
  // "0 B" yaziyi yanlis olarak "hicbir sey yuklenmedi" gibi gosteriyordu.
  el.statSize.textContent = totalSize > 0 ? formatBytes(totalSize) : '';
  el.statSize.hidden = totalSize === 0;

  // Spektrum: first | third (risksiz) | risk. Risk, third-party'nin alt kumesi.
  const risky = visible.filter((e) => e.noIntegrity || e.mixedContent).length;
  const thirdSafe = Math.max(0, stats.third - risky);
  const total = stats.total || 1;
  const pct = (n) => `${(n / total) * 100}%`;
  el.specFirst.style.width = pct(stats.first);
  el.specThird.style.width = pct(thirdSafe);
  el.specRisk.style.width = pct(risky);
  el.spectrum.setAttribute('aria-label',
    `Composition: ${stats.first} first-party, ${thirdSafe} third-party, ${risky} at risk`);
}

function renderTabCounts() {
  el.tabFindings.textContent = String(state.findings.length);
  el.tabSources.textContent = String(state.origins.length);
}

function showStates({ loading = false, empty = false, noMatch = false }) {
  el.stateLoading.hidden = !loading;
  el.stateEmpty.hidden = !empty;
  el.stateNoMatch.hidden = !noMatch;
}

function renderStates() {
  if (!state.loaded) { showStates({ loading: true }); return; }
  if (!state.supported) { showStates({ empty: true }); return; }
  const base = baseItems();
  if (base.length === 0) {
    // Gorunume ozel bos-durum metni.
    const title = state.view === 'findings' ? 'No findings'
      : state.view === 'sources' ? 'No recovered sources'
      : state.view === 'diff' ? (state.prevSnapshot ? 'No changes' : 'No snapshot yet')
      : 'Nothing collected yet';
    const hint = state.view === 'findings' ? 'Run Deep Scan with mining enabled to surface secrets and endpoints.'
      : state.view === 'sources' ? 'Run Deep Scan with source recovery enabled to rebuild the original file tree.'
      : state.view === 'diff' ? (state.prevSnapshot ? 'Current capture matches the last snapshot.' : 'Take a Snapshot, browse or reload, then compare.')
      : 'Reload the page or browse around — JSHarvest records scripts as they load.';
    el.stateEmpty.querySelector('.state__title').textContent = title;
    el.stateEmpty.querySelector('.state__hint').textContent = hint;
    showStates({ empty: true });
    return;
  }
  showStates({ noMatch: state.filtered.length === 0 });
}

function badge(cls, text) { return makeEl('span', `badge ${cls}`, text); }

function scriptRow(entry) {
  const classes = ['row', entry.party === 'first' ? 'is-first' : 'is-third'];
  if (entry.confidence === 'inferred') classes.push('is-inferred');
  const row = makeEl('div', classes.join(' '));

  const top = makeEl('div', 'row__top');
  top.appendChild(makeEl('span', 'row__name', entry.fileName));
  const badges = makeEl('div', 'row__badges');
  if (entry.confidence === 'inferred') badges.appendChild(badge('badge--inferred', 'inferred'));
  if (entry.kind === 'worker' || entry.kind === 'serviceworker') badges.appendChild(badge('badge--worker', 'worker'));
  // Vendor adi tam gosterilir; "Google Tag Manager".split(' ')[0] gibi kisaltma
  // yanlis marka atfina yol aciyordu.
  if (entry.vendor) badges.appendChild(badge('badge--vendor', entry.vendor));
  if (entry.party !== 'first') badges.appendChild(badge('badge--3p', '3P'));
  if (entry.noIntegrity) badges.appendChild(badge('badge--risk', 'no-SRI'));
  if (entry.mixedContent) badges.appendChild(badge('badge--risk', 'mixed'));
  if (entry.isBundle) badges.appendChild(badge('badge--bundle', 'bundle'));
  if (entry.hasSourceMap || entry.kind === 'sourcemap') badges.appendChild(badge('badge--map', 'map'));
  if (entry.error) badges.appendChild(badge('badge--err', 'err'));
  else if (entry.statusCode) badges.appendChild(badge(entry.statusCode >= 400 ? 'badge--err' : 'badge--status', String(entry.statusCode)));
  top.appendChild(badges);
  row.appendChild(top);
  row.appendChild(makeEl('span', 'row__path', entry.dirPath));
  return row;
}

function findingRow(item) {
  const row = makeEl('div', `row ${item.category === 'secret' ? 'is-secret' : 'is-endpoint'}`);
  const top = makeEl('div', 'row__top');
  top.appendChild(makeEl('span', 'row__value', item.value));
  const badges = makeEl('div', 'row__badges');
  badges.appendChild(badge(item.category === 'secret' ? 'badge--secret' : 'badge--endpoint', item.type));
  badges.appendChild(badge(`badge--conf-${item.confidence}`, item.confidence));
  top.appendChild(badges);
  row.appendChild(top);
  let file = item.file;
  try { file = new URL(item.file).pathname; } catch { /* ham */ }
  row.appendChild(makeEl('span', 'row__meta', file));
  return row;
}

function sourceRow(item) {
  const row = makeEl('div', 'row');
  const top = makeEl('div', 'row__top');
  const name = item.path.split('/').filter(Boolean).pop() || item.path;
  top.appendChild(makeEl('span', 'row__value', name));
  const badges = makeEl('div', 'row__badges');
  if (item.hasContent) badges.appendChild(badge('badge--map', 'content'));
  top.appendChild(badges);
  row.appendChild(top);
  row.appendChild(makeEl('span', 'row__meta', item.path));
  return row;
}

function diffRow(item) {
  const marker = item._diff;
  const row = makeEl('div', `row is-${marker}`);
  const top = makeEl('div', 'row__top');
  top.appendChild(makeEl('span', 'row__name', item.fileName || item.normalizedUrl));
  const badges = makeEl('div', 'row__badges');
  const map = { added: ['badge--diff-add', '+ added'], removed: ['badge--diff-rm', '− removed'], changed: ['badge--diff-ch', '~ changed'] };
  badges.appendChild(badge(map[marker][0], map[marker][1]));
  if (marker === 'changed' && item.prevStatus !== item.statusCode) {
    badges.appendChild(badge('badge--status', `${item.prevStatus ?? '—'}→${item.statusCode ?? '—'}`));
  }
  top.appendChild(badges);
  row.appendChild(top);
  row.appendChild(makeEl('span', 'row__path', item.dirPath || item.normalizedUrl));
  return row;
}

function buildRow(item, index) {
  let row;
  if (state.view === 'findings') row = findingRow(item);
  else if (state.view === 'sources') row = sourceRow(item);
  else if (state.view === 'diff') row = diffRow(item);
  else row = scriptRow(item);
  row.style.top = `${index * ROW_HEIGHT}px`;
  row.dataset.index = String(index);
  return row;
}

function renderList() {
  const total = state.filtered.length;
  el.scroller.style.height = `${total * ROW_HEIGHT}px`;
  const scrollTop = el.list.scrollTop;
  const viewportHeight = el.list.clientHeight || 400;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) fragment.appendChild(buildRow(state.filtered[i], i));
  el.scroller.textContent = '';
  el.scroller.appendChild(fragment);
}

// ---------------------------------------------------------------------------
// Detay paneli
// ---------------------------------------------------------------------------

function detailRow(key, value) {
  const row = makeEl('div', 'detail__row');
  row.appendChild(makeEl('span', 'detail__key', key));
  row.appendChild(makeEl('span', 'detail__val', value));
  return row;
}

function openDetail(item) {
  state.detailItem = item;
  el.detailBody.textContent = '';
  let title = '';
  let openUrl = '';

  if (state.view === 'findings') {
    title = item.type;
    el.detailBody.appendChild(detailRow('Type', item.type));
    el.detailBody.appendChild(detailRow('Category', item.category));
    el.detailBody.appendChild(detailRow('Confidence', item.confidence));
    el.detailBody.appendChild(detailRow('Value', item.value));
    el.detailBody.appendChild(detailRow('File', item.file));
    const snip = makeEl('div', 'detail__snippet', item.snippet);
    el.detailBody.appendChild(snip);
    openUrl = item.file;
  } else if (state.view === 'sources') {
    title = item.path.split('/').pop() || item.path;
    el.detailBody.appendChild(detailRow('Path', item.path));
    el.detailBody.appendChild(detailRow('Has content', item.hasContent ? 'yes' : 'no'));
    el.detailBody.appendChild(detailRow('From map', item.map || '—'));
    openUrl = item.map || '';
  } else {
    const e = item;
    title = e.fileName || e.normalizedUrl;
    el.detailBody.appendChild(detailRow('URL', e.normalizedUrl));
    el.detailBody.appendChild(detailRow('Party', e.party === 'first' ? 'first-party' : 'third-party'));
    el.detailBody.appendChild(detailRow('Kind', kindLabel(e.kind)));
    if (e.vendor) el.detailBody.appendChild(detailRow('Vendor', e.vendor));
    el.detailBody.appendChild(detailRow('Status', e.error || (e.statusCode ?? '—')));
    el.detailBody.appendChild(detailRow('Size', formatBytes(e.size)));
    if (e.duration) el.detailBody.appendChild(detailRow('Duration', `${e.duration} ms`));
    el.detailBody.appendChild(detailRow('Sources', (e.sources || []).join(', ')));
    if (e.frameIds && e.frameIds.length) el.detailBody.appendChild(detailRow('Frames', e.frameIds.join(', ')));
    el.detailBody.appendChild(detailRow('Confidence', e.confidence || 'confirmed'));
    if (e.hasSourceMap) el.detailBody.appendChild(detailRow('Source map', e.sourceMapUrl || 'yes'));
    if (e.mapSourceCount != null) el.detailBody.appendChild(detailRow('Map sources', String(e.mapSourceCount)));
    if (e.noIntegrity) el.detailBody.appendChild(detailRow('SRI', 'missing (third-party)'));
    if (e.mixedContent) el.detailBody.appendChild(detailRow('Security', 'mixed content'));
    if (e.initiator) el.detailBody.appendChild(detailRow('Initiator', e.initiator));
    openUrl = e.normalizedUrl;
  }

  el.detailTitle.textContent = title;
  el.detail.dataset.copy = openUrl;
  el.detail.dataset.open = /^https?:/i.test(openUrl) ? openUrl : '';
  el.detailOpen.style.display = el.detail.dataset.open ? '' : 'none';
  el.detail.hidden = false;
}

function closeDetail() {
  el.detail.hidden = true;
  state.detailItem = null;
}

// ---------------------------------------------------------------------------
// Export menu (gorunume gore)
// ---------------------------------------------------------------------------

const EXPORT_MENUS = {
  scripts: [
    ['txt', 'TXT — one URL per line'],
    ['json', 'JSON — full metadata'],
    ['csv', 'CSV — spreadsheet'],
    ['md', 'Markdown — grouped'],
    ['wordlist', 'Wordlist — ffuf/gobuster'],
    ['curl', 'curl — status probe script'],
    ['har', 'HAR — devtools archive']
  ],
  findings: [
    ['md', 'Markdown — report'],
    ['csv', 'CSV — spreadsheet'],
    ['json', 'JSON — full']
  ],
  sources: [
    ['tree', 'Tree — file hierarchy'],
    ['txt', 'TXT — one path per line'],
    ['json', 'JSON — full']
  ],
  diff: [
    ['txt', 'TXT — added + changed URLs'],
    ['json', 'JSON — added entries']
  ]
};

function buildExportMenu() {
  el.exportMenu.textContent = '';
  for (const [format, label] of EXPORT_MENUS[state.view] || EXPORT_MENUS.scripts) {
    const btn = makeEl('button', null, label);
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.dataset.format = format;
    el.exportMenu.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Etkilesim
// ---------------------------------------------------------------------------

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1600);
}

async function copyText(text, successMessage) {
  if (!text) { toast('Nothing to copy'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage);
    return;
  } catch { /* fallback */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    toast(ok ? successMessage : 'Copy failed');
  } catch {
    toast('Copy failed');
  }
}

/** Aktif gorunumun filtrelenmis icerigini duz metne cevirir. */
function currentAsText() {
  if (state.view === 'findings') {
    return state.filtered.map((f) => `${f.type}\t${f.value}\t${f.file}`).join('\n') + (state.filtered.length ? '\n' : '');
  }
  if (state.view === 'sources') {
    return state.filtered.map((s) => s.path).join('\n') + (state.filtered.length ? '\n' : '');
  }
  return toTXT(state.filtered);
}

function triggerDownload(content, mime, ext) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = buildFilename(state.pageUrl, ext);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function download(format) {
  let result;
  if (state.view === 'findings') result = buildFindingsExport(format, state.filtered, state.pageUrl);
  else if (state.view === 'sources') result = buildSourcesExport(format, state.filtered, state.pageUrl);
  else result = buildExport(format, state.filtered, state.pageUrl);
  triggerDownload(result.content, result.mime, result.ext);
  toast(`Exported ${state.filtered.length} as ${result.ext.toUpperCase()}`);
}

function setScanning(active) {
  state.scanning = active;
  el.scanbar.hidden = !active;
  el.deepScan.disabled = active;
  if (!active) {
    el.scanFill.style.width = '0%';
    el.scanLabel.textContent = 'Deep scan…';
  }
}

function setExportMenu(open) {
  el.exportMenu.hidden = !open;
  el.exportBtn.setAttribute('aria-expanded', String(open));
}

function switchView(view) {
  if (state.view === view) return;
  state.view = view;
  state.query = '';
  el.search.value = '';
  closeDetail();
  for (const tab of el.tabs.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.view === view);
  }
  el.list.scrollTop = 0;
  applyView();
}

el.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) switchView(tab.dataset.view);
});

el.list.addEventListener('scroll', () => renderList(), { passive: true });

el.list.addEventListener('click', (event) => {
  const row = event.target.closest('.row');
  if (!row || row.dataset.index == null) return;
  const item = state.filtered[Number(row.dataset.index)];
  if (item) openDetail(item);
});

el.detailClose.addEventListener('click', closeDetail);
el.detailCopy.addEventListener('click', () => copyText(el.detail.dataset.copy, 'Copied'));
el.detailOpen.addEventListener('click', () => {
  const url = el.detail.dataset.open;
  if (url) api.tabs.create({ url }).catch(() => toast('Could not open'));
});

el.openOptions.addEventListener('click', () => {
  if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
});

el.search.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = el.search.value;
    el.list.scrollTop = 0;
    applyView();
  }, SEARCH_DEBOUNCE_MS);
});

el.chips.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  if (chip.dataset.toggle === 'special') {
    state.showSpecial = !state.showSpecial;
    chip.classList.toggle('is-active', state.showSpecial);
    applyView();
    renderHeader();
    return;
  }
  state.filter = chip.dataset.filter || 'all';
  for (const node of el.chips.querySelectorAll('.chip[data-filter]')) {
    node.classList.toggle('is-active', node === chip);
  }
  el.list.scrollTop = 0;
  applyView();
});

el.copyAll.addEventListener('click', () => {
  copyText(currentAsText(), `Copied ${state.filtered.length} item(s)`);
});

el.exportBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  setExportMenu(el.exportMenu.hidden);
});

el.exportMenu.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-format]');
  if (!button) return;
  setExportMenu(false);
  download(button.dataset.format);
});

document.addEventListener('click', (event) => {
  if (!el.exportMenu.hidden && !event.target.closest('.menu-wrap')) setExportMenu(false);
});

el.snapshot.addEventListener('click', async () => {
  const saved = await saveSnapshot(state.pageUrl, state.scripts);
  if (saved) {
    await refreshSnapshot();
    toast('Snapshot saved');
    if (state.view === 'diff') applyView();
  } else {
    toast('History disabled (see Options)');
  }
});

el.deepScan.addEventListener('click', async () => {
  if (state.scanning || state.tabId == null) return;
  setScanning(true);
  el.scanLabel.textContent = 'Deep scan starting…';
  const response = await send({ type: 'deep-scan-start', tabId: state.tabId });
  if (!response.ok) {
    setScanning(false);
    toast(response.error || 'Deep scan failed');
  }
});

el.scanCancel.addEventListener('click', () => {
  send({ type: 'deep-scan-cancel', tabId: state.tabId });
  el.scanLabel.textContent = 'Cancelling…';
});

el.clear.addEventListener('click', async () => {
  const response = await send({ type: 'clear-tab', tabId: state.tabId });
  if (!response.ok) { toast(response.error || 'Clear failed'); return; }
  state.updatedAt = -1;
  await load();
  toast('Cleared');
});

// --- AI gorunumu ---

async function setupAiView() {
  const settings = await getSettings();   // Options'ta degismis olabilir
  state.settings = settings;
  let key = '';
  try { key = await getApiKey(); } catch { key = ''; }
  const providerId = detectProvider(key);
  const ready = Boolean(settings.aiEnabled) && Boolean(key) && Boolean(providerId);
  el.aiHint.hidden = ready;
  el.aiWork.hidden = !ready;
  if (ready && !state.aiRunning) showAiIdentity(providerId, settings);
}

/**
 * Calisma oncesinde de hangi saglayici ve modelin kullanilacagini gosterir.
 * Model sabitlenmemisse saglayicinin ilk adayi gosterilir; gercekte kullanilan
 * model calisma sonrasinda kesinlesir ve ayni satirda guncellenir.
 */
function showAiIdentity(providerId, settings) {
  const provider = PROVIDERS[providerId];
  if (!provider) { el.aiMeta.textContent = ''; return; }
  const pinned = (settings.aiModel || '').trim();
  const model = state.aiModel || pinned || (modelsFor(providerId)[0] || '');
  const suffix = pinned ? ' · pinned' : (state.aiModel ? '' : ' · auto');
  el.aiMeta.textContent = `${provider.label}${model ? ' · ' + model : ''}${suffix}`;
}

function setAiRunning(active) {
  el.aiStop.hidden = !active;
  el.aiRun.hidden = active;
  el.aiQuestion.disabled = active;
  for (const b of el.aiRuns.querySelectorAll('.ai-run')) b.disabled = active;
}

/** Akan ham metni markdown olarak cizer (innerHTML yok). */
function paintAi() {
  el.aiOut.textContent = '';
  el.aiOut.appendChild(renderMarkdown(state.aiText));
}

function aiLabel(analysis) {
  return analysis === 'freeform' ? 'question' : analysis;
}

async function runAi(analysis, question, { followUp = false } = {}) {
  if (state.aiRunning) return;
  const q = (question || '').trim();
  if (analysis === 'freeform' && !q) { toast('Type a question first'); return; }
  if (!state.scripts.length) { toast('Nothing collected to analyze'); return; }

  // Yeni analiz konusmayi sifirlar; takip sorusu gecmisi korur.
  if (!followUp) state.aiHistory = [];

  state.aiRunning = true;
  state.aiText = '';
  state.aiController = new AbortController();
  el.aiOut.classList.add('is-streaming');
  el.aiOut.textContent = '';
  setAiRunning(true);
  el.aiMeta.textContent = `${state.aiModel || 'model'} · ${aiLabel(analysis)} · thinking…`;

  const data = { pageUrl: state.pageUrl, entries: state.scripts, findings: state.findings, origins: state.origins };
  let painted = 0;
  try {
    const result = await runAnalysis({
      data,
      analysis,
      question: q,
      history: followUp ? state.aiHistory : [],
      signal: state.aiController.signal,
      onDelta: (chunk) => {
        state.aiText += chunk;
        // Her parcada tam yeniden cizim pahali; ~80 karakterde bir ciz.
        if (state.aiText.length - painted > 80) {
          painted = state.aiText.length;
          paintAi();
          el.aiOut.scrollTop = el.aiOut.scrollHeight;
        }
      }
    });
    paintAi();
    el.aiOut.scrollTop = el.aiOut.scrollHeight;
    if (!state.aiText) el.aiOut.textContent = 'The provider returned an empty response.';

    // Konusmayi surdurmek icin gecmisi guncelle.
    const askedAs = analysis === 'freeform' ? q : `Run the "${analysis}" analysis.`;
    state.aiHistory.push({ role: 'user', content: askedAs });
    state.aiHistory.push({ role: 'assistant', content: state.aiText });
    if (state.aiHistory.length > 8) state.aiHistory = state.aiHistory.slice(-8);

    state.aiModel = result && result.model ? result.model : '';
    const providerLabel = result && result.provider && PROVIDERS[result.provider]
      ? PROVIDERS[result.provider].label : '';
    el.aiMeta.textContent = [providerLabel, state.aiModel, aiLabel(analysis), 'ask a follow-up below']
      .filter(Boolean).join(' · ');
    el.aiQuestion.placeholder = 'Follow-up question…';
  } catch (err) {
    const message = (err && err.name === 'AbortError') ? 'Stopped.' : (err && err.message ? err.message : String(err));
    paintAi();
    const notice = document.createElement('p');
    notice.className = 'ai__error';
    notice.textContent = message;
    el.aiOut.appendChild(notice);
    el.aiMeta.textContent = 'error';
  } finally {
    state.aiRunning = false;
    state.aiController = null;
    el.aiOut.classList.remove('is-streaming');
    setAiRunning(false);
  }
}

el.aiRuns.addEventListener('click', (event) => {
  const btn = event.target.closest('.ai-run');
  if (btn) runAi(btn.dataset.analysis, '');
});
el.aiRun.addEventListener('click', () => {
  const value = el.aiQuestion.value;
  el.aiQuestion.value = '';
  runAi('freeform', value, { followUp: state.aiHistory.length > 0 });
});
el.aiQuestion.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const value = el.aiQuestion.value;
  el.aiQuestion.value = '';
  runAi('freeform', value, { followUp: state.aiHistory.length > 0 });
});
el.aiStop.addEventListener('click', () => { if (state.aiController) state.aiController.abort(); });
el.aiCopy.addEventListener('click', () => copyText(state.aiText, 'Analysis copied'));
el.aiOpenOptions.addEventListener('click', () => { if (api.runtime.openOptionsPage) api.runtime.openOptionsPage(); });

document.addEventListener('keydown', (event) => {
  const inField = event.target === el.search;
  if (event.key === '/' && !inField) {
    event.preventDefault();
    el.search.focus();
    el.search.select();
    return;
  }
  if (event.key === 'Escape') {
    if (!el.detail.hidden) { closeDetail(); return; }
    if (!el.exportMenu.hidden) { setExportMenu(false); return; }
    el.search.value = '';
    state.query = '';
    state.filter = 'all';
    for (const node of el.chips.querySelectorAll('.chip[data-filter]')) {
      node.classList.toggle('is-active', node.dataset.filter === 'all');
    }
    el.search.blur();
    el.list.scrollTop = 0;
    applyView();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'c' || event.key === 'C')) {
    const selection = String(window.getSelection() || '');
    if (selection.trim().length > 0) return;
    event.preventDefault();
    copyText(currentAsText(), `Copied ${state.filtered.length} item(s)`);
  }
});

api.runtime.onMessage.addListener((message) => {
  if (!message || message.tabId !== state.tabId) return;
  if (message.type === 'deep-scan-progress') {
    setScanning(true);
    const percent = message.total > 0 ? Math.round((message.done / message.total) * 100) : 0;
    el.scanFill.style.width = `${percent}%`;
    const extra = [];
    if (message.findings) extra.push(`${message.findings} secrets`);
    if (message.sources) extra.push(`${message.sources} sources`);
    el.scanLabel.textContent = `Deep scan ${message.done}/${message.total} · ${message.found} found${extra.length ? ' · ' + extra.join(' · ') : ''}`;
  } else if (message.type === 'deep-scan-done') {
    setScanning(false);
    state.updatedAt = -1;
    load();
    toast(message.error
      ? `Deep scan error: ${message.error}`
      : `Deep scan finished · ${message.found || 0} found`);
  }
});

// ---------------------------------------------------------------------------
// Baslangic
// ---------------------------------------------------------------------------

function disableActions() {
  for (const b of [el.deepScan, el.copyAll, el.exportBtn, el.clear, el.snapshot]) b.disabled = true;
}

async function init() {
  showStates({ loading: true });
  buildExportMenu();
  try { state.settings = await getSettings(); } catch { state.settings = null; }
  if (state.settings) state.showSpecial = Boolean(state.settings.showSpecialByDefault);

  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== 'number') {
    state.loaded = true;
    state.supported = false;
    el.stateEmpty.querySelector('.state__title').textContent = 'No active tab';
    el.stateEmpty.querySelector('.state__hint').textContent = 'Open a web page and try again.';
    renderStates();
    return;
  }

  state.tabId = tab.id;
  state.pageUrl = tab.url || '';
  state.supported = SUPPORTED_PAGE_RE.test(state.pageUrl);

  if (!state.supported) {
    state.loaded = true;
    renderHeader();
    el.stateEmpty.querySelector('.state__title').textContent = 'Page not supported';
    el.stateEmpty.querySelector('.state__hint').textContent =
      'JSHarvest cannot inspect browser or extension pages (chrome://, about:, extension URLs).';
    disableActions();
    renderStates();
    return;
  }

  if (state.showSpecial) {
    const chip = el.chips.querySelector('#chipSpecial');
    if (chip) chip.classList.add('is-active');
  }

  await refreshSnapshot();
  await load();
  renderHeader();
  pollTimer = setInterval(() => { load({ silent: true }); }, POLL_INTERVAL_MS);
}

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});

init();
