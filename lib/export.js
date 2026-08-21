// lib/export.js
// Dort disa aktarim formati: TXT, JSON, CSV, Markdown.
// Tum fonksiyonlar saftir: girdiyi degistirmez, string dondurur.

/** Dosya adi icin guvenli host parcasi uretir. */
function safeHost(pageUrl) {
  try {
    const host = new URL(pageUrl).hostname;
    return host.replace(/[^a-z0-9.-]/gi, '_') || 'page';
  } catch {
    return 'page';
  }
}

/** YYYYMMDD-HHmm damgasi. */
function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** jsharvest_<host>_<YYYYMMDD-HHmm>.<ext> */
export function buildFilename(pageUrl, ext, date = new Date()) {
  return `jsharvest_${safeHost(pageUrl)}_${timestamp(date)}.${ext}`;
}

/** Satir basina bir URL. */
export function toTXT(entries) {
  return entries.map((entry) => entry.normalizedUrl).join('\n') + (entries.length ? '\n' : '');
}

/** Tam metadata. */
export function toJSON(entries, pageUrl, capturedAt = new Date()) {
  const payload = {
    page: pageUrl || '',
    capturedAt: capturedAt.toISOString(),
    tool: 'JSHarvest 1.0.0',
    count: entries.length,
    scripts: entries.map((entry) => ({
      url: entry.url,
      normalizedUrl: entry.normalizedUrl,
      party: entry.party === 'first' ? 'first-party' : 'third-party',
      vendor: entry.vendor || null,
      kind: entry.kind || 'script',
      statusCode: entry.statusCode ?? null,
      error: entry.error || null,
      size: entry.size || 0,
      duration: entry.duration || 0,
      fromCache: entry.fromCache ?? null,
      isBundle: Boolean(entry.isBundle),
      hasSourceMap: Boolean(entry.hasSourceMap),
      sourceMapUrl: entry.sourceMapUrl || null,
      confidence: entry.confidence || 'confirmed',
      sources: entry.sources || [],
      frameIds: entry.frameIds || [],
      firstSeen: entry.firstSeen ? new Date(entry.firstSeen).toISOString() : null
    }))
  };
  return JSON.stringify(payload, null, 2);
}

/** RFC 4180 uyumlu alan kacisi. */
function csvField(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCSV(entries) {
  const header = ['url', 'party', 'vendor', 'status', 'size', 'sources'];
  const rows = entries.map((entry) => [
    entry.normalizedUrl,
    entry.party === 'first' ? 'first-party' : 'third-party',
    entry.vendor || '',
    entry.statusCode ?? (entry.error ? 'error' : ''),
    entry.size || 0,
    (entry.sources || []).join('|')
  ].map(csvField).join(','));
  return [header.join(','), ...rows].join('\n') + '\n';
}

export function toMarkdown(entries, pageUrl, capturedAt = new Date()) {
  const first = entries.filter((entry) => entry.party === 'first');
  const third = entries.filter((entry) => entry.party !== 'first');

  const line = (entry) => {
    const badges = [];
    if (entry.vendor) badges.push(entry.vendor);
    if (entry.isBundle) badges.push('bundle');
    if (entry.hasSourceMap) badges.push('map');
    if (entry.confidence === 'inferred') badges.push('inferred');
    if (entry.statusCode) badges.push(String(entry.statusCode));
    const suffix = badges.length ? ` — _${badges.join(', ')}_` : '';
    return `- \`${entry.normalizedUrl}\`${suffix}`;
  };

  const parts = [
    `# JSHarvest — ${pageUrl || 'unknown page'}`,
    '',
    `Captured at ${capturedAt.toISOString()} · ${entries.length} script(s)`,
    '',
    `## First-party (${first.length})`,
    '',
    first.length ? first.map(line).join('\n') : '_none_',
    '',
    `## Third-party (${third.length})`,
    '',
    third.length ? third.map(line).join('\n') : '_none_',
    ''
  ];
  return parts.join('\n');
}

/**
 * Recon wordlist: benzersiz yol segmentleri ve dosya adlari (uzantisiz dahil).
 * ffuf / gobuster gibi araclar icin girdi.
 */
export function toWordlist(entries) {
  const words = new Set();
  for (const entry of entries) {
    let pathname = '';
    try {
      pathname = new URL(entry.normalizedUrl).pathname;
    } catch {
      continue;
    }
    for (const segment of pathname.split('/')) {
      const clean = segment.trim();
      if (!clean) continue;
      words.add(clean);
      // Uzantisiz halini de ekle (fuzzing icin faydali).
      const dot = clean.lastIndexOf('.');
      if (dot > 0) words.add(clean.slice(0, dot));
    }
  }
  return [...words].sort().join('\n') + (words.size ? '\n' : '');
}

/** Her URL icin bir curl komutu (kimlik bilgisi tasimaz). */
export function toCurl(entries) {
  return entries
    .map((entry) => `curl -sS -o /dev/null -w "%{http_code} %{size_download} ${entry.normalizedUrl}\\n" '${entry.normalizedUrl.replace(/'/g, "'\\''")}'`)
    .join('\n') + (entries.length ? '\n' : '');
}

/** Minimal HAR (HTTP Archive) alt kumesi — devtools/analiz araclarina aktarim. */
export function toHAR(entries, pageUrl, capturedAt = new Date()) {
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'JSHarvest', version: '1.0.0' },
      pages: [{
        startedDateTime: capturedAt.toISOString(),
        id: 'page_1',
        title: pageUrl || '',
        pageTimings: {}
      }],
      entries: entries.map((entry) => ({
        pageref: 'page_1',
        startedDateTime: entry.firstSeen ? new Date(entry.firstSeen).toISOString() : capturedAt.toISOString(),
        time: entry.duration || 0,
        request: { method: 'GET', url: entry.normalizedUrl, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
        response: {
          status: entry.statusCode ?? 0,
          statusText: entry.error ? 'ERROR' : '',
          httpVersion: 'HTTP/1.1',
          headers: [],
          cookies: [],
          content: { size: entry.size || 0, mimeType: 'application/javascript' },
          redirectURL: '',
          headersSize: -1,
          bodySize: entry.size || 0,
          _fromCache: entry.fromCache ? 'memory' : undefined
        },
        cache: {},
        timings: { send: 0, wait: entry.duration || 0, receive: 0 },
        _jsharvest: { party: entry.party, sources: entry.sources, confidence: entry.confidence }
      }))
    }
  };
  return JSON.stringify(har, null, 2);
}

/** Source map'ten cikan orijinal kaynak yollarindan agac cizer. */
export function toSourcesTree(origins) {
  const paths = [...new Set((origins || []).map((o) => o.path).filter(Boolean))].sort();
  if (paths.length === 0) return 'No original sources recovered.\n';

  const root = {};
  for (const path of paths) {
    let node = root;
    for (const part of path.split('/').filter(Boolean)) {
      node[part] = node[part] || {};
      node = node[part];
    }
  }

  const lines = [];
  const walk = (node, prefix) => {
    const keys = Object.keys(node).sort();
    keys.forEach((keyName, i) => {
      const last = i === keys.length - 1;
      lines.push(prefix + (last ? '└── ' : '├── ') + keyName);
      walk(node[keyName], prefix + (last ? '    ' : '│   '));
    });
  };
  walk(root, '');
  return `# Recovered source tree (${paths.length} files)\n\n` + lines.join('\n') + '\n';
}

/** Madencilik bulgularini Markdown olarak raporlar. */
export function findingsToMarkdown(findings, pageUrl, capturedAt = new Date()) {
  const secrets = findings.filter((f) => f.category === 'secret');
  const endpoints = findings.filter((f) => f.category === 'endpoint');
  const line = (f) => `- **${f.type}** (${f.confidence}) — \`${f.value}\`\n  - file: \`${f.file}\`\n  - context: \`${f.snippet}\``;
  return [
    `# JSHarvest findings — ${pageUrl || 'unknown page'}`,
    '',
    `Captured at ${capturedAt.toISOString()} · ${findings.length} finding(s)`,
    '',
    `## Secrets (${secrets.length})`,
    '',
    secrets.length ? secrets.map(line).join('\n') : '_none_',
    '',
    `## Endpoints (${endpoints.length})`,
    '',
    endpoints.length ? endpoints.map(line).join('\n') : '_none_',
    ''
  ].join('\n');
}

/** Madencilik bulgularini CSV olarak yazar. */
export function findingsToCSV(findings) {
  const header = ['type', 'category', 'confidence', 'value', 'file', 'context'];
  const rows = findings.map((f) => [f.type, f.category, f.confidence, f.value, f.file, f.snippet].map(csvField).join(','));
  return [header.join(','), ...rows].join('\n') + '\n';
}

/** Ana liste icin format adina gore icerik + MIME + uzanti dondurur. */
export function buildExport(format, entries, pageUrl) {
  const now = new Date();
  switch (format) {
    case 'json':
      return { content: toJSON(entries, pageUrl, now), mime: 'application/json', ext: 'json' };
    case 'csv':
      return { content: toCSV(entries), mime: 'text/csv', ext: 'csv' };
    case 'md':
      return { content: toMarkdown(entries, pageUrl, now), mime: 'text/markdown', ext: 'md' };
    case 'wordlist':
      return { content: toWordlist(entries), mime: 'text/plain', ext: 'wordlist.txt' };
    case 'curl':
      return { content: toCurl(entries), mime: 'text/plain', ext: 'curl.sh' };
    case 'har':
      return { content: toHAR(entries, pageUrl, now), mime: 'application/json', ext: 'har' };
    case 'txt':
    default:
      return { content: toTXT(entries), mime: 'text/plain', ext: 'txt' };
  }
}

/** Findings gorunumu icin export. */
export function buildFindingsExport(format, findings, pageUrl) {
  const now = new Date();
  if (format === 'csv') return { content: findingsToCSV(findings), mime: 'text/csv', ext: 'findings.csv' };
  if (format === 'json') return { content: JSON.stringify({ page: pageUrl, capturedAt: now.toISOString(), findings }, null, 2), mime: 'application/json', ext: 'findings.json' };
  return { content: findingsToMarkdown(findings, pageUrl, now), mime: 'text/markdown', ext: 'findings.md' };
}

/** Sources gorunumu icin export. */
export function buildSourcesExport(format, origins, pageUrl) {
  const now = new Date();
  if (format === 'txt') {
    const list = [...new Set((origins || []).map((o) => o.path))].sort().join('\n');
    return { content: list + (origins.length ? '\n' : ''), mime: 'text/plain', ext: 'sources.txt' };
  }
  if (format === 'json') return { content: JSON.stringify({ page: pageUrl, capturedAt: now.toISOString(), sources: origins }, null, 2), mime: 'application/json', ext: 'sources.json' };
  return { content: toSourcesTree(origins), mime: 'text/plain', ext: 'sources-tree.txt' };
}
