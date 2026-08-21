// lib/mine.js
// JS iceriginden sir (secret) ve endpoint madenciligi. Saf fonksiyonlar.
//
// UYARI: Bu ozellik yalnizca opt-in Deep Scan sirasinda ve yalnizca first-party
// JS uzerinde calisir. Amac, yetkili recon/guvenlik degerlendirmesinde ifsa
// olmus anahtarlari ve ic endpoint'leri ortaya cikarmaktir.
//
// Yaklasim: yuksek-sinyalli desenler yuksek guven, jenerik desenler dusuk guven
// ile isaretlenir. Deger kismen maskelenerek saklanir (tam sir loglanmaz).

/** Sinyal guveni: high (belirgin format), medium, low (jenerik). */
const SECRET_PATTERNS = [
  { type: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g, confidence: 'high' },
  { type: 'AWS Secret Key', re: /\baws_secret_access_key\s*[:=]\s*['"]([A-Za-z0-9/+=]{40})['"]/gi, confidence: 'high', group: 1 },
  { type: 'Google API Key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, confidence: 'high' },
  { type: 'Google OAuth', re: /\b[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com\b/g, confidence: 'medium' },
  { type: 'Firebase API Key', re: /\bapiKey\s*:\s*['"](AIza[0-9A-Za-z\-_]{35})['"]/g, confidence: 'high', group: 1 },
  { type: 'Slack Token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,72}\b/g, confidence: 'high' },
  { type: 'Slack Webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, confidence: 'high' },
  { type: 'GitHub Token', re: /\bgh[pousr]_[0-9A-Za-z]{36,255}\b/g, confidence: 'high' },
  { type: 'GitLab Token', re: /\bglpat-[0-9A-Za-z\-_]{20}\b/g, confidence: 'high' },
  { type: 'Stripe Live Key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/g, confidence: 'high' },
  { type: 'Stripe Publishable', re: /\bpk_live_[0-9A-Za-z]{24,}\b/g, confidence: 'medium' },
  { type: 'Twilio SID', re: /\bAC[0-9a-fA-F]{32}\b/g, confidence: 'medium' },
  { type: 'SendGrid Key', re: /\bSG\.[0-9A-Za-z\-_]{22}\.[0-9A-Za-z\-_]{43}\b/g, confidence: 'high' },
  { type: 'Mailgun Key', re: /\bkey-[0-9a-f]{32}\b/g, confidence: 'medium' },
  { type: 'npm Token', re: /\bnpm_[0-9A-Za-z]{36}\b/g, confidence: 'high' },
  { type: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, confidence: 'medium' },
  { type: 'Private Key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, confidence: 'high' },
  { type: 'Bearer Token', re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g, confidence: 'low' },
  { type: 'Basic Auth URL', re: /\bhttps?:\/\/[^\s'":/]+:[^\s'"@/]+@[^\s'"/]+/g, confidence: 'high' },
  // Jenerik "<isim> = '<deger>'" atamalari (dusuk guven, cok gurultulu olabilir).
  { type: 'Generic Secret', re: /['"]?(?:api[_-]?key|secret|token|passwd|password|access[_-]?token|client[_-]?secret)['"]?\s*[:=]\s*['"]([^'"\s]{12,80})['"]/gi, confidence: 'low', group: 1 }
];

/** Endpoint / ic hostname desenleri. */
const ENDPOINT_PATTERNS = [
  { type: 'S3 Bucket', re: /\b[a-z0-9.\-]{3,63}\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com\b/gi, confidence: 'medium' },
  { type: 'Internal Host', re: /\bhttps?:\/\/(?:[a-z0-9-]+\.)*(?:internal|corp|local|intranet|staging|dev|test|qa|uat)[.a-z0-9-]*\b/gi, confidence: 'medium' },
  { type: 'Private IP URL', re: /\bhttps?:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1|localhost)(?::\d+)?\b/gi, confidence: 'medium' },
  { type: 'GraphQL Endpoint', re: /['"](\/[^'"\s]*graphql[^'"\s]*)['"]/gi, confidence: 'medium', group: 1 },
  { type: 'API Path', re: /['"](\/(?:api|v\d|rest|internal|admin|graphql|oauth|auth)\/[A-Za-z0-9_\-./{}:]{1,120})['"]/g, confidence: 'low', group: 1 }
];

const MAX_MATCHES_PER_PATTERN = 100;
const MAX_TOTAL = 500;
const SNIPPET_RADIUS = 40;

/** Sirri kismen maskeler: bas 4 + son 2 karakter, ortasi yildiz. */
function maskValue(value) {
  const v = String(value);
  if (v.length <= 8) return v[0] + '*'.repeat(Math.max(1, v.length - 1));
  return v.slice(0, 4) + '…' + '*'.repeat(6) + v.slice(-2);
}

/** Eslesme cevresinden kisa baglam alir (tek satira indirger). */
function snippetAround(code, index, length) {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(code.length, index + length + SNIPPET_RADIUS);
  return code.slice(start, end).replace(/\s+/g, ' ').trim();
}

/** Endpoint yollari icin basit gurultu filtresi (asset/uzanti eleme). */
function isNoiseEndpoint(value) {
  return /\.(?:js|mjs|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map|json)(?:$|[?#])/i.test(value)
    || value.length < 4;
}

/**
 * Bir JS metnini tarar. Deger tam olarak saklanmaz — maskelenir; ham eslesme
 * yalnizca `raw` alaninda ve yalnizca endpoint (sir olmayan) icin tutulur.
 * @returns {Array<{id,type,category,value,raw,snippet,file,confidence}>}
 */
export function mine(code, sourceUrl = '') {
  if (typeof code !== 'string' || code.length === 0) return [];
  const findings = [];
  const seen = new Set();

  const push = (type, category, matchValue, index, matchLen, confidence, keepRaw) => {
    if (findings.length >= MAX_TOTAL) return;
    const value = String(matchValue);
    const id = `${type}|${value}|${sourceUrl}`;
    if (seen.has(id)) return;
    seen.add(id);
    const masked = category === 'secret' ? maskValue(value) : value;
    let snippet = snippetAround(code, index, matchLen);
    // KRITIK: baglam metni ham sirri kelimesi kelimesine icerir. Maskelenmis
    // deger `value` alaninda dogru gorunse bile snippet sizdirirdi (UI'da,
    // export'ta ve panoda). Sirri snippet icinde de maskeliyoruz.
    if (category === 'secret' && value.length >= 6) {
      snippet = snippet.split(value).join(masked);
    }
    findings.push({
      id,
      type,
      category,
      value: masked,
      raw: keepRaw ? value : '',
      snippet,
      file: sourceUrl,
      confidence
    });
  };

  const run = (patterns, category) => {
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      let match;
      let count = 0;
      while ((match = pattern.re.exec(code)) !== null && count < MAX_MATCHES_PER_PATTERN) {
        count++;
        const value = pattern.group ? match[pattern.group] : match[0];
        if (!value) continue;
        if (category === 'endpoint' && isNoiseEndpoint(value)) continue;
        push(pattern.type, category, value, match.index, match[0].length, pattern.confidence, category === 'endpoint');
        if (match.index === pattern.re.lastIndex) pattern.re.lastIndex++; // sonsuz dongu korumasi
      }
    }
  };

  run(SECRET_PATTERNS, 'secret');
  run(ENDPOINT_PATTERNS, 'endpoint');
  return findings;
}
