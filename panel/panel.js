// panel/panel.js
// DevTools paneli mantigi. Genis, sutunlu, siralanabilir tablo. Sanallastirilmis
// (28px sabit satir). Ana liste (scripts) uzerine odaklidir; findings/sources
// popup'ta kalir.
//
// NOT: DevTools panel sayfalari bazi tarayicilarda statik `<script type="module">`
// ile guvenilir calismaz (bos/beyaz panel). Bu yuzden panel.html bu dosyayi
// KLASIK script olarak yukler ve modul bagimliliklari burada DINAMIK import ile
// alinir. Tum baslatma try/catch icinde; hata olursa panele gorunur sekilde yazilir.

(() => {
  'use strict';

  const el = (id) => document.getElementById(id);

  /** Olumcul hatayi panele gorunur sekilde yazar (sessiz beyaz ekran olmasin). */
  function showFatal(err) {
    const msg = (err && err.message) ? err.message : String(err);
    try { console.error('[JSHarvest panel]', err); } catch { /* yoksayilir */ }
    const box = el('empty') || document.body;
    box.hidden = false;
    box.textContent = 'JSHarvest panel error: ' + msg;
    box.style.color = '#c0392b';
    box.style.padding = '16px';
    box.style.fontFamily = 'monospace';
  }

  async function boot() {
    const api = globalThis.browser || globalThis.chrome;

    // Modul bagimliliklari — dinamik import (devtools baglaminda daha guvenilir).
    const [classify, exportMod] = await Promise.all([
      import('../lib/classify.js'),
      import('../lib/export.js')
    ]);
    const { decorate, compareEntries, summarize, kindLabel } = classify;
    const { buildExport, buildFilename } = exportMod;

    const ROW_HEIGHT = 28;
    const OVERSCAN = 8;
    const POLL_MS = 1500;

    const tbody = el('tbody');
    const scroller = el('scroller');

    const state = {
      tabId: (api.devtools && api.devtools.inspectedWindow) ? api.devtools.inspectedWindow.tabId : null,
      pageUrl: '',
      scripts: [],
      filtered: [],
      filter: 'all',
      query: '',
      sortKey: 'default',
      sortDir: 1,
      updatedAt: -1,
      scanning: false
    };

    let toastTimer = null;
    function toast(msg) {
      const t = el('toast');
      t.textContent = msg;
      t.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.hidden = true; }, 1500);
    }

    function send(message) {
      return new Promise((resolve) => {
        try {
          const r = api.runtime.sendMessage(message);
          if (r && typeof r.then === 'function') r.then((x) => resolve(x || {})).catch(() => resolve({ ok: false }));
          else resolve({ ok: false });
        } catch { resolve({ ok: false }); }
      });
    }

    async function load({ silent = false } = {}) {
      if (state.tabId == null) return;
      const res = await send({ type: 'get-tab-data', tabId: state.tabId });
      if (!res.ok) return;
      if (silent && res.updatedAt === state.updatedAt && !res.deepScanRunning) return;
      state.updatedAt = res.updatedAt;
      state.pageUrl = res.pageUrl || state.pageUrl;
      state.scripts = (res.entries || []).map((e) => decorate(e, state.pageUrl));
      state.scanning = Boolean(res.deepScanRunning);
      apply();
    }

    function comparator(a, b) {
      if (state.sortKey === 'default') return compareEntries(a, b);
      let av = a[state.sortKey];
      let bv = b[state.sortKey];
      if (state.sortKey === 'sources') { av = (a.sources || []).join(); bv = (b.sources || []).join(); }
      if (av == null) av = '';
      if (bv == null) bv = '';
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * state.sortDir;
      return String(av).localeCompare(String(bv)) * state.sortDir;
    }

    function passesChip(e) {
      switch (state.filter) {
        case 'first': return e.party === 'first';
        case 'third': return e.party !== 'first';
        case 'bundles': return Boolean(e.isBundle);
        case 'maps': return Boolean(e.hasSourceMap) || e.kind === 'sourcemap';
        case 'risk': return Boolean(e.noIntegrity) || Boolean(e.mixedContent);
        default: return true;
      }
    }

    function apply() {
      const q = state.query.trim().toLowerCase();
      state.filtered = state.scripts
        .filter(passesChip)
        .filter((e) => !q || e.normalizedUrl.toLowerCase().includes(q))
        .sort(comparator);

      const s = summarize(state.scripts);
      const size = state.scripts.reduce((sum, e) => sum + (e.size || 0), 0);
      el('summary').textContent = `${s.total} scripts · ${s.first} 1st · ${s.third} 3rd · ${(size / 1024).toFixed(0)} KB`;
      const empty = el('empty');
      empty.hidden = state.scripts.length !== 0;
      if (!empty.hidden) {
        empty.textContent = state.tabId == null
          ? 'DevTools could not resolve the inspected tab.'
          : 'No scripts captured for this tab yet — reload the page.';
      }
      render();
    }

    function cell(cls, text) {
      const c = document.createElement('span');
      c.className = 'cell ' + cls;
      if (text != null) c.textContent = text;
      return c;
    }

    function buildRow(e, index) {
      const row = document.createElement('div');
      row.className = 'row ' + (e.party === 'first' ? 'is-first' : 'is-third') + (e.confidence === 'inferred' ? ' is-inferred' : '');
      row.style.top = `${index * ROW_HEIGHT}px`;

      const file = document.createElement('span');
      file.className = 'cell cell--file';
      file.title = e.normalizedUrl;
      const b = document.createElement('b');
      b.textContent = e.fileName;
      const dir = document.createElement('span');
      dir.textContent = '  ' + e.dirPath;
      file.appendChild(b);
      file.appendChild(dir);
      file.addEventListener('click', () => { navigator.clipboard.writeText(e.normalizedUrl).then(() => toast('URL copied')).catch(() => {}); });
      row.appendChild(file);

      row.appendChild(cell('cell--dim', e.party === 'first' ? '1st' : '3rd'));
      row.appendChild(cell('cell--dim', kindLabel(e.kind)));
      row.appendChild(cell('cell--dim', e.vendor || '—'));
      const status = cell((e.error || e.statusCode >= 400) ? 'cell--err' : '', e.error ? 'err' : (e.statusCode ?? '—'));
      row.appendChild(status);
      row.appendChild(cell('cell--dim', e.size ? (e.size < 1024 ? e.size + 'B' : (e.size / 1024).toFixed(1) + 'K') : '—'));
      const risk = e.noIntegrity ? 'no-SRI ' : '';
      row.appendChild(cell(e.noIntegrity || e.mixedContent ? 'cell--risk' : '', risk + (e.sources || []).join(',')));
      return row;
    }

    function render() {
      const total = state.filtered.length;
      scroller.style.height = `${total * ROW_HEIGHT}px`;
      const scrollTop = tbody.scrollTop;
      const vh = tbody.clientHeight || 500;
      const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
      const end = Math.min(total, Math.ceil((scrollTop + vh) / ROW_HEIGHT) + OVERSCAN);
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) frag.appendChild(buildRow(state.filtered[i], i));
      scroller.textContent = '';
      scroller.appendChild(frag);
    }

    // --- Etkilesim ---

    tbody.addEventListener('scroll', render, { passive: true });

    el('search').addEventListener('input', (ev) => { state.query = ev.target.value; tbody.scrollTop = 0; apply(); });

    el('chips').addEventListener('click', (ev) => {
      const chip = ev.target.closest('.chip');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      for (const c of el('chips').querySelectorAll('.chip')) c.classList.toggle('is-active', c === chip);
      tbody.scrollTop = 0;
      apply();
    });

    el('thead').addEventListener('click', (ev) => {
      const th = ev.target.closest('.th');
      if (!th) return;
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = 1; }
      for (const h of el('thead').querySelectorAll('.th')) h.classList.toggle('is-sorted', h === th);
      apply();
    });

    el('deepScan').addEventListener('click', async () => {
      if (state.tabId == null) return;
      el('deepScan').disabled = true;
      toast('Deep scan started…');
      await send({ type: 'deep-scan-start', tabId: state.tabId });
    });

    el('exportBtn').addEventListener('click', () => {
      const { content, mime, ext } = buildExport('json', state.filtered, state.pageUrl);
      const blob = new Blob([content], { type: `${mime};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildFilename(state.pageUrl, ext);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`Exported ${state.filtered.length} as JSON`);
    });

    el('clear').addEventListener('click', async () => {
      await send({ type: 'clear-tab', tabId: state.tabId });
      state.updatedAt = -1;
      await load();
      toast('Cleared');
    });

    api.runtime.onMessage.addListener((message) => {
      if (!message || message.tabId !== state.tabId) return;
      if (message.type === 'deep-scan-done') {
        el('deepScan').disabled = false;
        state.updatedAt = -1;
        load();
        toast(message.error ? 'Deep scan error' : `Deep scan finished · ${message.found || 0} found`);
      }
    });

    // Ilk render hemen (veri gelmeden once de baslik/bos-durum gorunur).
    apply();
    load();
    setInterval(() => load({ silent: true }), POLL_MS);
  }

  function start() {
    boot().catch(showFatal);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
