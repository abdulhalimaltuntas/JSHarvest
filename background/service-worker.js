// background/service-worker.js
// Ag katmani toplayicisi + mesaj yonlendirici.
//
// MV3 notu: bu worker her an sonlandirilabilir. Bu dosyadaki tum kalici durum
// lib/store.js uzerinden storage.session'a yazilir. Buradaki Map'ler
// yalnizca kisa omurlu yardimci veriler icindir ve kaybolmalari tolere edilir.

import * as store from '../lib/store.js';
import { api } from '../lib/browser-api.js';
import { looksLikeJs } from '../lib/classify.js';
import { broadcast } from '../lib/messaging.js';
import { runDeepScan, cancelDeepScan, isDeepScanRunning } from '../lib/deepscan.js';
import { getSettings, toDeepScanOptions, DEFAULT_SETTINGS } from '../lib/settings.js';
import * as sessions from '../lib/sessions.js';
import { startRun, cancelRun, getRun, activeRunForTab, reconcileHistory } from './ai-runner.js';

/** Izlenen istek tipleri. Lazy chunk'lar cogu zaman xhr/other olarak gelir. */
const WATCHED_TYPES = ['script', 'xmlhttprequest', 'other'];

/** requestId -> content-type. Worker uykusunda kaybolmasi sorun degil. */
const mimeByRequest = new Map();
const MIME_CACHE_CAP = 500;

/** Bellekte tutulan ayar onbellegi (storage.onChanged ile tazelenir). */
let cachedSettings = { ...DEFAULT_SETTINGS };
getSettings().then((s) => { cachedSettings = s; }).catch(() => { /* varsayilan kalir */ });
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings && changes.settings.newValue) {
    cachedSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    // Rozet ayari degistiyse tum tablarda tazele.
    refreshAllBadges().catch(() => { /* yoksayilir */ });
  }
});

/** Guvenli listener kaydi: API yoksa veya izin verilmediyse sessizce gecilir. */
function safeAddListener(target, handler, filter, extraInfoSpec) {
  try {
    if (extraInfoSpec) target.addListener(handler, filter, extraInfoSpec);
    else target.addListener(handler, filter);
  } catch (err) {
    console.warn('[JSHarvest] listener registration failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Angajman oturumlari
// ---------------------------------------------------------------------------
//
// Sekme bazli yakalama (lib/store.js) oldugu gibi kalir; bir sekme bir oturuma
// bagliysa ayni kayitlar KALICI oturum deposuna da islenir. Boylece sekme
// kapansa, tarayici yeniden baslasa bile angajman envanteri birikmeye devam
// eder. Kapsam disi host'lar oturuma hic yazilmaz.

const ATTACH_KEY = 'session-attach';   // storage.session: { tabId: sessionId }
const AUTH_KEY = 'session-auth';       // storage.session: { tabId: 'anon'|'auth' }

async function readMap(key) {
  try {
    const stored = await api.storage.session.get(key);
    const map = stored && stored[key];
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

async function writeMap(key, map) {
  try { await api.storage.session.set({ [key]: map }); } catch { /* yoksayilir */ }
}

async function getAttachment(tabId) {
  const map = await readMap(ATTACH_KEY);
  return map[String(tabId)] || '';
}

async function setAttachment(tabId, sessionId) {
  const map = await readMap(ATTACH_KEY);
  if (sessionId) map[String(tabId)] = sessionId;
  else delete map[String(tabId)];
  await writeMap(ATTACH_KEY, map);
}

async function getAuthState(tabId) {
  const map = await readMap(AUTH_KEY);
  return map[String(tabId)] === 'auth' ? 'auth' : 'anon';
}

async function setAuthState(tabId, authState) {
  const map = await readMap(AUTH_KEY);
  map[String(tabId)] = authState === 'auth' ? 'auth' : 'anon';
  await writeMap(AUTH_KEY, map);
}

/**
 * Sekmede toplanan kayitlari bagli oturuma isler. Kapsam disi URL'ler atlanir —
 * bu hem angajman hijyeni hem gizlilik korumasidir.
 */
async function projectToSession(tabId, rawEntries, pageUrl) {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) return;
  const sessionId = await getAttachment(tabId);
  if (!sessionId) return;

  const session = await sessions.getSession(sessionId);
  if (!session || session.archived) return;

  const scope = Array.isArray(session.scope) ? session.scope : [];
  const inScope = scope.length === 0
    ? rawEntries
    : rawEntries.filter((e) => sessions.urlInScope(e.url, scope));
  if (inScope.length === 0) return;

  const authState = await getAuthState(tabId);
  try {
    await sessions.mergeEntries(sessionId, inScope, { authState, pageUrl });
    await sessions.updateSession(sessionId, {});   // updatedAt tazelensin
  } catch (err) {
    console.warn('[JSHarvest] session merge failed:', err);
  }
}

/** Navigasyonda kapsamina gore otomatik baglama. */
async function autoAttach(tabId, url) {
  const current = await getAttachment(tabId);
  if (current) {
    // Zaten bagli: kapsam disina cikildiysa bagi koparma, yalnizca kayit dursun.
    return;
  }
  const match = await sessions.findSessionForUrl(url);
  if (match) await setAttachment(tabId, match.id);
}

// ---------------------------------------------------------------------------
// Toolbar rozeti
// ---------------------------------------------------------------------------

const badgeTimers = new Map();

async function setBadge(tabId, count) {
  if (!api.action) return;
  try {
    const text = cachedSettings.showBadge && count > 0
      ? (count > 999 ? '999+' : String(count))
      : '';
    await api.action.setBadgeText({ tabId, text });
    if (text && api.action.setBadgeBackgroundColor) {
      await api.action.setBadgeBackgroundColor({ tabId, color: '#b8860b' });
    }
  } catch {
    // Tab kapanmis olabilir; yoksayilir.
  }
}

/** Rozeti kisa bir gecikmeyle (throttle) gunceller — her istekte cagirmayalim. */
function scheduleBadge(tabId) {
  if (badgeTimers.has(tabId)) return;
  const timer = setTimeout(async () => {
    badgeTimers.delete(tabId);
    try {
      const record = await store.getRecord(tabId);
      await setBadge(tabId, Object.keys(record.entries).length);
    } catch {
      /* yoksayilir */
    }
  }, 500);
  badgeTimers.set(tabId, timer);
}

async function refreshAllBadges() {
  let tabs = [];
  try {
    tabs = await api.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      const record = await store.getRecord(tab.id);
      await setBadge(tab.id, Object.keys(record.entries).length);
    } catch {
      /* yoksayilir */
    }
  }
}

// ---------------------------------------------------------------------------
// Ag katmani
// ---------------------------------------------------------------------------

safeAddListener(
  api.webRequest.onHeadersReceived,
  (details) => {
    if (details.type === 'script') return; // zaten JS sayiliyor
    const headers = details.responseHeaders || [];
    const header = headers.find((h) => h.name && h.name.toLowerCase() === 'content-type');
    if (!header || !header.value) return;
    if (!/javascript|ecmascript/i.test(header.value)) return;
    if (mimeByRequest.size > MIME_CACHE_CAP) mimeByRequest.clear();
    mimeByRequest.set(details.requestId, header.value);
  },
  { urls: ['<all_urls>'], types: WATCHED_TYPES },
  ['responseHeaders']
);

function toNetworkEntry(details, extra) {
  return {
    url: details.url,
    sources: ['network'],
    frameId: details.frameId,
    requestType: details.type,
    initiator: details.initiator || '',
    fromCache: details.fromCache ?? null,
    confidence: 'confirmed',
    ...extra
  };
}

async function recordNetworkHit(details, extra) {
  if (typeof details.tabId !== 'number' || details.tabId < 0) return;
  const contentType = mimeByRequest.get(details.requestId);
  mimeByRequest.delete(details.requestId);
  if (!looksLikeJs(details.url, { type: details.type, contentType })) return;
  try {
    const entry = toNetworkEntry(details, extra);
    await store.addEntries(details.tabId, [entry]);
    scheduleBadge(details.tabId);
    projectToSession(details.tabId, [entry], details.documentUrl || '')
      .catch(() => { /* oturum yazilamazsa sekme verisi zaten duruyor */ });
  } catch (err) {
    console.warn('[JSHarvest] network entry store failed:', err);
  }
}

safeAddListener(
  api.webRequest.onCompleted,
  (details) => {
    recordNetworkHit(details, { statusCode: details.statusCode ?? null });
  },
  { urls: ['<all_urls>'], types: WATCHED_TYPES }
);

safeAddListener(
  api.webRequest.onErrorOccurred,
  (details) => {
    recordNetworkHit(details, { statusCode: null, error: details.error || 'net error' });
  },
  { urls: ['<all_urls>'], types: WATCHED_TYPES }
);

// ---------------------------------------------------------------------------
// Tab yasam dongusu (navigasyon epoch modeli)
// ---------------------------------------------------------------------------

// Ana frame navigasyonu baslarken epoch artirilir ama liste KORUNUR; boylece
// commit'e yarisan erken script'ler yeni epoch'u alip yasar.
safeAddListener(
  api.webNavigation.onBeforeNavigate,
  (details) => {
    if (details.frameId !== 0) return;
    store.beginNavigation(details.tabId, details.url).catch(() => { /* yoksayilir */ });
  },
  { url: [{ schemes: ['http', 'https', 'file'] }] }
);

// Ana frame commit'i: epoch commit edilir, yalnizca onceki sayfanin kayitlari
// temizlenir. History API (SPA) navigasyonlari onCommitted tetiklemez.
safeAddListener(
  api.webNavigation.onCommitted,
  (details) => {
    if (details.frameId !== 0) return;
    store.commitNavigation(details.tabId, details.url)
      .then(() => scheduleBadge(details.tabId))
      .catch(() => { /* yoksayilir */ });
    autoAttach(details.tabId, details.url).catch(() => { /* yoksayilir */ });
  },
  { url: [{ schemes: ['http', 'https', 'file'] }] }
);

// SPA route degisimi: yalnizca sayfa URL'i guncellenir, liste korunur.
safeAddListener(
  api.webNavigation.onHistoryStateUpdated,
  (details) => {
    if (details.frameId !== 0) return;
    store.setPageUrl(details.tabId, details.url).catch(() => { /* yoksayilir */ });
  },
  { url: [{ schemes: ['http', 'https', 'file'] }] }
);

api.tabs.onRemoved.addListener((tabId) => {
  const timer = badgeTimers.get(tabId);
  if (timer) { clearTimeout(timer); badgeTimers.delete(tabId); }
  store.deleteTab(tabId).catch(() => { /* yoksayilir */ });
  setAttachment(tabId, '').catch(() => { /* yoksayilir */ });
});

api.runtime.onInstalled.addListener(() => {
  store.pruneOrphans().catch(() => { /* yoksayilir */ });
});

api.runtime.onStartup.addListener(() => {
  store.pruneOrphans().catch(() => { /* yoksayilir */ });
});

// Worker her uyandiginda: 'running' kalmis analiz kayitlari artik calismiyordur.
reconcileHistory().catch(() => { /* yoksayilir */ });

// Worker sonlandirilmadan once bekleyen yazmalari bosalt.
if (api.runtime.onSuspend) {
  api.runtime.onSuspend.addListener(() => {
    store.flush().catch(() => { /* yoksayilir */ });
  });
}

// ---------------------------------------------------------------------------
// Mesajlasma
// ---------------------------------------------------------------------------

/** Content script'ten gelen DOM kayitlarini isler. */
async function handleDomBatch(message, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (typeof tabId !== 'number' || tabId < 0) return { ok: false, error: 'no tab' };
  const items = Array.isArray(message.items) ? message.items : [];
  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;

  const normalized = items
    .filter((item) => item && typeof item.url === 'string')
    .map((item) => ({
      url: item.url,
      sources: [item.source || 'dom'],
      frameId,
      kind: item.kind || 'script',
      size: item.size || 0,
      duration: item.duration || 0,
      hasSourceMap: Boolean(item.hasSourceMap),
      sourceMapUrl: item.sourceMapUrl || '',
      integrity: Boolean(item.integrity),
      mixedContent: Boolean(item.mixedContent),
      confidence: item.confidence === 'inferred' ? 'inferred' : 'confirmed'
    }));

  const added = await store.addEntries(tabId, normalized);
  // Ana frame ise sayfa URL'ini de tazele (ilk yuklemede commit kacmis olabilir).
  if (frameId === 0 && typeof message.pageUrl === 'string' && message.pageUrl) {
    await store.setPageUrl(tabId, message.pageUrl);
  }
  if (added > 0) scheduleBadge(tabId);
  projectToSession(tabId, normalized, message.pageUrl || '')
    .catch(() => { /* yoksayilir */ });
  return { ok: true, added };
}

/** Popup/panel icin tab verisini dondurur. */
async function handleGetTabData(message) {
  const tabId = Number(message.tabId);
  if (!Number.isFinite(tabId)) return { ok: false, error: 'invalid tabId' };
  const record = await store.getRecord(tabId);
  let pageUrl = record.pageUrl;
  if (!pageUrl) {
    try {
      const tab = await api.tabs.get(tabId);
      pageUrl = tab && tab.url ? tab.url : '';
      if (pageUrl) await store.setPageUrl(tabId, pageUrl);
    } catch {
      pageUrl = '';
    }
  }
  const sessionId = await getAttachment(tabId);
  const session = sessionId ? await sessions.getSession(sessionId) : null;

  return {
    ok: true,
    pageUrl,
    updatedAt: record.updatedAt,
    entries: Object.values(record.entries),
    findings: record.findings || [],
    origins: record.origins || [],
    deepScanRunning: isDeepScanRunning(tabId),
    session: session ? { id: session.id, name: session.name, scope: session.scope } : null,
    authState: await getAuthState(tabId)
  };
}

async function handleMessage(message, sender) {
  switch (message && message.type) {
    case 'dom-batch':
      return handleDomBatch(message, sender);
    case 'get-tab-data':
      return handleGetTabData(message);
    case 'clear-tab': {
      const tabId = Number(message.tabId);
      if (!Number.isFinite(tabId)) return { ok: false, error: 'invalid tabId' };
      let pageUrl = '';
      try {
        const tab = await api.tabs.get(tabId);
        pageUrl = tab && tab.url ? tab.url : '';
      } catch {
        pageUrl = '';
      }
      await store.resetTab(tabId, pageUrl);
      scheduleBadge(tabId);
      return { ok: true };
    }
    case 'deep-scan-start': {
      const tabId = Number(message.tabId);
      if (!Number.isFinite(tabId)) return { ok: false, error: 'invalid tabId' };
      const settings = await getSettings();
      const options = toDeepScanOptions(settings);
      // Await edilmez; ilerleme mesajlarla bildirilir.
      runDeepScan(tabId, options)
        .then(async () => {
          scheduleBadge(tabId);
          // Deep Scan ciktilarini (bulgular, kurtarilan kaynaklar) oturuma isle.
          const sessionId = await getAttachment(tabId);
          if (!sessionId) return;
          const record = await store.getRecord(tabId);
          await sessions.mergeFindings(sessionId, record.findings || []);
          await sessions.mergeOrigins(sessionId, record.origins || []);
          await projectToSession(tabId, Object.values(record.entries), record.pageUrl || '');
        })
        .catch((err) => {
          broadcast({ type: 'deep-scan-done', tabId, error: String(err && err.message ? err.message : err) });
        });
      return { ok: true, started: true };
    }
    case 'deep-scan-cancel':
      cancelDeepScan(Number(message.tabId));
      return { ok: true };
    // --- AI calismalari (popup kapansa da devam eder) ---
    case 'ai-run-start': {
      const tabId = Number(message.tabId);
      if (!Number.isFinite(tabId)) return { ok: false, error: 'invalid tabId' };
      try {
        const { runId, historyId } = await startRun({
          tabId,
          data: message.data,
          analysis: message.analysis,
          question: message.question,
          target: message.target,
          history: message.history,
          label: message.label
        });
        return { ok: true, runId, historyId };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    }
    case 'ai-run-cancel':
      return { ok: true, cancelled: cancelRun(message.runId) };
    case 'ai-run-status': {
      if (message.runId) return { ok: true, run: getRun(message.runId) };
      const tabId = Number(message.tabId);
      return { ok: true, run: Number.isFinite(tabId) ? activeRunForTab(tabId) : null };
    }

    // --- Angajman oturumlari ---
    case 'session-list':
      return { ok: true, sessions: await sessions.listSessions({ includeArchived: Boolean(message.includeArchived) }) };
    case 'session-create': {
      const created = await sessions.createSession({
        name: message.name,
        scope: message.scope,
        autoAttach: message.autoAttach !== false
      });
      if (Number.isFinite(Number(message.tabId))) {
        await setAttachment(Number(message.tabId), created.id);
      }
      return { ok: true, session: created };
    }
    case 'session-update':
      return { ok: true, session: await sessions.updateSession(message.id, message.patch || {}) };
    case 'session-delete':
      await sessions.deleteSession(message.id);
      return { ok: true };
    case 'session-attach': {
      const tabId = Number(message.tabId);
      if (!Number.isFinite(tabId)) return { ok: false, error: 'invalid tabId' };
      await setAttachment(tabId, message.sessionId || '');
      const session = message.sessionId ? await sessions.getSession(message.sessionId) : null;
      return { ok: true, session: session ? { id: session.id, name: session.name, scope: session.scope } : null };
    }
    case 'session-data': {
      if (!message.id) return { ok: false, error: 'missing session id' };
      const data = await sessions.getData(message.id);
      return {
        ok: true,
        entries: Object.values(data.entries),
        findings: data.findings,
        origins: data.origins,
        notes: data.notes
      };
    }
    case 'session-summary':
      return { ok: true, summary: await sessions.summary(message.id) };
    case 'session-notes':
      return { ok: true, notes: await sessions.setNotes(message.id, message.notes) };
    case 'session-auth': {
      const tabId = Number(message.tabId);
      if (!Number.isFinite(tabId)) return { ok: false, error: 'invalid tabId' };
      await setAuthState(tabId, message.authState);
      return { ok: true, authState: await getAuthState(tabId) };
    }

    case 'flush':
      await store.flush();
      return { ok: true };
    case 'ping':
      return { ok: true, alive: true };
    default:
      return { ok: false, error: 'unknown message type' };
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // asenkron yanit
});
