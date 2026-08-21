// lib/browser-api.js
// Tarayici API'si icin tek giris noktasi.
//
// Firefox promise tabanli `browser.*` namespace'ini sunar; `chrome.*` takma adi
// Firefox'ta callback tabanlidir ve `await` edildiginde undefined doner — bu
// sessiz bir hata kaynagi olurdu. Chrome ise yalnizca `chrome.*` tanimlar ve
// MV3'te zaten promise dondurur.
//
// Kural: `browser` varsa o kullanilir, yoksa `chrome`. Boylece tum cagrilar
// her iki tarayicida da await edilebilir.

export const api = globalThis.browser ?? globalThis.chrome;

/** Firefox event page mi, Chrome service worker mi calisiyoruz. */
export const isGecko = typeof globalThis.browser !== 'undefined';
