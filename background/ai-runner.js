// background/ai-runner.js
// AI analizlerini POPUP'TA DEGIL burada calistirir.
//
// Neden: popup bir sayfadir ve kullanici baska yere tikladigi anda yok edilir —
// devam eden fetch iptal olur, analiz yarida kalir. Calisma background'a
// tasindiginda popup yalnizca bir goruntuleyici olur; kapatip acabilirsin,
// analiz calismaya devam eder.
//
// MV3 notu: service worker bosta kalinca sonlandirilir. Calisma suresince
// periyodik bir API cagrisi ile bosta kalma sayaci sifirlanir. Yine de worker
// oldurulebilir; bu durumda gecmisteki kayit 'interrupted' olarak isaretlenir,
// kullaniciya "hala calisiyor" yalani soylenmez.

import { api } from '../lib/browser-api.js';
import { broadcast } from '../lib/messaging.js';
import { runAnalysis } from '../lib/ai.js';
import { saveAnalysis, updateAnalysis, markOrphansInterrupted } from '../lib/ai-history.js';
import { getSettings } from '../lib/settings.js';

/** runId -> { tabId, analysis, label, question, text, model, provider, controller, done } */
const runs = new Map();

const DELTA_FLUSH_MS = 140;     // akis parcalarini toplu yayinla
const KEEPALIVE_MS = 20000;     // < 30s bosta kalma esigi

let keepAliveTimer = null;

/** Calisma varken worker'i canli tut. */
function ensureKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (runs.size === 0) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      return;
    }
    // Herhangi bir eklenti API cagrisi bosta kalma sayacini sifirlar.
    try {
      if (api.runtime.getPlatformInfo) api.runtime.getPlatformInfo(() => { void api.runtime.lastError; });
      else api.storage.session.get('keepalive').catch(() => {});
    } catch {
      /* yoksayilir */
    }
  }, KEEPALIVE_MS);
}

function newRunId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Popup icin calisma durumu ozeti. */
function snapshot(run) {
  return {
    runId: run.runId,
    tabId: run.tabId,
    analysis: run.analysis,
    label: run.label,
    question: run.question,
    text: run.text,
    model: run.model,
    provider: run.provider,
    stage: run.stage || null,
    running: !run.done,
    error: run.error || ''
  };
}

/** Bir sekmede devam eden calisma varsa dondurur. */
export function activeRunForTab(tabId) {
  for (const run of runs.values()) {
    if (run.tabId === tabId && !run.done) return snapshot(run);
  }
  return null;
}

export function getRun(runId) {
  const run = runs.get(runId);
  return run ? snapshot(run) : null;
}

export function cancelRun(runId) {
  const run = runs.get(runId);
  if (!run || run.done) return false;
  run.cancelled = true;
  try { run.controller.abort(); } catch { /* yoksayilir */ }
  return true;
}

/**
 * Analizi baslatir ve HEMEN doner. Sonuc mesajlarla yayinlanir, gecmise yazilir.
 * @returns {Promise<{runId: string, historyId: string}>}
 */
export async function startRun({ tabId, data, analysis, question, target, history, label } = {}) {
  const runId = newRunId();
  const controller = new AbortController();
  const settings = await getSettings();

  const run = {
    runId,
    tabId,
    analysis,
    label: label || analysis,
    question: question || '',
    text: '',
    model: '',
    provider: '',
    error: '',
    done: false,
    cancelled: false,
    controller,
    historyId: ''
  };
  runs.set(runId, run);
  ensureKeepAlive();

  // Istek gonderilir gonderilmez gecmise yaz: popup kapansa, worker olse bile
  // ne sorduğun kaybolmaz.
  if (settings.aiSaveHistory) {
    try {
      const record = await saveAnalysis({
        pageUrl: data && data.pageUrl ? data.pageUrl : '',
        analysis,
        label: run.label,
        question: run.question,
        text: '',
        status: 'running'
      });
      if (record) run.historyId = record.id;
    } catch {
      /* gecmis yazilamazsa calisma yine de surer */
    }
  }

  broadcast({ type: 'ai-run-started', ...snapshot(run), historyId: run.historyId });

  // Akis parcalarini biriktirip periyodik yayinla (mesaj trafigini kismak icin).
  let pending = '';
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (!pending) return;
    const chunk = pending;
    pending = '';
    broadcast({ type: 'ai-run-delta', runId, chunk, text: run.text });
  };

  runAnalysis({
    data,
    analysis,
    question,
    target,
    history,
    signal: controller.signal,
    onStage: (info) => {
      // Kod indirme uzun surebilir; kullanici bekledigini bilsin.
      run.stage = info;
      broadcast({ type: 'ai-run-stage', runId, ...info });
    },
    onDelta: (chunk) => {
      run.text += chunk;
      pending += chunk;
      if (!flushTimer) flushTimer = setTimeout(flush, DELTA_FLUSH_MS);
    }
  }).then(async (result) => {
    if (flushTimer) { clearTimeout(flushTimer); flush(); }
    run.model = result && result.model ? result.model : '';
    run.provider = result && result.provider ? result.provider : '';
    run.done = true;

    if (run.historyId) {
      await updateAnalysis(run.historyId, {
        text: run.text,
        model: run.model,
        provider: run.provider,
        status: 'done'
      }).catch(() => { /* yoksayilir */ });
    }
    broadcast({ type: 'ai-run-done', ...snapshot(run) });
  }).catch(async (err) => {
    if (flushTimer) { clearTimeout(flushTimer); flush(); }
    const aborted = run.cancelled || (err && err.name === 'AbortError');
    run.done = true;
    run.error = aborted ? 'Stopped.' : String(err && err.message ? err.message : err);

    if (run.historyId) {
      await updateAnalysis(run.historyId, {
        text: run.text,
        status: aborted ? 'interrupted' : 'error',
        error: run.error
      }).catch(() => { /* yoksayilir */ });
    }
    broadcast({ type: 'ai-run-done', ...snapshot(run) });
  }).finally(() => {
    // Kisa bir sure sakla ki popup acildiginda son sonucu gorebilsin.
    setTimeout(() => runs.delete(runId), 60000);
  });

  return { runId, historyId: run.historyId };
}

/** Worker yeniden basladiginda yarim kalan kayitlari duzelt. */
export async function reconcileHistory() {
  const active = [...runs.values()].filter((r) => !r.done).map((r) => r.historyId).filter(Boolean);
  try { await markOrphansInterrupted(active); } catch { /* yoksayilir */ }
}
