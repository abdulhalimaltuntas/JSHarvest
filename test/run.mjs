// test/run.mjs
// JSHarvest birim testleri. Chrome/Firefox API'leri stub'lanarak node ile
// calisir: `node test/run.mjs`. Cerceve yok.

import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = (p) => import('file://' + join(root, p));

// --- chrome/browser stub (session + local storage) ---
const session = {};
const local = {};
const changeListeners = [];
globalThis.chrome = {
  runtime: {
    lastError: null,
    id: 'test',
    // Popup'in tam yolunu yurumesi icin mesaj tipine gore gercekci yanit.
    sendMessage: (msg) => {
      const type = msg && msg.type;
      if (type === 'get-tab-data') {
        return Promise.resolve({
          ok: true, pageUrl: 'https://example.com/', updatedAt: 1,
          entries: [{ url: 'https://example.com/a.js', key: 'k1', normalizedUrl: 'https://example.com/a.js', sources: ['network'], statusCode: 200 }],
          findings: [], origins: [], deepScanRunning: false, session: null, authState: 'anon'
        });
      }
      if (type === 'session-list') return Promise.resolve({ ok: true, sessions: [] });
      if (type === 'ai-run-status') return Promise.resolve({ ok: true, run: null });
      return Promise.resolve({ ok: true });
    },
    getURL: (p) => 'chrome-extension://x/' + p,
    openOptionsPage: () => {},
    getPlatformInfo: (cb) => { if (cb) cb({ os: 'linux' }); },
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onSuspend: { addListener: () => {} }
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: {
    get: async () => ({ id: 1, url: 'https://example.com/' }),
    query: async () => [{ id: 1, url: 'https://example.com/' }],
    create: async () => ({}),
    onRemoved: { addListener: () => {} }
  },
  storage: {
    session: {
      get: async (k) => (k === null ? { ...session } : { [k]: session[k] }),
      set: async (o) => { Object.assign(session, o); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete session[k]; }
    },
    local: {
      get: async (k) => (k === null ? { ...local } : { [k]: local[k] }),
      set: async (o) => { Object.assign(local, o); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete local[k]; }
    },
    onChanged: { addListener: (fn) => changeListeners.push(fn) }
  }
};

// --- Minimal DOM stub (yalnizca lib/markdown.js icin) ---
// Gercek bir DOM'un davranisini taklit eder: metin metindir, HTML asla
// ayristirilmaz. Boylece XSS testi anlamli olur.
class StubNode {
  constructor(tag) {
    this.tagName = tag ? tag.toUpperCase() : '';
    this.nodeType = tag ? 1 : 3;
    this.children = [];
    this._text = '';
    this.className = '';
  }
  appendChild(child) {
    if (child && child.__fragment) {
      for (const c of child.children) this.children.push(c);
      return child;
    }
    this.children.push(child);
    return child;
  }
  get textContent() {
    if (this.nodeType === 3) return this._text;
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  _walk(out) {
    for (const c of this.children) {
      if (c.nodeType === 1) { out.push(c); c._walk(out); }
    }
    return out;
  }
  querySelectorAll(sel) {
    const tag = sel.toUpperCase();
    return this._walk([]).filter((n) => n.tagName === tag);
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
globalThis.document = {
  createElement: (tag) => new StubNode(tag),
  createTextNode: (text) => { const n = new StubNode(null); n._text = String(text); return n; },
  createDocumentFragment: () => { const n = new StubNode(null); n.nodeType = 11; n.__fragment = true; return n; }
};

let pass = 0;
let failed = 0;
const check = (name, fn) => {
  Promise.resolve().then(fn).then(
    () => { console.log('  ok  -', name); pass++; },
    (err) => { console.log('  FAIL-', name, '\n       ', err.message); failed++; process.exitCode = 1; }
  );
};
// Seri calistirma icin basit kuyruk.
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
async function runAll() {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('  ok  -', name); pass++; }
    catch (err) { console.log('  FAIL-', name, '\n       ', err.message); failed++; process.exitCode = 1; }
  }
  console.log(`\n${pass} passed, ${failed} failed.`);
}
void check;

const classify = await mod('lib/classify.js');
const store = await mod('lib/store.js');
const sourcemap = await mod('lib/sourcemap.js');
const mine = await mod('lib/mine.js');
const diff = await mod('lib/diff.js');
const exp = await mod('lib/export.js');
const settings = await mod('lib/settings.js');
const history = await mod('lib/history.js');
const deep = await mod('lib/deepscan.js');
const ai = await mod('lib/ai.js');
const md = await mod('lib/markdown.js');
const aiHist = await mod('lib/ai-history.js');
const sess = await mod('lib/sessions.js');
const triage = await mod('lib/triage.js');
const report = await mod('lib/report.js');

// ---------------------------------------------------------------------------
console.log('\n[classify]');

test('SRI/mixed-content turetilmis bayraklar', () => {
  const noSri = classify.decorate({ url: 'https://cdn.other.com/a.js', kind: 'script' }, 'https://shop.com/');
  assert.strictEqual(noSri.noIntegrity, true);
  const withSri = classify.decorate({ url: 'https://cdn.other.com/a.js', kind: 'script', integrity: true }, 'https://shop.com/');
  assert.strictEqual(withSri.noIntegrity, false);
  const mixed = classify.decorate({ url: 'http://shop.com/a.js' }, 'https://shop.com/');
  assert.strictEqual(mixed.mixedContent, true);
});

test('kindLabel', () => {
  assert.strictEqual(classify.kindLabel('serviceworker'), 'service worker');
  assert.strictEqual(classify.kindLabel('worker'), 'worker');
  assert.strictEqual(classify.kindLabel(undefined), 'script');
});

// ---------------------------------------------------------------------------
console.log('\n[store — epoch modeli]');

test('commit onceki sayfayi temizler, yeni-sayfa yarisi yasar', async () => {
  await store.addEntries(10, [{ url: 'https://a.com/old.js', sources: ['network'] }]);
  await store.beginNavigation(10, 'https://a.com/p2');
  await store.addEntries(10, [{ url: 'https://a.com/new.js', sources: ['network'] }]); // yeni epoch
  await store.commitNavigation(10, 'https://a.com/p2');
  const rec = await store.getRecord(10);
  const urls = Object.values(rec.entries).map((e) => e.url);
  assert.deepStrictEqual(urls, ['https://a.com/new.js']);
});

test('onBeforeNavigate kacsa bile commit eski listeyi temizler', async () => {
  await store.addEntries(11, [{ url: 'https://b.com/old.js', sources: ['network'] }]);
  await store.commitNavigation(11, 'https://b.com/p2');
  const rec = await store.getRecord(11);
  assert.strictEqual(Object.keys(rec.entries).length, 0);
});

test('addFindings ve addOrigins deduplike eder', async () => {
  await store.addFindings(12, [{ id: 'x|1|f', type: 'AWS', category: 'secret' }, { id: 'x|1|f', type: 'AWS', category: 'secret' }]);
  await store.addOrigins(12, [{ path: 'src/a.js' }, { path: 'src/a.js' }, { path: 'src/b.js' }]);
  const rec = await store.getRecord(12);
  assert.strictEqual(rec.findings.length, 1);
  assert.strictEqual(rec.origins.length, 2);
});

// ---------------------------------------------------------------------------
console.log('\n[sourcemap]');

test('sources ve webpack:// temizligi + sourcesContent tespiti', () => {
  const map = JSON.stringify({
    version: 3, file: 'main.js',
    sources: ['webpack:///./src/app.js', 'webpack:///./node_modules/x/index.js', 'webpack:///./src/app.js'],
    sourcesContent: ['export const a=1', null]
  });
  const parsed = sourcemap.parseSourceMap(map, 'https://s.com/main.js.map');
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.count, 2); // dedupe
  assert.deepStrictEqual(parsed.sources.map((s) => s.path), ['./src/app.js'.replace('./', ''), 'node_modules/x/index.js']);
  assert.strictEqual(parsed.sources[0].hasContent, true);
  assert.strictEqual(parsed.hasContent, true);
});

test('bozuk JSON guvenli sekilde reddedilir', () => {
  assert.strictEqual(sourcemap.parseSourceMap('{not json', 'x').ok, false);
});

// ---------------------------------------------------------------------------
console.log('\n[mine]');

test('AWS/Google/jenerik sirlar ve maskeleme', () => {
  const code = `var k="AKIAIOSFODNN7EXAMPLE";const g="AIza${'B'.repeat(35)}";api_key='supersecretvalue123'`;
  const found = mine.mine(code, 'https://s.com/app.js');
  const types = found.map((f) => f.type);
  assert.ok(types.includes('AWS Access Key'), types.join());
  assert.ok(types.includes('Google API Key'));
  const aws = found.find((f) => f.type === 'AWS Access Key');
  assert.ok(aws.value.includes('*'), 'sir maskelenmeli: ' + aws.value);
  assert.ok(!aws.value.includes('IOSFODNN7'), 'tam sir gozukmemeli');
});

test('endpoint madenciligi ve gurultu filtresi', () => {
  const code = `fetch("/api/v2/users/list");var s="app.chunk.js";var g="/graphql";`;
  const found = mine.mine(code, 'https://s.com/app.js');
  const values = found.filter((f) => f.category === 'endpoint').map((f) => f.value);
  assert.ok(values.some((v) => v.includes('/api/v2/users/list')), values.join());
  assert.ok(!values.some((v) => v.includes('app.chunk.js')), 'asset gurultusu elenmeli');
});

test('sir SNIPPET icinde de maskelenir (gizlilik regresyonu)', () => {
  const secret = 'AIza' + 'B'.repeat(35);   // desenin bekledigi tam uzunluk
  const code = `fetch("https://api.x/create?key=${secret}")`;
  const found = mine.mine(code, 'https://s.com/app.js').filter((f) => f.category === 'secret');
  assert.ok(found.length > 0, 'sir bulunmali');
  for (const f of found) {
    assert.ok(!f.snippet.includes(secret),
      'ham sir snippet icinde gorunmemeli: ' + f.snippet);
    assert.ok(f.snippet.includes(f.value), 'snippet maskeli degeri icermeli');
  }
});

test('vendor yalnizca ucuncu taraf icin atanir (yanlis marka regresyonu)', () => {
  const own = classify.decorate({ url: 'https://www.youtube.com/s/player/base.js' }, 'https://www.youtube.com/');
  assert.strictEqual(own.vendor, '', 'kendi sitesinde vendor rozeti olmamali');
  const embedded = classify.decorate({ url: 'https://www.youtube.com/iframe_api' }, 'https://blog.com/');
  assert.strictEqual(embedded.vendor, 'YouTube');
  const vimeo = classify.decorate({ url: 'https://player.vimeo.com/api/player.js' }, 'https://blog.com/');
  assert.strictEqual(vimeo.vendor, 'Vimeo', 'Vimeo ve YouTube ayri markalar');
});

test('mine dedupe eder', () => {
  const code = `k="AKIAIOSFODNN7EXAMPLE";k2="AKIAIOSFODNN7EXAMPLE";`;
  const found = mine.mine(code, 'https://s.com/a.js').filter((f) => f.type === 'AWS Access Key');
  assert.strictEqual(found.length, 1);
});

// ---------------------------------------------------------------------------
console.log('\n[diff]');

test('added / removed / changed', () => {
  const prev = [
    { key: 'k1', normalizedUrl: 'https://s.com/a.js', statusCode: 200, size: 100 },
    { key: 'k2', normalizedUrl: 'https://s.com/b.js', statusCode: 200, size: 50 }
  ];
  const curr = [
    { key: 'k1', normalizedUrl: 'https://s.com/a.js', statusCode: 200, size: 100 },       // unchanged
    { key: 'k2', normalizedUrl: 'https://s.com/b.js', statusCode: 200, size: 80 },        // changed (size)
    { key: 'k3', normalizedUrl: 'https://s.com/c.js', statusCode: 200, size: 10 }         // added
  ];
  const d = diff.diffCaptures(prev, curr);
  assert.strictEqual(d.summary.added, 1);
  assert.strictEqual(d.summary.changed, 1);
  assert.strictEqual(d.unchanged, 1);
  assert.strictEqual(d.removed.length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n[export]');

const sample = [
  { url: 'https://s.com/assets/app.4f2a.js?v=1', normalizedUrl: 'https://s.com/assets/app.4f2a.js?v=1', party: 'first', sources: ['network'], statusCode: 200, size: 100, duration: 12 },
  { url: 'https://cdn.other.com/lib.js', normalizedUrl: 'https://cdn.other.com/lib.js', party: 'third', sources: ['dom'], statusCode: 200, size: 50 }
];

test('wordlist benzersiz segmentler + uzantisiz', () => {
  const wl = exp.toWordlist(sample).trim().split('\n');
  assert.ok(wl.includes('assets'));
  assert.ok(wl.includes('app.4f2a.js'));
  assert.ok(wl.includes('app.4f2a'), 'uzantisiz form da olmali');
});

test('curl her URL icin komut', () => {
  const c = exp.toCurl(sample).trim().split('\n');
  assert.strictEqual(c.length, 2);
  assert.ok(c[0].startsWith('curl '));
});

test('HAR gecerli JSON ve log.entries', () => {
  const har = JSON.parse(exp.toHAR(sample, 'https://s.com/'));
  assert.strictEqual(har.log.entries.length, 2);
  assert.strictEqual(har.log.entries[0].request.url, sample[0].normalizedUrl);
});

test('sources tree ve findings csv/md', () => {
  const tree = exp.toSourcesTree([{ path: 'src/a.js' }, { path: 'src/b/c.js' }]);
  assert.ok(tree.includes('src'));
  assert.ok(tree.includes('└──') || tree.includes('├──'));
  const findings = [{ type: 'AWS', category: 'secret', confidence: 'high', value: 'AK***', file: 'x.js', snippet: 'k=AK' }];
  assert.ok(exp.findingsToMarkdown(findings, 'p').includes('## Secrets (1)'));
  assert.ok(exp.findingsToCSV(findings).split('\n')[0].startsWith('type,category'));
});

// ---------------------------------------------------------------------------
console.log('\n[settings + history]');

test('settings varsayilan + guncelleme + deep scan secenekleri', async () => {
  const def = await settings.getSettings();
  assert.strictEqual(def.deepScanVerify, true);
  await settings.updateSettings({ deepScanMine: false, deepScanMaxDepth: 2 });
  const next = await settings.getSettings();
  assert.strictEqual(next.deepScanMine, false);
  const opts = settings.toDeepScanOptions(next);
  assert.strictEqual(opts.mine, false);
  assert.strictEqual(opts.maxDepth, 2);
});

test('history persist on/off + latest snapshot', async () => {
  await settings.updateSettings({ persistHistory: true, historyLimit: 3 });
  const entries = [{ url: 'https://h.com/a.js', key: 'k1', normalizedUrl: 'https://h.com/a.js', statusCode: 200, size: 10 }];
  const saved = await history.saveSnapshot('https://h.com/p', entries);
  assert.strictEqual(saved, true);
  const latest = await history.getLatestSnapshot('https://h.com/p');
  assert.strictEqual(latest.entries.length, 1);
  // Kapaliyken kaydetmez.
  await settings.updateSettings({ persistHistory: false });
  const saved2 = await history.saveSnapshot('https://h.com/p', entries);
  assert.strictEqual(saved2, false);
});

// ---------------------------------------------------------------------------
console.log('\n[deepscan — ek bundler kaliplari]');

test('Vite __vite__mapDeps dizisi', () => {
  const code = `const __vite__mapDeps=(i,m=["assets/chunk-a.js","assets/chunk-b.js"])=>i.map(x=>m[x]);`;
  const urls = [...deep.extractCandidates(code, 'https://v.com/assets/index.js').keys()];
  assert.ok(urls.includes('https://v.com/assets/chunk-a.js'), urls.join('\n'));
  assert.ok(urls.includes('https://v.com/assets/chunk-b.js'));
});

test('new URL(..., import.meta.url) worker', () => {
  const code = `const w=new Worker(new URL("./worker-abc.js",import.meta.url));`;
  const found = deep.extractCandidates(code, 'https://v.com/assets/index.js');
  assert.ok(found.has('https://v.com/assets/worker-abc.js'));
  assert.strictEqual(found.get('https://v.com/assets/worker-abc.js').kind, 'worker');
});

test('SystemJS register bagimliliklari', () => {
  const code = `System.register(["./dep-one.js","./dep-two.js"],function(e){return{}});`;
  const urls = [...deep.extractCandidates(code, 'https://sys.com/app/main.js').keys()];
  assert.ok(urls.includes('https://sys.com/app/dep-one.js'), urls.join('\n'));
});

test('webpack chunk haritasi hala calisiyor (regresyon)', () => {
  const cra = `__webpack_require__.p="/",__webpack_require__.u=function(e){return"static/js/"+e+"."+{179:"b7a4",245:"0d1c"}[e]+".chunk.js"};`;
  const urls = [...deep.extractCandidates(cra, 'https://app.com/static/js/main.js').keys()];
  assert.ok(urls.includes('https://app.com/static/js/179.b7a4.chunk.js'), urls.join('\n'));
});

// ---------------------------------------------------------------------------
console.log('\n[ai — cok saglayicili katman]');

const aiData = {
  pageUrl: 'https://shop.com/checkout',
  entries: [
    classify.decorate({ url: 'https://shop.com/assets/main.abc123.js', kind: 'script' }, 'https://shop.com/'),
    classify.decorate({ url: 'https://www.google-analytics.com/analytics.js', kind: 'script' }, 'https://shop.com/'),
    classify.decorate({ url: 'https://cdn.other.com/lib.js', kind: 'script' }, 'https://shop.com/')
  ],
  findings: [
    { id: '1', type: 'AWS Access Key', category: 'secret', confidence: 'high', value: 'AKIA…******LE', file: 'https://shop.com/assets/main.abc123.js', snippet: 'k=AKIA' },
    { id: '2', type: 'API Path', category: 'endpoint', confidence: 'low', value: '/api/v2/pay', file: 'x', snippet: '"/api/v2/pay"' }
  ],
  origins: [{ path: 'src/checkout/Pay.tsx', hasContent: true }]
};

test('buildContext ozet + maskeli sir + redaksiyon', () => {
  const ctx = ai.buildContext(aiData, { redact: true });
  assert.ok(ctx.includes('PAGE: https://shop.com/checkout'));
  assert.ok(/TOTALS: 3 scripts/.test(ctx), ctx.slice(0, 200));
  assert.ok(ctx.includes('google-analytics.com'), 'ucuncu taraf envanteri');
  assert.ok(ctx.includes('AKIA\u2026******LE'), 'maskeli sir gecmeli');
  assert.ok(!ctx.includes('src/checkout/Pay.tsx'), 'redaksiyon acikken kaynak yollari gizli');
  const raw = ai.buildContext(aiData, { redact: false });
  assert.ok(raw.includes('src/checkout/Pay.tsx'), 'redaksiyon kapaliyken yollar gorunur');
});

test('buildContext risk sinyallerini ve teknoloji izlerini tasir', () => {
  const ctx = ai.buildContext(aiData, { redact: true });
  assert.ok(/SIGNALS:/.test(ctx));
  assert.ok(/without SRI/.test(ctx));
  assert.ok(ctx.includes('Google Tag Manager') || ctx.includes('TECHNOLOGY'), 'tech izleri');
});

test('techHints kanit tabanli tespit', () => {
  const hints = ai.techHints([
    { normalizedUrl: 'https://s.com/_next/static/chunks/main.js' },
    { normalizedUrl: 'https://s.com/js/jquery.min.js' }
  ]).map((h) => h.name);
  assert.ok(hints.includes('Next.js'), hints.join());
  assert.ok(hints.includes('jQuery'), hints.join());
});

test('anahtar bicimden saglayici tespiti', () => {
  assert.strictEqual(ai.detectProvider('sk-ant-api03-xxx'), 'anthropic');
  assert.strictEqual(ai.detectProvider('sk-proj-abc123'), 'openai');
  assert.strictEqual(ai.detectProvider('sk-or-v1-abc'), 'openrouter');
  assert.strictEqual(ai.detectProvider('gsk_abc123'), 'groq');
  assert.strictEqual(ai.detectProvider('AIzaSyABCDEFGHIJKLMNOP'), 'gemini');
  assert.strictEqual(ai.detectProvider('garbage'), '');
  assert.strictEqual(ai.describeKey('sk-ant-x').label, 'Anthropic (Claude)');
  assert.strictEqual(ai.describeKey('garbage').ok, false);
});

test('buildMessages: ilk istek baglam tasir, takip tasimaz', () => {
  const { system, user } = ai.buildMessages('surface', '', 'CTX', false);
  assert.ok(/application-security/i.test(system));
  assert.ok(user.includes('ATTACK-SURFACE'));
  assert.ok(user.includes('CTX'));
  const follow = ai.buildMessages('freeform', 'and the workers?', 'CTX', true);
  assert.strictEqual(follow.user, 'and the workers?');
  assert.ok(!follow.user.includes('CTX'), 'takip sorusunda baglam tekrar gonderilmez');
});

test('Anthropic istek sekli + gecmis', () => {
  const req = ai.PROVIDERS.anthropic.request({
    model: 'claude-sonnet-5', key: 'sk-ant', system: 'S', user: 'U',
    history: [{ role: 'user', content: 'prev' }, { role: 'assistant', content: 'ans' }],
    maxTokens: 100, stream: true
  });
  assert.strictEqual(req.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(req.headers['x-api-key'], 'sk-ant');
  assert.strictEqual(req.body.messages.length, 3);
  assert.strictEqual(req.body.messages[2].content, 'U');
  assert.strictEqual(ai.PROVIDERS.anthropic.parse({ content: [{ text: 'he' }, { text: 'llo' }] }), 'hello');
});

test('OpenAI-uyumlu saglayicilar (openai/groq/openrouter)', () => {
  const o = ai.PROVIDERS.openai.request({ model: 'gpt-4o', key: 'sk', system: 'S', user: 'U', history: [], maxTokens: 50 });
  assert.strictEqual(o.url, 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(o.headers.authorization, 'Bearer sk');
  const g = ai.PROVIDERS.groq.request({ model: 'm', key: 'gsk_x', system: 'S', user: 'U', history: [], maxTokens: 50 });
  assert.ok(g.url.startsWith('https://api.groq.com/openai/v1'), g.url);
  const r = ai.PROVIDERS.openrouter.request({ model: 'm', key: 'sk-or', system: 'S', user: 'U', history: [], maxTokens: 50 });
  assert.ok(r.url.startsWith('https://openrouter.ai/api/v1'), r.url);
  assert.strictEqual(ai.PROVIDERS.openai.streamDelta({ choices: [{ delta: { content: 'z' } }] }), 'z');
});

test('Gemini istek + gecmis rol donusumu', () => {
  const req = ai.PROVIDERS.gemini.request({
    model: 'gemini-2.0-flash', key: 'K', system: 'S', user: 'U',
    history: [{ role: 'assistant', content: 'prev' }], maxTokens: 50, stream: true
  });
  assert.ok(req.url.includes('streamGenerateContent'), req.url);
  assert.ok(req.url.includes('alt=sse'), req.url);
  assert.strictEqual(req.body.contents[0].role, 'model', 'assistant -> model');
  assert.strictEqual(ai.PROVIDERS.gemini.parse({ candidates: [{ content: { parts: [{ text: 'g' }] } }] }), 'g');
});

test('modelsFor saglayici adaylarini dondurur', () => {
  assert.ok(ai.modelsFor('anthropic').length >= 1);
  assert.ok(ai.modelsFor('gemini').includes('gemini-2.0-flash'));
  assert.deepStrictEqual(ai.modelsFor('yok-boyle-saglayici'), []);
});

test('sabitlenen model once denenir, sonra onbellek, sonra varsayilanlar', async () => {
  // Override bos: varsayilan sira korunur
  await settings.updateSettings({ aiModel: '' });
  const auto = await ai.aiConfig();
  assert.strictEqual(auto.override, '');

  // Override doluysa aiConfig bunu tasir
  await settings.updateSettings({ aiModel: 'claude-opus-5' });
  const pinned = await ai.aiConfig();
  assert.strictEqual(pinned.override, 'claude-opus-5');

  // Bosluklar kirpilir
  await settings.updateSettings({ aiModel: '  gpt-4o-mini  ' });
  const trimmed = await ai.aiConfig();
  assert.strictEqual(trimmed.override, 'gpt-4o-mini');

  await settings.updateSettings({ aiModel: '' });
});

test('her saglayicinin aday model listesi var (otomatik yedekleme)', () => {
  for (const [id, p] of Object.entries(ai.PROVIDERS)) {
    assert.ok(Array.isArray(p.models) && p.models.length >= 1, id + ' model adayi yok');
  }
});

test('API anahtari storage.local roundtrip + ayarlardan ayri', async () => {
  await ai.setApiKey('sk-ant-secret-123');
  assert.strictEqual(await ai.getApiKey(), 'sk-ant-secret-123');
  const s = await settings.getSettings();
  assert.ok(!('aiKey' in s), 'ANAHTAR getSettings icinde olmamali — ayri storage.local anahtarinda');
  assert.ok(!('aiProvider' in s), 'saglayici anahtardan tespit edilir, ayarda tutulmaz');
  // Model ise sir degil: istege bagli bir tercih, ayarlarda tutulur.
  assert.ok('aiModel' in s, 'model override alani ayarlarda bulunmali');
  assert.strictEqual(s.aiModel, '', 'varsayilan bos = otomatik sec');
  await ai.setApiKey('');
  assert.strictEqual(await ai.getApiKey(), '');
});

// ---------------------------------------------------------------------------
console.log('\n[markdown — guvenli render]');

test('baslik/liste/kalin/kod dugumleri, HTML enjeksiyonu yok', () => {
  const frag = md.renderMarkdown('## Verdict\n\nUse **SRI** on `gtm.js`.\n\n- one\n- two\n');
  const host = document.createElement('div');
  host.appendChild(frag);
  assert.strictEqual(host.querySelectorAll('h2').length, 1);
  assert.strictEqual(host.querySelectorAll('li').length, 2);
  assert.strictEqual(host.querySelector('strong').textContent, 'SRI');
  assert.strictEqual(host.querySelector('code').textContent, 'gtm.js');
});

test('HTML metin olarak kalir (XSS yok)', () => {
  const frag = md.renderMarkdown('<img src=x onerror=alert(1)> and <b>bold</b>');
  const host = document.createElement('div');
  host.appendChild(frag);
  assert.strictEqual(host.querySelectorAll('img').length, 0, 'img dugumu olusmamali');
  assert.strictEqual(host.querySelectorAll('b').length, 0, 'b dugumu olusmamali');
  assert.ok(host.textContent.includes('<img src=x'), 'ham metin olarak gorunmeli');
});

test('kod blogu ve yatay cizgi', () => {
  const frag = md.renderMarkdown('```\nconst a = 1;\n```\n\n---\n');
  const host = document.createElement('div');
  host.appendChild(frag);
  assert.strictEqual(host.querySelector('pre').textContent, 'const a = 1;');
  assert.strictEqual(host.querySelectorAll('hr').length, 1);
});

// ---------------------------------------------------------------------------
console.log('\n[ai — canli model listesi, hedefli analiz, ozel motorlar]');

test('listModels saglayici yanitini normalize eder ve onbellekler', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        data: [
          { id: 'zzz/late-model', name: 'Late', context_length: 128000, pricing: { prompt: '0.000003', completion: '0.000015' } },
          { id: 'anthropic/claude-sonnet-4.5', name: 'Sonnet 4.5', context_length: 200000 },
          { id: 'x-ai/0x-alpha', name: '0x Alpha', context_length: 256000 }
        ]
      })
    };
  };

  const first = await ai.listModels('openrouter', 'sk-or-v1-test', { force: true });
  assert.strictEqual(first.error, '');
  assert.strictEqual(first.models.length, 3);
  // Bilinen varsayilan basa alinir, gerisi alfabetik
  assert.strictEqual(first.models[0].id, 'anthropic/claude-sonnet-4.5');
  // Saglayicida ne varsa listede: sabit kodlu listede olmayan model de gelir
  assert.ok(first.models.some((m) => m.id === 'x-ai/0x-alpha'), 'stealth model listede olmali');

  // Ikinci cagri onbellekten gelir, ag istegi tekrarlanmaz
  const before = calls.length;
  const second = await ai.listModels('openrouter', 'sk-or-v1-test');
  assert.strictEqual(second.cached, true);
  assert.strictEqual(calls.length, before, 'onbellek varken tekrar istek atilmamali');
  delete globalThis.fetch;
});

test('listModels hata durumunda anlasilir mesaj dondurur', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) });
  const res = await ai.listModels('openai', 'sk-bad', { force: true });
  assert.strictEqual(res.models.length, 0);
  assert.match(res.error, /Invalid or unauthorized/i);
  delete globalThis.fetch;
});

test('searchModels coklu terimle filtreler', () => {
  const models = [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' },
    { id: 'x-ai/0x-alpha', name: '0x Alpha' }
  ];
  assert.strictEqual(ai.searchModels(models, 'claude').length, 1);
  assert.strictEqual(ai.searchModels(models, '0x').length, 1);
  assert.strictEqual(ai.searchModels(models, 'openai mini').length, 1, 'terimlerin hepsi eslesmeli');
  assert.strictEqual(ai.searchModels(models, '').length, 3);
});

test('describeModel baglam ve fiyati okunur yazar', () => {
  const text = ai.describeModel({ id: 'x', context: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } });
  assert.match(text, /200K ctx/);
  assert.match(text, /\$3\.00\/\$15\.00 per 1M/);
  assert.strictEqual(ai.describeModel({ id: 'y' }), '');
});

test('findingPrompt bulguyu tasir ve yanlis-pozitif dengesini soyler', () => {
  const prompt = ai.findingPrompt({
    type: 'Google API Key', category: 'secret', confidence: 'high',
    value: 'AIza…***xE', file: 'https://s.com/app.js', snippet: 'key=AIza…***xE'
  });
  assert.ok(prompt.includes('Google API Key'));
  assert.ok(prompt.includes('AIza…***xE'));
  assert.ok(/false positive/i.test(prompt));
  assert.ok(/public by design/i.test(prompt), 'client-side anahtarlar icin dengeleyici talimat');
});

test('scriptPrompt kod varsa ekler, yoksa bunu soyler', () => {
  const entry = classify.decorate({ url: 'https://cdn.x.com/a.js', kind: 'script', size: 2048 }, 'https://s.com/');
  const withCode = ai.scriptPrompt(entry, 'console.log(1)');
  assert.ok(withCode.includes('CONTENT (truncated)'));
  assert.ok(withCode.includes('console.log(1)'));
  const without = ai.scriptPrompt(entry, '');
  assert.ok(/not retrieved/i.test(without));
  assert.ok(without.includes('third-party'));
});

test('resolveAnalysis yerlesik ve kullanici tanimli motorlari cozer', () => {
  assert.strictEqual(ai.resolveAnalysis('surface').id, 'surface');
  const customs = [{ id: 'c1', label: 'GDPR', instruction: 'Check GDPR exposure.' }];
  const found = ai.resolveAnalysis('custom:c1', customs);
  assert.strictEqual(found.label, 'GDPR');
  assert.strictEqual(found.instruction, 'Check GDPR exposure.');
  assert.strictEqual(ai.resolveAnalysis('custom:yok', customs), null);
  assert.strictEqual(ai.resolveAnalysis('freeform'), null, 'serbest soru bir sablon degildir');
});

test('buildMessages ozel analiz talimatini kullanir', () => {
  const customs = [{ id: 'c9', label: 'X', instruction: 'MY OWN INSTRUCTION' }];
  const { user } = ai.buildMessages('custom:c9', '', 'CTX', false, customs);
  assert.ok(user.startsWith('MY OWN INSTRUCTION'));
  assert.ok(user.includes('CTX'));
});

test('renderSourceSamples kaynak kodunu baglama isler', () => {
  const out = ai.renderSourceSamples([{ path: 'src/pay.ts', code: 'const x = 1;' }]);
  assert.ok(out.includes('RECOVERED SOURCE CODE'));
  assert.ok(out.includes('src/pay.ts'));
  assert.ok(out.includes('const x = 1;'));
  assert.strictEqual(ai.renderSourceSamples([]), '');
});

test('collectSourceSamples map indirip icerigi cikarir, bagimliliklari eler', async () => {
  const map = JSON.stringify({
    version: 3,
    sources: ['webpack:///./src/checkout.ts', 'webpack:///./node_modules/lib/index.js'],
    sourcesContent: ['export const pay = () => {};', 'module.exports = {};']
  });
  globalThis.fetch = async () => ({ ok: true, text: async () => map });
  const samples = await ai.collectSourceSamples([
    { path: 'src/checkout.ts', hasContent: true, map: 'https://s.com/a.js.map' },
    { path: 'node_modules/lib/index.js', hasContent: true, map: 'https://s.com/a.js.map' }
  ]);
  assert.strictEqual(samples.length, 1, 'node_modules elenmeli');
  assert.strictEqual(samples[0].path, 'src/checkout.ts');
  assert.ok(samples[0].code.includes('export const pay'));
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
console.log('\n[ai gecmisi]');

test('analiz kaydedilir, sayfaya gore filtrelenir ve silinir', async () => {
  await aiHist.clearAnalyses();
  await aiHist.saveAnalysis({ pageUrl: 'https://a.com/x', analysis: 'surface', label: 'Attack surface', text: 'AAA', model: 'm1' });
  await aiHist.saveAnalysis({ pageUrl: 'https://b.com/y', analysis: 'triage', label: 'Triage', text: 'BBB', model: 'm2' });

  const all = await aiHist.listAnalyses();
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].text, 'BBB', 'en yeni basta');

  const forA = await aiHist.listForPage('https://a.com/other-page');
  assert.strictEqual(forA.length, 1, 'ayni origin eslesir');
  assert.strictEqual(forA[0].label, 'Attack surface');

  const left = await aiHist.deleteAnalysis(all[0].id);
  assert.strictEqual(left.length, 1);
  await aiHist.clearAnalyses();
  assert.strictEqual((await aiHist.listAnalyses()).length, 0);
});

test('bos metinli analiz kaydedilmez', async () => {
  const res = await aiHist.saveAnalysis({ pageUrl: 'https://a.com', text: '' });
  assert.strictEqual(res, null);
});

// ---------------------------------------------------------------------------
console.log('\n[angajman oturumlari]');

test('kapsam eslesmesi: tam host, joker ve bos kapsam', () => {
  assert.strictEqual(sess.matchesScope('acme.com', ['acme.com']), true);
  assert.strictEqual(sess.matchesScope('www.acme.com', ['acme.com']), false, 'tam host kesin eslesir');
  assert.strictEqual(sess.matchesScope('www.acme.com', ['*.acme.com']), true);
  assert.strictEqual(sess.matchesScope('acme.com', ['*.acme.com']), true, 'joker alan adinin kendisini de kapsar');
  assert.strictEqual(sess.matchesScope('evil-acme.com', ['*.acme.com']), false, 'benzer isim kapsama girmez');
  assert.strictEqual(sess.matchesScope('any.host', []), true, 'bos kapsam = her sey');
  assert.strictEqual(sess.urlInScope('https://api.acme.com/a.js', ['*.acme.com']), true);
  assert.strictEqual(sess.urlInScope('not a url', ['*.acme.com']), false);
});

test('oturum olustur, guncelle, listele, sil', async () => {
  const created = await sess.createSession({ name: 'Acme', scope: ['*.acme.com'] });
  assert.ok(created.id);
  assert.strictEqual(created.name, 'Acme');

  const updated = await sess.updateSession(created.id, { name: 'Acme Q3', scope: [' *.acme.com ', ''] });
  assert.strictEqual(updated.name, 'Acme Q3');
  assert.deepStrictEqual(updated.scope, ['*.acme.com'], 'bosluklar kirpilir, bos girisler elenir');

  const list = await sess.listSessions();
  assert.ok(list.some((x) => x.id === created.id));

  await sess.deleteSession(created.id);
  assert.strictEqual((await sess.listSessions()).some((x) => x.id === created.id), false);
});

test('kayitlar oturuma birikir; sekmeler ve zaman boyunca birlesir', async () => {
  const s1 = await sess.createSession({ name: 'Merge', scope: [] });
  await sess.mergeEntries(s1.id, [
    { url: 'https://acme.com/a.js', sources: ['network'], statusCode: 200 }
  ], { authState: 'anon', pageUrl: 'https://acme.com/p1' });

  // Ayni dosya baska bir sayfada, baska bir katmandan
  await sess.mergeEntries(s1.id, [
    { url: 'https://acme.com/a.js?v=2', sources: ['dom'] },
    { url: 'https://acme.com/b.js', sources: ['network'] }
  ], { authState: 'anon', pageUrl: 'https://acme.com/p2' });

  const data = await sess.getData(s1.id);
  const entries = Object.values(data.entries);
  assert.strictEqual(entries.length, 2, 'cache-buster ayni dosyayi ikiye bolmemeli');
  const a = entries.find((e) => e.normalizedUrl.includes('/a.js'));
  assert.deepStrictEqual([...a.sources].sort(), ['dom', 'network']);
  assert.deepStrictEqual(a.pages, ['https://acme.com/p1', 'https://acme.com/p2'], 'gorulen sayfalar birikir');
  await sess.deleteSession(s1.id);
});

test('auth durumu kaydedilir: yalnizca girisliyken gelen script tespit edilir', async () => {
  const s2 = await sess.createSession({ name: 'Auth', scope: [] });
  await sess.mergeEntries(s2.id, [{ url: 'https://acme.com/public.js', sources: ['network'] }], { authState: 'anon' });
  await sess.mergeEntries(s2.id, [
    { url: 'https://acme.com/public.js', sources: ['network'] },
    { url: 'https://acme.com/admin-panel.js', sources: ['network'] }
  ], { authState: 'auth' });

  const data = await sess.getData(s2.id);
  const pub = data.entries[Object.keys(data.entries).find((k) => k.includes('public'))];
  const admin = data.entries[Object.keys(data.entries).find((k) => k.includes('admin'))];
  assert.deepStrictEqual([...pub.authStates].sort(), ['anon', 'auth']);
  assert.deepStrictEqual(admin.authStates, ['auth'], 'admin script yalnizca girisliyken gorulmus');

  const sum = await sess.summary(s2.id);
  assert.strictEqual(sum.authOnly, 1, 'yalnizca-auth sayaci');
  assert.strictEqual(sum.scripts, 2);
  await sess.deleteSession(s2.id);
});

test('bulgular ve kaynaklar deduplike edilerek birikir, notlar saklanir', async () => {
  const s3 = await sess.createSession({ name: 'Data', scope: [] });
  await sess.mergeFindings(s3.id, [{ id: 'f1', type: 'AWS' }, { id: 'f1', type: 'AWS' }, { id: 'f2', type: 'JWT' }]);
  await sess.mergeOrigins(s3.id, [{ path: 'src/a.ts' }, { path: 'src/a.ts' }]);
  await sess.setNotes(s3.id, 'IDOR suphesi: /v1/internal/export');

  const data = await sess.getData(s3.id);
  assert.strictEqual(data.findings.length, 2);
  assert.strictEqual(data.origins.length, 1);
  assert.ok(data.notes.includes('IDOR'));
  await sess.deleteSession(s3.id);
});

test('findSessionForUrl yalnizca autoAttach + kapsami olan oturumu doner', async () => {
  const off = await sess.createSession({ name: 'Off', scope: ['*.target.com'], autoAttach: false });
  assert.strictEqual(await sess.findSessionForUrl('https://x.target.com/'), null, 'autoAttach kapali');
  const on = await sess.createSession({ name: 'On', scope: ['*.target.com'], autoAttach: true });
  const found = await sess.findSessionForUrl('https://x.target.com/');
  assert.strictEqual(found && found.id, on.id);
  assert.strictEqual(await sess.findSessionForUrl('https://other.com/'), null, 'kapsam disi');
  await sess.deleteSession(off.id);
  await sess.deleteSession(on.id);
});

// ---------------------------------------------------------------------------
console.log('\n[triyaj]');

test('durum atanir, kaldirilir ve origin bazli izole kalir', async () => {
  await triage.setState('https://a.com/page', 'k1', 'interesting');
  await triage.setState('https://a.com/other', 'k2', 'reviewed');
  await triage.setState('https://b.com/page', 'k1', 'ignored');

  const a = await triage.getTriage('https://a.com/anything');
  assert.strictEqual(a.k1, 'interesting');
  assert.strictEqual(a.k2, 'reviewed', 'ayni origin, farkli sayfa -> ayni kova');

  const b = await triage.getTriage('https://b.com/');
  assert.strictEqual(b.k1, 'ignored');
  assert.strictEqual(b.k2, undefined, 'origin"ler birbirine karismaz');

  await triage.setState('https://a.com/page', 'k1', 'new');
  const cleared = await triage.getTriage('https://a.com/');
  assert.strictEqual(cleared.k1, undefined, '"new" isareti kaldirir');

  await triage.clearTriage('https://a.com/');
  await triage.clearTriage('https://b.com/');
});

test('countStates dagilimi verir', () => {
  const entries = [{ key: 'k1' }, { key: 'k2' }, { key: 'k3' }];
  const counts = triage.countStates(entries, { k1: 'reviewed', k2: 'interesting' });
  assert.deepStrictEqual(counts, { new: 1, reviewed: 1, interesting: 1, ignored: 0 });
});

// ---------------------------------------------------------------------------
console.log('\n[angajman raporu]');

const reportInput = {
  session: { id: 's1', name: 'Acme Q3', scope: ['*.acme.com'] },
  pageUrl: 'https://acme.com/',
  entries: [
    { url: 'https://acme.com/app.js', normalizedUrl: 'https://acme.com/app.js', key: 'k1',
      sources: ['network'], statusCode: 200, size: 4096, authStates: ['anon', 'auth'], pages: ['https://acme.com/'] },
    { url: 'https://acme.com/admin.js', normalizedUrl: 'https://acme.com/admin.js', key: 'k2',
      sources: ['network'], statusCode: 200, size: 2048, authStates: ['auth'], pages: ['https://acme.com/panel'] },
    { url: 'https://cdn.other.com/t.js', normalizedUrl: 'https://cdn.other.com/t.js', key: 'k3',
      sources: ['dom'], statusCode: 200, kind: 'script', authStates: ['anon'], pages: ['https://acme.com/'] }
  ],
  findings: [{ id: 'f1', type: 'AWS Access Key', category: 'secret', confidence: 'high', value: 'AKIA…**LE', file: 'https://acme.com/app.js' }],
  origins: [{ path: 'src/pay.ts' }, { path: 'src/ui/button.ts' }],
  notes: 'IDOR suspected on /v1/export',
  triage: { k2: 'interesting', k3: 'ignored' },
  analyses: [{ label: 'Attack surface', model: 'm1', at: Date.now(), text: 'Looks fine.' }]
};

test('HTML rapor tum bolumleri icerir ve tek dosyadir', () => {
  const html = report.buildSessionReport(reportInput);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('Acme Q3'));
  assert.ok(html.includes('*.acme.com'), 'kapsam yazilmali');
  assert.ok(html.includes('IDOR suspected'), 'notlar');
  assert.ok(html.includes('AWS Access Key'), 'bulgular');
  assert.ok(html.includes('Only seen while authenticated'), 'auth-only bolumu');
  assert.ok(html.includes('admin.js'));
  assert.ok(html.includes('Recovered sources (2)'), 'kaynak bolumu basligi');
  assert.ok(html.includes('pay.ts') && html.includes('└──'), 'agac hiyerarsi olarak cizilir');
  assert.ok(html.includes('Attack surface'), 'AI analizleri');
  // Harici kaynak olmamali — tek dosya calismali
  assert.ok(!/<script\b/i.test(html), 'raporda script olmamali');
  assert.ok(!/https?:\/\/(cdn|fonts|unpkg)/.test(html.replace(/https:\/\/(acme|cdn\.other)\.com/g, '')), 'harici varlik yok');
});

test('rapor kullanici verisini kacisla gomer (HTML enjeksiyonu yok)', () => {
  const html = report.buildSessionReport({
    ...reportInput,
    session: { name: '<img src=x onerror=alert(1)>', scope: [] },
    notes: '</pre><script>alert(2)</script>'
  });
  assert.ok(!html.includes('<img src=x'), 'ham HTML gecmemeli');
  assert.ok(html.includes('&lt;img src=x'), 'kacisli gorunmeli');
  assert.ok(!html.includes('<script>alert(2)'), 'script enjeksiyonu engellenmeli');
});

test('JSON disa aktarim tasinabilir ve tam', () => {
  const parsed = JSON.parse(report.buildSessionJson(reportInput));
  assert.strictEqual(parsed.kind, 'engagement');
  assert.strictEqual(parsed.session.name, 'Acme Q3');
  assert.strictEqual(parsed.entries.length, 3);
  assert.strictEqual(parsed.findings.length, 1);
  assert.strictEqual(parsed.triage.k2, 'interesting');
  assert.ok(parsed.exportedAt);
});

test('bos angajman raporu da gecerli uretir', () => {
  const html = report.buildSessionReport({ session: { name: 'Empty', scope: [] } });
  assert.ok(html.includes('Empty'));
  assert.ok(html.includes('Inventory (0)'));
});

// ---------------------------------------------------------------------------
console.log('\n[ai calisma dayanikliligi]');

test('istek gonderildigi anda gecmise yazilir (metin bos olsa da)', async () => {
  await aiHist.clearAnalyses();
  const started = await aiHist.saveAnalysis({
    pageUrl: 'https://acme.com/', analysis: 'surface', label: 'Attack surface',
    question: '', text: '', status: 'running'
  });
  assert.ok(started, 'calisma kaydi bos metinle de olusmali');
  assert.strictEqual(started.status, 'running');

  const list = await aiHist.listAnalyses();
  assert.strictEqual(list.length, 1, 'popup kapansa bile ne istendigi kayitli');
  await aiHist.clearAnalyses();
});

test('bos metinli TAMAMLANMIS kayit yine de reddedilir', async () => {
  const res = await aiHist.saveAnalysis({ pageUrl: 'https://a.com', text: '', status: 'done' });
  assert.strictEqual(res, null);
});

test('calisma bitince ayni kayit tamamlanir, yenisi acilmaz', async () => {
  await aiHist.clearAnalyses();
  const started = await aiHist.saveAnalysis({
    pageUrl: 'https://acme.com/', analysis: 'triage', label: 'Triage', text: '', status: 'running'
  });
  const done = await aiHist.updateAnalysis(started.id, {
    text: 'Final answer.', model: 'm1', provider: 'anthropic', status: 'done'
  });
  assert.strictEqual(done.id, started.id, 'ayni kayit guncellenir');
  assert.strictEqual(done.text, 'Final answer.');
  assert.strictEqual(done.status, 'done');

  const list = await aiHist.listAnalyses();
  assert.strictEqual(list.length, 1, 'tek kayit kalmali');
  await aiHist.clearAnalyses();
});

test('worker olurse yarim kalan kayit "interrupted" olur, "running" kalmaz', async () => {
  await aiHist.clearAnalyses();
  const a = await aiHist.saveAnalysis({ pageUrl: 'https://a.com/', analysis: 'surface', text: '', status: 'running' });
  const b = await aiHist.saveAnalysis({ pageUrl: 'https://a.com/', analysis: 'tech', text: '', status: 'running' });

  // b hala calisiyor, a degil
  await aiHist.markOrphansInterrupted([b.id]);

  const list = await aiHist.listAnalyses();
  const after = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.strictEqual(after[a.id].status, 'interrupted', 'sahipsiz kayit interrupted olur');
  assert.ok(after[a.id].error, 'sebep yazilir');
  assert.strictEqual(after[b.id].status, 'running', 'devam eden kayda dokunulmaz');
  await aiHist.clearAnalyses();
});

test('hata durumu kaydedilir ve kismi metin korunur', async () => {
  await aiHist.clearAnalyses();
  const started = await aiHist.saveAnalysis({ pageUrl: 'https://a.com/', analysis: 'next', text: '', status: 'running' });
  await aiHist.updateAnalysis(started.id, { text: 'partial…', status: 'error', error: 'Rate limited' });
  const [rec] = await aiHist.listAnalyses();
  assert.strictEqual(rec.status, 'error');
  assert.strictEqual(rec.error, 'Rate limited');
  assert.strictEqual(rec.text, 'partial…', 'kismi cikti kaybolmaz');
  await aiHist.clearAnalyses();
});

// ---------------------------------------------------------------------------
console.log('\n[popup — yuklenme duman testi]');

// Bu test bir regresyondan dogdu: bir duzenleme popup.js'ten 16 fonksiyonu
// sildi. Sozdizimi gecerli kaldigi icin `node --check` yakalamadi; arayuz
// "Reading collected scripts…" ekraninda kilitlendi. Modulu gercekten
// calistirmak bu sinif hatayi (tanimsiz referans) yakalar.
test('popup.js tanimsiz referans olmadan yuklenir ve baslar', async () => {
  const listeners = [];
  const el = () => {
    const node = {
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      dataset: {}, style: {}, hidden: false, value: '', placeholder: '',
      textContent: '', title: '', disabled: false, scrollTop: 0, clientHeight: 400,
      addEventListener: (t, fn) => listeners.push([t, fn]),
      removeEventListener() {}, appendChild: (c) => c, removeChild() {}, remove() {},
      setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
      querySelector: () => el(), querySelectorAll: () => [],
      closest: () => null, focus() {}, select() {}, click() {},
      getBoundingClientRect: () => ({ width: 100, height: 100, top: 0, left: 0 }),
      insertBefore: (c) => c, contains: () => false
    };
    return node;
  };

  const prevDocument = globalThis.document;
  globalThis.document = {
    getElementById: () => el(),
    querySelector: () => el(),
    querySelectorAll: () => [],
    createElement: () => el(),
    createTextNode: () => el(),
    createDocumentFragment: () => el(),
    addEventListener: (t, fn) => listeners.push([t, fn]),
    body: el()
  };
  globalThis.window = {
    addEventListener: (t, fn) => listeners.push([t, fn]),
    innerWidth: 500, innerHeight: 596,
    getSelection: () => ''
  };
  // Node'da globalThis.navigator salt-okunurdur; gecici olarak tanimla.
  const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true, writable: true
  });

  // popup init() bir yoklama zamanlayicisi baslatir; test sonunda Node'un
  // acik kalmamasi icin zamanlayicilari yakalayip temizliyoruz.
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { const t = realSetInterval(fn, ms); timers.push(t); return t; };

  let failure = null;
  const prevUnhandled = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (err) => { failure = err; });

  try {
    // Cache-buster: ayni modul iki kez yuklenmesin diye tek sefer calisir.
    await mod('popup/popup.js');
    // Modul sonunda init() cagrilir; asenkron zincirin bitmesini bekle.
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    process.removeAllListeners('unhandledRejection');
    for (const fn of prevUnhandled) process.on('unhandledRejection', fn);
    for (const t of timers) clearInterval(t);
    globalThis.setInterval = realSetInterval;
    globalThis.document = prevDocument;
    delete globalThis.window;
    if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
    else delete globalThis.navigator;
  }

  if (failure) throw new Error('popup baslatilirken hata: ' + (failure.message || failure));
  assert.ok(listeners.length > 10, 'olay dinleyicileri baglanmis olmali');
});

// ---------------------------------------------------------------------------
console.log('\n[ai — script icerigi baglami]');

const codeEntries = [
  classify.decorate({ url: 'https://acme.com/static/main.abc123.js', size: 200000 }, 'https://acme.com/'),
  classify.decorate({ url: 'https://acme.com/static/small.js', size: 500 }, 'https://acme.com/'),
  classify.decorate({ url: 'https://cdn.other.com/jquery.min.js', size: 90000 }, 'https://acme.com/'),
  classify.decorate({ url: 'https://cdn.other.com/widget.js', size: 9000 }, 'https://acme.com/'),
  classify.decorate({ url: 'https://acme.com/app.js.map', kind: 'sourcemap' }, 'https://acme.com/')
];

test('hedef secimi: first-party once, bundle once, kutuphaneler ve map elenir', () => {
  const picked = ai.selectCodeTargets(codeEntries, { thirdParty: false }).map((e) => e.fileName);
  assert.ok(picked.includes('main.abc123.js'));
  assert.ok(picked.includes('small.js'));
  assert.ok(!picked.some((f) => f.includes('jquery')), 'bilinen kutuphane elenmeli');
  assert.ok(!picked.some((f) => f.endsWith('.map')), 'source map kod degil');
  assert.ok(!picked.includes('widget.js'), 'ucuncu taraf varsayilan olarak disarda');
  assert.strictEqual(picked[0], 'main.abc123.js', 'bundle basta');

  const withThird = ai.selectCodeTargets(codeEntries, { thirdParty: true }).map((e) => e.fileName);
  assert.ok(withThird.includes('widget.js'), 'acikca istenirse ucuncu taraf da gelir');
});

test('kod indirme butceyi asmaz ve dosya basina kirpar', async () => {
  const big = 'A'.repeat(50000);
  globalThis.fetch = async () => ({ ok: true, text: async () => big });

  const res = await ai.collectScriptCode(codeEntries, { budget: 30000, perFile: 20000, thirdParty: false });
  assert.ok(res.budgetUsed <= 30000, 'toplam butce asilmamali: ' + res.budgetUsed);
  for (const sample of res.samples) {
    assert.ok(sample.code.length <= 20000, 'dosya basina sinir');
    assert.strictEqual(sample.truncated, true, 'kirpildi olarak isaretlenmeli');
  }
  delete globalThis.fetch;
});

test('butce sifirsa hicbir istek atilmaz', async () => {
  let called = 0;
  globalThis.fetch = async () => { called++; return { ok: true, text: async () => 'x' }; };
  const res = await ai.collectScriptCode(codeEntries, { budget: 0 });
  assert.strictEqual(res.samples.length, 0);
  assert.strictEqual(called, 0, 'butce yoksa ag trafigi de yok');
  delete globalThis.fetch;
});

test('renderScriptCode kodu ve kirpma bilgisini baglama yazar', () => {
  const out = ai.renderScriptCode([
    { url: 'https://acme.com/a.js', code: 'el.innerHTML=location.hash', truncated: true, size: 9999, party: 'first' }
  ]);
  assert.ok(out.includes('SCRIPT SOURCE'));
  assert.ok(out.includes('el.innerHTML=location.hash'), 'kodun kendisi gecmeli');
  assert.ok(out.includes('first-party'));
  assert.ok(out.includes('truncated from 9999'), 'kirpildigi soylenmeli');
  assert.strictEqual(ai.renderScriptCode([]), '');
});

test('DOM sink analizi tanimli ve kod yoksa uydurmamasi soylenmis', () => {
  const resolved = ai.resolveAnalysis('domxss');
  assert.strictEqual(resolved.label, 'DOM sinks');
  assert.ok(/innerHTML/.test(resolved.instruction));
  assert.ok(/location\.hash/.test(resolved.instruction));
  assert.ok(/do not speculate from filenames/i.test(resolved.instruction), 'kod yoksa tahmin yasak');
  assert.ok(/sink alone is not a finding/i.test(resolved.instruction), 'yanlis pozitif dengesi');
});

runAll();
