// content/collector.js
// DOM katmani toplayicisi. Klasik (module olmayan) content script olarak calisir,
// bu yuzden lib/ modullerini import etmez; ihtiyac duydugu az sayida regex burada
// tekrar tanimlanir.
//
// Toplama kaynaklari:
//   1. script[src]
//   2. link[rel=preload][as=script] ve link[rel=modulepreload]
//   3. performance.getEntriesByType('resource') -> initiatorType === 'script'
//   4. inline script iceriginde gecen JS yol referanslari (dusuk guven)
//   5. //# sourceMappingURL referanslari
//   6. MutationObserver ile sonradan eklenen script elementleri

(() => {
  'use strict';

  // Klasik content script oldugu icin lib/browser-api.js import edilemez;
  // ayni kural burada yerel olarak uygulanir (Firefox: browser, Chrome: chrome).
  const api = globalThis.browser || globalThis.chrome;

  // chrome:// , about: ve eklenti sayfalarinda calisma (savunma amacli).
  const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
  if (!SUPPORTED_PROTOCOLS.has(location.protocol)) return;
  // Ayni frame'e iki kez enjekte edilmeye karsi koruma.
  if (window.__jsHarvestCollectorActive) return;
  window.__jsHarvestCollectorActive = true;

  const JS_PATH_RE = /\.(?:m|c)?js(?:[?#]|$)/i;
  const INLINE_PATH_RE = /["'`]([^"'`\s<>]+?\.(?:m|c)?js(?:\?[^"'`\s<>]{0,200})?)["'`]/g;
  const SOURCEMAP_GLOBAL_RE = /[#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/g;

  const MAX_INLINE_CHARS = 200000;   // cok buyuk inline bundle'larda regex maliyetini sinirla
  const MAX_INLINE_HITS = 200;       // inline basina en fazla referans
  const BATCH_SIZE = 250;            // tek mesajda gonderilecek kayit sayisi
  const OBSERVER_DEBOUNCE_MS = 400;

  /** Ayni URL'i tekrar tekrar gondermemek icin yerel dedupe. */
  const seen = new Set();
  const pending = [];
  let flushTimer = null;
  let scanTimer = null;
  let disposed = false;

  function absolutize(value, base) {
    try {
      return new URL(value, base || location.href).href;
    } catch {
      return '';
    }
  }

  function queue(url, source, extra) {
    if (disposed || !url) return;
    if (url.length > 8192) return;
    const dedupeKey = source === 'inline-reference' ? `i|${url}` : `c|${url}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    pending.push({ url, source, ...(extra || {}) });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer || disposed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 120);
  }

  function flush() {
    if (disposed || pending.length === 0) return;
    // Eklenti yeniden yuklendiyse runtime.id undefined olur.
    if (!api.runtime || !api.runtime.id) {
      dispose();
      return;
    }
    while (pending.length > 0) {
      const items = pending.splice(0, BATCH_SIZE);
      try {
        const result = api.runtime.sendMessage({
          type: 'dom-batch',
          pageUrl: location.href,
          items
        });
        if (result && typeof result.catch === 'function') {
          result.catch(() => { /* worker uyaniyor olabilir; kayip tolere edilir */ });
        }
      } catch {
        // Baglam gecersizlestiyse toplamayi durdur.
        dispose();
        return;
      }
      if (api.runtime.lastError) { /* bilincli olarak yutuluyor */ }
    }
  }

  // --- Toplayicilar ---------------------------------------------------------

  const IS_HTTPS_PAGE = location.protocol === 'https:';

  function collectScriptTags(root) {
    const nodes = root.querySelectorAll('script[src]');
    for (const node of nodes) {
      const raw = node.getAttribute('src');
      if (!raw) continue;
      const absolute = absolutize(raw);
      if (!absolute) continue;
      // SRI: integrity niteligi var mi? Karisik icerik: https sayfada http src.
      queue(absolute, 'dom', {
        integrity: node.hasAttribute('integrity'),
        mixedContent: IS_HTTPS_PAGE && absolute.startsWith('http://')
      });
    }
  }

  // Import map: <script type="importmap"> icindeki spec->url eslemeleri.
  function collectImportMaps(root) {
    const nodes = root.querySelectorAll('script[type="importmap"], script[type="importmap-shim"]');
    for (const node of nodes) {
      const text = node.textContent || '';
      if (!text || text.length > MAX_INLINE_CHARS) continue;
      let map;
      try {
        map = JSON.parse(text);
      } catch {
        continue;
      }
      const targets = [];
      if (map && typeof map.imports === 'object' && map.imports) {
        targets.push(...Object.values(map.imports));
      }
      if (map && typeof map.scopes === 'object' && map.scopes) {
        for (const scope of Object.values(map.scopes)) {
          if (scope && typeof scope === 'object') targets.push(...Object.values(scope));
        }
      }
      for (const target of targets) {
        if (typeof target !== 'string' || !target) continue;
        const absolute = absolutize(target);
        if (absolute) queue(absolute, 'importmap', { kind: 'importmap-target' });
      }
    }
  }

  function collectPreloads(root) {
    const selector = 'link[rel~="preload"][as="script"], link[rel~="modulepreload"]';
    const nodes = root.querySelectorAll(selector);
    for (const node of nodes) {
      const raw = node.getAttribute('href');
      if (!raw) continue;
      queue(absolutize(raw), 'dom');
    }
  }

  function collectPerformanceEntries() {
    let entries = [];
    try {
      entries = performance.getEntriesByType('resource') || [];
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name || '';
      // script initiator'i olan her kayit + uzantisi JS olan diger kayitlar.
      if (entry.initiatorType !== 'script' && !JS_PATH_RE.test(name)) continue;
      queue(entry.name, 'performance', {
        size: entry.transferSize || entry.encodedBodySize || 0,
        duration: Math.round(entry.duration || 0)
      });
    }
  }

  function collectInlineReferences(root) {
    const nodes = root.querySelectorAll('script:not([src])');
    for (const node of nodes) {
      const text = node.textContent || '';
      if (!text || text.length > MAX_INLINE_CHARS) continue;
      let hits = 0;

      INLINE_PATH_RE.lastIndex = 0;
      let match = INLINE_PATH_RE.exec(text);
      while (match && hits < MAX_INLINE_HITS) {
        const candidate = match[1];
        // Sadece yol gibi gorunen degerleri al (bare specifier'lari ele).
        if (/^(?:https?:)?\/\/|^\/|^\.{1,2}\//.test(candidate)) {
          const absolute = absolutize(candidate);
          if (absolute) {
            queue(absolute, 'inline-reference', { confidence: 'inferred' });
            hits++;
          }
        }
        match = INLINE_PATH_RE.exec(text);
      }

      collectSourceMaps(text, location.href);
    }
  }

  function collectSourceMaps(text, base) {
    SOURCEMAP_GLOBAL_RE.lastIndex = 0;
    let match = SOURCEMAP_GLOBAL_RE.exec(text);
    while (match) {
      const target = match[1];
      if (target && !target.startsWith('data:')) {
        const absolute = absolutize(target, base);
        if (absolute) queue(absolute, 'sourcemap', { kind: 'sourcemap', confidence: 'inferred' });
      }
      match = SOURCEMAP_GLOBAL_RE.exec(text);
    }
  }

  function fullScan() {
    if (disposed) return;
    try {
      collectScriptTags(document);
      collectPreloads(document);
      collectImportMaps(document);
      collectPerformanceEntries();
      collectInlineReferences(document);
    } catch (err) {
      // Tek bir toplayicinin hatasi digerlerini durdurmasin.
      console.debug('[JSHarvest] scan error:', err);
    }
    flush();
  }

  function scheduleScan(delay) {
    if (scanTimer || disposed) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      fullScan();
    }, delay);
  }

  // --- Gozlemciler ----------------------------------------------------------

  let mutationObserver = null;
  let performanceObserver = null;

  function startObservers() {
    try {
      mutationObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!node || node.nodeType !== 1) continue;
            const tag = node.tagName;
            if (tag === 'SCRIPT' || tag === 'LINK') {
              scheduleScan(OBSERVER_DEBOUNCE_MS);
              return;
            }
            if (node.querySelector && node.querySelector('script, link')) {
              scheduleScan(OBSERVER_DEBOUNCE_MS);
              return;
            }
          }
        }
      });
      mutationObserver.observe(document.documentElement || document, {
        childList: true,
        subtree: true
      });
    } catch (err) {
      console.debug('[JSHarvest] MutationObserver unavailable:', err);
    }

    try {
      performanceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.initiatorType === 'script' || JS_PATH_RE.test(entry.name || '')) {
            queue(entry.name, 'performance', {
              size: entry.transferSize || entry.encodedBodySize || 0,
              duration: Math.round(entry.duration || 0)
            });
          }
        }
      });
      performanceObserver.observe({ type: 'resource', buffered: true });
    } catch (err) {
      console.debug('[JSHarvest] PerformanceObserver unavailable:', err);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    pending.length = 0;
    if (flushTimer) clearTimeout(flushTimer);
    if (scanTimer) clearTimeout(scanTimer);
    try { if (mutationObserver) mutationObserver.disconnect(); } catch { /* yoksayilir */ }
    try { if (performanceObserver) performanceObserver.disconnect(); } catch { /* yoksayilir */ }
    try { window.removeEventListener('message', onPageMessage); } catch { /* yoksayilir */ }
  }

  // --- Worker koprusu (MAIN world page-hook) --------------------------------

  // Worker / SharedWorker / serviceWorker.register cagrilarini yakalamak icin
  // sayfa baglamina (MAIN world) bir hook enjekte edilir. Content script izole
  // dunyada oldugu icin sayfa constructor'larini goremez; hook window.postMessage
  // ile bize URL'leri iletir.
  function onPageMessage(event) {
    if (disposed) return;
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__jsharvest !== true || typeof data.url !== 'string') return;
    const kind = data.kind === 'serviceworker' ? 'serviceworker' : 'worker';
    const absolute = absolutize(data.url);
    if (absolute) queue(absolute, kind, { kind });
  }

  function injectPageHook() {
    try {
      if (!api.runtime || !api.runtime.getURL) return;
      const script = document.createElement('script');
      script.src = api.runtime.getURL('content/page-hook.js');
      script.async = false;
      // Hook DOM'a girer girmez calisir; ardindan kendini kaldirir.
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (err) {
      console.debug('[JSHarvest] page-hook injection failed:', err);
    }
  }

  // --- Baslangic ------------------------------------------------------------

  window.addEventListener('message', onPageMessage);
  injectPageHook();
  fullScan();
  startObservers();

  // Gec yuklenen kaynaklar icin birkac ek tarama.
  window.addEventListener('load', () => scheduleScan(300), { once: true });
  setTimeout(() => scheduleScan(0), 2000);
  setTimeout(() => scheduleScan(0), 6000);
  window.addEventListener('pagehide', () => flush(), { once: true });
})();
