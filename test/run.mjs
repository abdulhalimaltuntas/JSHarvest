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
  runtime: { lastError: null, id: 'test', sendMessage: () => Promise.resolve(), getURL: (p) => 'chrome-extension://x/' + p },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { get: async () => ({ id: 1, url: 'https://example.com/' }), query: async () => [] },
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

runAll();
