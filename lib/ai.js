// lib/ai.js
// AI analiz katmani. Kullanici YALNIZCA API anahtarini girer; saglayici ve model
// anahtarin bicimden otomatik tespit edilir, model bulunamazsa aday listesinden
// otomatik yedeklenir.
//
// Tasarim ilkeleri:
//  - Cagri eklenti SAYFASINDAN yapilir (popup), service worker'dan degil: uzun
//    analizde SW olmez ve <all_urls> host izni CORS'u bypass eder.
//  - API anahtari ayri bir storage.local anahtarinda tutulur; ayarlara sizmaz,
//    content script'e asla gitmez.
//  - Gizlilik: sir DEGERLERI zaten madencilikte maskelenir (ham sir hic
//    saklanmaz). `aiRedact` acikken dosya yollari ve ham endpoint degerleri de
//    baglamdan cikarilir.

import { api } from './browser-api.js';
import { getSettings } from './settings.js';

const KEY_STORAGE = 'jsharvest_ai_key';
const MODEL_CACHE = 'jsharvest_ai_model';

// ---------------------------------------------------------------------------
// Anahtar yonetimi
// ---------------------------------------------------------------------------

export async function getApiKey() {
  try {
    const stored = await api.storage.local.get(KEY_STORAGE);
    return (stored && stored[KEY_STORAGE]) || '';
  } catch {
    return '';
  }
}

export async function setApiKey(key) {
  try {
    if (key) await api.storage.local.set({ [KEY_STORAGE]: key });
    else await api.storage.local.remove(KEY_STORAGE);
    // Anahtar degisti -> onbellekteki model artik gecerli olmayabilir.
    await api.storage.local.remove(MODEL_CACHE);
  } catch {
    /* yoksayilir */
  }
}

async function getCachedModel(providerId) {
  try {
    const stored = await api.storage.local.get(MODEL_CACHE);
    const cache = stored && stored[MODEL_CACHE];
    return (cache && cache.provider === providerId) ? cache.model : '';
  } catch {
    return '';
  }
}

async function setCachedModel(providerId, model) {
  try {
    await api.storage.local.set({ [MODEL_CACHE]: { provider: providerId, model } });
  } catch {
    /* yoksayilir */
  }
}

// ---------------------------------------------------------------------------
// Saglayicilar — anahtar bicimlerinden otomatik tespit
// ---------------------------------------------------------------------------

/** OpenAI /chat/completions uyumlu govde (OpenAI, Groq, OpenRouter, yerel). */
function openAiCompatible(baseUrl, label, models, extraHeaders) {
  return {
    label,
    models,
    request: ({ model, key, system, user, history, maxTokens, stream }) => ({
      url: baseUrl + '/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(extraHeaders || {}) },
      body: {
        model,
        messages: [
          { role: 'system', content: system },
          ...(history || []),
          { role: 'user', content: user }
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: Boolean(stream)
      }
    }),
    parse: (json) => (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '',
    streamDelta: (evt) => (evt && evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content) || ''
  };
}

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
    request: ({ model, key, system, user, history, maxTokens, stream }) => ({
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: {
        model,
        max_tokens: maxTokens,
        temperature: 0.3,
        system,
        messages: [...(history || []), { role: 'user', content: user }],
        stream: Boolean(stream)
      }
    }),
    parse: (json) => (json && Array.isArray(json.content)) ? json.content.map((b) => b.text || '').join('') : '',
    streamDelta: (evt) => (evt && evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') ? evt.delta.text : ''
  },

  openai: openAiCompatible('https://api.openai.com/v1', 'OpenAI', ['gpt-4o', 'gpt-4o-mini']),

  gemini: {
    label: 'Google Gemini',
    models: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-1.5-flash'],
    request: ({ model, key, system, user, history, maxTokens, stream }) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:`
        + `${stream ? 'streamGenerateContent' : 'generateContent'}?${stream ? 'alt=sse&' : ''}key=${encodeURIComponent(key)}`,
      headers: { 'content-type': 'application/json' },
      body: {
        system_instruction: { parts: [{ text: system }] },
        contents: [
          ...(history || []).map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          })),
          { role: 'user', parts: [{ text: user }] }
        ],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 }
      }
    }),
    parse: (json) => {
      const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
      return Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
    },
    streamDelta: (evt) => {
      const parts = evt && evt.candidates && evt.candidates[0] && evt.candidates[0].content && evt.candidates[0].content.parts;
      return Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
    }
  },

  groq: openAiCompatible('https://api.groq.com/openai/v1', 'Groq',
    ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']),

  openrouter: openAiCompatible('https://openrouter.ai/api/v1', 'OpenRouter',
    ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o-mini'],
    { 'HTTP-Referer': 'https://github.com/jsharvest', 'X-Title': 'JSHarvest' })
};

/**
 * API anahtarinin bicimden saglayiciyi tespit eder.
 * Kullanicinin model/URL girmesine gerek kalmaz.
 */
export function detectProvider(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (/^sk-ant-/i.test(k)) return 'anthropic';
  if (/^sk-or-v1-/i.test(k)) return 'openrouter';
  if (/^gsk_/.test(k)) return 'groq';
  if (/^AIza[0-9A-Za-z_-]{10,}$/.test(k)) return 'gemini';
  if (/^sk-/i.test(k)) return 'openai';   // sk-proj-… dahil
  return '';
}

/** UI icin: anahtardan okunan saglayici etiketi. */
export function describeKey(key) {
  const id = detectProvider(key);
  if (!id) return { id: '', label: '', ok: false };
  return { id, label: PROVIDERS[id].label, ok: true };
}

// ---------------------------------------------------------------------------
// Teknoloji ipuclari (hem baglami zenginlestirir hem "tech" analizini besler)
// ---------------------------------------------------------------------------

const TECH_PATTERNS = [
  [/\breact(-dom)?[.-]/i, 'React'],
  [/\bnext\/|_next\/static/i, 'Next.js'],
  [/\bvue(@|[.-])/i, 'Vue'],
  [/\bnuxt\b|_nuxt\//i, 'Nuxt'],
  [/\bangular|main\.[a-f0-9]+\.js.*runtime/i, 'Angular'],
  [/\bsvelte|_app\/immutable/i, 'Svelte/SvelteKit'],
  [/\bjquery\b/i, 'jQuery'],
  [/\bbootstrap\b/i, 'Bootstrap'],
  [/\blodash\b|\bunderscore\b/i, 'Lodash/Underscore'],
  [/\bd3(\.min)?\.js|\bchart\.js|\bhighcharts\b/i, 'Charting library'],
  [/\bthree(\.min)?\.js|\bbabylon\b/i, '3D engine'],
  [/\bwp-(content|includes)\b/i, 'WordPress'],
  [/\bshopify\b|cdn\.shopify/i, 'Shopify'],
  [/\bwix\b|parastorage/i, 'Wix'],
  [/\bcloudflare\b/i, 'Cloudflare'],
  [/\bsentry\b/i, 'Sentry'],
  [/\bstripe\b/i, 'Stripe'],
  [/\bhotjar\b|\bclarity\.ms/i, 'Session recording'],
  [/\bgtm\.js|googletagmanager/i, 'Google Tag Manager'],
  [/google-analytics\.com|\bgtag\/js|\banalytics\.js\b/i, 'Google Analytics'],
  [/connect\.facebook\.net|\bfbevents\.js/i, 'Meta Pixel'],
  [/\brecaptcha\b|challenges\.cloudflare\.com/i, 'Bot protection'],
  [/\bintercom|\bzendesk|\bcrisp\.chat|\btawk\.to/i, 'Support chat'],
  [/\bsegment\.(com|io)|\bmxpnl\b|\bamplitude\b/i, 'Product analytics'],
  [/\bwebpack|chunk\./i, 'webpack'],
  [/\bassets\/index-[A-Za-z0-9_-]{6,}\.js/i, 'Vite'],
  [/\bpolyfill/i, 'polyfills']
];

/** URL'lerden gorulen teknoloji izlerini toplar (kanit tabanli, tahmin degil). */
export function techHints(entries) {
  const hits = new Map();
  for (const entry of entries || []) {
    const url = entry.normalizedUrl || entry.url || '';
    for (const [re, name] of TECH_PATTERNS) {
      if (!re.test(url)) continue;
      if (!hits.has(name)) hits.set(name, url);
    }
  }
  return [...hits].map(([name, evidence]) => ({ name, evidence }));
}

// ---------------------------------------------------------------------------
// Baglam olusturma
// ---------------------------------------------------------------------------

const CAP = { thirdParty: 45, bundles: 30, findings: 60, sources: 100, workers: 12, errors: 15 };

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function kb(bytes) { return `${Math.round((bytes || 0) / 1024)} KB`; }

/**
 * Toplanan veriyi AI'a gonderilecek yogun, kanit-tabanli bir metne cevirir.
 * @param {{pageUrl:string, entries:Array, findings:Array, origins:Array}} data
 * @param {{redact:boolean}} opts
 */
export function buildContext(data, opts = {}) {
  const redact = opts.redact !== false;
  const entries = data.entries || [];
  const findings = data.findings || [];
  const origins = data.origins || [];

  const first = entries.filter((e) => e.party === 'first');
  const third = entries.filter((e) => e.party !== 'first');
  const totalSize = entries.reduce((s, e) => s + (e.size || 0), 0);
  const thirdSize = third.reduce((s, e) => s + (e.size || 0), 0);
  const noSri = third.filter((e) => e.noIntegrity);
  const mixed = entries.filter((e) => e.mixedContent);
  const workers = entries.filter((e) => e.kind === 'worker' || e.kind === 'serviceworker');
  const maps = entries.filter((e) => e.hasSourceMap || e.kind === 'sourcemap');
  const errors = entries.filter((e) => e.error || (e.statusCode && e.statusCode >= 400));
  const inferred = entries.filter((e) => e.confidence === 'inferred');
  const withContent = origins.filter((o) => o.hasContent).length;

  const L = [];
  L.push(`PAGE: ${data.pageUrl || 'unknown'}`);
  L.push(`TOTALS: ${entries.length} scripts | ${first.length} first-party | ${third.length} third-party`
    + ` | ${kb(totalSize)} total (${kb(thirdSize)} third-party)`);
  L.push(`SIGNALS: ${noSri.length} third-party without SRI | ${mixed.length} mixed-content`
    + ` | ${workers.length} worker/service-worker | ${maps.length} source maps`
    + ` | ${errors.length} failed/4xx | ${inferred.length} unverified (Deep Scan inferences)`);

  // Ucuncu taraf envanteri: host + vendor + kac dosya + SRI durumu.
  const byHost = new Map();
  for (const e of third) {
    const host = e.host || hostOf(e.normalizedUrl);
    if (!host) continue;
    const rec = byHost.get(host) || { count: 0, vendor: '', size: 0, noSri: 0 };
    rec.count++;
    rec.size += e.size || 0;
    if (e.noIntegrity) rec.noSri++;
    if (!rec.vendor && e.vendor) rec.vendor = e.vendor;
    byHost.set(host, rec);
  }
  const hostRows = [...byHost].sort((a, b) => b[1].size - a[1].size).slice(0, CAP.thirdParty);
  L.push('', `THIRD-PARTY HOSTS (${byHost.size}):`);
  for (const [host, r] of hostRows) {
    L.push(`  - ${host} — ${r.count} file(s), ${kb(r.size)}${r.vendor ? ', ' + r.vendor : ''}${r.noSri ? `, ${r.noSri} without SRI` : ''}`);
  }
  if (byHost.size > hostRows.length) L.push(`  … and ${byHost.size - hostRows.length} more hosts`);

  // First-party bundle'lar (boyuta gore) — asil saldiri yuzeyi.
  const bundles = first.filter((e) => e.isBundle || (e.size || 0) > 50 * 1024)
    .sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, CAP.bundles);
  if (bundles.length) {
    L.push('', `FIRST-PARTY BUNDLES (largest first):`);
    for (const b of bundles) {
      L.push(`  - ${b.fileName} — ${kb(b.size)}${b.hasSourceMap ? ', source map available' : ''}${b.confidence === 'inferred' ? ', UNVERIFIED' : ''}`);
    }
  }

  const tech = techHints(entries);
  if (tech.length) {
    L.push('', 'TECHNOLOGY TRACES (from URLs — evidence, not confirmation):');
    for (const t of tech) L.push(`  - ${t.name}`);
  }

  if (workers.length) {
    L.push('', `WORKER SCRIPTS (${workers.length}):`);
    for (const w of workers.slice(0, CAP.workers)) {
      L.push(`  - ${w.kind}: ${redact ? w.fileName : w.normalizedUrl}`);
    }
  }

  if (errors.length) {
    L.push('', `FAILED / ERROR RESPONSES (${errors.length}):`);
    for (const e of errors.slice(0, CAP.errors)) {
      L.push(`  - ${e.fileName} — ${e.error || e.statusCode}${e.party === 'first' ? ' (first-party)' : ''}`);
    }
  }

  if (findings.length) {
    const secrets = findings.filter((f) => f.category === 'secret');
    const endpoints = findings.filter((f) => f.category === 'endpoint');
    L.push('', `MINED FINDINGS — ${secrets.length} secret-like, ${endpoints.length} endpoint-like.`);
    L.push('(Secret values are ALREADY MASKED. Confidence is the miner\'s own regex confidence, not a verdict.)');
    for (const f of findings.slice(0, CAP.findings)) {
      const where = redact ? '' : ` | in ${f.file}`;
      L.push(`  - [${f.category}/${f.confidence}] ${f.type}: ${f.value}${where}`);
    }
    if (findings.length > CAP.findings) L.push(`  … and ${findings.length - CAP.findings} more`);
  }

  if (origins.length) {
    L.push('', `RECOVERED SOURCES: ${origins.length} original files from source maps`
      + `${withContent ? `, ${withContent} with full source content embedded` : ''}.`);
    if (!redact) {
      for (const o of origins.slice(0, CAP.sources)) L.push(`  - ${o.path}`);
      if (origins.length > CAP.sources) L.push(`  … and ${origins.length - CAP.sources} more`);
    } else {
      L.push('  (paths withheld — redaction is on)');
    }
  }

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Promptlar
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are a principal application-security engineer supporting an AUTHORIZED assessment.',
  'You receive a passive inventory of a web page\'s JavaScript surface, gathered by a browser extension.',
  '',
  'Rules you must follow:',
  '- Ground every claim in the supplied data. Never invent URLs, endpoints, versions, or secrets.',
  '- Distinguish observation from inference. Say "observed" vs "likely" vs "unverified" explicitly.',
  '- Items marked UNVERIFIED are static-analysis guesses; treat them as leads, not facts.',
  '- Secret values arrive masked. Never ask for or speculate about the unmasked value.',
  '- Regex "confidence" is the miner\'s, not yours — re-judge it yourself and say when it looks like a false positive.',
  '- Prioritise by real impact, not by how many findings exist. Say plainly when something is low risk or normal.',
  '- Recommend only lawful, in-scope actions for an authorized test.',
  '- Be concise and specific. No filler, no restating the data back, no generic security lecture.',
  '',
  'Format: GitHub-flavoured Markdown. Use ## headings, short paragraphs and tight bullets.',
  'When you rate something, use a bold severity label: **Critical**, **High**, **Medium**, **Low**, **Info**.'
].join('\n');

const ANALYSES = {
  surface: {
    label: 'Attack surface',
    instruction: [
      'Write an ATTACK-SURFACE ASSESSMENT of this page.',
      '',
      'Structure:',
      '## Verdict — 2-3 sentences: what this page is built with and where the risk actually concentrates.',
      '## First-party surface — the bundles that matter, what they suggest about the app, source-map exposure.',
      '## Third-party surface — who executes code on this page, what that implies for trust and data.',
      '## Prioritised risks — ranked list, each with a severity label, the evidence from the data, and the impact.',
      '## What I would verify first — 3-5 concrete checks, most valuable first.'
    ].join('\n')
  },
  triage: {
    label: 'Triage findings',
    instruction: [
      'TRIAGE the mined findings. If there are none, say so plainly and stop.',
      '',
      'For each finding worth attention:',
      '- Restate it compactly, with a severity label.',
      '- Judge whether it is likely real or a false positive, and why (pattern shape, location, context).',
      '- State the concrete impact if real.',
      '- Give one specific verification step.',
      '',
      'Then: ## Dismissed — group the ones not worth chasing with a one-line reason each.',
      'Remember client-side keys (e.g. publishable/analytics keys) are often intentionally public — say so when true.'
    ].join('\n')
  },
  thirdparty: {
    label: 'Third-party risk',
    instruction: [
      'Assess THIRD-PARTY / SUPPLY-CHAIN RISK.',
      '',
      '## Inventory — group the hosts by what they actually do (analytics, ads, payments, support, CDN…).',
      '## Trust exposure — which of these can read the DOM, forms, cookies or tokens on this page, and what that means here.',
      '## Weak links — missing SRI, mixed content, unusual or unknown hosts, dead/4xx third-party scripts.',
      '## Hardening — specific, ordered recommendations (CSP directives worth adding, SRI, self-hosting, removal candidates).',
      'Be concrete about which host each recommendation applies to.'
    ].join('\n')
  },
  tech: {
    label: 'Tech fingerprint',
    instruction: [
      'Perform TECHNOLOGY FINGERPRINTING strictly from the evidence.',
      '',
      '## Stack — framework, build tooling, and notable libraries, each with the filename/host that evidences it and a confidence.',
      '## Versions — only where a version is genuinely inferable; otherwise say it is not determinable from this data.',
      '## Worth checking — components that are commonly outdated or have known CVE history, with what to check.',
      'Do not guess versions from hashes. Do not list a technology you cannot point to evidence for.'
    ].join('\n')
  },
  next: {
    label: 'Next steps',
    instruction: [
      'Recommend RECON NEXT STEPS for an authorized tester, ordered by expected value.',
      '',
      'For each step: what to do, which specific host/path/finding from the data it targets, and what it would confirm.',
      'Prefer steps that are cheap and high-signal. Include at least one step that uses the source maps or bundles if they exist.',
      'Keep it to 5-7 steps. End with ## Not worth it — briefly, what looks tempting but is a dead end here.'
    ].join('\n')
  }
};

export function analysisList() {
  return Object.entries(ANALYSES).map(([id, a]) => ({ id, label: a.label }));
}

export function buildMessages(analysis, question, contextText, isFollowUp) {
  const instruction = (analysis === 'freeform' || !ANALYSES[analysis])
    ? (question || 'Analyse the collected JavaScript surface and report anything noteworthy.')
    : ANALYSES[analysis].instruction;

  // Takip sorularinda baglami tekrar gondermeyiz; model onceki mesajlarda gordu.
  const user = isFollowUp
    ? instruction
    : `${instruction}\n\n===== COLLECTED DATA =====\n${contextText}\n===== END DATA =====`;
  return { system: SYSTEM_PROMPT, user };
}

// ---------------------------------------------------------------------------
// Calistirma
// ---------------------------------------------------------------------------

export async function aiConfig() {
  const settings = await getSettings();
  const key = await getApiKey();
  const providerId = detectProvider(key);
  const provider = providerId ? PROVIDERS[providerId] : null;
  const cached = providerId ? await getCachedModel(providerId) : '';
  return { settings, key, providerId, provider, cachedModel: cached };
}

/** Hata govdesinden okunabilir mesaj cikarir. */
async function readError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = (j && j.error && (j.error.message || j.error.code)) || (j && j.message) || '';
  } catch { /* metin degil */ }

  if (res.status === 401 || res.status === 403) return 'Invalid or unauthorized API key.';
  if (res.status === 429) return 'Rate limited or out of quota on your API account.';
  if (res.status >= 500) return `Provider error (${res.status}). Try again shortly.`;
  return detail || `${res.status} ${res.statusText}`;
}

/** Model bulunamadi/desteklenmiyor hatasi mi? -> bir sonraki adaya gec. */
function isModelError(message, status) {
  return status === 404
    || /model|not found|does not exist|unsupported|decommissioned|deprecated/i.test(message || '');
}

async function consumeSSE(res, provider, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const delta = provider.streamDelta(obj);
      if (delta) { full += delta; onDelta(delta); }
    }
  }
  return full;
}

/** Tek bir model adayiyla dener; model hatasinda null doner (yedege gecilir). */
async function attempt({ provider, model, key, system, user, history, maxTokens, onDelta, signal }) {
  const stream = typeof onDelta === 'function';
  const req = provider.request({ model, key, system, user, history, maxTokens, stream });
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal
  });

  if (!res.ok) {
    const message = await readError(res);
    if (isModelError(message, res.status)) return { modelUnavailable: true, message };
    throw new Error(message);
  }

  if (stream && res.body && res.body.getReader) {
    return { text: await consumeSSE(res, provider, onDelta) };
  }
  const json = await res.json();
  return { text: provider.parse(json) };
}

/**
 * Analizi calistirir. Model otomatik secilir; ilk aday calismazsa sirayla
 * digerleri denenir ve calisan model onbellege alinir.
 *
 * @param {{data, analysis, question, history, onDelta, signal}} opts
 * @returns {Promise<{text:string, model:string, provider:string}>}
 */
export async function runAnalysis({ data, analysis, question, history, onDelta, signal } = {}) {
  const { settings, key, providerId, provider, cachedModel } = await aiConfig();
  if (!settings.aiEnabled) throw new Error('AI analysis is off — turn it on in Options.');
  if (!key) throw new Error('No API key set — add one in Options.');
  if (!provider) throw new Error('Unrecognized API key format. Use an Anthropic, OpenAI, Gemini, Groq or OpenRouter key.');

  const isFollowUp = Array.isArray(history) && history.length > 0;
  const contextText = isFollowUp ? '' : buildContext(data, { redact: settings.aiRedact });
  const { system, user } = buildMessages(analysis, question, contextText, isFollowUp);

  // Aday sirasi: onbellekteki calisan model once.
  const candidates = cachedModel
    ? [cachedModel, ...provider.models.filter((m) => m !== cachedModel)]
    : [...provider.models];

  let lastMessage = '';
  for (const model of candidates) {
    const result = await attempt({
      provider, model, key, system, user,
      history: history || [],
      maxTokens: settings.aiMaxTokens || 2000,
      onDelta, signal
    });
    if (result.modelUnavailable) { lastMessage = result.message; continue; }
    if (!result.text) throw new Error('Empty response from provider.');
    if (model !== cachedModel) await setCachedModel(providerId, model);
    return { text: result.text, model, provider: providerId };
  }
  throw new Error(lastMessage || 'No usable model found for this API key.');
}

/** Anahtar dogrulama: kucuk bir istekle anahtari ve modeli test eder. */
export async function testConnection() {
  const { settings, key, providerId, provider, cachedModel } = await aiConfig();
  if (!key) throw new Error('No API key set.');
  if (!provider) throw new Error('Unrecognized API key format.');

  const candidates = cachedModel
    ? [cachedModel, ...provider.models.filter((m) => m !== cachedModel)]
    : [...provider.models];

  let lastMessage = '';
  for (const model of candidates) {
    const result = await attempt({
      provider, model, key,
      system: 'You are a connectivity check.',
      user: 'Reply with the single word: ok',
      history: [],
      maxTokens: settings.aiMaxTokens ? Math.min(16, settings.aiMaxTokens) : 16
    });
    if (result.modelUnavailable) { lastMessage = result.message; continue; }
    await setCachedModel(providerId, model);
    return { provider: provider.label, model };
  }
  throw new Error(lastMessage || 'No usable model found for this API key.');
}
