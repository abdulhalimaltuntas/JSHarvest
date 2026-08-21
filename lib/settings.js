// lib/settings.js
// Kullanici ayarlari. storage.local kalicidir (oturumlar arasi yasar).
// Hem background (deep scan davranisi) hem popup/options tarafindan okunur.

import { api } from './browser-api.js';

const KEY = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  // Deep scan davranisi
  deepScanVerify: true,      // kesfedilen chunk'lari HEAD ile dogrula
  deepScanRecursive: true,   // kesfedilen first-party chunk'lari da tara
  deepScanMaxDepth: 1,       // recursion derinligi
  deepScanMine: true,        // sir/endpoint madenciligi
  deepScanSources: true,     // source map -> orijinal kaynak yollari

  // Arayuz
  showBadge: true,           // toolbar ikon rozetinde script sayisi
  showSpecialByDefault: false, // blob:/data: varsayilan gorunur
  defaultExportFormat: 'txt',

  // Kalicilik
  persistHistory: true,      // origin basina snapshot sakla (diff icin)
  historyLimit: 20,          // origin basina en fazla snapshot

  // AI analiz katmani (opt-in). API anahtari ayarlarda TUTULMAZ; ayri
  // storage.local anahtarinda (lib/ai.js) saklanir.
  // Kullanici yalnizca API anahtarini girer; saglayici ve model anahtarin
  // bicimden otomatik tespit edilir (lib/ai.js).
  aiEnabled: false,
  aiModel: '',               // bos = saglayiciya gore otomatik sec; doluysa bu model denenir
  aiMaxTokens: 2000,
  aiRedact: true,            // dosya yollari + ham endpoint degerlerini AI'a gonderme
  aiIncludeSources: false,   // source map'ten kurtarilan GERCEK kaynak kodunu baglama ekle
  aiSaveHistory: true,       // analizleri storage.local'de sakla
  aiCustomAnalyses: []       // [{ id, label, instruction }] kullanici tanimli analizler
});

/** Ayarlari yukler; eksik alanlar varsayilanla tamamlanir. */
export async function getSettings() {
  try {
    const stored = await api.storage.local.get(KEY);
    const value = stored && stored[KEY];
    if (value && typeof value === 'object') {
      return { ...DEFAULT_SETTINGS, ...value };
    }
  } catch {
    // yoksayilir — varsayilan doner
  }
  return { ...DEFAULT_SETTINGS };
}

/** Kismi guncelleme; mevcut ayarla birlestirilip yazilir. */
export async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch || {}) };
  try {
    await api.storage.local.set({ [KEY]: next });
  } catch {
    // kota/erisim hatasi: sessizce gecilir
  }
  return next;
}

/** Ayarlari varsayilana dondurur. */
export async function resetSettings() {
  try {
    await api.storage.local.set({ [KEY]: { ...DEFAULT_SETTINGS } });
  } catch {
    // yoksayilir
  }
  return { ...DEFAULT_SETTINGS };
}

/** Ayarlardan deep scan secenek nesnesi turetir. */
export function toDeepScanOptions(settings) {
  const s = settings || DEFAULT_SETTINGS;
  return {
    verify: s.deepScanVerify,
    recursive: s.deepScanRecursive,
    maxDepth: Math.max(0, Math.min(3, s.deepScanMaxDepth | 0)),
    mine: s.deepScanMine,
    sources: s.deepScanSources
  };
}
