// lib/report.js
// Angajman raporu: tek dosyalik, kendi kendine yeten HTML + tasinabilir JSON.
//
// Rapor bir pentest ciktisi degil, onun ILK TASLAGIDIR: envanter, risk
// sinyalleri, bulgular, kurtarilan kaynak agaci, triyaj durumu ve notlar tek
// yerde. Harici kaynak yok — dosyayi tek basina acabilir, e-postayla
// yollayabilirsin.

import { decorate, compareEntries, summarize } from './classify.js';

/** HTML'e gomulen her kullanici verisi bundan gecer. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kb(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function when(ts) {
  return ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) : '—';
}

/** Kaynak yollarindan agac metni uretir. */
function sourceTree(origins) {
  const paths = [...new Set((origins || []).map((o) => o.path).filter(Boolean))].sort();
  if (!paths.length) return '';
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
    keys.forEach((key, i) => {
      const last = i === keys.length - 1;
      lines.push(prefix + (last ? '└── ' : '├── ') + key);
      walk(node[key], prefix + (last ? '    ' : '│   '));
    });
  };
  walk(root, '');
  return lines.join('\n');
}

/**
 * Angajman raporunu tek dosyalik HTML olarak uretir.
 * @param {{session, entries, findings, origins, notes, triage, analyses}} input
 */
export function buildSessionReport(input) {
  const session = input.session || { name: 'Untitled engagement', scope: [] };
  const pageUrl = input.pageUrl || '';
  const entries = (input.entries || []).map((e) => decorate(e, e.pages && e.pages[0] ? e.pages[0] : pageUrl))
    .sort(compareEntries);
  const findings = input.findings || [];
  const origins = input.origins || [];
  const triage = input.triage || {};
  const analyses = input.analyses || [];
  const notes = input.notes || '';

  const stats = summarize(entries);
  const totalSize = entries.reduce((sum, e) => sum + (e.size || 0), 0);
  const risky = entries.filter((e) => e.noIntegrity || e.mixedContent);
  const authOnly = entries.filter((e) => (e.authStates || []).includes('auth')
    && !(e.authStates || []).includes('anon'));
  const secrets = findings.filter((f) => f.category === 'secret');
  const endpoints = findings.filter((f) => f.category === 'endpoint');
  const marked = Object.keys(triage).length;

  const rows = entries.map((e) => {
    const state = triage[e.key] || 'new';
    const flags = [
      e.noIntegrity ? 'no-SRI' : '',
      e.mixedContent ? 'mixed' : '',
      e.isBundle ? 'bundle' : '',
      e.hasSourceMap ? 'map' : '',
      e.confidence === 'inferred' ? 'inferred' : '',
      (e.authStates || []).includes('auth') && !(e.authStates || []).includes('anon') ? 'auth-only' : ''
    ].filter(Boolean).join(' ');
    return `<tr class="${e.party === 'first' ? 'first' : 'third'} t-${esc(state)}">
      <td class="u">${esc(e.normalizedUrl)}</td>
      <td>${e.party === 'first' ? '1st' : '3rd'}</td>
      <td>${esc(e.vendor || '—')}</td>
      <td>${esc(e.error || (e.statusCode ?? '—'))}</td>
      <td class="n">${kb(e.size)}</td>
      <td class="f">${esc(flags || '—')}</td>
      <td>${esc(state === 'new' ? '' : state)}</td>
    </tr>`;
  }).join('\n');

  const findingRows = findings.map((f) => `<tr class="${f.category === 'secret' ? 'sec' : 'ep'}">
      <td>${esc(f.type)}</td>
      <td>${esc(f.confidence)}</td>
      <td class="u">${esc(f.value)}</td>
      <td class="u dim">${esc(f.file)}</td>
    </tr>`).join('\n');

  const analysisBlocks = analyses.map((a) => `<article class="analysis">
      <h3>${esc(a.label || a.analysis)} <span class="dim">${esc(a.model)} · ${esc(when(a.at))}</span></h3>
      <pre>${esc(a.text)}</pre>
    </article>`).join('\n');

  const tree = sourceTree(origins);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>JSHarvest — ${esc(session.name)}</title>
<style>
  :root { color-scheme: light dark; --bg:#0b0e14; --sf:#11151e; --ln:#212a38; --tx:#e7ecf5; --dm:#98a2b6; --ft:#6b7688;
          --first:#3ddc97; --third:#e8a33d; --risk:#ff6b60; --acc:#9b8cff; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --sf:#fff; --ln:#dde1e9; --tx:#131722; --dm:#545c6b; --ft:#6d7688;
            --first:#12996a; --third:#a4671a; --risk:#cf3529; --acc:#5b45d8; }
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--tx); font:14px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif }
  .wrap { max-width:1180px; margin:0 auto; padding:40px 24px 80px }
  h1 { font-size:26px; margin:0 0 4px; letter-spacing:-.02em }
  h2 { font-size:11px; letter-spacing:.09em; text-transform:uppercase; color:var(--ft); margin:34px 0 10px }
  h3 { font-size:14px; margin:0 0 6px }
  .lead { color:var(--dm); margin:0 }
  .scope { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--acc) }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-top:18px }
  .card { background:var(--sf); border:1px solid var(--ln); border-radius:10px; padding:12px }
  .card b { display:block; font-size:21px; font-variant-numeric:tabular-nums }
  .card span { font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--ft) }
  .card.risk b { color:var(--risk) } .card.auth b { color:var(--first) }
  table { width:100%; border-collapse:collapse; background:var(--sf); border:1px solid var(--ln); border-radius:10px; overflow:hidden }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--ln); font-size:12px; vertical-align:top }
  th { font-size:10px; letter-spacing:.07em; text-transform:uppercase; color:var(--ft); background:rgba(127,127,127,.06) }
  tr:last-child td { border-bottom:0 }
  td.u { font-family:ui-monospace,Menlo,monospace; word-break:break-all }
  td.n { font-variant-numeric:tabular-nums; white-space:nowrap }
  td.f, .dim { color:var(--ft) }
  tr.first td:nth-child(2) { color:var(--first) } tr.third td:nth-child(2) { color:var(--third) }
  tr.t-ignored { opacity:.45 }
  tr.sec td:first-child { color:var(--risk) } tr.ep td:first-child { color:var(--acc) }
  pre { background:var(--sf); border:1px solid var(--ln); border-radius:10px; padding:14px; overflow-x:auto;
        font-family:ui-monospace,Menlo,monospace; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-word }
  .analysis { margin-bottom:18px }
  footer { margin-top:44px; padding-top:16px; border-top:1px solid var(--ln); color:var(--ft); font-size:12px }
</style></head><body><div class="wrap">

<h1>${esc(session.name)}</h1>
<p class="lead">JSHarvest engagement report · generated ${esc(when(Date.now()))}</p>
${(session.scope || []).length ? `<p class="scope">scope: ${esc((session.scope || []).join('  ·  '))}</p>` : ''}

<div class="cards">
  <div class="card"><b>${stats.total}</b><span>Scripts</span></div>
  <div class="card"><b>${stats.first}</b><span>First-party</span></div>
  <div class="card"><b>${stats.third}</b><span>Third-party</span></div>
  <div class="card"><b>${kb(totalSize)}</b><span>Transferred</span></div>
  <div class="card risk"><b>${risky.length}</b><span>Risk flags</span></div>
  <div class="card auth"><b>${authOnly.length}</b><span>Auth-only</span></div>
  <div class="card"><b>${secrets.length}</b><span>Secrets</span></div>
  <div class="card"><b>${endpoints.length}</b><span>Endpoints</span></div>
  <div class="card"><b>${origins.length}</b><span>Sources</span></div>
  <div class="card"><b>${marked}</b><span>Triaged</span></div>
</div>

${notes ? `<h2>Notes</h2><pre>${esc(notes)}</pre>` : ''}

${findings.length ? `<h2>Findings (${findings.length})</h2>
<p class="lead">Secret values are masked. Confidence is the miner's pattern confidence, not a verdict.</p>
<table><thead><tr><th>Type</th><th>Confidence</th><th>Value</th><th>File</th></tr></thead>
<tbody>${findingRows}</tbody></table>` : ''}

${authOnly.length ? `<h2>Only seen while authenticated (${authOnly.length})</h2>
<p class="lead">These scripts never loaded in the logged-out capture — usually the most interesting surface.</p>
<pre>${esc(authOnly.map((e) => e.normalizedUrl).join('\n'))}</pre>` : ''}

<h2>Inventory (${entries.length})</h2>
<table><thead><tr><th>URL</th><th>Party</th><th>Vendor</th><th>Status</th><th>Size</th><th>Flags</th><th>Triage</th></tr></thead>
<tbody>${rows}</tbody></table>

${tree ? `<h2>Recovered sources (${origins.length})</h2><pre>${esc(tree)}</pre>` : ''}

${analysisBlocks ? `<h2>AI analyses (${analyses.length})</h2>${analysisBlocks}` : ''}

<footer>
  Generated by JSHarvest. Collection is passive; Deep Scan and AI analysis are opt-in.
  All testing represented here was performed against systems the operator owns or is authorized to assess.
</footer>
</div></body></html>`;
}

/** Tasinabilir JSON: baska bir tarayiciya/ekip arkadasina aktarim icin. */
export function buildSessionJson(input) {
  return JSON.stringify({
    tool: 'JSHarvest',
    kind: 'engagement',
    version: 1,
    exportedAt: new Date().toISOString(),
    session: input.session || null,
    notes: input.notes || '',
    triage: input.triage || {},
    entries: input.entries || [],
    findings: input.findings || [],
    origins: input.origins || [],
    analyses: input.analyses || []
  }, null, 2);
}
