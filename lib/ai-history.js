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
 * @param {{pageUrl,analysis,label,question,text,model,provider}} entry
 */
export async function saveAnalysis(entry) {
  if (!entry || !entry.text) return null;
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
    text: String(entry.text).slice(0, MAX_TEXT)
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

export async function deleteAnalysis(id) {
  const list = await listAnalyses();
  const next = list.filter((a) => a.id !== id);
  try { await api.storage.local.set({ [KEY]: next }); } catch { /* yoksayilir */ }
  return next;
}

export async function clearAnalyses() {
  try { await api.storage.local.remove(KEY); } catch { /* yoksayilir */ }
}
