// lib/store.js
// storage.session (chrome.storage.session / browser.storage.session) uzerine
// kurulu depolama katmani.
//
// MV3 service worker her an uykuya gecebilir; bellek icindeki Map yalnizca
// *onbellek* olarak kullanilir. Tek dogruluk kaynagi storage.session'dir.
// Worker uyandiginda kayitlar oradan rehydrate edilir.
//
// Yazma stratejisi: her istekte ayri set() cagrisi performansi yok eder, bu
// yuzden 300ms debounce + en fazla 1000ms gecikme siniri ile batch yazilir.
//
// Navigasyon epoch'u: her kayit, eklendigi navigasyon "epoch"u ile etiketlenir.
// onBeforeNavigate epoch'u artirir ama listeyi silmez; onCommitted commit eder
// ve yalnizca onceki epoch'a ait kayitlari temizler. Boylece commit'e yarisan
// erken script'ler kaybolmaz (sert reset yarisi cozulur).

import { normalizeUrl } from './classify.js';
import { api } from './browser-api.js';

const KEY_PREFIX = 'tab:';
const FLUSH_DEBOUNCE_MS = 300;
const FLUSH_MAX_DELAY_MS = 1000;
export const MAX_ENTRIES_PER_TAB = 5000;
export const MAX_FINDINGS_PER_TAB = 2000;
export const MAX_ORIGINS_PER_TAB = 8000;

/** tabId -> record onbellegi (kalici degil). */
const cache = new Map();
/** Diske yazilmayi bekleyen tabId kumesi. */
const dirty = new Set();

let debounceTimer = null;
let firstDirtyAt = 0;

function storageKey(tabId) {
  return KEY_PREFIX + tabId;
}

function emptyRecord(tabId, pageUrl = '') {
  return {
    tabId,
    pageUrl,
    updatedAt: Date.now(),
    epoch: 0,        // commit edilmis son navigasyon
    navEpoch: 0,     // devam eden (veya son) navigasyon
    entries: {},
    findings: [],    // deep scan sir/endpoint madenciligi sonuclari
    origins: []      // source map'ten cikarilan orijinal kaynak yollari
  };
}

/** Kayit sema uyumsuzluklarina karsi savunma (eski/eksik alanlari tamamlar). */
function sanitize(record, tabId) {
  if (!record || typeof record !== 'object' || typeof record.entries !== 'object' || !record.entries) {
    return emptyRecord(tabId);
  }
  return {
    tabId,
    pageUrl: record.pageUrl || '',
    updatedAt: record.updatedAt || 0,
    epoch: Number.isFinite(record.epoch) ? record.epoch : 0,
    navEpoch: Number.isFinite(record.navEpoch) ? record.navEpoch : (record.epoch || 0),
    entries: record.entries,
    findings: Array.isArray(record.findings) ? record.findings : [],
    origins: Array.isArray(record.origins) ? record.origins : []
  };
}

/** Tab kaydini onbellekten veya session storage'dan yukler. */
export async function getRecord(tabId) {
  if (cache.has(tabId)) return cache.get(tabId);
  const key = storageKey(tabId);
  let record = emptyRecord(tabId);
  try {
    const stored = await api.storage.session.get(key);
    record = sanitize(stored && stored[key], tabId);
  } catch {
    record = emptyRecord(tabId);
  }
  // Yukleme sirasinda baska bir cagri onbellege yazmis olabilir.
  if (cache.has(tabId)) return cache.get(tabId);
  cache.set(tabId, record);
  return record;
}

function markDirty(tabId) {
  dirty.add(tabId);
  if (!firstDirtyAt) firstDirtyAt = Date.now();
  scheduleFlush();
}

function scheduleFlush() {
  if (debounceTimer) clearTimeout(debounceTimer);
  const waited = Date.now() - firstDirtyAt;
  const delay = waited >= FLUSH_MAX_DELAY_MS
    ? 0
    : Math.min(FLUSH_DEBOUNCE_MS, FLUSH_MAX_DELAY_MS - waited);
  debounceTimer = setTimeout(() => {
    flush().catch(() => { /* yazma hatasi bir sonraki turda tekrar denenir */ });
  }, delay);
}

/** Bekleyen tum kayitlari session storage'a yazar. */
export async function flush() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (dirty.size === 0) return;
  const ids = [...dirty];
  dirty.clear();
  firstDirtyAt = 0;

  const payload = {};
  for (const id of ids) {
    const record = cache.get(id);
    if (record) payload[storageKey(id)] = record;
  }
  if (Object.keys(payload).length === 0) return;

  try {
    await api.storage.session.set(payload);
  } catch (err) {
    // Kota tasmasi: kayitlari yariya indirip tek sefer daha dene.
    const reduced = {};
    for (const id of ids) {
      const record = cache.get(id);
      if (!record) continue;
      trimEntries(record, Math.floor(MAX_ENTRIES_PER_TAB / 2));
      record.findings = (record.findings || []).slice(0, Math.floor(MAX_FINDINGS_PER_TAB / 2));
      record.origins = (record.origins || []).slice(0, Math.floor(MAX_ORIGINS_PER_TAB / 2));
      reduced[storageKey(id)] = record;
    }
    try {
      await api.storage.session.set(reduced);
    } catch {
      // Hala yazilamiyorsa bellekteki veriyle devam edilir; kullanici verisi
      // kaybolmaz, yalnizca worker uykusundan sonra eksik kalabilir.
    }
  }
}

/** En eski kayitlari atarak kayit sayisini sinira ceker. */
function trimEntries(record, limit = MAX_ENTRIES_PER_TAB) {
  const keys = Object.keys(record.entries);
  if (keys.length <= limit) return;
  keys.sort((a, b) => (record.entries[a].firstSeen || 0) - (record.entries[b].firstSeen || 0));
  const removeCount = keys.length - limit;
  for (let i = 0; i < removeCount; i++) {
    delete record.entries[keys[i]];
  }
}

/**
 * Gelen kaydi mevcut kayitla birlestirir.
 * Not: performans nedeniyle kayit nesnesi yerinde guncellenir. Immutability
 * kurali depolama katmaninin disinda (popup/export) korunur.
 */
function mergeEntry(existing, incoming, now, epoch) {
  const sources = new Set(existing.sources || []);
  for (const source of incoming.sources || []) sources.add(source);
  const frameIds = new Set(existing.frameIds || []);
  if (typeof incoming.frameId === 'number') frameIds.add(incoming.frameId);

  existing.sources = [...sources];
  existing.frameIds = [...frameIds];
  existing.lastSeen = now;
  existing.epoch = epoch; // en son goruldugu epoch — commit purge'unde yasar
  if (existing.url == null) existing.url = incoming.url;
  if (incoming.statusCode != null) existing.statusCode = incoming.statusCode;
  if (incoming.error) existing.error = incoming.error;
  if (incoming.fromCache != null) existing.fromCache = incoming.fromCache;
  if (incoming.size) existing.size = Math.max(existing.size || 0, incoming.size);
  if (incoming.duration) existing.duration = Math.max(existing.duration || 0, incoming.duration);
  if (incoming.initiator && !existing.initiator) existing.initiator = incoming.initiator;
  if (incoming.requestType && !existing.requestType) existing.requestType = incoming.requestType;
  if (incoming.hasSourceMap) existing.hasSourceMap = true;
  if (incoming.sourceMapUrl && !existing.sourceMapUrl) existing.sourceMapUrl = incoming.sourceMapUrl;
  if (incoming.integrity) existing.integrity = true;
  if (incoming.mixedContent) existing.mixedContent = true;
  if (incoming.mapSourceCount != null) existing.mapSourceCount = incoming.mapSourceCount;
  if (incoming.mapHasContent != null) existing.mapHasContent = incoming.mapHasContent;
  // worker/serviceworker gibi daha ozgun kind bilgisi genel "script"i ezebilir.
  if (incoming.kind && incoming.kind !== 'script' && (!existing.kind || existing.kind === 'script')) {
    existing.kind = incoming.kind;
  }
  // "confirmed" her zaman "inferred" kaydini ezer.
  if (incoming.confidence === 'confirmed') existing.confidence = 'confirmed';
  return existing;
}

function newEntry(incoming, key, normalized, now, epoch) {
  return {
    url: incoming.url,
    key,
    normalizedUrl: normalized,
    kind: incoming.kind || 'script',
    sources: [...new Set(incoming.sources || [])],
    frameIds: typeof incoming.frameId === 'number' ? [incoming.frameId] : [],
    statusCode: incoming.statusCode ?? null,
    error: incoming.error || '',
    fromCache: incoming.fromCache ?? null,
    size: incoming.size || 0,
    duration: incoming.duration || 0,
    initiator: incoming.initiator || '',
    requestType: incoming.requestType || '',
    hasSourceMap: Boolean(incoming.hasSourceMap),
    sourceMapUrl: incoming.sourceMapUrl || '',
    integrity: Boolean(incoming.integrity),
    mixedContent: Boolean(incoming.mixedContent),
    mapSourceCount: incoming.mapSourceCount ?? null,
    mapHasContent: incoming.mapHasContent ?? null,
    confidence: incoming.confidence === 'inferred' ? 'inferred' : 'confirmed',
    epoch,
    firstSeen: now,
    lastSeen: now
  };
}

/**
 * Bir veya birden fazla kaydi tab koleksiyonuna ekler.
 * @returns {Promise<number>} yeni eklenen (daha once gorulmemis) kayit sayisi
 */
export async function addEntries(tabId, incomingList) {
  if (!Array.isArray(incomingList) || incomingList.length === 0) return 0;
  const record = await getRecord(tabId);
  const now = Date.now();
  const epoch = record.navEpoch ?? record.epoch ?? 0;
  let added = 0;

  for (const incoming of incomingList) {
    if (!incoming || typeof incoming.url !== 'string' || incoming.url.length === 0) continue;
    if (incoming.url.length > 8192) continue; // asiri uzun data: URL'leri atla
    const { key, normalized } = normalizeUrl(incoming.url);
    if (!key) continue;
    const existing = record.entries[key];
    if (existing) {
      mergeEntry(existing, incoming, now, epoch);
    } else {
      record.entries[key] = newEntry(incoming, key, normalized, now, epoch);
      added++;
    }
  }

  if (added > 0) trimEntries(record);
  record.updatedAt = now;
  markDirty(tabId);
  return added;
}

/**
 * Deep scan madenciligi sonuclarini ekler (sir/endpoint bulgulari).
 * `id` alani (type + value + file) uzerinden deduplike edilir.
 */
export async function addFindings(tabId, findings) {
  if (!Array.isArray(findings) || findings.length === 0) return 0;
  const record = await getRecord(tabId);
  const seen = new Set(record.findings.map((f) => f.id));
  let added = 0;
  for (const finding of findings) {
    if (!finding || !finding.id || seen.has(finding.id)) continue;
    seen.add(finding.id);
    record.findings.push(finding);
    added++;
    if (record.findings.length >= MAX_FINDINGS_PER_TAB) break;
  }
  if (added > 0) {
    record.updatedAt = Date.now();
    markDirty(tabId);
  }
  return added;
}

/** Source map'ten cikan orijinal kaynak yollarini ekler (deduplike). */
export async function addOrigins(tabId, origins) {
  if (!Array.isArray(origins) || origins.length === 0) return 0;
  const record = await getRecord(tabId);
  const seen = new Set(record.origins.map((o) => o.path));
  let added = 0;
  for (const origin of origins) {
    if (!origin || !origin.path || seen.has(origin.path)) continue;
    seen.add(origin.path);
    record.origins.push(origin);
    added++;
    if (record.origins.length >= MAX_ORIGINS_PER_TAB) break;
  }
  if (added > 0) {
    record.updatedAt = Date.now();
    markDirty(tabId);
  }
  return added;
}

/** Sayfa URL'ini gunceller (koleksiyonu sifirlamaz). */
export async function setPageUrl(tabId, pageUrl) {
  const record = await getRecord(tabId);
  if (record.pageUrl === pageUrl) return record;
  record.pageUrl = pageUrl || '';
  record.updatedAt = Date.now();
  markDirty(tabId);
  return record;
}

/**
 * Ana frame navigasyonu baslarken cagrilir. Epoch artirilir ama liste
 * KORUNUR — yeni sayfanin commit'e yarisan script'leri yeni epoch'u alir.
 */
export async function beginNavigation(tabId, pendingUrl) {
  const record = await getRecord(tabId);
  record.navEpoch = (record.epoch ?? 0) + 1;
  record.pendingUrl = pendingUrl || '';
  record.updatedAt = Date.now();
  markDirty(tabId);
  return record;
}

/**
 * Ana frame commit'i. Epoch commit edilir ve yalnizca onceki epoch'lara ait
 * kayitlar (onceki sayfanin script'leri) temizlenir.
 */
export async function commitNavigation(tabId, pageUrl) {
  const record = await getRecord(tabId);
  // onBeforeNavigate kacmis olabilir: navEpoch commit'ten ileri degilse artir.
  const target = (record.navEpoch ?? 0) > (record.epoch ?? 0)
    ? record.navEpoch
    : (record.epoch ?? 0) + 1;
  record.epoch = target;
  record.navEpoch = target;
  record.pendingUrl = '';
  record.pageUrl = pageUrl || '';
  for (const key of Object.keys(record.entries)) {
    if ((record.entries[key].epoch ?? 0) < target) delete record.entries[key];
  }
  // Yeni sayfa: bir onceki sayfanin bulgulari ve kaynaklari da temizlenir.
  record.findings = [];
  record.origins = [];
  record.updatedAt = Date.now();
  cache.set(tabId, record);
  markDirty(tabId);
  await flush();
  return record;
}

/** Kullanici "Clear" dediginde: her seyi sifirla, epoch surekliligini koru. */
export async function resetTab(tabId, pageUrl) {
  const prev = cache.get(tabId);
  const nextEpoch = (prev && Number.isFinite(prev.epoch) ? prev.epoch : 0) + 1;
  const record = emptyRecord(tabId, pageUrl || '');
  record.epoch = nextEpoch;
  record.navEpoch = nextEpoch;
  cache.set(tabId, record);
  markDirty(tabId);
  await flush();
  return record;
}

/** Tab kapandiginda tum izleri temizler. */
export async function deleteTab(tabId) {
  cache.delete(tabId);
  dirty.delete(tabId);
  try {
    await api.storage.session.remove(storageKey(tabId));
  } catch {
    // Silinemeyen kayit bir sonraki oturumda zaten kaybolur (session storage).
  }
}

/** Depolamada kalmis, artik var olmayan tab kayitlarini temizler. */
export async function pruneOrphans() {
  let all;
  try {
    all = await api.storage.session.get(null);
  } catch {
    return;
  }
  const staleKeys = [];
  for (const key of Object.keys(all || {})) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const tabId = Number(key.slice(KEY_PREFIX.length));
    if (!Number.isFinite(tabId)) {
      staleKeys.push(key);
      continue;
    }
    try {
      await api.tabs.get(tabId);
    } catch {
      staleKeys.push(key);
      cache.delete(tabId);
    }
  }
  if (staleKeys.length === 0) return;
  try {
    await api.storage.session.remove(staleKeys);
  } catch {
    // Sessizce gecilir.
  }
}
