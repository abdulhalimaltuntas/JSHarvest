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
    await store.addEntries(details.tabId, [toNetworkEntry(details, extra)]);
    scheduleBadge(details.tabId);
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
});

api.runtime.onInstalled.addListener(() => {
  store.pruneOrphans().catch(() => { /* yoksayilir */ });
});

api.runtime.onStartup.addListener(() => {
  store.pruneOrphans().catch(() => { /* yoksayilir */ });
});

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
  return {
    ok: true,
    pageUrl,
    updatedAt: record.updatedAt,
    entries: Object.values(record.entries),
    findings: record.findings || [],
    origins: record.origins || [],
    deepScanRunning: isDeepScanRunning(tabId)
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
        .then(() => scheduleBadge(tabId))
        .catch((err) => {
          broadcast({ type: 'deep-scan-done', tabId, error: String(err && err.message ? err.message : err) });
        });
      return { ok: true, started: true };
    }
    case 'deep-scan-cancel':
      cancelDeepScan(Number(message.tabId));
      return { ok: true };
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
