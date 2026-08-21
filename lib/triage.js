// lib/triage.js
// Triyaj durumu: buyuk listelerde nerede kaldigini bilmek icin.
//
// Origin bazli ve KALICI (storage.local) — angajmana bagli olmadan da calisir,
// boylece hizli bir bakista bile isaretleme yapilabilir. Angajman raporu bu
// isaretleri toplayarak kullanir.
//
//   triage:<origin> -> { <dedupeKey>: 'reviewed' | 'interesting' | 'ignored' }

import { api } from './browser-api.js';
import { parseUrlSafe } from './classify.js';

const PREFIX = 'triage:';

/** Gecerli durumlar. 'new' varsayilandir ve saklanmaz. */
export const STATES = ['new', 'reviewed', 'interesting', 'ignored'];

export const STATE_LABELS = {
  new: 'New',
  reviewed: 'Reviewed',
  interesting: 'Interesting',
  ignored: 'Not relevant'
};

function keyFor(pageUrl) {
  const parsed = parseUrlSafe(pageUrl || '');
  return parsed ? PREFIX + parsed.origin : '';
}

/** Bir origin icin tum triyaj isaretlerini dondurur. */
export async function getTriage(pageUrl) {
  const storeKey = keyFor(pageUrl);
  if (!storeKey) return {};
  try {
    const stored = await api.storage.local.get(storeKey);
    const map = stored && stored[storeKey];
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

/**
 * Bir kaydin durumunu ayarlar. 'new' isareti kaldirir (varsayilana doner).
 * @returns {Promise<Object>} guncel harita
 */
export async function setState(pageUrl, entryKey, state) {
  const storeKey = keyFor(pageUrl);
  if (!storeKey || !entryKey) return {};
  const map = await getTriage(pageUrl);

  if (!state || state === 'new') delete map[entryKey];
  else if (STATES.includes(state)) map[entryKey] = state;

  try {
    if (Object.keys(map).length === 0) await api.storage.local.remove(storeKey);
    else await api.storage.local.set({ [storeKey]: map });
  } catch {
    /* yazilamazsa isaret bu oturumda gorunmez, veri kaybi yok */
  }
  return map;
}

export async function clearTriage(pageUrl) {
  const storeKey = keyFor(pageUrl);
  if (!storeKey) return;
  try { await api.storage.local.remove(storeKey); } catch { /* yoksayilir */ }
}

/** Durum dagilimi: kac yeni, kac incelendi… */
export function countStates(entries, map) {
  const counts = { new: 0, reviewed: 0, interesting: 0, ignored: 0 };
  for (const entry of entries || []) {
    const state = (map || {})[entry.key] || 'new';
    if (counts[state] == null) counts.new++;
    else counts[state]++;
  }
  return counts;
}
