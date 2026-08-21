// lib/classify.js
// URL normalizasyonu, dedupe anahtari uretimi, taraf (first/third-party),
// vendor ve bundle sinifllandirmasi. Harici bagimlilik yok; hem service worker
// hem de popup tarafindan import edilir.

/** JS uzantisi tespiti (.js / .mjs / .cjs, query veya hash ile birlikte). */
export const JS_PATH_RE = /\.(?:m|c)?js(?:[?#]|$)/i;

/** JS MIME tipleri. */
export const JS_MIME_RE = /(?:application|text)\/(?:x-)?(?:java|ecma)script|\/module|text\/babel/i;

/** sourceMappingURL yorum satiri. */
export const SOURCEMAP_RE = /[#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/;

/**
 * Basit public-suffix yaklasimi. Tam PSL kutuphanesi eklemek yerine en yaygin
 * cok parcali son ekler ve populer barindirma alan adlari elle listelenir.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'bel.tr', 'k12.tr',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.mx', 'com.ar',
  'com.co', 'com.pe', 'com.ve', 'com.ec', 'com.uy',
  'co.in', 'co.kr', 'co.nz', 'co.za', 'co.il', 'co.id', 'co.th',
  'com.sg', 'com.hk', 'com.tw', 'com.my', 'com.ph', 'com.vn',
  'com.sa', 'com.eg', 'com.ua', 'com.pl', 'com.es', 'com.ru', 'com.pk',
  'com.ng', 'com.gh', 'com.bd', 'com.np', 'com.qa', 'com.kw',
  // Barindirma alan adlari: alt alan adlari farkli sahiplere ait oldugundan
  // eTLD+1 hesabinda ayni sekilde ele alinir.
  'github.io', 'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'cloudfront.net', 'amazonaws.com', 'azurewebsites.net',
  'web.app', 'firebaseapp.com', 'workers.dev', 'appspot.com', 'onrender.com'
]);

/** Bilinen ucuncu taraf saglayicilar. Sira onemlidir; ilk eslesen kazanir. */
const VENDOR_PATTERNS = [
  { name: 'Google Tag Manager', re: /googletagmanager\.com/i },
  { name: 'Google Analytics', re: /google-analytics\.com|\/(?:ga|analytics)\.js|gtag\/js/i },
  { name: 'Google Ads', re: /googlesyndication\.com|doubleclick\.net|googleadservices\.com/i },
  { name: 'reCAPTCHA', re: /google\.com\/recaptcha|gstatic\.com\/recaptcha/i },
  { name: 'Google APIs', re: /apis\.google\.com|ajax\.googleapis\.com/i },
  { name: 'Facebook', re: /connect\.facebook\.net|facebook\.net\/.*\/sdk/i },
  { name: 'TikTok', re: /analytics\.tiktok\.com|tiktokcdn\.com/i },
  { name: 'LinkedIn', re: /snap\.licdn\.com|linkedin\.com\/.*\.js/i },
  { name: 'X / Twitter', re: /platform\.twitter\.com|static\.ads-twitter\.com|analytics\.twitter\.com/i },
  { name: 'Hotjar', re: /hotjar\.(?:com|io)/i },
  { name: 'Sentry', re: /sentry[-.](?:cdn|io)|browser\.sentry|\bsentry\.min\.js/i },
  { name: 'Datadog', re: /datadoghq[-.](?:com|browser-agent|eu)|datadog-rum/i },
  { name: 'New Relic', re: /newrelic\.com|nr-data\.net|\bnreum/i },
  { name: 'Cloudflare Insights', re: /cloudflareinsights\.com/i },
  { name: 'Cloudflare Turnstile', re: /challenges\.cloudflare\.com/i },
  { name: 'cdnjs', re: /cdnjs\.cloudflare\.com/i },
  { name: 'jsDelivr', re: /cdn\.jsdelivr\.net/i },
  { name: 'unpkg', re: /unpkg\.com/i },
  { name: 'esm.sh', re: /cdn\.skypack\.dev|esm\.sh/i },
  { name: 'jQuery', re: /code\.jquery\.com|\bjquery(?:[-.][\w.]+)?(?:\.min)?\.js/i },
  { name: 'Segment', re: /cdn\.segment\.(?:com|io)/i },
  { name: 'Amplitude', re: /amplitude\.com|cdn\.amplitude/i },
  { name: 'Mixpanel', re: /cdn\.mxpnl\.com|mixpanel/i },
  { name: 'Intercom', re: /intercomcdn\.com|widget\.intercom\.io/i },
  { name: 'HubSpot', re: /hs-scripts\.com|hsappstatic\.net|hubspot\.com/i },
  { name: 'Stripe', re: /js\.stripe\.com/i },
  { name: 'PayPal', re: /paypal(?:objects)?\.com/i },
  { name: 'Microsoft Clarity', re: /clarity\.ms/i },
  { name: 'Yandex Metrica', re: /mc\.yandex\.(?:ru|com)/i },
  { name: 'Optimizely', re: /optimizely\.com/i },
  { name: 'Adobe', re: /use\.typekit\.net|adobedtm\.com|omtrdc\.net/i },
  { name: 'Zendesk', re: /zdassets\.com|zendesk\.com/i },
  { name: 'Live chat', re: /client\.crisp\.chat|tawk\.to/i },
  { name: 'YouTube', re: /youtube\.com\/(?:s|iframe_api)|ytimg\.com/i },
  { name: 'Vimeo', re: /player\.vimeo\.com/i }
];

/** Bundler ciktisi gorunumundeki dosya adlari. */
const BUNDLE_NAME_RE =
  /(?:^|[/._-])(?:chunk|chunks|vendors?|runtime|polyfills?|framework|main|app|bundle|entry|commons?|manifest)(?:[._-]|\.[mc]?js)/i;

/** Ic ice hash iceren dosya adlari: main.4f2a91c3.js, index-Bc12Xz.js gibi. */
const HASHED_NAME_RE = /[.\-_][0-9a-f]{8,}\.[mc]?js/i;
const HASHED_NAME_B64_RE = /[.\-_][A-Za-z0-9_-]{8,}\.[mc]?js$/;

/** URL'i guvenli sekilde parse eder; basarisizsa null doner. */
export function parseUrlSafe(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * URL'i normalize eder.
 * - hash fragment atilir
 * - `normalized` alaninda query korunur (cache-buster bilgisi kaybolmasin)
 * - dedupe anahtari yalnizca origin + pathname uzerinden uretilir
 */
export function normalizeUrl(raw) {
  const url = String(raw || '');
  const parsed = parseUrlSafe(url);
  if (!parsed) {
    return { key: url.slice(0, 512), normalized: url, scheme: 'other', host: '', pathname: url, search: '' };
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (scheme === 'blob' || scheme === 'data') {
    // blob:/data: URL'lerinde pathname anlamli degil; ham deger anahtar olur.
    return { key: url.slice(0, 512), normalized: url, scheme, host: '', pathname: '', search: '' };
  }
  const normalized = parsed.origin + parsed.pathname + parsed.search;
  return {
    key: (parsed.origin + parsed.pathname).toLowerCase(),
    normalized,
    scheme,
    host: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search
  };
}

/** eTLD+1 seviyesinde kayitli alan adini dondurur. */
export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return '';
  if (/^\[?[0-9a-f:.]+\]?$/i.test(h) && /[:.]/.test(h) && /^\d|^\[/.test(h)) return h; // IP adresleri
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/** URL icin bilinen saglayici adini dondurur, yoksa bos string. */
export function detectVendor(url) {
  for (const pattern of VENDOR_PATTERNS) {
    if (pattern.re.test(url)) return pattern.name;
  }
  return '';
}

/** Dosya adinin bundler ciktisi gibi gorunup gorunmedigini soyler. */
export function isBundlePath(pathname) {
  const p = String(pathname || '');
  const fileName = p.split('/').pop() || '';
  return BUNDLE_NAME_RE.test(p) || HASHED_NAME_RE.test(fileName) || HASHED_NAME_B64_RE.test(fileName);
}

/** URL veya MIME bilgisinden JS olup olmadigina karar verir. */
export function looksLikeJs(url, { type, contentType } = {}) {
  if (type === 'script') return true;
  if (contentType && JS_MIME_RE.test(contentType)) return true;
  const parsed = parseUrlSafe(url);
  const target = parsed ? parsed.pathname + parsed.search : String(url || '');
  return JS_PATH_RE.test(target);
}

/**
 * Depolanmis ham kaydi UI icin zenginlestirir. Girdi mutasyona ugramaz;
 * yeni bir nesne dondurulur.
 */
export function decorate(entry, pageUrl) {
  const info = normalizeUrl(entry.url);
  const pageParsed = parseUrlSafe(pageUrl || '');
  const pageDomain = pageParsed ? registrableDomain(pageParsed.hostname) : '';
  const entryDomain = registrableDomain(info.host);
  const isSpecialScheme = info.scheme === 'blob' || info.scheme === 'data';
  const party = isSpecialScheme
    ? 'first'
    : (entryDomain && pageDomain && entryDomain === pageDomain ? 'first' : 'third');
  const fileName = isSpecialScheme
    ? `${info.scheme}:…${info.normalized.slice(-24)}`
    : (info.pathname.split('/').filter(Boolean).pop() || '/');
  const dirPath = isSpecialScheme
    ? info.scheme + ':'
    : info.host + info.pathname.slice(0, info.pathname.length - fileName.length);

  const decorated = {
    ...entry,
    normalizedUrl: info.normalized,
    key: entry.key || info.key,
    scheme: info.scheme,
    host: info.host,
    fileName,
    dirPath,
    party,
    // Vendor yalnizca UCUNCU TARAF icin: youtube.com'da YouTube rozeti gurultudur
    // ve yanlis marka atfina yol acar.
    vendor: (isSpecialScheme || party === 'first') ? '' : detectVendor(entry.url),
    isBundle: !isSpecialScheme && isBundlePath(info.pathname)
  };

  // Turetilmis guvenlik bayraklari.
  // Bir ucuncu-taraf script'in integrity (SRI) niteligi yoksa bu bir zayifliktir.
  decorated.noIntegrity = party === 'third'
    && (entry.kind || 'script') === 'script'
    && info.scheme === 'https'
    && entry.integrity !== true;
  // Karisik icerik: https sayfada http script.
  decorated.mixedContent = Boolean(entry.mixedContent) || info.scheme === 'http';
  return decorated;
}

/** Bir kaydin insan-okunur kind etiketi. */
export function kindLabel(kind) {
  switch (kind) {
    case 'sourcemap': return 'sourcemap';
    case 'worker': return 'worker';
    case 'serviceworker': return 'service worker';
    case 'importmap-target': return 'import map';
    default: return 'script';
  }
}

/** firstParty once, sonra alfabetik siralama. */
export function compareEntries(a, b) {
  if (a.party !== b.party) return a.party === 'first' ? -1 : 1;
  return a.normalizedUrl.localeCompare(b.normalizedUrl);
}

/** Liste icin ozet sayaclar. */
export function summarize(entries) {
  let first = 0;
  let third = 0;
  let bundles = 0;
  let maps = 0;
  let inferred = 0;
  for (const entry of entries) {
    if (entry.party === 'first') first++;
    else third++;
    if (entry.isBundle) bundles++;
    if (entry.hasSourceMap) maps++;
    if (entry.confidence === 'inferred') inferred++;
  }
  return { total: entries.length, first, third, bundles, maps, inferred };
}
