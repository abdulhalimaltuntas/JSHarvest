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
import { getApiKey, detectProvider, PROVIDERS, modelsFor } from '../lib/ai.js';
import { renderMarkdown } from '../lib/markdown.js';
import { listForPage, saveAnalysis, clearAnalyses } from '../lib/ai-history.js';
import { getTriage, setState as setTriageState, countStates, STATE_LABELS } from '../lib/triage.js';
import { buildSessionReport, buildSessionJson } from '../lib/report.js';

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
  aiOpenOptions: document.getElementById('aiOpenOptions'),
  aiHistoryBtn: document.getElementById('aiHistoryBtn'),
  aiHistory: document.getElementById('aiHistory'),
  aiHistoryList: document.getElementById('aiHistoryList'),
  aiHistoryClose: document.getElementById('aiHistoryClose'),
  detailAskAi: document.getElementById('detailAskAi'),
  ctxmenu: document.getElementById('ctxmenu'),
  sessionPill: document.getElementById('sessionPill'),
  sessionDot: document.getElementById('sessionDot'),
  sessionName: document.getElementById('sessionName'),
  sessionCount: document.getElementById('sessionCount'),
  sessionMenu: document.getElementById('sessionMenu'),
  authToggle: document.getElementById('authToggle'),
  authLabel: document.getElementById('authLabel'),
  sessionView: document.getElementById('sessionView'),
  sessionEmpty: document.getElementById('sessionEmpty'),
  sessionBody: document.getElementById('sessionBody'),
  sessionStats: document.getElementById('sessionStats'),
  sessionScope: document.getElementById('sessionScope'),
  sessionNotes: document.getElementById('sessionNotes'),
  sessionReport: document.getElementById('sessionReport'),
  sessionExportJson: document.getElementById('sessionExportJson'),
  sessionDelete: document.getElementById('sessionDelete'),
  sessionCreateEmpty: document.getElementById('sessionCreateEmpty')
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
  aiText: '',
  aiHistory: [],      // takip sorulari icin konusma gecmisi
  aiModel: '',
  aiTarget: null,     // hedefli analiz (tek bulgu / tek script)
  ctxItem: null,      // sag tiklanan satir
  session: null,      // bagli angajman { id, name, scope }
  authState: 'anon',  // bu sekmede yakalanan kimlik durumu
  triage: {},         // dedupeKey -> durum
  sessionData: null,  // Session gorunumu icin yuklenen oturum verisi
  aiRunId: '',        // background'da devam eden analizin kimligi
  aiPendingAsk: ''    // yanit bekleyen soru (konusma gecmisi icin)
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
  state.session = response.session || null;
  state.authState = response.authState || 'anon';
  state.loaded = true;

  if (response.deepScanRunning && !state.scanning) setScanning(true);
  applyView();
  renderHeader();
  renderTabCounts();
  renderSessionBar();
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
    case 'new': return (state.triage[entry.key] || 'new') === 'new';
    case 'interesting': return state.triage[entry.key] === 'interesting';
    case 'authonly': return (entry.authStates || []).includes('auth')
      && !(entry.authStates || []).includes('anon');
    default: return true;
  }
}

function updateChrome() {
  const isAi = state.view === 'ai';
  const isSession = state.view === 'session';
  const isPanel = isAi || isSession;
  el.controls.style.display = isPanel ? 'none' : '';
  el.list.style.display = isPanel ? 'none' : '';
  el.aiPanel.hidden = !isAi;
  el.sessionView.hidden = !isSession;
  // Export/Copy/Snapshot yalnizca liste gorunumlerinde anlamli.
  for (const b of [el.copyAll, el.exportBtn, el.snapshot]) b.style.display = isPanel ? 'none' : '';
  if (isPanel) showStates({});
}

function applyView() {
  updateChrome();
  if (state.view === 'ai') { setupAiView(); return; }
  if (state.view === 'session') { renderSessionView(); return; }

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
  const triageState = state.triage[entry.key];
  if (triageState) classes.push(`is-${triageState}`);
  const row = makeEl('div', classes.join(' '));

  const top = makeEl('div', 'row__top');
  top.appendChild(makeEl('span', 'row__name', entry.fileName));
  const badges = makeEl('div', 'row__badges');
  if (triageState === 'interesting') badges.appendChild(badge('badge--triage', '★'));
  if ((entry.authStates || []).includes('auth') && !(entry.authStates || []).includes('anon')) {
    badges.appendChild(badge('badge--authonly', 'auth'));
  }
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

// Sag tik: satira ozel eylemler (AI'a gonder, kopyala, ac)
el.list.addEventListener('contextmenu', (event) => {
  const row = event.target.closest('.row');
  if (!row || row.dataset.index == null) return;
  const item = state.filtered[Number(row.dataset.index)];
  if (!item) return;
  event.preventDefault();
  openCtxMenu(item, event.clientX, event.clientY);
});

// Menuyu disari tiklayinca, kaydirinca veya Esc ile kapat
document.addEventListener('click', (event) => {
  if (!el.ctxmenu.hidden && !event.target.closest('.ctxmenu')) hideCtxMenu();
});
el.list.addEventListener('scroll', () => { if (!el.ctxmenu.hidden) hideCtxMenu(); }, { passive: true });

// --- Angajman oturumu olaylari ---
el.sessionPill.addEventListener('click', (event) => {
  event.stopPropagation();
  if (el.sessionMenu.hidden) openSessionMenu();
  else hideSessionMenu();
});
document.addEventListener('click', (event) => {
  if (!el.sessionMenu.hidden && !event.target.closest('.sessmenu') && !event.target.closest('#sessionPill')) {
    hideSessionMenu();
  }
});
el.authToggle.addEventListener('click', toggleAuthState);
el.sessionCreateEmpty.addEventListener('click', createSessionHere);

el.sessionScope.addEventListener('change', async () => {
  if (!state.session) return;
  const scope = el.sessionScope.value.split('\n').map((x) => x.trim()).filter(Boolean);
  const res = await send({ type: 'session-update', id: state.session.id, patch: { scope } });
  if (res.ok && res.session) {
    state.session = { id: res.session.id, name: res.session.name, scope: res.session.scope };
    toast('Scope saved');
  }
});

el.sessionNotes.addEventListener('change', async () => {
  if (!state.session) return;
  await send({ type: 'session-notes', id: state.session.id, notes: el.sessionNotes.value });
  toast('Notes saved');
});

el.sessionReport.addEventListener('click', () => exportSession('html'));
el.sessionExportJson.addEventListener('click', () => exportSession('json'));

el.sessionDelete.addEventListener('click', async () => {
  if (!state.session) return;
  const name = state.session.name;
  await send({ type: 'session-delete', id: state.session.id });
  await send({ type: 'session-attach', tabId: state.tabId, sessionId: '' });
  state.session = null;
  state.sessionData = null;
  renderSessionBar();
  applyView();
  toast(`Deleted ${name}`);
});

el.aiHistoryBtn.addEventListener('click', () => {
  if (el.aiHistory.hidden) showHistory();
  else hideHistory();
});
el.aiHistoryClose.addEventListener('click', hideHistory);

// Detay panelinden hedefli analiz
el.detailAskAi.addEventListener('click', () => {
  const item = state.detailItem;
  if (!item) return;
  closeDetail();
  switchView('ai');
  if (state.view === 'ai') {
    if (item.category) runAi('finding', '', { target: item, label: item.type || 'finding' });
    else if (item.normalizedUrl || item.url) runAi('script', '', { target: item, label: item.fileName || 'script' });
    else toast('Nothing to analyse here');
  }
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
  if (ready) renderCustomRuns(settings);
  if (!ready) return;

  // Popup kapaninca analiz durmuyor; acilista devam edene baglan.
  if (!state.aiRunning && !state.aiRunId) {
    const attached = await attachToActiveRun();
    if (attached) return;
  }
  if (!state.aiRunning) showAiIdentity(providerId, settings);
}

/** Kullanici tanimli analizleri yerlesiklerin yanina buton olarak ekler. */
function renderCustomRuns(settings) {
  for (const old of el.aiRuns.querySelectorAll('.ai-run--custom')) old.remove();
  const customs = Array.isArray(settings.aiCustomAnalyses) ? settings.aiCustomAnalyses : [];
  for (const item of customs) {
    if (!item || !item.instruction || !item.id) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-run ai-run--custom';
    btn.dataset.analysis = `custom:${item.id}`;
    btn.dataset.label = item.label || 'Custom';
    btn.textContent = item.label || 'Custom analysis';
    el.aiRuns.appendChild(btn);
  }
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
  if (analysis === 'freeform') return 'question';
  if (analysis === 'finding') return 'finding';
  if (analysis === 'script') return 'script';
  if (typeof analysis === 'string' && analysis.startsWith('custom:')) return 'custom';
  return analysis;
}

/**
 * Analizi BACKGROUND'da baslatir ve hemen doner.
 *
 * Onceden istek popup icinde atiliyordu; kullanici baska yere tiklayip popup
 * kapaninca sayfa yok oluyor ve fetch iptal oluyordu. Artik popup yalnizca
 * goruntuleyici: kapatip acabilirsin, analiz calismaya devam eder ve istek
 * gonderildigi anda gecmise yazilir.
 */
async function runAi(analysis, question, { followUp = false, target = null, label = '' } = {}) {
  if (state.aiRunning) return;
  const q = (question || '').trim();
  if (analysis === 'freeform' && !q) { toast('Type a question first'); return; }
  const targeted = analysis === 'finding' || analysis === 'script';
  if (!targeted && !state.scripts.length) { toast('Nothing collected to analyze'); return; }

  hideHistory();
  state.aiTarget = target;
  if (!followUp) state.aiHistory = [];

  state.aiRunning = true;
  state.aiText = '';
  el.aiOut.classList.add('is-streaming');
  el.aiOut.textContent = '';
  setAiRunning(true);
  el.aiMeta.textContent = `${label || aiLabel(analysis)} · starting…`;

  const res = await send({
    type: 'ai-run-start',
    tabId: state.tabId,
    analysis,
    question: q,
    target,
    label: label || aiLabel(analysis),
    history: followUp ? state.aiHistory : [],
    data: {
      pageUrl: state.pageUrl,
      entries: state.scripts,
      findings: state.findings,
      origins: state.origins
    }
  });

  if (!res.ok) {
    state.aiRunning = false;
    el.aiOut.classList.remove('is-streaming');
    setAiRunning(false);
    el.aiMeta.textContent = 'error';
    toast(res.error || 'Could not start analysis');
    return;
  }

  state.aiRunId = res.runId;
  el.aiMeta.textContent = `${label || aiLabel(analysis)} · running in the background`;
  // Konusma gecmisine soruyu simdiden ekle; yanit gelince tamamlanir.
  state.aiPendingAsk = analysis === 'freeform' ? q : `Run the "${analysis}" analysis.`;
}

/** Calisma bitince (veya hata alinca) arayuzu toparla. */
function finishAiRun(payload) {
  state.aiRunning = false;
  state.aiRunId = '';
  el.aiOut.classList.remove('is-streaming');
  setAiRunning(false);

  if (payload.text) state.aiText = payload.text;
  paintAi();
  el.aiOut.scrollTop = el.aiOut.scrollHeight;

  if (payload.error) {
    const notice = document.createElement('p');
    notice.className = 'ai__error';
    notice.textContent = payload.error;
    el.aiOut.appendChild(notice);
    el.aiMeta.textContent = 'error';
    return;
  }

  if (!state.aiText) {
    el.aiOut.textContent = 'The provider returned an empty response.';
    return;
  }

  state.aiModel = payload.model || state.aiModel;
  if (state.aiPendingAsk) {
    state.aiHistory.push({ role: 'user', content: state.aiPendingAsk });
    state.aiHistory.push({ role: 'assistant', content: state.aiText });
    if (state.aiHistory.length > 8) state.aiHistory = state.aiHistory.slice(-8);
    state.aiPendingAsk = '';
  }

  const providerLabel = payload.provider && PROVIDERS[payload.provider]
    ? PROVIDERS[payload.provider].label : '';
  el.aiMeta.textContent = [providerLabel, state.aiModel, payload.label, 'ask a follow-up below']
    .filter(Boolean).join(' · ');
  el.aiQuestion.placeholder = 'Follow-up question…';
}

/** Popup acildiginda background'da devam eden bir analiz varsa ona baglan. */
async function attachToActiveRun() {
  const res = await send({ type: 'ai-run-status', tabId: state.tabId });
  const run = res.ok ? res.run : null;
  if (!run) return false;

  state.aiRunId = run.runId;
  state.aiText = run.text || '';
  state.aiModel = run.model || '';
  paintAi();

  if (run.running) {
    state.aiRunning = true;
    el.aiOut.classList.add('is-streaming');
    setAiRunning(true);
    el.aiMeta.textContent = `${run.label || aiLabel(run.analysis)} · running in the background`;
  } else {
    finishAiRun(run);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Angajman oturumu
// ---------------------------------------------------------------------------

function renderSessionBar() {
  const attached = Boolean(state.session);
  el.sessionPill.classList.toggle('is-attached', attached);
  el.sessionName.textContent = attached ? state.session.name : 'Tab only';
  el.sessionPill.title = attached
    ? `Attached to “${state.session.name}” — in-scope captures accumulate here`
    : 'Tab-only capture: cleared when the browser closes. Click to attach an engagement.';

  const isAuth = state.authState === 'auth';
  el.authToggle.classList.toggle('is-auth', isAuth);
  el.authLabel.textContent = isAuth ? 'Logged in' : 'Logged out';
  el.authToggle.title = isAuth
    ? 'Captures are tagged as authenticated — scripts seen only here become "auth-only"'
    : 'Captures are tagged as anonymous. Switch after you log in to compare surfaces.';

  const marked = countStates(state.scripts, state.triage);
  el.sessionCount.textContent = marked.new < state.scripts.length
    ? `${state.scripts.length - marked.new}/${state.scripts.length} triaged`
    : '';
}

function hideSessionMenu() { el.sessionMenu.hidden = true; }

async function openSessionMenu() {
  const menu = el.sessionMenu;
  menu.textContent = '';

  const res = await send({ type: 'session-list' });
  const list = res.ok ? res.sessions : [];

  const makeItem = (name, meta, onClick, active) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sessmenu__item' + (active ? ' is-active' : '');
    b.appendChild(makeEl('span', 'sessmenu__name', name));
    if (meta) b.appendChild(makeEl('span', 'sessmenu__meta', meta));
    b.addEventListener('click', () => { hideSessionMenu(); onClick(); });
    return b;
  };

  menu.appendChild(makeItem('Tab only', 'Ephemeral — cleared with the browser',
    () => attachSession(''), !state.session));

  if (list.length) {
    const sep = makeEl('div', 'sessmenu__sep');
    menu.appendChild(sep);
    for (const item of list) {
      menu.appendChild(makeItem(
        item.name,
        (item.scope || []).join(', ') || 'no scope — captures everything',
        () => attachSession(item.id),
        state.session && state.session.id === item.id
      ));
    }
  }

  menu.appendChild(makeEl('div', 'sessmenu__sep'));
  menu.appendChild(makeItem('New engagement…', 'Scoped to this site by default', createSessionHere, false));
  menu.hidden = false;
}

async function attachSession(sessionId) {
  const res = await send({ type: 'session-attach', tabId: state.tabId, sessionId });
  if (!res.ok) { toast(res.error || 'Could not attach'); return; }
  state.session = res.session;
  renderSessionBar();
  if (state.view === 'session') applyView();
  toast(res.session ? `Attached to ${res.session.name}` : 'Tab-only capture');
}

/** Bu sitenin alan adini varsayilan kapsam alarak yeni angajman kurar. */
async function createSessionHere() {
  let host = '';
  try { host = new URL(state.pageUrl).hostname; } catch { host = ''; }
  const base = host.split('.').slice(-2).join('.');
  const res = await send({
    type: 'session-create',
    tabId: state.tabId,
    name: base || 'Engagement',
    scope: base ? [base, `*.${base}`] : []
  });
  if (!res.ok) { toast(res.error || 'Could not create'); return; }
  state.session = { id: res.session.id, name: res.session.name, scope: res.session.scope };
  renderSessionBar();
  switchView('session');
  toast(`Created ${res.session.name}`);
}

async function toggleAuthState() {
  const next = state.authState === 'auth' ? 'anon' : 'auth';
  const res = await send({ type: 'session-auth', tabId: state.tabId, authState: next });
  if (!res.ok) { toast(res.error || 'Could not switch'); return; }
  state.authState = res.authState;
  renderSessionBar();
  toast(state.authState === 'auth'
    ? 'Capturing as logged in'
    : 'Capturing as logged out');
}

// --- Oturum gorunumu ---

async function renderSessionView() {
  const attached = Boolean(state.session);
  el.sessionEmpty.hidden = attached;
  el.sessionBody.hidden = !attached;
  if (!attached) return;

  const res = await send({ type: 'session-data', id: state.session.id });
  const data = res.ok ? res : { entries: [], findings: [], origins: [], notes: '' };
  state.sessionData = data;

  const decorated = (data.entries || []).map((e) =>
    decorate(e, (e.pages && e.pages[0]) || state.pageUrl));
  const stats = summarize(decorated);
  const authOnly = decorated.filter((e) => (e.authStates || []).includes('auth')
    && !(e.authStates || []).includes('anon')).length;
  const risky = decorated.filter((e) => e.noIntegrity || e.mixedContent).length;

  el.sessionStats.textContent = '';
  const cards = [
    ['scripts', stats.total, ''],
    ['auth-only', authOnly, 'sstat--auth'],
    ['risk', risky, 'sstat--risk'],
    ['findings', (data.findings || []).length, '']
  ];
  for (const [label, value, cls] of cards) {
    const card = makeEl('div', `sstat ${cls}`.trim());
    card.appendChild(makeEl('span', 'sstat__value', String(value)));
    card.appendChild(makeEl('span', 'sstat__label', label));
    el.sessionStats.appendChild(card);
  }

  el.sessionScope.value = (state.session.scope || []).join('\n');
  el.sessionNotes.value = data.notes || '';
}

async function exportSession(format) {
  if (!state.session) { toast('No engagement attached'); return; }
  const data = state.sessionData || { entries: [], findings: [], origins: [], notes: '' };
  let analyses = [];
  try { analyses = await listForPage(state.pageUrl); } catch { analyses = []; }

  const input = {
    session: state.session,
    pageUrl: state.pageUrl,
    entries: data.entries || [],
    findings: data.findings || [],
    origins: data.origins || [],
    notes: data.notes || '',
    triage: state.triage,
    analyses
  };

  const safeName = (state.session.name || 'engagement').replace(/[^a-z0-9._-]/gi, '_');
  if (format === 'json') {
    triggerDownload(buildSessionJson(input), 'application/json', 'json');
    toast('Engagement exported as JSON');
  } else {
    triggerDownload(buildSessionReport(input), 'text/html', 'report.html');
    toast('Report exported');
  }
  void safeName;
}

// ---------------------------------------------------------------------------
// Triyaj
// ---------------------------------------------------------------------------

async function refreshTriage() {
  try { state.triage = await getTriage(state.pageUrl); } catch { state.triage = {}; }
}

async function markTriage(item, nextState) {
  if (!item || !item.key) return;
  state.triage = await setTriageState(state.pageUrl, item.key, nextState);
  applyView();
  renderSessionBar();
  toast(nextState === 'new' ? 'Mark cleared' : `Marked ${STATE_LABELS[nextState].toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Satir baglam menusu (sag tik)
// ---------------------------------------------------------------------------

function hideCtxMenu() {
  el.ctxmenu.hidden = true;
  state.ctxItem = null;
}

function ctxButton(label, onClick, accent) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctxmenu__item' + (accent ? ' ctxmenu__item--accent' : '');
  b.textContent = label;
  b.addEventListener('click', () => { hideCtxMenu(); onClick(); });
  return b;
}

/** Ogeye gore menuyu kurup imlecin yaninda acar. */
function openCtxMenu(item, x, y) {
  state.ctxItem = item;
  const menu = el.ctxmenu;
  menu.textContent = '';

  const title = document.createElement('div');
  title.className = 'ctxmenu__title';
  title.textContent = state.view === 'findings' ? (item.type || 'finding')
    : state.view === 'sources' ? (item.path || '')
    : (item.fileName || item.normalizedUrl || '');
  menu.appendChild(title);

  if (state.view === 'findings') {
    menu.appendChild(ctxButton('Ask AI about this finding', () => {
      switchView('ai');
      runAi('finding', '', { target: item, label: item.type || 'finding' });
    }, true));
    menu.appendChild(ctxButton('Copy value', () => copyText(item.value, 'Value copied')));
    menu.appendChild(ctxButton('Copy file URL', () => copyText(item.file, 'URL copied')));
  } else if (state.view === 'sources') {
    menu.appendChild(ctxButton('Copy path', () => copyText(item.path, 'Path copied')));
    if (item.map) menu.appendChild(ctxButton('Copy source map URL', () => copyText(item.map, 'URL copied')));
  } else {
    const url = item.normalizedUrl || item.url || '';
    menu.appendChild(ctxButton('Send to AI', () => {
      switchView('ai');
      runAi('script', '', { target: item, label: item.fileName || 'script' });
    }, true));

    const sep = document.createElement('div');
    sep.className = 'ctxmenu__sep';
    menu.appendChild(sep);

    const current = state.triage[item.key] || 'new';
    menu.appendChild(ctxButton(
      current === 'interesting' ? 'Clear ★ interesting' : 'Mark ★ interesting',
      () => markTriage(item, current === 'interesting' ? 'new' : 'interesting')));
    menu.appendChild(ctxButton(
      current === 'reviewed' ? 'Clear reviewed' : 'Mark reviewed',
      () => markTriage(item, current === 'reviewed' ? 'new' : 'reviewed')));
    menu.appendChild(ctxButton(
      current === 'ignored' ? 'Clear not-relevant' : 'Mark not relevant',
      () => markTriage(item, current === 'ignored' ? 'new' : 'ignored')));

    const sep2 = document.createElement('div');
    sep2.className = 'ctxmenu__sep';
    menu.appendChild(sep2);

    menu.appendChild(ctxButton('Copy URL', () => copyText(url, 'URL copied')));
    menu.appendChild(ctxButton('Copy as curl', () => copyText(
      `curl -sS '${url.replace(/'/g, "'\\''")}'`, 'curl command copied')));
    if (item.sourceMapUrl) {
      menu.appendChild(ctxButton('Copy source map URL', () => copyText(item.sourceMapUrl, 'URL copied')));
    }
    if (/^https?:/i.test(url)) {
      menu.appendChild(ctxButton('Open in new tab', () => {
        api.tabs.create({ url }).catch(() => toast('Could not open'));
      }));
    }
  }

  // Once gorunur yap ki olculebilsin, sonra ekrana sigacak sekilde konumla.
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${Math.max(6, top)}px`;
}

// ---------------------------------------------------------------------------
// Analiz gecmisi
// ---------------------------------------------------------------------------

function hideHistory() {
  el.aiHistory.hidden = true;
}

function formatWhen(ts) {
  const d = new Date(ts);
  const now = Date.now();
  const mins = Math.round((now - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
}

async function showHistory() {
  const list = el.aiHistoryList;
  list.textContent = '';
  let entries = [];
  try { entries = await listForPage(state.pageUrl); } catch { entries = []; }

  if (!entries.length) {
    const empty = makeEl('p', 'ai__history-empty',
      'No saved analyses for this site yet. Run one and it will appear here.');
    list.appendChild(empty);
  } else {
    for (const entry of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'histrow';

      const top = makeEl('div', 'histrow__top');
      top.appendChild(makeEl('span', 'histrow__label', entry.label || entry.analysis));
      top.appendChild(makeEl('span', 'histrow__when', formatWhen(entry.at)));
      row.appendChild(top);
      row.appendChild(makeEl('span', 'histrow__meta',
        [entry.model, entry.question].filter(Boolean).join(' · ') || entry.pageUrl));

      row.addEventListener('click', () => {
        state.aiText = entry.text;
        state.aiHistory = [];          // gecmisten okunan analiz yeni konusma baslatir
        paintAi();
        hideHistory();
        el.aiMeta.textContent = [entry.model, entry.label, formatWhen(entry.at)]
          .filter(Boolean).join(' · ');
      });
      list.appendChild(row);
    }
  }
  el.aiHistory.hidden = false;
}

el.aiRuns.addEventListener('click', (event) => {
  const btn = event.target.closest('.ai-run');
  if (btn) runAi(btn.dataset.analysis, '', { label: btn.dataset.label || '' });
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
el.aiStop.addEventListener('click', () => {
  if (state.aiRunId) send({ type: 'ai-run-cancel', runId: state.aiRunId });
});
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
    if (!el.ctxmenu.hidden) { hideCtxMenu(); return; }
    if (!el.sessionMenu.hidden) { hideSessionMenu(); return; }
    if (!el.aiHistory.hidden) { hideHistory(); return; }
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
  if (!message) return;

  // --- Background'da calisan AI analizinin akisi ---
  if (message.type === 'ai-run-delta' && message.runId === state.aiRunId) {
    state.aiText = message.text != null ? message.text : (state.aiText + message.chunk);
    paintAi();
    el.aiOut.scrollTop = el.aiOut.scrollHeight;
    return;
  }
  if (message.type === 'ai-run-done' && message.runId === state.aiRunId) {
    finishAiRun(message);
    return;
  }
  if (message.type === 'ai-run-started' && message.tabId === state.tabId && !state.aiRunId) {
    // Baska bir popup ornegi baslatmis olabilir; ona baglan.
    state.aiRunId = message.runId;
    return;
  }

  if (message.tabId !== state.tabId) return;
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
  for (const b of [el.deepScan, el.copyAll, el.exportBtn, el.clear, el.snapshot, el.sessionPill, el.authToggle]) b.disabled = true;
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
  await refreshTriage();
  await load();
  renderHeader();
  pollTimer = setInterval(() => { load({ silent: true }); }, POLL_INTERVAL_MS);
}

window.addEventListener('unload', () => {
  if (pollTimer) clearInterval(pollTimer);
});

init();
