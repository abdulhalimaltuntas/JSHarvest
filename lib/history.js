// lib/history.js
// Origin basina yakalama snapshot'lari. storage.local kalicidir (restart sonrasi
// yasar). Diff modu ve gecmis icin kullanilir.
//
// Snapshot yalnizca hafif alanlari saklar (url, key, statusCode, size,
// hasSourceMap, party) — tam kaydi degil — kota dostu olmak icin.

import { api } from './browser-api.js';
import { getSettings } from './settings.js';

const PREFIX = 'hist:';
const MAX_SNAPSHOT_ENTRIES = 4000;

/** pageUrl -> origin anahtari. */
function originKeyOf(pageUrl) {
  try {
    return PREFIX + new URL(pageUrl).origin;
  } catch {
    return '';
  }
}

/** Bir kayitin hafif snapshot bicimini uretir. */
function lite(entry) {
  return {
    url: entry.url,
    key: entry.key || entry.normalizedUrl || entry.url,
    normalizedUrl: entry.normalizedUrl || entry.url,
    statusCode: entry.statusCode ?? null,
    size: entry.size || 0,
    party: entry.party || null,
    hasSourceMap: Boolean(entry.hasSourceMap)
  };
}

/**
 * Bir yakalamayi origin gecmisine ekler. Ayarlarda kapaliysa hicbir sey yapmaz.
 * @returns {Promise<boolean>} kaydedildi mi
 */
export async function saveSnapshot(pageUrl, entries) {
  const settings = await getSettings();
  if (!settings.persistHistory) return false;
  const key = originKeyOf(pageUrl);
  if (!key) return false;

  const snapshot = {
    at: Date.now(),
    page: pageUrl,
    count: entries.length,
    entries: entries.slice(0, MAX_SNAPSHOT_ENTRIES).map(lite)
  };

  let list = [];
  try {
    const stored = await api.storage.local.get(key);
    if (stored && Array.isArray(stored[key])) list = stored[key];
  } catch {
    list = [];
  }

  list.push(snapshot);
  const limit = Math.max(1, settings.historyLimit | 0);
  if (list.length > limit) list = list.slice(list.length - limit);

  try {
    await api.storage.local.set({ [key]: list });
    return true;
  } catch {
    // Kota tasmasi: en eski yariyi at, tekrar dene.
    try {
      await api.storage.local.set({ [key]: list.slice(Math.floor(list.length / 2)) });
      return true;
    } catch {
      return false;
    }
  }
}

/** Bir origin'in tum snapshot'larini dondurur (eskiden yeniye). */
export async function getSnapshots(pageUrl) {
  const key = originKeyOf(pageUrl);
  if (!key) return [];
  try {
    const stored = await api.storage.local.get(key);
    return stored && Array.isArray(stored[key]) ? stored[key] : [];
  } catch {
    return [];
  }
}

/** Bir origin'in en son snapshot'ini dondurur (yoksa null). */
export async function getLatestSnapshot(pageUrl) {
  const list = await getSnapshots(pageUrl);
  return list.length ? list[list.length - 1] : null;
}

/** Bir origin'in gecmisini siler. */
export async function clearHistory(pageUrl) {
  const key = originKeyOf(pageUrl);
  if (!key) return;
  try {
    await api.storage.local.remove(key);
  } catch {
    // yoksayilir
  }
}

/** Tum origin gecmislerini siler. */
export async function clearAllHistory() {
  try {
    const all = await api.storage.local.get(null);
    const keys = Object.keys(all || {}).filter((k) => k.startsWith(PREFIX));
    if (keys.length) await api.storage.local.remove(keys);
  } catch {
    // yoksayilir
  }
}
