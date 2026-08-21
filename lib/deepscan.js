// lib/deepscan.js
// Opt-in derin tarama. Yalnizca kullanici butona bastiginda calisir.
//
// Amac: DOM veya ag katmaninda hic gorulmemis, bundle icine gomulu chunk
// URL'lerini ortaya cikarmak. Bunun icin first-party JS dosyalari indirilir ve
// icerikleri statik olarak analiz edilir (eval YOK).
//
// UYARI: Bu islem hedef sunucuya ek istek gonderir.

import * as store from './store.js';
import { decorate, JS_PATH_RE, normalizeUrl, registrableDomain, parseUrlSafe } from './classify.js';
import { broadcast } from './messaging.js';
import { parseSourceMap } from './sourcemap.js';
import { mine } from './mine.js';

const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10000;
const MAX_FILES = 80;              // metin olarak indirilecek en fazla dosya (recursion dahil)
const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;
const MAX_HITS_PER_FILE = 300;
const MAX_TOTAL_DISCOVERIES = 2000;
const MAX_SOURCEMAP_FETCHES = 40;
const MAX_HEAD_VERIFICATIONS = 400;
const DEFAULT_MAX_DEPTH = 1;       // recursion derinligi (0 = yalnizca ilk kume)

const DEFAULT_OPTIONS = {
  verify: true,      // kesfedilen chunk'lari HEAD ile dogrula
  recursive: true,   // kesfedilen first-party chunk'lari da tara
  maxDepth: DEFAULT_MAX_DEPTH,
  mine: true,        // sir/endpoint madenciligi
  sources: true      // source map -> orijinal kaynak yollari
};

/** tabId -> { cancelled: boolean } */
const activeScans = new Map();

export function isDeepScanRunning(tabId) {
  return activeScans.has(tabId);
}

export function cancelDeepScan(tabId) {
  const state = activeScans.get(tabId);
  if (state) state.cancelled = true;
}

// ---------------------------------------------------------------------------
// Metin analizi yardimcilari
// ---------------------------------------------------------------------------

const SOURCEMAP_GLOBAL_RE = /[#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/g;
const DYNAMIC_IMPORT_RE = /import\(\s*["'`]([^"'`]+?\.(?:m|c)?js)(\?[^"'`]{0,120})?["'`]\s*\)/g;
const PATH_LITERAL_RE =
  /["'`]((?:https?:\/\/|\/|\.{1,2}\/)[^"'`\s<>()]{1,300}?\.(?:m|c)?js)(\?[^"'`\s<>]{0,120})?["'`]/g;
const PUBLIC_PATH_RE = /\.p\s*=\s*["']([^"']{0,200})["']/;
// Vite: const p="modulepreload",...__vite__mapDeps=(i,m=i.map(i=>d[i]),...) veya
// dogrudan __vite__mapDeps=(i,m=["assets/x.js","assets/y.js"])=>...
const VITE_MAPDEPS_RE = /__vite__mapDeps\s*=\s*\([^)]*?\[([^\]]{0,8000})\]/g;
const STRING_IN_ARRAY_RE = /["'`]([^"'`]{1,300})["'`]/g;
const META_URL_RE = /new\s+URL\(\s*["'`]([^"'`]+?\.(?:m|c)?js)["'`]\s*,\s*import\.meta\.url\s*\)/g;
const SYSTEM_REGISTER_RE = /System\.register\(\s*\[([^\]]{0,4000})\]/g;

/** `+` operatoru ile birlestirilmis ifadeyi ust seviyede parcalara ayirir. */
function splitTopLevelPlus(expr) {
  const parts = [];
  let buffer = '';
  let depth = 0;
  let quote = null;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      buffer += ch;
      if (ch === '\\') {
        buffer += expr[i + 1] || '';
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === '+' && depth === 0) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  parts.push(buffer);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Dis parantezleri ve `||fallback` kuyruklarini temizler. */
function stripWrappers(part) {
  let value = part.trim();
  for (let i = 0; i < 4; i++) {
    if (value.startsWith('(') && value.endsWith(')')) {
      const inner = value.slice(1, -1).trim();
      // Parantez gercekten tum ifadeyi sariyorsa kirp.
      if (balanced(inner)) {
        value = inner;
        continue;
      }
    }
    const orIndex = indexOfTopLevel(value, '||');
    if (orIndex > 0) {
      value = value.slice(0, orIndex).trim();
      continue;
    }
    break;
  }
  return value;
}

function balanced(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function indexOfTopLevel(text, needle) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0 && text.startsWith(needle, i)) return i;
  }
  return -1;
}

function parseStringLiteral(part) {
  const value = part.trim();
  if (value.length < 2) return null;
  const first = value[0];
  if ((first !== '"' && first !== "'" && first !== '`') || value[value.length - 1] !== first) return null;
  const inner = value.slice(1, -1);
  if (inner.includes(first)) return null; // kirilmis literal
  return inner.replace(/\\(.)/g, '$1');
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `{1:"a",2:"b"}[e]` bicimindeki *tek* bir obje literalinden id->deger
 * haritasi cikarir. Ifade tam olarak bu kalibi tasimiyorsa null doner; boylece
 * birden fazla harita iceren birlesik ifadeler yanlislikla tek harita sayilmaz.
 */
function parseIdMap(part, paramName) {
  const value = part.trim();
  if (!value.startsWith('{')) return null;
  const closeBrace = readBalanced(value, 0, '{', '}');
  if (closeBrace === -1) return null;
  const tail = value.slice(closeBrace + 1).trim();
  const tailRe = new RegExp(`^\\[\\s*${escapeRegExp(paramName)}\\s*\\]$`);
  if (!tailRe.test(tail)) return null;
  const body = value.slice(1, closeBrace);
  const map = new Map();
  const pairRe = /(?:"([^"]{1,120})"|'([^']{1,120})'|([\w$]{1,60}))\s*:\s*(?:"([^"]{0,200})"|'([^']{0,200})')/g;
  let match = pairRe.exec(body);
  while (match && map.size < 4000) {
    const key = match[1] ?? match[2] ?? match[3];
    const val = match[4] ?? match[5] ?? '';
    if (key != null) map.set(String(key), val);
    match = pairRe.exec(body);
  }
  return map.size > 0 ? map : null;
}

/** `.u = ...` atamalarinin deger baslangic indekslerini bulur. */
function findPropertyAssignments(code, prop, limit = 6) {
  const positions = [];
  const needle = '.' + prop;
  let index = code.indexOf(needle);
  while (index !== -1 && positions.length < limit) {
    let i = index + needle.length;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === '=' && code[i + 1] !== '=' && code[i - 1] !== '!' && code[i - 1] !== '=') {
      positions.push(i + 1);
    }
    index = code.indexOf(needle, index + needle.length);
  }
  return positions;
}

/**
 * Bir ifadenin bittigi indeksi bulur: ust seviye `;` / `,` veya icinde
 * bulunulan blogun kapanis parantezi (depth negatife dustugu an).
 */
function findExpressionEnd(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i; // kapsayan blok bitti
      depth--;
      continue;
    }
    if (depth === 0 && (ch === ';' || ch === ',')) return i;
  }
  return text.length;
}

function readBalanced(code, start, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * `.u` atamasindan { param, expr } cikarir.
 * Hem `function(e){return "..."+e+"..."}` hem de `e=>"..."+e` bicimini destekler.
 */
function parseChunkUrlFunction(code, valueStart) {
  let i = valueStart;
  while (i < code.length && /\s/.test(code[i])) i++;
  const slice = code.slice(i, i + 12);

  if (slice.startsWith('function')) {
    const parenStart = code.indexOf('(', i);
    if (parenStart === -1) return null;
    const parenEnd = readBalanced(code, parenStart, '(', ')');
    if (parenEnd === -1) return null;
    const param = code.slice(parenStart + 1, parenEnd).trim().split(/[,=]/)[0].trim();
    const braceStart = code.indexOf('{', parenEnd);
    if (braceStart === -1) return null;
    const braceEnd = readBalanced(code, braceStart, '{', '}');
    if (braceEnd === -1) return null;
    const body = code.slice(braceStart + 1, braceEnd);
    const returnIndex = body.indexOf('return');
    if (returnIndex === -1) return null;
    const raw = body.slice(returnIndex + 6).trim();
    const expr = raw.slice(0, findExpressionEnd(raw));
    return { param, expr: expr.trim() };
  }

  // Arrow fonksiyon
  let param = '';
  if (code[i] === '(') {
    const parenEnd = readBalanced(code, i, '(', ')');
    if (parenEnd === -1) return null;
    param = code.slice(i + 1, parenEnd).trim().split(/[,=]/)[0].trim();
    i = parenEnd + 1;
  } else {
    const identMatch = /^[\w$]+/.exec(code.slice(i));
    if (!identMatch) return null;
    param = identMatch[0];
    i += param.length;
  }
  while (i < code.length && /\s/.test(code[i])) i++;
  if (code.slice(i, i + 2) !== '=>') return null;
  i += 2;
  while (i < code.length && /\s/.test(code[i])) i++;

  if (code[i] === '{') {
    const braceEnd = readBalanced(code, i, '{', '}');
    if (braceEnd === -1) return null;
    const body = code.slice(i + 1, braceEnd);
    const returnIndex = body.indexOf('return');
    if (returnIndex === -1) return null;
    const raw = body.slice(returnIndex + 6).trim();
    const expr = raw.slice(0, findExpressionEnd(raw));
    return { param, expr: expr.trim() };
  }

  // Tek satirlik arrow: ifade ust seviye `;` / `,` veya kapsayan blogun
  // kapanisina kadar okunur.
  const rest = code.slice(i, i + 4000);
  return { param, expr: rest.slice(0, findExpressionEnd(rest)).trim() };
}

/**
 * Sablon ifadesini parcalara ayirir. Ic ice parantezli birlesimler
 * (Next.js: `(({1:"a"}[e]||e)+"."+{1:"h"}[e])`) icin ozyinelemeli calisir.
 */
function collectShape(expr, param, shape, depth = 0) {
  const parts = splitTopLevelPlus(expr).map(stripWrappers);
  for (const part of parts) {
    const literal = parseStringLiteral(part);
    if (literal !== null) {
      shape.push({ type: 'literal', value: literal });
      continue;
    }
    if (part === param) {
      shape.push({ type: 'id' });
      continue;
    }
    const map = parseIdMap(part, param);
    if (map) {
      shape.push({ type: 'map', map });
      continue;
    }
    if (depth < 4 && indexOfTopLevel(part, '+') !== -1) {
      collectShape(part, param, shape, depth + 1);
      continue;
    }
    // Cozulemeyen parca: bos string kabul edilir.
    shape.push({ type: 'unknown' });
  }
}

/** Chunk URL sablonundan tum olasi chunk yollarini uretir. */
function buildChunkPaths(template) {
  const { param, expr } = template;
  if (!param || !expr) return [];
  const shape = [];
  collectShape(expr, param, shape);
  const firstMap = shape.find((piece) => piece.type === 'map');
  const idMap = firstMap ? firstMap.map : null;

  if (!idMap) return [];
  const paths = [];
  for (const id of idMap.keys()) {
    let path = '';
    let usable = true;
    for (const piece of shape) {
      if (piece.type === 'literal') path += piece.value;
      else if (piece.type === 'id') path += id;
      else if (piece.type === 'map') {
        const value = piece.map.get(id);
        if (value == null) { usable = false; break; }
        path += value;
      }
    }
    if (usable && path && /\.[mc]?js$/i.test(path)) paths.push(path);
    if (paths.length >= MAX_HITS_PER_FILE) break;
  }
  return paths;
}

/**
 * Webpack `publicPath` bilinmiyorsa (p="auto") chunk yolu bundle'in dizinine
 * gore cozulur; ancak chunk yolunun bas segmentleri dizinin son segmentleriyle
 * ortusuyorsa bu ortusme kirpilir. Ornek: bundle /assets/index.js, chunk
 * "assets/12-aa11.js" -> /assets/12-aa11.js (assets iki kez tekrarlanmaz).
 */
function trimOverlapBase(baseUrl, candidate) {
  const dir = new URL('./', baseUrl);
  const baseSegments = dir.pathname.split('/').filter(Boolean);
  const candidateSegments = candidate.replace(/^\.\//, '').split('/').filter(Boolean);
  const candidateDirs = candidateSegments.slice(0, -1);
  let overlap = 0;
  for (let k = Math.min(baseSegments.length, candidateDirs.length); k > 0; k--) {
    if (baseSegments.slice(-k).join('/') === candidateDirs.slice(0, k).join('/')) {
      overlap = k;
      break;
    }
  }
  if (overlap === 0) return dir.href;
  const trimmed = baseSegments.slice(0, baseSegments.length - overlap);
  return new URL('/' + (trimmed.length ? trimmed.join('/') + '/' : ''), dir).href;
}

function resolveCandidate(candidate, baseUrl, publicPath, isChunk) {
  try {
    if (/^https?:\/\//i.test(candidate)) return new URL(candidate).href;
    if (candidate.startsWith('/')) return new URL(candidate, baseUrl).href;
    if (isChunk && publicPath) {
      const rawBase = /^https?:\/\//i.test(publicPath)
        ? publicPath
        : new URL(publicPath, baseUrl).href;
      const base = rawBase.endsWith('/') ? rawBase : rawBase + '/';
      return new URL(candidate, base).href;
    }
    if (isChunk) return new URL(candidate, trimOverlapBase(baseUrl, candidate)).href;
    // Dinamik import / literal / sourcemap: her zaman dosyanin kendi konumuna gore.
    return new URL(candidate, baseUrl).href;
  } catch {
    return '';
  }
}

/** Tek bir bundle metninden aday URL'leri cikarir. */
export function extractCandidates(code, baseUrl) {
  const found = new Map(); // url -> { kind }
  const publicPathMatch = PUBLIC_PATH_RE.exec(code);
  const publicPath = publicPathMatch ? publicPathMatch[1] : '';

  const add = (candidate, kind, isChunk = false) => {
    if (found.size >= MAX_HITS_PER_FILE) return;
    if (!candidate || candidate.startsWith('data:')) return;
    const resolved = resolveCandidate(candidate, baseUrl, publicPath, isChunk);
    if (!resolved) return;
    if (resolved === baseUrl) return;
    if (kind !== 'sourcemap' && !JS_PATH_RE.test(resolved)) return;
    if (!found.has(resolved)) found.set(resolved, { kind });
    // 'worker' kind'i genel 'script' kaydini ezer (ayni URL baska desende de gecebilir).
    else if (kind === 'worker' && found.get(resolved).kind !== 'worker') {
      found.get(resolved).kind = 'worker';
    }
  };

  // 1) Webpack chunk haritalari
  for (const position of findPropertyAssignments(code, 'u')) {
    const template = parseChunkUrlFunction(code, position);
    if (!template) continue;
    for (const path of buildChunkPaths(template)) add(path, 'script', true);
  }

  // 2) Dinamik import yollari (Vite / Rollup / native ESM)
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  let match = DYNAMIC_IMPORT_RE.exec(code);
  while (match) {
    add(match[1] + (match[2] || ''), 'script');
    match = DYNAMIC_IMPORT_RE.exec(code);
  }

  // 3) Genel yol literalleri
  PATH_LITERAL_RE.lastIndex = 0;
  match = PATH_LITERAL_RE.exec(code);
  while (match) {
    add(match[1] + (match[2] || ''), 'script');
    match = PATH_LITERAL_RE.exec(code);
  }

  // 4) Vite preload dependency dizileri: __vite__mapDeps=(i,m=["assets/a.js",...])
  VITE_MAPDEPS_RE.lastIndex = 0;
  match = VITE_MAPDEPS_RE.exec(code);
  while (match) {
    const arrayBody = match[1];
    let inner;
    STRING_IN_ARRAY_RE.lastIndex = 0;
    while ((inner = STRING_IN_ARRAY_RE.exec(arrayBody)) !== null) {
      // mapDeps yollari base'e (publicPath / site koku) goredir -> chunk cozumu.
      if (/\.[mc]?js$/i.test(inner[1])) add(inner[1], 'script', true);
    }
    match = VITE_MAPDEPS_RE.exec(code);
  }

  // 5) new URL("...", import.meta.url) -> worker / asset URL'leri
  META_URL_RE.lastIndex = 0;
  match = META_URL_RE.exec(code);
  while (match) {
    add(match[1], 'worker');
    match = META_URL_RE.exec(code);
  }

  // 6) SystemJS register bagimliliklari: System.register(["dep-a.js",...], ...)
  SYSTEM_REGISTER_RE.lastIndex = 0;
  match = SYSTEM_REGISTER_RE.exec(code);
  while (match) {
    let inner;
    STRING_IN_ARRAY_RE.lastIndex = 0;
    while ((inner = STRING_IN_ARRAY_RE.exec(match[1])) !== null) {
      if (/\.[mc]?js$/i.test(inner[1])) add(inner[1], 'script');
    }
    match = SYSTEM_REGISTER_RE.exec(code);
  }

  // 7) sourceMappingURL
  SOURCEMAP_GLOBAL_RE.lastIndex = 0;
  match = SOURCEMAP_GLOBAL_RE.exec(code);
  while (match) {
    add(match[1], 'sourcemap');
    match = SOURCEMAP_GLOBAL_RE.exec(code);
  }

  return found;
}

// ---------------------------------------------------------------------------
// Ag islemleri
// ---------------------------------------------------------------------------

async function fetchText(url, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      cache: 'force-cache',
      signal: controller.signal
    });
    if (!response.ok) return '';
    const text = await response.text();
    return text.length > MAX_BYTES_PER_FILE ? text.slice(0, MAX_BYTES_PER_FILE) : text;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function headStatus(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Bir URL'in sayfa ile ayni kayitli alan adinda olup olmadigi (first-party). */
function isFirstParty(url, pageDomain) {
  const parsed = parseUrlSafe(url);
  if (!parsed) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return registrableDomain(parsed.hostname) === pageDomain && !!pageDomain;
}

// ---------------------------------------------------------------------------
// Ana akis
// ---------------------------------------------------------------------------

function selectTargets(entries, pageUrl) {
  const decorated = entries.map((entry) => decorate(entry, pageUrl));
  const targets = decorated.filter((entry) => {
    if (entry.party !== 'first') return false;
    if (entry.scheme !== 'http' && entry.scheme !== 'https') return false;
    if (entry.kind === 'sourcemap') return false;
    return JS_PATH_RE.test(entry.normalizedUrl);
  });
  // Bundle gorunumlu dosyalar once taranir; chunk haritalari orada olur.
  targets.sort((a, b) => {
    if (a.isBundle !== b.isBundle) return a.isBundle ? -1 : 1;
    return (b.size || 0) - (a.size || 0);
  });
  return targets.slice(0, MAX_FILES);
}

/**
 * Deep scan. Kuyruk tabanli, opsiyonel olarak ozyinelemeli.
 *
 * Akis:
 *  1. first-party JS dosyalari indirilir, extractCandidates ile aday URL'ler
 *     cikarilir.
 *  2. Kesfedilen script'ler 'inferred' olarak eklenir; verify acikken HEAD ile
 *     dogrulanip 200 ise 'confirmed'e yukseltilir, 404 ise statusCode isaretlenir.
 *  3. recursive acikken kesfedilen first-party chunk'lar da kuyruga eklenir
 *     (maxDepth'e kadar).
 *  4. sources acikken .map dosyalari indirilip orijinal kaynak yollari cikarilir.
 *  5. mine acikken first-party icerikte sir/endpoint madenciligi yapilir.
 */
export async function runDeepScan(tabId, userOptions) {
  if (activeScans.has(tabId)) return { ok: false, error: 'already running' };
  const options = { ...DEFAULT_OPTIONS, ...(userOptions || {}) };
  const state = { cancelled: false };
  activeScans.set(tabId, state);

  const stats = { done: 0, total: 0, found: 0, findings: 0, sources: 0 };
  const report = () => broadcast({ type: 'deep-scan-progress', tabId, ...stats });

  try {
    const record = await store.getRecord(tabId);
    const pageUrl = record.pageUrl || '';
    const pageParsed = parseUrlSafe(pageUrl);
    const pageDomain = pageParsed ? registrableDomain(pageParsed.hostname) : '';
    const initial = selectTargets(Object.values(record.entries), pageUrl);

    const knownKeys = new Set(Object.keys(record.entries));
    const queuedScan = new Set();     // metin taramasi kuyruguna alinan url'ler
    const queue = [];                 // { url, depth }
    for (const target of initial) {
      queue.push({ url: target.normalizedUrl, depth: 0 });
      queuedScan.add(target.normalizedUrl);
    }
    stats.total = queue.length;
    report();

    if (queue.length === 0) {
      broadcast({ type: 'deep-scan-done', tabId, ...stats, error: '' });
      return { ok: true, ...stats };
    }

    const headQueue = [];             // { url, kind, owner }
    const mapQueue = [];              // { url, owner }
    let discovered = 0;
    let fetchedCount = 0;

    // Bir dosyayi indir, adaylari cikar, kuyruklari besle.
    const processScan = async (item) => {
      if (fetchedCount >= MAX_FILES) return;
      fetchedCount++;
      const code = await fetchText(item.url);
      if (state.cancelled || !code) return;

      // Madencilik (yalnizca first-party icerik zaten indirildi).
      if (options.mine) {
        const found = mine(code, item.url);
        if (found.length > 0) {
          const added = await store.addFindings(tabId, found);
          stats.findings += added;
        }
      }

      const candidates = extractCandidates(code, item.url);
      const additions = [];
      for (const [url, meta] of candidates) {
        const { key } = normalizeUrl(url);
        if (meta.kind === 'sourcemap') {
          if (options.sources && mapQueue.length < MAX_SOURCEMAP_FETCHES && !knownKeys.has(key)) {
            mapQueue.push({ url, owner: item.url });
          }
          continue;
        }
        if (knownKeys.has(key)) continue;
        knownKeys.add(key);
        additions.push({
          url,
          sources: ['discovered'],
          kind: meta.kind === 'worker' ? 'worker' : 'script',
          confidence: 'inferred'
        });
        discovered++;
        if (options.verify && headQueue.length < MAX_HEAD_VERIFICATIONS) {
          headQueue.push({ url, kind: meta.kind });
        }
        if (options.recursive && item.depth < options.maxDepth
            && isFirstParty(url, pageDomain) && !queuedScan.has(url)
            && JS_PATH_RE.test(url)) {
          queuedScan.add(url);
          queue.push({ url, depth: item.depth + 1 });
          stats.total++;
        }
        if (discovered >= MAX_TOTAL_DISCOVERIES) break;
      }
      if (additions.length > 0) {
        await store.addEntries(tabId, additions);
        stats.found += additions.length;
      }
    };

    // Kuyruk tabanli isci havuzu (kuyruk recursion ile buyuyebilir).
    const runScanPool = async () => {
      const worker = async () => {
        while (!state.cancelled) {
          const item = queue.shift();
          if (!item) return;
          await processScan(item);
          stats.done++;
          report();
        }
      };
      const pool = [];
      for (let i = 0; i < CONCURRENCY; i++) pool.push(worker());
      await Promise.all(pool);
    };
    await runScanPool();

    // HEAD dogrulama: inferred chunk'lari confirmed'e yukselt veya statu isaretle.
    if (options.verify && headQueue.length > 0 && !state.cancelled) {
      let hCursor = 0;
      const headWorker = async () => {
        while (hCursor < headQueue.length && !state.cancelled) {
          const item = headQueue[hCursor++];
          const { ok, status } = await headStatus(item.url);
          await store.addEntries(tabId, [{
            url: item.url,
            sources: ['discovered'],
            kind: item.kind === 'worker' ? 'worker' : 'script',
            confidence: ok ? 'confirmed' : 'inferred',
            statusCode: status || null
          }]);
        }
      };
      const hp = [];
      for (let i = 0; i < CONCURRENCY; i++) hp.push(headWorker());
      await Promise.all(hp);
    }

    // Source map'ler: indir, ayristir, orijinal kaynak yollarini cikar.
    if (options.sources && mapQueue.length > 0 && !state.cancelled) {
      let mCursor = 0;
      const mapWorker = async () => {
        while (mCursor < mapQueue.length && !state.cancelled) {
          const item = mapQueue[mCursor++];
          const text = await fetchText(item.url);
          const parsed = text ? parseSourceMap(text, item.url) : { ok: false };
          const exists = parsed.ok;
          await store.addEntries(tabId, [{
            url: item.url,
            sources: ['discovered'],
            kind: 'sourcemap',
            confidence: exists ? 'confirmed' : 'inferred',
            statusCode: exists ? 200 : null,
            mapSourceCount: exists ? parsed.count : null,
            mapHasContent: exists ? parsed.hasContent : null
          }]);
          await store.addEntries(tabId, [{
            url: item.owner,
            sources: ['discovered'],
            hasSourceMap: true,
            sourceMapUrl: item.url,
            confidence: 'confirmed'
          }]);
          if (exists && parsed.sources.length > 0) {
            const origins = parsed.sources.map((s) => ({
              path: s.path,
              hasContent: s.hasContent,
              map: item.url
            }));
            const added = await store.addOrigins(tabId, origins);
            stats.sources += added;
          }
          stats.found++;
          report();
        }
      };
      const mp = [];
      for (let i = 0; i < Math.min(CONCURRENCY, mapQueue.length); i++) mp.push(mapWorker());
      await Promise.all(mp);
    }

    await store.flush();
    broadcast({ type: 'deep-scan-done', tabId, ...stats, cancelled: state.cancelled, error: '' });
    return { ok: true, ...stats };
  } catch (err) {
    await store.flush().catch(() => { /* yoksayilir */ });
    broadcast({
      type: 'deep-scan-done',
      tabId,
      ...stats,
      error: String(err && err.message ? err.message : err)
    });
    return { ok: false, error: String(err) };
  } finally {
    activeScans.delete(tabId);
  }
}
