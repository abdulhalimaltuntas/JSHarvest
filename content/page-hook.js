// content/page-hook.js
// MAIN world (sayfa baglami) hook'u. web_accessible_resources olarak sunulur ve
// collector.js tarafindan <script> ile enjekte edilir.
//
// Amac: Worker / SharedWorker / serviceWorker.register cagrilarinda gecen script
// URL'lerini yakalayip window.postMessage ile content script'e iletmek. Bu JS
// sinifi ne ag "script" tipi ne de DOM <script> ile guvenilir yakalanabilir.
//
// Tasarim ilkesi: sayfanin davranisini ASLA degistirmemek. Orijinal
// constructor/fonksiyon her zaman cagrilir; hook yalnizca gozlemler.

(() => {
  'use strict';
  if (window.__jsHarvestPageHook) return;
  window.__jsHarvestPageHook = true;

  function report(url, kind) {
    try {
      if (typeof url !== 'string' || !url) return;
      // blob: URL'leri de bildir; content script mutlaklastirip siniflandirir.
      window.postMessage({ __jsharvest: true, kind, url }, '*');
    } catch {
      /* yoksayilir */
    }
  }

  // Worker constructor argumanindan URL string'i cikarir (string | URL | TrustedURL).
  function urlFromArg(arg) {
    try {
      if (typeof arg === 'string') return arg;
      if (arg instanceof URL) return arg.href;
      if (arg && typeof arg.toString === 'function') return String(arg);
    } catch {
      /* yoksayilir */
    }
    return '';
  }

  // Worker'i sar.
  try {
    const NativeWorker = window.Worker;
    if (typeof NativeWorker === 'function') {
      const WrappedWorker = function Worker(scriptURL, options) {
        report(urlFromArg(scriptURL), 'worker');
        return new NativeWorker(scriptURL, options);
      };
      WrappedWorker.prototype = NativeWorker.prototype;
      Object.defineProperty(WrappedWorker, 'name', { value: 'Worker' });
      window.Worker = WrappedWorker;
    }
  } catch {
    /* sayfayi bozma; sessizce gec */
  }

  // SharedWorker'i sar.
  try {
    const NativeShared = window.SharedWorker;
    if (typeof NativeShared === 'function') {
      const WrappedShared = function SharedWorker(scriptURL, options) {
        report(urlFromArg(scriptURL), 'worker');
        return new NativeShared(scriptURL, options);
      };
      WrappedShared.prototype = NativeShared.prototype;
      Object.defineProperty(WrappedShared, 'name', { value: 'SharedWorker' });
      window.SharedWorker = WrappedShared;
    }
  } catch {
    /* yoksayilir */
  }

  // navigator.serviceWorker.register'i sar.
  try {
    const swContainer = navigator.serviceWorker;
    if (swContainer && typeof swContainer.register === 'function') {
      const nativeRegister = swContainer.register.bind(swContainer);
      swContainer.register = function register(scriptURL, options) {
        report(urlFromArg(scriptURL), 'serviceworker');
        return nativeRegister(scriptURL, options);
      };
    }
  } catch {
    /* yoksayilir */
  }
})();
