// lib/sessions.js
// Angajman oturumlari. Sekme bazli/oturumluk yakalamanin (lib/store.js) uzerine
// KALICI bir birikim katmani ekler.
//
// Model:
//   - Oturum = adlandirilmis bir angajman: { id, name, scope[], autoAttach }
//   - Kapsam (scope) host desenleridir: "acme.com", "*.acme.com"
//   - Bir sekme bir oturuma bagliyken, o sekmede toplanan kayitlar oturuma da
//     islenir; boylece 40 sayfa ve 3 sekme tek envanterde birikir
//   - Kapsam ayni zamanda gizlilik korumasidir: kapsam disi host'lar oturuma
//     yazilmaz, kisisel gezinme angajman verisine karismaz
//
// Depolama: storage.LOCAL (tarayici kapansa da yasar).
//   sessions          -> [{ id, name, scope, autoAttach, createdAt, updatedAt, archived }]
//   sessdata:<id>     -> { entries: {key: entry}, findings: [], origins: [], notes }

import { api } from './browser-api.js';
import { normalizeUrl, parseUrlSafe } from './classify.js';

const LIST_KEY = 'sessions';
const DATA_PREFIX = 'sessdata:';

export const MAX_ENTRIES_PER_SESSION = 8000;
export const MAX_FINDINGS_PER_SESSION = 3000;
export const MAX_ORIGINS_PER_SESSION = 6000;
const MAX_NOTES = 20000;

function newId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function dataKey(id) {
  return DATA_PREFIX + id;
}

// ---------------------------------------------------------------------------
// Kapsam eslesmesi
// ---------------------------------------------------------------------------

/**
 * Bir host'un kapsam desenlerinden herhangi biriyle eslesip eslesmedigi.
 * Desen bicimleri:
 *   "acme.com"    -> tam host
 *   "*.acme.com"  -> alt alan adlari VE alan adinin kendisi
 * Bos kapsam = her seye acik (kullanici henuz daraltmadi).
 */
export function matchesScope(host, patterns) {
  const h = String(host || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!h) return false;
  const list = (patterns || []).map((p) => String(p || '').trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;

  return list.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return h === base || h.endsWith('.' + base);
    }
    return h === pattern;
  });
}

/** URL kapsam icinde mi? */
export function urlInScope(url, patterns) {
  const parsed = parseUrlSafe(url || '');
  return parsed ? matchesScope(parsed.hostname, patterns) : false;
}

// ---------------------------------------------------------------------------
// Oturum listesi (meta)
// ---------------------------------------------------------------------------

export async function listSessions({ includeArchived = false } = {}) {
  try {
    const stored = await api.storage.local.get(LIST_KEY);
    const list = stored && Array.isArray(stored[LIST_KEY]) ? stored[LIST_KEY] : [];
    const visible = includeArchived ? list : list.filter((s) => !s.archived);
    return [...visible].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return [];
  }
}

export async function getSession(id) {
  const list = await listSessions({ includeArchived: true });
  return list.find((s) => s.id === id) || null;
}

async function writeSessions(list) {
  try {
    await api.storage.local.set({ [LIST_KEY]: list });
    return true;
  } catch {
    return false;
  }
}

export async function createSession({ name, scope = [], autoAttach = true } = {}) {
  const list = await listSessions({ includeArchived: true });
  const session = {
    id: newId(),
    name: (name || 'Untitled engagement').slice(0, 120),
    scope: (scope || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 50),
    autoAttach: Boolean(autoAttach),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false
  };
  list.push(session);
  await writeSessions(list);
  return session;
}

export async function updateSession(id, patch) {
  const list = await listSessions({ includeArchived: true });
  const index = list.findIndex((s) => s.id === id);
  if (index === -1) return null;
  const next = { ...list[index], ...(patch || {}), id, updatedAt: Date.now() };
  if (Array.isArray(next.scope)) {
    next.scope = next.scope.map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
  }
  list[index] = next;
  await writeSessions(list);
  return next;
}

export async function deleteSession(id) {
  const list = await listSessions({ includeArchived: true });
  await writeSessions(list.filter((s) => s.id !== id));
  try { await api.storage.local.remove(dataKey(id)); } catch { /* yoksayilir */ }
}

/** Kapsamina gore bu URL'i sahiplenen ilk (en son kullanilan) oturum. */
export async function findSessionForUrl(url) {
  const parsed = parseUrlSafe(url || '');
  if (!parsed) return null;
  const list = await listSessions();
  return list.find((s) => s.autoAttach && Array.isArray(s.scope) && s.scope.length
    && matchesScope(parsed.hostname, s.scope)) || null;
}

// ---------------------------------------------------------------------------
// Oturum verisi
// ---------------------------------------------------------------------------

function emptyData() {
  return { entries: {}, findings: [], origins: [], notes: '' };
}

export async function getData(id) {
  try {
    const stored = await api.storage.local.get(dataKey(id));
    const data = stored && stored[dataKey(id)];
    if (!data || typeof data !== 'object') return emptyData();
    return {
      entries: data.entries && typeof data.entries === 'object' ? data.entries : {},
      findings: Array.isArray(data.findings) ? data.findings : [],
      origins: Array.isArray(data.origins) ? data.origins : [],
      notes: typeof data.notes === 'string' ? data.notes : ''
    };
  } catch {
    return emptyData();
  }
}

async function writeData(id, data) {
  try {
    await api.storage.local.set({ [dataKey(id)]: data });
    return true;
  } catch {
    // Kota tasmasi: en eski kayitlari atip tek sefer daha dene.
    trimEntries(data, Math.floor(MAX_ENTRIES_PER_SESSION / 2));
    data.findings = data.findings.slice(0, Math.floor(MAX_FINDINGS_PER_SESSION / 2));
    data.origins = data.origins.slice(0, Math.floor(MAX_ORIGINS_PER_SESSION / 2));
    try {
      await api.storage.local.set({ [dataKey(id)]: data });
      return true;
    } catch {
      return false;
    }
  }
}

function trimEntries(data, limit = MAX_ENTRIES_PER_SESSION) {
  const keys = Object.keys(data.entries);
  if (keys.length <= limit) return;
  keys.sort((a, b) => (data.entries[a].firstSeen || 0) - (data.entries[b].firstSeen || 0));
  for (let i = 0; i < keys.length - limit; i++) delete data.entries[keys[i]];
}

/**
 * Sekmede toplanan kayitlari oturuma isler.
 * @param {string} id
 * @param {Array} entries      decorate EDILMEMIS ham kayitlar
 * @param {{authState?: 'anon'|'auth', pageUrl?: string, scope?: string[]}} ctx
 * @returns {Promise<{added:number, merged:number, skipped:number}>}
 */
export async function mergeEntries(id, entries, ctx = {}) {
  if (!id || !Array.isArray(entries) || entries.length === 0) {
    return { added: 0, merged: 0, skipped: 0 };
  }
  const data = await getData(id);
  const now = Date.now();
  const auth = ctx.authState === 'auth' ? 'auth' : 'anon';
  let added = 0;
  let merged = 0;
  let skipped = 0;

  for (const incoming of entries) {
    if (!incoming || typeof incoming.url !== 'string') { skipped++; continue; }
    const { key, normalized } = normalizeUrl(incoming.url);
    if (!key) { skipped++; continue; }

    const existing = data.entries[key];
    if (existing) {
      existing.lastSeen = now;
      existing.sources = [...new Set([...(existing.sources || []), ...(incoming.sources || [])])];
      existing.authStates = [...new Set([...(existing.authStates || []), auth])];
      if (incoming.statusCode != null) existing.statusCode = incoming.statusCode;
      if (incoming.size) existing.size = Math.max(existing.size || 0, incoming.size);
      if (incoming.hasSourceMap) existing.hasSourceMap = true;
      if (incoming.sourceMapUrl && !existing.sourceMapUrl) existing.sourceMapUrl = incoming.sourceMapUrl;
      if (incoming.integrity) existing.integrity = true;
      if (incoming.mixedContent) existing.mixedContent = true;
      if (incoming.confidence === 'confirmed') existing.confidence = 'confirmed';
      if (ctx.pageUrl && !(existing.pages || []).includes(ctx.pageUrl)) {
        existing.pages = [...(existing.pages || []), ctx.pageUrl].slice(-8);
      }
      merged++;
    } else {
      data.entries[key] = {
        ...incoming,
        key,
        normalizedUrl: normalized,
        authStates: [auth],
        pages: ctx.pageUrl ? [ctx.pageUrl] : [],
        firstSeen: incoming.firstSeen || now,
        lastSeen: now
      };
      added++;
    }
  }

  if (added > 0) trimEntries(data);
  await writeData(id, data);
  return { added, merged, skipped };
}

/** Bulgulari oturuma isler (id alanina gore deduplike). */
export async function mergeFindings(id, findings) {
  if (!id || !Array.isArray(findings) || findings.length === 0) return 0;
  const data = await getData(id);
  const seen = new Set(data.findings.map((f) => f.id));
  let added = 0;
  for (const f of findings) {
    if (!f || !f.id || seen.has(f.id)) continue;
    seen.add(f.id);
    data.findings.push(f);
    added++;
    if (data.findings.length >= MAX_FINDINGS_PER_SESSION) break;
  }
  if (added > 0) await writeData(id, data);
  return added;
}

/** Kurtarilan kaynak yollarini oturuma isler. */
export async function mergeOrigins(id, origins) {
  if (!id || !Array.isArray(origins) || origins.length === 0) return 0;
  const data = await getData(id);
  const seen = new Set(data.origins.map((o) => o.path));
  let added = 0;
  for (const o of origins) {
    if (!o || !o.path || seen.has(o.path)) continue;
    seen.add(o.path);
    data.origins.push(o);
    added++;
    if (data.origins.length >= MAX_ORIGINS_PER_SESSION) break;
  }
  if (added > 0) await writeData(id, data);
  return added;
}

export async function setNotes(id, notes) {
  const data = await getData(id);
  data.notes = String(notes || '').slice(0, MAX_NOTES);
  await writeData(id, data);
  return data.notes;
}

/** Oturumun sayisal ozeti (liste ekranlari icin). */
export async function summary(id) {
  const data = await getData(id);
  const entries = Object.values(data.entries);
  const authOnly = entries.filter((e) => (e.authStates || []).includes('auth')
    && !(e.authStates || []).includes('anon')).length;
  return {
    scripts: entries.length,
    findings: data.findings.length,
    origins: data.origins.length,
    authOnly,
    hasNotes: Boolean(data.notes)
  };
}
