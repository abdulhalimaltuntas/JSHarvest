// lib/ai-history.js
// AI analiz gecmisi. storage.local'de kalicidir (popup kapaninca kaybolmasin).
//
// Saklanan sey yalnizca analizin kendisi ve uretim kosullaridir; gonderilen
// baglam SAKLANMAZ (icinde maskeli de olsa bulgu metinleri gecer, ve tekrar
// uretilebilir bir seyi tutmanin kota maliyeti anlamsizdir).

import { api } from './browser-api.js';

const KEY = 'jsharvest_ai_history';
const MAX_ENTRIES = 60;
const MAX_TEXT = 40000;   // tek analiz icin ust sinir

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Tum gecmisi dondurur (yeniden eskiye). */
export async function listAnalyses() {
  try {
    const stored = await api.storage.local.get(KEY);
    const list = stored && Array.isArray(stored[KEY]) ? stored[KEY] : [];
    return [...list].sort((a, b) => (b.at || 0) - (a.at || 0));
  } catch {
    return [];
  }
}

/** Yalnizca belirli bir sayfaya (origin) ait analizler. */
export async function listForPage(pageUrl) {
  let origin = '';
  try { origin = new URL(pageUrl).origin; } catch { origin = ''; }
  const all = await listAnalyses();
  return origin ? all.filter((a) => a.origin === origin) : all;
}

/**
 * Bir analizi kaydeder.
 *
 * Kayit analiz BASLAR BASLAMAZ (status: 'running', metin bos) yazilir; boylece
 * popup kapansa veya calisma yarida kesilse bile ne istendigi kaybolmaz.
 * Sonuc geldiginde updateAnalysis ile ayni kayit tamamlanir.
 *
 * @param {{pageUrl,analysis,label,question,text,model,provider,status}} entry
 */
export async function saveAnalysis(entry) {
  if (!entry) return null;
  const status = entry.status || 'done';
  // Yalnizca tamamlanmis kayitlarda metin sarti aranir.
  if (status === 'done' && !entry.text) return null;
  let origin = '';
  try { origin = new URL(entry.pageUrl || '').origin; } catch { origin = ''; }

  const record = {
    id: newId(),
    at: Date.now(),
    origin,
    pageUrl: entry.pageUrl || '',
    analysis: entry.analysis || 'freeform',
    label: entry.label || '',
    question: entry.question || '',
    model: entry.model || '',
    provider: entry.provider || '',
    status,                       // 'running' | 'done' | 'error' | 'interrupted'
    error: entry.error || '',
    text: String(entry.text || '').slice(0, MAX_TEXT)
  };

  const list = await listAnalyses();
  list.unshift(record);
  const trimmed = list.slice(0, MAX_ENTRIES);

  try {
    await api.storage.local.set({ [KEY]: trimmed });
  } catch {
    // Kota tasmasi: yariya indirip tek sefer daha dene.
    try {
      await api.storage.local.set({ [KEY]: trimmed.slice(0, Math.floor(MAX_ENTRIES / 2)) });
    } catch {
      return null;
    }
  }
  return record;
}

/** Var olan bir kaydi gunceller (calisma bitince metin/model/durum yazilir). */
export async function updateAnalysis(id, patch) {
  if (!id) return null;
  const list = await listAnalyses();
  const index = list.findIndex((a) => a.id === id);
  if (index === -1) return null;

  const next = { ...list[index], ...(patch || {}), id };
  if (patch && typeof patch.text === 'string') next.text = patch.text.slice(0, MAX_TEXT);
  next.updatedAt = Date.now();
  list[index] = next;

  try { await api.storage.local.set({ [KEY]: list }); } catch { return null; }
  return next;
}

/**
 * Service worker sonlandirilirsa 'running' kayitlar oylece kalir. Worker
 * yeniden basladiginda bunlar kesintiye ugramis sayilir — kullaniciya
 * "hala calisiyor" yalanini soylemeyelim.
 */
export async function markOrphansInterrupted(activeIds = []) {
  const active = new Set(activeIds);
  const list = await listAnalyses();
  let changed = false;
  for (const item of list) {
    if (item.status === 'running' && !active.has(item.id)) {
      item.status = 'interrupted';
      item.error = item.error || 'Interrupted — the browser suspended the extension.';
      changed = true;
    }
  }
  if (!changed) return 0;
  try { await api.storage.local.set({ [KEY]: list }); } catch { return 0; }
  return 1;
}

export async function deleteAnalysis(id) {
  const list = await listAnalyses();
  const next = list.filter((a) => a.id !== id);
  try { await api.storage.local.set({ [KEY]: next }); } catch { /* yoksayilir */ }
  return next;
}

export async function clearAnalyses() {
  try { await api.storage.local.remove(KEY); } catch { /* yoksayilir */ }
}
